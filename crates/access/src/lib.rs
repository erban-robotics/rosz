//! rosz 接入: 不装 ROS, 直连 Zenoh router 发现与订阅 rmw_zenoh 的 ROS 2 话题, 按内置 `.msg` 解码.
//!
//! 对外 API: [`connect`], [`Session::topics`], [`Session::latest`], [`Session::subscribe`], [`Session::create_publisher`].
//! 预期内失败用返回值 (超时为 `None`, 解不了的消息 [`Message::value`] 返回错误), 只有程序错误与连接失败为 `Err`.

mod publish;
mod session;
mod transport;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub use rosz_decode::media::{AlignError, DepthImage, ImageKind, MediaError, RgbImage};
pub use publish::{Publisher, QosProfile};
pub use rosz_decode::{Decodability, DecodeError, EncodeError, Registry, Value};
pub use session::{Session, Subscription, connect, resolve_router};
use thiserror::Error;
use transport::RawSample;

/// 环境变量: router 地址, `--router` 未给时用
pub const ROUTER_ENV: &str = "ROSZ_ROUTER";

#[derive(Debug, Error)]
pub enum Error {
    #[error("未指定 Zenoh router: 用 --router 或环境变量 ROSZ_ROUTER 给出, 如 tcp/192.168.1.10:7447")]
    NoRouter,
    #[error("连不上 router {router}: {source}")]
    Connect { router: String, source: zenoh::Error },
    #[error("没有话题 {topic}{}", candidates_hint(.candidates))]
    UnknownTopic { topic: String, candidates: Vec<String> },
    #[error("没有类型 {0} 的定义 (内置或追加的 .msg 目录里都没有)")]
    UnknownType(String),
    #[error(transparent)]
    Encode(#[from] EncodeError),
    #[error("zenoh: {0}")]
    Zenoh(zenoh::Error),
}

fn candidates_hint(candidates: &[String]) -> String {
    if candidates.is_empty() { String::new() } else { format!(", 是否要找: {}", candidates.join(", ")) }
}

/// 解不了一条消息的原因.
#[derive(Debug, Error, PartialEq)]
pub enum MessageError {
    #[error("{0}")]
    NotDecodable(String),
    #[error(transparent)]
    Decode(#[from] DecodeError),
    #[error(transparent)]
    Media(#[from] MediaError),
}

/// 一个话题 (按发布端 liveliness token 汇总).
#[derive(Clone, Debug, PartialEq)]
pub struct TopicInfo {
    pub name: String,
    /// `包/msg/类型`
    pub type_name: String,
    pub type_hash: String,
    /// 发布端 transient_local: 订阅时先取发布方缓存的历史
    pub transient_local: bool,
    pub publishers: usize,
    pub decodability: Decodability,
}

/// 收到的一条消息. 值树按需解码, 原始 CDR 保留在 `payload`.
#[derive(Clone, Debug)]
pub struct Message {
    pub topic: String,
    pub type_name: String,
    /// 本机收到时刻, Unix 纳秒
    pub receive_time_ns: i64,
    /// 采样时刻 (Header.stamp), Unix 纳秒; 类型无 Header 为 None
    pub sample_time_ns: Option<i64>,
    /// 发布方发出时刻 (attachment), Unix 纳秒
    pub source_time_ns: Option<i64>,
    /// 含 4 字节封装头的 CDR
    pub payload: Vec<u8>,
    pub decodability: Decodability,
    registry: Arc<Registry>,
}

impl Message {
    pub(crate) fn new(topic: &TopicInfo, sample: RawSample, registry: Arc<Registry>) -> Self {
        let decodable = topic.decodability.is_ok();
        let payload = sample.payload;
        Message {
            topic: topic.name.clone(),
            type_name: topic.type_name.clone(),
            receive_time_ns: sample.receive_time_ns,
            sample_time_ns: decodable.then(|| registry.header_stamp(&topic.type_name, &payload)).flatten(),
            source_time_ns: sample.attachment.map(|a| a.source_time_ns),
            payload,
            decodability: topic.decodability.clone(),
            registry,
        }
    }

    /// 解码值树.
    pub fn value(&self) -> Result<Value<'_>, MessageError> {
        if let Some(reason) = self.decodability.reason() {
            return Err(MessageError::NotDecodable(reason));
        }
        Ok(self.registry.decode(&self.type_name, &self.payload)?)
    }

    /// 图像消息是彩色还是深度; 非图像消息或解不了为 None.
    pub fn image_kind(&self) -> Option<ImageKind> {
        rosz_decode::media::kind(&self.type_name, &self.value().ok()?)
    }

    /// 彩色图转 RGB.
    pub fn image(&self) -> Result<RgbImage, MessageError> {
        Ok(rosz_decode::media::image(&self.type_name, &self.value()?)?)
    }

    /// 深度图转 uint16 毫米, 原分辨率.
    pub fn depth(&self) -> Result<DepthImage, MessageError> {
        Ok(rosz_decode::media::depth(&self.type_name, &self.value()?)?)
    }
}

pub(crate) fn now_ns() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i64)
}

/// 与 `name` 最相近的已知话题, 至多 3 个: 先取互相包含的, 再按编辑距离.
pub fn candidates<'a>(name: &str, known: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let name = name.trim_end_matches('/');
    let mut scored: Vec<(f64, &str)> = known
        .into_iter()
        .map(|k| {
            let contains = k.contains(name.trim_start_matches('/')) || name.contains(k);
            let score = strsim::normalized_levenshtein(name, k) + if contains { 1.0 } else { 0.0 };
            (score, k)
        })
        .filter(|(score, _)| *score >= 0.5)
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(b.1)));
    scored.into_iter().take(3).map(|(_, k)| k.to_owned()).collect()
}
