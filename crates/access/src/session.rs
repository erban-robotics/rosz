use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::transport::{Endpoint, Qos, RawSubscriber, Transport};
use crate::{Error, Message, ROUTER_ENV, Registry, TopicInfo, candidates};

const DEFAULT_ROUTER_PORT: u16 = 7447;
/// 每个订阅的待取队列; 满了丢新到的 (消费方太慢时不无限占内存)
const SUBSCRIPTION_QUEUE: usize = 256;

/// router 地址: 参数优先, 其次环境变量 `ROSZ_ROUTER`, 都没有为 [`Error::NoRouter`].
/// 接受 `tcp/host:port`, `host:port`, `host` (端口默认 7447).
pub fn resolve_router(router: Option<&str>) -> Result<String, Error> {
    let from_env = env::var(ROUTER_ENV).ok();
    let raw = router.or(from_env.as_deref()).map(str::trim).filter(|s| !s.is_empty()).ok_or(Error::NoRouter)?;
    Ok(if raw.contains('/') {
        raw.into()
    } else if raw.contains(':') {
        format!("tcp/{raw}")
    } else {
        format!("tcp/{raw}:{DEFAULT_ROUTER_PORT}")
    })
}

/// 以 client 连 router 并完成首轮话题发现. 用内置 `.msg`, ROS domain 取 `ROS_DOMAIN_ID` (默认 0).
pub async fn connect(router: Option<&str>) -> Result<Session, Error> {
    Session::open(router, None, Registry::builtin()).await
}

/// 一个到 router 的连接. 克隆共享同一连接.
#[derive(Clone)]
pub struct Session {
    inner: Arc<Inner>,
}

struct Inner {
    transport: Transport,
    registry: Arc<Registry>,
}

impl Session {
    /// 同 [`connect`], 可指定 domain 与注册表 (如已追加自定义 `.msg` 目录).
    pub async fn open(router: Option<&str>, domain: Option<u32>, registry: Registry) -> Result<Session, Error> {
        let endpoint = resolve_router(router)?;
        let domain = domain.or_else(|| env::var("ROS_DOMAIN_ID").ok()?.parse().ok()).unwrap_or(0);
        let transport = Transport::open(endpoint.clone(), domain)
            .await
            .map_err(|source| Error::Connect { router: endpoint, source })?;
        Ok(Session { inner: Arc::new(Inner { transport, registry: Arc::new(registry) }) })
    }

    pub(crate) fn transport(&self) -> &Transport {
        &self.inner.transport
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.inner.registry
    }

    /// 当前全部有发布端的话题, 按名字排序.
    pub fn topics(&self) -> Vec<TopicInfo> {
        self.topic_publishers().into_iter().map(|(info, _)| info).collect()
    }

    /// 每话题一个代表发布端与汇总信息.
    fn topic_publishers(&self) -> Vec<(TopicInfo, Endpoint)> {
        let mut by_topic: HashMap<String, (Endpoint, usize)> = HashMap::new();
        for publisher in self.inner.transport.publishers() {
            let entry = by_topic.entry(publisher.topic.clone()).or_insert_with(|| (publisher.clone(), 0));
            entry.1 += 1;
            // 发布端 durability 不一时以 transient_local 的为代表: 订阅时取得到它缓存的历史, 话题也标静态
            if publisher.qos.transient_local && !entry.0.qos.transient_local {
                entry.0 = publisher;
            }
        }
        let mut out: Vec<_> = by_topic
            .into_values()
            .map(|(publisher, count)| {
                let type_name = publisher.ros_type();
                let info = TopicInfo {
                    name: publisher.topic.clone(),
                    decodability: self.inner.registry.check(&type_name, Some(&publisher.type_hash)),
                    type_name,
                    type_hash: publisher.type_hash.clone(),
                    transient_local: publisher.qos.transient_local,
                    publishers: count,
                };
                (info, publisher)
            })
            .collect();
        out.sort_by(|a, b| a.0.name.cmp(&b.0.name));
        out
    }

    /// 话题不存在时的错误, 附最相近的候选.
    fn unknown(&self, topic: &str, known: &[(TopicInfo, Endpoint)]) -> Error {
        let candidates = candidates(topic, known.iter().map(|(t, _)| t.name.as_str()));
        Error::UnknownTopic { topic: topic.into(), candidates }
    }

    /// 订阅若干话题, 同时声明订阅端 token (按需发布的话题因此开始发布).
    pub async fn subscribe(&self, topics: &[&str]) -> Result<Subscription, Error> {
        let known = self.topic_publishers();
        let mut chosen = Vec::new();
        for topic in topics {
            let normalized = format!("/{}", topic.trim_matches('/'));
            let found = known.iter().find(|(t, _)| t.name == normalized).ok_or_else(|| self.unknown(topic, &known))?;
            chosen.push(found.clone());
        }
        let (tx, rx) = mpsc::channel(SUBSCRIPTION_QUEUE);
        let mut handles = Vec::new();
        for (info, publisher) in chosen {
            // transient_local 话题按代表发布端的深度取全它缓存的历史
            let qos = if info.transient_local {
                Qos { transient_local: true, depth: publisher.qos.depth, ..Qos::default() }
            } else {
                Qos::default()
            };
            let (tx, registry, info) = (tx.clone(), self.inner.registry.clone(), Arc::new(info));
            let on_sample = move |sample| {
                let _ = tx.try_send(Message::new(&info, sample, registry.clone()));
            };
            handles.push(self.inner.transport.subscribe(&publisher, qos, on_sample).await.map_err(Error::Zenoh)?);
        }
        Ok(Subscription { rx, _handles: handles })
    }

    /// 取话题的下一条消息 (transient_local 话题为缓存里最新的历史); 超时为 None.
    pub async fn latest(&self, topic: &str, timeout: Duration) -> Result<Option<Message>, Error> {
        let mut subscription = self.subscribe(&[topic]).await?;
        Ok(tokio::time::timeout(timeout, subscription.recv_last()).await.ok().flatten())
    }
}

/// 订阅流; drop 即退订.
pub struct Subscription {
    rx: mpsc::Receiver<Message>,
    _handles: Vec<RawSubscriber>,
}

impl Subscription {
    /// 下一条消息; 连接关闭为 None.
    pub async fn recv(&mut self) -> Option<Message> {
        self.rx.recv().await
    }

    /// 等到至少一条, 再取走队列里已到的 (如一批历史), 返回最后一条.
    async fn recv_last(&mut self) -> Option<Message> {
        let mut last = self.rx.recv().await?;
        while let Ok(message) = self.rx.try_recv() {
            last = message;
        }
        Some(last)
    }
}
