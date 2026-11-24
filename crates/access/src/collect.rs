//! 采集: 按话题清单把收到的消息原样写成 MCAP (ros2 profile), 不丢已到达的消息.
//!
//! - 发现驱动订阅: 清单里的话题一有发布端 (开录后才上线, 发布进程重启) 即订上; transient_local 话题先取发布端缓存的历史
//! - zenoh 回调只记统计并入无界队列; 独立写盘线程写 MCAP, stop 时写完队列再封口
//! - 每话题一个 channel: `log_time` = 接收时刻, `publish_time` = attachment 源时间戳, `sequence` = 发布端序号低 32 位,
//!   schema 为 rosz 注册表生成的 `ros2msg` 文本, 消息编码 `cdr`
//!
//! 只做通用部分: 就绪判定, "追到停止时刻" 之类的收尾语义留给调用方 (看 [`Collector::stats`] 自己判).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufWriter};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use thiserror::Error;
use tokio::sync::watch;

use crate::transport::{Endpoint, Qos, RawSample, RawSubscriber, Transport};
use crate::{Registry, Session};

/// 采集订阅的 QoS 深度: hiroz 每到一条即取走, 深度只在订阅建立期间 (transient_local 历史一次到达多条) 兜底,
/// 也是向 transient_local 发布端取历史的条数上限
const COLLECT_DEPTH: usize = 1000;
/// 图变化通知之外, 每隔这么久也重查一次清单内的发布端 (兜底, 并重试订阅失败的话题)
const RESCAN_INTERVAL: Duration = Duration::from_millis(500);
/// 统计里至多留这么多条错误
const MAX_ERRORS: usize = 100;
/// MCAP chunk 默认大小 (同 mcap 库默认)
pub const DEFAULT_CHUNK_SIZE: u64 = 768 * 1024;

/// MCAP chunk 压缩.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Compression {
    #[default]
    None,
    Zstd,
    Lz4,
}

impl FromStr for Compression {
    type Err = String;

    /// `none` / `zstd` / `lz4`
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "none" => Ok(Compression::None),
            "zstd" => Ok(Compression::Zstd),
            "lz4" => Ok(Compression::Lz4),
            _ => Err(format!("不支持的压缩 {s}: 可选 none, zstd, lz4")),
        }
    }
}

/// 采集选项.
#[derive(Clone, Debug)]
pub struct CollectOptions {
    /// chunk 压缩, 默认不压缩
    pub compression: Compression,
    /// chunk 大小 (字节), 默认 [`DEFAULT_CHUNK_SIZE`]
    pub chunk_size: u64,
}

impl Default for CollectOptions {
    fn default() -> Self {
        CollectOptions { compression: Compression::None, chunk_size: DEFAULT_CHUNK_SIZE }
    }
}

#[derive(Debug, Error)]
pub enum CollectError {
    #[error("建 {path} 失败: {source}")]
    Create { path: String, source: io::Error },
    #[error("写 MCAP 失败: {0}")]
    Mcap(#[from] mcap::McapError),
    #[error("采集写盘线程异常退出")]
    WriterPanicked,
}

/// 一次采集的统计.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CollectStats {
    /// 已订上的话题 (清单里还没发布端的不在内)
    pub topics: BTreeMap<String, TopicStats>,
    /// 已写盘条数
    pub written: u64,
    /// 已收到未写盘的条数
    pub queue_depth: usize,
    /// 最近一次写盘时刻, Unix 纳秒
    pub last_write_time_ns: Option<i64>,
    /// 订阅失败, 写盘失败等 (不中断采集), 至多 100 条
    pub errors: Vec<String>,
}

/// 一个话题的统计.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TopicStats {
    /// `包/msg/类型`
    pub type_name: String,
    pub received: u64,
    pub written: u64,
    /// 按发布端序号算的缺口条数 (每个发布端 gid 各自计)
    pub gaps: u64,
    /// 首个之后出现新发布端 gid, 或同一 gid 序号回退的次数 (多发布端话题首次见到其余发布端也各计一次)
    pub publisher_restarts: u64,
    /// 最近一条的接收时刻, Unix 纳秒
    pub last_receive_time_ns: Option<i64>,
    /// 最近一条的 Header.stamp, Unix 纳秒; 类型无 Header 或解不了为 None
    pub last_header_stamp_ns: Option<i64>,
    /// 接收时刻减源时间戳; 没有带 attachment 的消息为 None
    pub latency: Option<LatencyStats>,
}

/// 延迟分布, 纳秒.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LatencyStats {
    pub p50_ns: i64,
    pub p95_ns: i64,
    pub max_ns: i64,
}

impl Session {
    /// 开始采集 `topics` 到 `path` (覆盖已有文件). 清单里现在没有发布端的话题, 一上线即订上.
    /// 返回后在后台持续采集, 直到 [`Collector::stop`].
    pub async fn collect(
        &self,
        path: impl AsRef<Path>,
        topics: &[&str],
        options: CollectOptions,
    ) -> Result<Collector, CollectError> {
        let path = path.as_ref().to_path_buf();
        let file = File::create(&path).map_err(|source| CollectError::Create { path: path.display().to_string(), source })?;
        let compression = match options.compression {
            Compression::None => None,
            Compression::Zstd => Some(mcap::Compression::Zstd),
            Compression::Lz4 => Some(mcap::Compression::Lz4),
        };
        let writer = mcap::WriteOptions::new()
            .profile("ros2")
            .library(concat!("rosz ", env!("CARGO_PKG_VERSION")))
            .compression(compression)
            .chunk_size(Some(options.chunk_size))
            .create(BufWriter::new(file))?;

        let shared = Arc::new(Shared::default());
        let (tx, rx) = mpsc::channel();
        let registry = self.registry().clone();
        let writer = {
            let (shared, registry) = (shared.clone(), registry.clone());
            thread::Builder::new()
                .name("rosz-collect-writer".into())
                .spawn(move || write_loop(writer, rx, &shared, &registry))
                .map_err(|source| CollectError::Create { path: path.display().to_string(), source })?
        };
        let (stop, stop_rx) = watch::channel(false);
        let wanted = topics.iter().map(|t| format!("/{}", t.trim_matches('/'))).collect();
        let discovery = Discovery { transport: self.transport().clone(), registry, wanted, shared: shared.clone(), tx };
        let discovery = tokio::spawn(discovery.run(stop_rx));
        Ok(Collector { path, shared, stop: Some(stop), discovery: Some(discovery), writer: Some(writer) })
    }
}

/// 进行中的采集. [`Collector::stop`] 写完队列并封口; 未 stop 就 drop 也会在后台停止并封口.
pub struct Collector {
    path: PathBuf,
    shared: Arc<Shared>,
    stop: Option<watch::Sender<bool>>,
    discovery: Option<tokio::task::JoinHandle<()>>,
    writer: Option<thread::JoinHandle<Result<(), CollectError>>>,
}

impl Collector {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 当前统计.
    pub fn stats(&self) -> CollectStats {
        self.shared.stats()
    }

    /// 停止订阅, 写完已收到的消息并封口, 返回最终统计.
    pub async fn stop(mut self) -> Result<CollectStats, CollectError> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(true);
        }
        if let Some(discovery) = self.discovery.take() {
            let _ = discovery.await;
        }
        let writer = self.writer.take();
        match tokio::task::spawn_blocking(move || writer.map(|w| w.join())).await {
            Ok(None) => {}
            Ok(Some(Ok(result))) => result?,
            _ => return Err(CollectError::WriterPanicked),
        }
        Ok(self.stats())
    }
}

/// 回调线程, 写盘线程, 发现任务共享的统计.
#[derive(Default)]
struct Shared {
    topics: Mutex<BTreeMap<String, Arc<TopicState>>>,
    queue_depth: AtomicUsize,
    written: AtomicU64,
    /// 0 为还没写过
    last_write_time_ns: AtomicI64,
    errors: Mutex<Vec<String>>,
}

impl Shared {
    fn note_error(&self, error: String) {
        let mut errors = self.errors.lock().unwrap_or_else(|e| e.into_inner());
        if errors.len() < MAX_ERRORS {
            errors.push(error);
        }
    }

    fn stats(&self) -> CollectStats {
        let topics = self.topics.lock().unwrap_or_else(|e| e.into_inner());
        let last_write = self.last_write_time_ns.load(Ordering::Relaxed);
        CollectStats {
            topics: topics.iter().map(|(name, state)| (name.clone(), state.stats())).collect(),
            written: self.written.load(Ordering::Relaxed),
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            last_write_time_ns: (last_write != 0).then_some(last_write),
            errors: self.errors.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }
}

/// 一个已订上的话题.
struct TopicState {
    name: String,
    type_name: String,
    /// 有定义且 hash 一致: 才取 Header.stamp
    decodable: bool,
    counters: Mutex<Counters>,
    written: AtomicU64,
}

/// 到达统计, 只在回调里改.
#[derive(Default)]
struct Counters {
    received: u64,
    gaps: u64,
    publisher_restarts: u64,
    last_receive_time_ns: Option<i64>,
    last_header_stamp_ns: Option<i64>,
    last_sequence_by_gid: HashMap<[u8; 16], i64>,
    latencies_ns: Vec<i64>,
}

impl TopicState {
    fn on_arrival(&self, sample: &RawSample, registry: &Registry) {
        let stamp = if self.decodable { registry.header_stamp(&self.type_name, &sample.payload) } else { None };
        let mut c = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        c.received += 1;
        c.last_receive_time_ns = Some(sample.receive_time_ns);
        if stamp.is_some() {
            c.last_header_stamp_ns = stamp;
        }
        let Some(attachment) = sample.attachment else { return };
        c.latencies_ns.push(sample.receive_time_ns - attachment.source_time_ns);
        let known = !c.last_sequence_by_gid.is_empty();
        match c.last_sequence_by_gid.insert(attachment.gid, attachment.sequence) {
            None if known => c.publisher_restarts += 1,
            None => {}
            Some(last) if attachment.sequence <= last => c.publisher_restarts += 1,
            Some(last) => c.gaps += (attachment.sequence - last - 1) as u64,
        }
    }

    fn stats(&self) -> TopicStats {
        let c = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        let latency = (!c.latencies_ns.is_empty()).then(|| {
            let mut sorted = c.latencies_ns.clone();
            sorted.sort_unstable();
            // 最近秩: 第 round((n-1)p) 个
            let at = |p: f64| sorted[((sorted.len() - 1) as f64 * p).round() as usize];
            LatencyStats { p50_ns: at(0.5), p95_ns: at(0.95), max_ns: *sorted.last().unwrap() }
        });
        TopicStats {
            type_name: self.type_name.clone(),
            received: c.received,
            written: self.written.load(Ordering::Relaxed),
            gaps: c.gaps,
            publisher_restarts: c.publisher_restarts,
            last_receive_time_ns: c.last_receive_time_ns,
            last_header_stamp_ns: c.last_header_stamp_ns,
            latency,
        }
    }
}

/// 写盘队列里的一项.
enum Item {
    Sample(Arc<TopicState>, RawSample),
    /// 订阅都已撤掉
    End,
}

/// 写盘线程: 写到 [`Item::End`], 再取完在途的, 封口.
fn write_loop(
    mut writer: mcap::Writer<BufWriter<File>>,
    rx: mpsc::Receiver<Item>,
    shared: &Shared,
    registry: &Registry,
) -> Result<(), CollectError> {
    let mut channels: HashMap<String, u16> = HashMap::new();
    let mut write = |topic: Arc<TopicState>, sample: RawSample| {
        shared.queue_depth.fetch_sub(1, Ordering::Relaxed);
        if let Err(error) = write_one(&mut writer, &mut channels, &topic, &sample, shared, registry) {
            shared.note_error(format!("{} 写盘失败, 跳过该条: {error}", topic.name));
        }
    };
    // 发送端全没了 (发现任务异常退出) 也按结束处理
    while let Ok(Item::Sample(topic, sample)) = rx.recv() {
        write(topic, sample);
    }
    while let Ok(item) = rx.try_recv() {
        if let Item::Sample(topic, sample) = item {
            write(topic, sample);
        }
    }
    writer.finish()?;
    Ok(())
}

fn write_one(
    writer: &mut mcap::Writer<BufWriter<File>>,
    channels: &mut HashMap<String, u16>,
    topic: &TopicState,
    sample: &RawSample,
    shared: &Shared,
    registry: &Registry,
) -> Result<(), mcap::McapError> {
    let channel_id = match channels.get(&topic.name) {
        Some(id) => *id,
        None => {
            // 注册表没有该类型: schema 留空照写 (同原录制器)
            let schema = registry.ros2msg_schema(&topic.type_name).unwrap_or_else(|error| {
                shared.note_error(format!("{} schema 留空: {error}", topic.name));
                String::new()
            });
            let schema_id = writer.add_schema(&topic.type_name, "ros2msg", schema.as_bytes())?;
            let id = writer.add_channel(schema_id, &topic.name, "cdr", &BTreeMap::new())?;
            channels.insert(topic.name.clone(), id);
            id
        }
    };
    // 不是 rmw_zenoh 发布端格式也照写: 序号记 0, 源时间戳退回接收时刻
    let (sequence, publish_time) = match sample.attachment {
        Some(a) => (a.sequence as u32, a.source_time_ns),
        None => (0, sample.receive_time_ns),
    };
    let header = mcap::records::MessageHeader {
        channel_id,
        sequence,
        log_time: sample.receive_time_ns as u64,
        publish_time: publish_time as u64,
    };
    writer.write_to_known_channel(&header, &sample.payload)?;
    topic.written.fetch_add(1, Ordering::Relaxed);
    shared.written.fetch_add(1, Ordering::Relaxed);
    shared.last_write_time_ns.store(crate::now_ns(), Ordering::Relaxed);
    Ok(())
}

/// 发现任务: 按图变化订阅清单内新上线的话题; 停止时撤掉全部订阅, 再通知写盘线程收尾.
struct Discovery {
    transport: Transport,
    registry: Arc<Registry>,
    wanted: HashSet<String>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<Item>,
}

impl Discovery {
    async fn run(self, mut stop: watch::Receiver<bool>) {
        let changed = self.transport.graph_changed();
        let mut subscribers: HashMap<String, RawSubscriber> = HashMap::new();
        loop {
            let notified = changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            for (topic, publisher) in self.pending(&subscribers) {
                match self.subscribe(&topic, &publisher).await {
                    Ok(subscriber) => {
                        subscribers.insert(topic, subscriber);
                    }
                    Err(error) => self.shared.note_error(format!("订阅 {topic} 失败, 稍后重试: {error}")),
                }
            }
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep(RESCAN_INTERVAL) => {}
                // 停止, 或 Collector 已 drop
                _ = stop.changed() => break,
            }
        }
        // 撤订阅 (同步等 zenoh 撤销) 之后不再有新回调
        let _ = tokio::task::spawn_blocking(move || drop(subscribers)).await;
        let _ = self.tx.send(Item::End);
    }

    /// 清单内有发布端但还没订上的话题, 每话题一个代表发布端 (有 transient_local 的取它: 订阅时取得到历史).
    fn pending(&self, subscribed: &HashMap<String, RawSubscriber>) -> Vec<(String, Endpoint)> {
        let mut found: HashMap<String, Endpoint> = HashMap::new();
        for publisher in self.transport.publishers() {
            if !self.wanted.contains(&publisher.topic) || subscribed.contains_key(&publisher.topic) {
                continue;
            }
            let entry = found.entry(publisher.topic.clone()).or_insert_with(|| publisher.clone());
            if publisher.qos.transient_local && !entry.qos.transient_local {
                *entry = publisher;
            }
        }
        found.into_iter().collect()
    }

    async fn subscribe(&self, topic: &str, publisher: &Endpoint) -> Result<RawSubscriber, zenoh::Error> {
        let type_name = publisher.ros_type();
        let state = Arc::new(TopicState {
            name: topic.into(),
            decodable: self.registry.check(&type_name, Some(&publisher.type_hash)).is_ok(),
            type_name,
            counters: Mutex::default(),
            written: AtomicU64::new(0),
        });
        let qos = Qos { transient_local: publisher.qos.transient_local, depth: Some(COLLECT_DEPTH), ..Qos::default() };
        let (tx, registry, shared) = (self.tx.clone(), self.registry.clone(), self.shared.clone());
        let on_sample = {
            let state = state.clone();
            move |sample: RawSample| {
                state.on_arrival(&sample, &registry);
                shared.queue_depth.fetch_add(1, Ordering::Relaxed);
                if tx.send(Item::Sample(state.clone(), sample)).is_err() {
                    shared.queue_depth.fetch_sub(1, Ordering::Relaxed);
                }
            }
        };
        // 先登记: transient_local 历史在订阅建立期间就会到
        self.shared.topics.lock().unwrap_or_else(|e| e.into_inner()).insert(topic.into(), state);
        let result = self.transport.subscribe(publisher, qos, on_sample).await;
        if result.is_err() {
            self.shared.topics.lock().unwrap_or_else(|e| e.into_inner()).remove(topic);
        }
        result
    }
}
