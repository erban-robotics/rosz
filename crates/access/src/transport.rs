//! 传输底座: rmw_zenoh 线协议全部交给 hiroz (keyexpr, liveliness token, attachment, transient_local 取历史).
//!
//! 本模块只按 "话题名 + DDS 类型名 + 类型 hash" 处理原始 CDR 字节, 不碰消息定义; 解码在上层.
//! 订阅, 采集, 发布, 服务共用这一层: 一个 [`Transport`] 即一个 zenoh 会话 (client 模式连 router) 上的一个 ROS 节点.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock};

use hiroz::Builder as _;
use hiroz::attachment::Attachment;
use hiroz::context::{ZContext, ZContextBuilder};
use hiroz::entity::{EndpointKind, Entity, TypeHash, TypeInfo};
use hiroz::msg::ZMessage;
use hiroz::node::ZNode;
use hiroz::pubsub::ZSub;
use hiroz::qos::{QosDurability, QosHistory, QosProfile, QosReliability};
use hiroz::queue::BoundedQueue;
use hiroz_protocol::qos as wire_qos;
use zenoh::sample::Sample;

use crate::now_ns;

/// 本进程在 ROS 图里的节点名
pub(crate) const NODE_NAME: &str = "rosz";
/// 订阅端 keep_last 默认深度 (同 rclpy 默认)
const DEFAULT_DEPTH: usize = 10;

/// 端点 QoS 里 rosz 关心的部分.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Qos {
    pub reliable: bool,
    pub transient_local: bool,
    /// keep_last 深度; None 为 keep_all
    pub depth: Option<usize>,
}

impl Default for Qos {
    /// reliable, volatile, keep_last(10)
    fn default() -> Self {
        Qos { reliable: true, transient_local: false, depth: Some(DEFAULT_DEPTH) }
    }
}

impl Qos {
    fn from_wire(qos: &wire_qos::QosProfile) -> Self {
        Qos {
            reliable: qos.reliability == wire_qos::QosReliability::Reliable,
            transient_local: qos.durability == wire_qos::QosDurability::TransientLocal,
            depth: match qos.history {
                wire_qos::QosHistory::KeepLast(depth) => Some(depth),
                wire_qos::QosHistory::KeepAll => None,
            },
        }
    }

    fn to_hiroz(self) -> QosProfile {
        QosProfile {
            reliability: if self.reliable { QosReliability::Reliable } else { QosReliability::BestEffort },
            durability: if self.transient_local { QosDurability::TransientLocal } else { QosDurability::Volatile },
            history: match self.depth.and_then(NonZeroUsize::new) {
                Some(depth) => QosHistory::KeepLast(depth),
                None => QosHistory::KeepAll,
            },
            ..Default::default()
        }
    }
}

/// 图里的一个话题端点 (发布端或订阅端), 取自其 liveliness token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    /// 带首 `/` 的话题名
    pub topic: String,
    /// DDS 类型名, 如 `sensor_msgs::msg::dds_::Image_`
    pub dds_type: String,
    /// `RIHS01_...`
    pub type_hash: String,
    pub qos: Qos,
}

impl Endpoint {
    /// `sensor_msgs::msg::dds_::Image_` -> `sensor_msgs/msg/Image`; 不是 ROS 类型名原样返回.
    pub fn ros_type(&self) -> String {
        hiroz_schema::type_name::ros_from_dds_strict(&self.dds_type)
    }

    fn type_info(&self) -> TypeInfo {
        TypeInfo::new(&self.dds_type, TypeHash::from_rihs_string(&self.type_hash).unwrap_or(TypeHash::zero()))
    }
}

/// 收到的一条原始消息.
#[derive(Clone, Debug)]
pub(crate) struct RawSample {
    /// 含 4 字节封装头的 CDR
    pub payload: Vec<u8>,
    /// 本机收到时刻 (zenoh 回调线程里取), Unix 纳秒
    pub receive_time_ns: i64,
    /// 发布方 attachment; 非 rmw_zenoh 发布端可能没有
    pub attachment: Option<SampleAttachment>,
}

/// rmw_zenoh attachment 里的发布方信息.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SampleAttachment {
    /// 发布端自增序号
    pub sequence: i64,
    /// 发布方发出时刻, Unix 纳秒
    pub source_time_ns: i64,
}

/// 原始订阅 (按类型名 + hash, 不反序列化). drop 即退订 (撤 zenoh 订阅与 liveliness token).
pub(crate) struct RawSubscriber {
    _sub: ZSub<RawBytes, Sample, <RawBytes as ZMessage>::Serdes>,
}

/// 原始订阅的消息类型占位: 只走 hiroz 的 Sample 队列, 从不按它反序列化.
type RawBytes = Vec<u8>;

/// 一个 zenoh 会话上的 rosz 节点. 克隆共享.
#[derive(Clone)]
pub(crate) struct Transport {
    inner: Arc<Inner>,
}

struct Inner {
    // node 先于 context drop: 先撤节点 token 再关会话
    node: ZNode,
    _context: ZContext,
}

impl Transport {
    /// 以 client 模式连 router (`tcp/host:port`), 声明节点 token, 并完成首轮图发现.
    /// hiroz 的建立是同步阻塞的, 放到阻塞线程池里做.
    pub async fn open(endpoint: String, domain: u32) -> Result<Transport, zenoh::Error> {
        tokio::task::spawn_blocking(move || Self::open_blocking(&endpoint, domain)).await.map_err(|e| e.to_string())?
    }

    fn open_blocking(endpoint: &str, domain: u32) -> Result<Transport, zenoh::Error> {
        let mut config = zenoh::Config::default();
        config.insert_json5("mode", "\"client\"")?;
        config.insert_json5("connect/endpoints", &format!("[\"{endpoint}\"]"))?;
        config.insert_json5("scouting/multicast/enabled", "false")?;
        let context = ZContextBuilder::default().with_domain_id(domain as usize).with_zenoh_config(config).build()?;
        let node = context.create_node(NODE_NAME).without_parameters().build()?;
        Ok(Transport { inner: Arc::new(Inner { node, _context: context }) })
    }

    /// 当前图里全部话题发布端.
    pub fn publishers(&self) -> Vec<Endpoint> {
        let graph = self.inner.node.graph();
        graph
            .get_topic_names_and_types()
            .into_iter()
            .flat_map(|(topic, _)| graph.get_entities_by_topic(EndpointKind::Publisher, topic))
            .filter_map(|entity| match &*entity {
                Entity::Endpoint(endpoint) => {
                    let type_info = endpoint.type_info.as_ref()?;
                    Some(Endpoint {
                        topic: endpoint.topic.clone(),
                        dds_type: type_info.name.clone(),
                        type_hash: type_info.hash.to_rihs_string(),
                        qos: Qos::from_wire(&endpoint.qos),
                    })
                }
                Entity::Node(_) => None,
            })
            .collect()
    }

    /// 按发布端的话题, 类型名, hash 订阅原始字节, 并声明订阅端 token (按需发布的话题因此开始发布).
    /// `qos.transient_local` 时先取各发布端缓存的历史 (至多 `depth` 条).
    ///
    /// `on_sample` 在 zenoh 接收线程里按到达顺序逐条调用, 应尽快返回. hiroz 侧 Sample 队列 (容量为 `qos.depth`)
    /// 每到一条即在通知里取空, 不积压; 只有订阅建立完成前到达超过 `depth` 条 (多个发布端的历史) 时会丢最旧的.
    pub async fn subscribe(
        &self,
        publisher: &Endpoint,
        qos: Qos,
        on_sample: impl Fn(RawSample) + Send + Sync + 'static,
    ) -> Result<RawSubscriber, zenoh::Error> {
        let builder = self
            .inner
            .node
            .create_sub_impl::<RawBytes>(&publisher.topic, Some(publisher.type_info()))
            .with_qos(qos.to_hiroz())
            // rmw_zenoh_cpp 0.2.11 不认 CPU buffer group: 不入组, token 与线上一致
            .with_buffer_group(hiroz::BufferGroup::Off);
        tokio::task::spawn_blocking(move || {
            let queue: Arc<OnceLock<Arc<BoundedQueue<Sample>>>> = Arc::default();
            let drain = Arc::new(Drain { queue: queue.clone(), on_sample, order: Mutex::new(()) });
            let notify = {
                let drain = drain.clone();
                move || drain.run()
            };
            let sub = builder.build_with_notifier(notify)?;
            if let Some(q) = &sub.queue {
                let _ = queue.set(q.clone());
            }
            // 建立期间 (如 transient_local 历史) 已到的
            drain.run();
            Ok(RawSubscriber { _sub: sub })
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// 把 hiroz 订阅队列里已到的 Sample 依次交给回调.
struct Drain<F> {
    queue: Arc<OnceLock<Arc<BoundedQueue<Sample>>>>,
    on_sample: F,
    /// 多个 zenoh 线程同时通知时保持出队顺序即回调顺序
    order: Mutex<()>,
}

impl<F: Fn(RawSample)> Drain<F> {
    fn run(&self) {
        let Some(queue) = self.queue.get() else { return };
        let _order = self.order.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(sample) = queue.try_recv() {
            (self.on_sample)(RawSample {
                receive_time_ns: now_ns(),
                attachment: sample.attachment().and_then(|a| Attachment::try_from(a).ok()).map(|a| SampleAttachment {
                    sequence: a.sequence_number,
                    source_time_ns: a.source_timestamp,
                }),
                payload: sample.payload().to_bytes().into_owned(),
            });
        }
    }
}
