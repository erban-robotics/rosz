use std::collections::HashMap;
use std::env;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc;
use zenoh::liveliness::LivelinessToken;
use zenoh::pubsub::Subscriber;
use zenoh::sample::SampleKind;
use zenoh_ext::{AdvancedSubscriber, AdvancedSubscriberBuilderExt, HistoryConfig};

use crate::wire::{self, PublisherToken};
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
    zenoh: zenoh::Session,
    registry: Arc<Registry>,
    domain: u32,
    zid: String,
    /// 发布端 token key -> 内容
    publishers: Arc<Mutex<HashMap<String, PublisherToken>>>,
    next_entity: AtomicU64,
    _node_token: LivelinessToken,
    _graph: Subscriber<()>,
}

impl Session {
    /// 同 [`connect`], 可指定 domain 与注册表 (如已追加自定义 `.msg` 目录).
    pub async fn open(router: Option<&str>, domain: Option<u32>, registry: Registry) -> Result<Session, Error> {
        let endpoint = resolve_router(router)?;
        let domain = domain.or_else(|| env::var("ROS_DOMAIN_ID").ok()?.parse().ok()).unwrap_or(0);
        let mut config = zenoh::Config::default();
        let set = |config: &mut zenoh::Config, key: &str, value: String| {
            config.insert_json5(key, &value).map_err(|e| Error::Connect { router: endpoint.clone(), source: e })
        };
        set(&mut config, "mode", "\"client\"".into())?;
        set(&mut config, "connect/endpoints", format!("[\"{endpoint}\"]"))?;
        set(&mut config, "scouting/multicast/enabled", "false".into())?;
        let zenoh = zenoh::open(config).await.map_err(|source| Error::Connect { router: endpoint.clone(), source })?;
        let zid = zenoh.zid().to_string();

        let publishers: Arc<Mutex<HashMap<String, PublisherToken>>> = Arc::default();
        let prefix = format!("{}/{domain}/**", wire::LIVELINESS_PREFIX);
        let graph = {
            let publishers = publishers.clone();
            zenoh
                .liveliness()
                .declare_subscriber(&prefix)
                .history(true)
                .callback(move |sample| {
                    let key = sample.key_expr().as_str();
                    let mut publishers = publishers.lock().unwrap();
                    match sample.kind() {
                        SampleKind::Put => {
                            if let Some(token) = wire::parse_publisher_token(key) {
                                publishers.insert(key.into(), token);
                            }
                        }
                        SampleKind::Delete => {
                            publishers.remove(key);
                        }
                    }
                })
                .await
                .map_err(Error::Zenoh)?
        };
        // 再查一次现存 token: 查询结束即首轮发现完成
        let replies = zenoh.liveliness().get(&prefix).await.map_err(Error::Zenoh)?;
        while let Ok(reply) = replies.recv_async().await {
            if let Ok(sample) = reply.result()
                && let Some(token) = wire::parse_publisher_token(sample.key_expr().as_str())
            {
                publishers.lock().unwrap().insert(sample.key_expr().to_string(), token);
            }
        }
        let node_token = zenoh.liveliness().declare_token(wire::node_token(domain, &zid)).await.map_err(Error::Zenoh)?;
        Ok(Session {
            inner: Arc::new(Inner {
                zenoh,
                registry: Arc::new(registry),
                domain,
                zid,
                publishers,
                next_entity: AtomicU64::new(1),
                _node_token: node_token,
                _graph: graph,
            }),
        })
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.inner.registry
    }

    /// 当前全部有发布端的话题, 按名字排序.
    pub fn topics(&self) -> Vec<TopicInfo> {
        self.topic_publishers().into_iter().map(|(info, _)| info).collect()
    }

    fn topic_publishers(&self) -> Vec<(TopicInfo, PublisherToken)> {
        let publishers = self.inner.publishers.lock().unwrap();
        let mut by_topic: HashMap<&str, (PublisherToken, usize)> = HashMap::new();
        for token in publishers.values() {
            by_topic.entry(&token.topic).or_insert_with(|| (token.clone(), 0)).1 += 1;
        }
        let mut out: Vec<_> = by_topic
            .into_values()
            .map(|(token, count)| {
                let type_name = wire::ros_type_name(&token.dds_type).unwrap_or_else(|| token.dds_type.clone());
                let info = TopicInfo {
                    name: token.topic.clone(),
                    decodability: self.inner.registry.check(&type_name, Some(&token.type_hash)),
                    type_name,
                    type_hash: token.type_hash.clone(),
                    transient_local: token.transient_local,
                    publishers: count,
                };
                (info, token)
            })
            .collect();
        out.sort_by(|a, b| a.0.name.cmp(&b.0.name));
        out
    }

    /// 话题不存在时的错误, 附最相近的候选.
    fn unknown(&self, topic: &str, known: &[(TopicInfo, PublisherToken)]) -> Error {
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
        for (info, token) in chosen {
            let keyexpr = wire::topic_keyexpr(self.inner.domain, &info.name, &token.dds_type, &token.type_hash);
            let (tx, registry, info) = (tx.clone(), self.inner.registry.clone(), Arc::new(info));
            let transient_local = info.transient_local;
            let callback = move |sample: zenoh::sample::Sample| {
                let attachment = sample.attachment().map(|a| a.to_bytes());
                let payload = sample.payload().to_bytes().into_owned();
                let _ = tx.try_send(Message::new(&info, payload, attachment.as_deref(), registry.clone()));
            };
            let builder = self.inner.zenoh.declare_subscriber(keyexpr).callback(callback);
            handles.push(if transient_local {
                // 发布端为 AdvancedPublisher + 缓存: 用 AdvancedSubscriber 先取历史
                Handle::Advanced(
                    builder.history(HistoryConfig::default().detect_late_publishers()).await.map_err(Error::Zenoh)?,
                )
            } else {
                Handle::Plain(builder.await.map_err(Error::Zenoh)?)
            });
            let entity = self.inner.next_entity.fetch_add(1, Ordering::Relaxed);
            let key = wire::subscription_token(self.inner.domain, &self.inner.zid, entity, &token);
            handles.push(Handle::Token(self.inner.zenoh.liveliness().declare_token(key).await.map_err(Error::Zenoh)?));
        }
        Ok(Subscription { rx, _handles: handles })
    }

    /// 取话题的下一条消息 (transient_local 话题为缓存里最新的历史); 超时为 None.
    pub async fn latest(&self, topic: &str, timeout: Duration) -> Result<Option<Message>, Error> {
        let mut subscription = self.subscribe(&[topic]).await?;
        Ok(tokio::time::timeout(timeout, subscription.recv_last()).await.ok().flatten())
    }
}

enum Handle {
    Plain(#[allow(dead_code)] Subscriber<()>),
    Advanced(#[allow(dead_code)] AdvancedSubscriber<()>),
    Token(#[allow(dead_code)] LivelinessToken),
}

/// 订阅流; drop 即退订.
pub struct Subscription {
    rx: mpsc::Receiver<Message>,
    _handles: Vec<Handle>,
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
