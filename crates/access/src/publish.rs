//! 发布: 值树按 `.msg` 定义编码为 CDR 后经 hiroz 原始 publisher 发出.
//!
//! 类型由会话注册表 (内置 + 追加的 `.msg` 目录) 运行时解析, type hash 由定义算出 (RIHS01).
//! 发布端 liveliness token, attachment (序号 + 源时间戳 + gid), transient_local 缓存均由 hiroz 按 rmw_zenoh 做.

use std::sync::Arc;

use hiroz::Builder as _;
use hiroz::entity::EndpointKind;
use hiroz::msg::ZMessage;
use hiroz::pubsub::ZPub;

use crate::session::Session;
use crate::transport::{self, Transport};
use crate::{Error, Registry, Value};

/// 原始发布的消息类型占位: 只发已编码的字节, 从不按它序列化.
type RawBytes = Vec<u8>;

/// 发布端 QoS (首版: 可靠性, 持久性, keep_last 深度).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QosProfile {
    /// reliable; false 为 best_effort
    pub reliable: bool,
    /// transient_local: 缓存最近 `depth` 条, 晚到的 transient_local 订阅端也取得到; false 为 volatile
    pub transient_local: bool,
    /// keep_last 深度, 至少 1 (0 按 1)
    pub depth: usize,
}

impl Default for QosProfile {
    /// reliable, volatile, keep_last(10) (同 rclpy 默认)
    fn default() -> Self {
        QosProfile { reliable: true, transient_local: false, depth: transport::DEFAULT_DEPTH }
    }
}

impl QosProfile {
    fn to_transport(self) -> transport::Qos {
        transport::Qos { reliable: self.reliable, transient_local: self.transient_local, depth: Some(self.depth.max(1)) }
    }
}

impl Session {
    /// 建话题发布端并声明其 liveliness token. `type_name` 为 `包/msg/类型` (或 `包/类型`), 须在会话注册表里.
    pub async fn create_publisher(&self, type_name: &str, topic: &str, qos: QosProfile) -> Result<Publisher, Error> {
        let registry = self.registry().clone();
        let unknown = || Error::UnknownType(type_name.into());
        let def_name = registry.get(type_name).ok_or_else(unknown)?.name.clone();
        let type_info = transport::type_info(&registry, &def_name).ok_or_else(unknown)?;
        let builder = self
            .transport()
            .node()
            .create_pub_impl::<RawBytes>(topic, Some(type_info))
            .with_qos(qos.to_transport().to_hiroz());
        // hiroz 的建立是同步阻塞的
        let zpub = transport::blocking(move || builder.build()).await.map_err(Error::Zenoh)?;
        Ok(Publisher { zpub, type_name: def_name, registry, transport: self.transport().clone() })
    }
}

/// 一个话题发布端. drop 即撤销 (撤 liveliness token, transient_local 缓存随之失效).
pub struct Publisher {
    zpub: ZPub<RawBytes, <RawBytes as ZMessage>::Serdes>,
    type_name: String,
    registry: Arc<Registry>,
    // 在 zpub 之后 drop: 发布端先撤, 节点与会话后关
    transport: Transport,
}

impl Publisher {
    /// 带首 `/` 的话题名.
    pub fn topic(&self) -> &str {
        &self.zpub.entity.topic
    }

    /// `包/msg/类型`
    pub fn type_name(&self) -> &str {
        &self.type_name
    }

    /// 按定义校验并编码后发出; 值不合定义时返回 [`Error::Encode`] (指出字段路径), 什么也不发.
    /// 值树形状见 [`rosz_decode::EncodeError`] 所在模块: 可用解码结果, 也可用整数 `I64`/`U64`, 浮点 `F64`, 数组 `List` 的宽松形状.
    ///
    /// 同步: zenoh put 立即返回 (reliable 时拥塞则阻塞). 不要在 tokio current_thread 运行时里直接调.
    pub fn publish(&self, value: &Value) -> Result<(), Error> {
        let payload = self.registry.encode(&self.type_name, value)?;
        self.publish_cdr(payload)
    }

    /// 发已编码的 CDR (含 4 字节封装头), 不校验.
    pub fn publish_cdr(&self, payload: Vec<u8>) -> Result<(), Error> {
        self.zpub.publish_serialized(payload).map_err(Error::Zenoh)
    }

    /// 图里此话题的订阅端个数 (同 rclpy `get_subscription_count`).
    pub fn subscription_count(&self) -> usize {
        self.transport.node().graph().get_entities_by_topic(EndpointKind::Subscription, self.topic()).len()
    }
}
