//! 查看器后端协议: `foxglove.websocket.v1` 的所需子集.
//!
//! - 服务端文本帧: `serverInfo` (连接时, `metadata.startTime` 为后端时钟的会话零点纳秒), `advertise` (连接时全部通道,
//!   之后话题上线增量), `unadvertise` (话题下线), `status` (订阅失败等)
//! - 客户端文本帧: `subscribe` / `unsubscribe`
//! - 服务端二进制帧 (MessageData): `u8 0x01` + `u32 订阅号` + `u64 后端 PC 时钟接收时间纳秒` + 原始 CDR (含 4 字节封装头), 小端.
//!   后端不解码
//!
//! 通道声明在 foxglove 字段 (`id` `topic` `encoding` `schemaName` `schema` `schemaEncoding`) 之外附 `typeHash` (RIHS01),
//! `undecodable` (解不了的原因, 能解为 null), `transientLocal`; 第三方客户端忽略这些键.
//! 丢帧通知为 `status` 帧附 `subscriptionId` 与 `dropped` (本次告知的条数), 见 [`crate::outbox`].

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message as WsMessage, Utf8Bytes, WebSocket};
use rosz_access::{Registry, Session, TopicInfo};
use rosz_decode::msg::BaseType;
use serde_json::{Value as Json, json};
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

use crate::outbox::{Outbox, Outgoing};

pub const SUBPROTOCOL: &str = "foxglove.websocket.v1";
/// 话题发现的刷新间隔: 按此轮询 liveliness 汇总, 与上次比出上下线增量
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(1);
const MESSAGE_DATA_OPCODE: u8 = 0x01;
/// ros2msg 多定义拼接的分隔行 (同 ros2 bag / foxglove)
const SCHEMA_SEPARATOR: &str = "================================================================================";

/// 通道目录的一次变化, 广播给各连接
#[derive(Clone)]
enum CatalogEvent {
    Advertise(Utf8Bytes),
    Unadvertise(Utf8Bytes),
}

struct Channel {
    id: u32,
    topic: String,
    type_name: String,
    json: Json,
}

#[derive(Default)]
struct Catalog {
    /// (话题, 类型, hash) -> 通道
    channels: HashMap<(String, String, String), Channel>,
    next_id: u32,
}

/// 各连接共享的后端状态: router 会话, 通道目录, 在线连接数.
pub struct Hub {
    session: Session,
    catalog: Mutex<Catalog>,
    events: broadcast::Sender<CatalogEvent>,
    connections: watch::Sender<usize>,
}

impl Hub {
    pub fn new(session: Session) -> Arc<Hub> {
        let hub = Arc::new(Hub {
            session,
            catalog: Mutex::default(),
            events: broadcast::channel(64).0,
            connections: watch::Sender::new(0),
        });
        hub.refresh();
        hub
    }

    /// 在线 WebSocket 连接数, 退出判定用
    pub fn connections(&self) -> watch::Receiver<usize> {
        self.connections.subscribe()
    }

    /// 定时刷新话题目录, 直到进程退出.
    pub async fn discover(self: Arc<Self>) {
        let mut ticker = tokio::time::interval(DISCOVERY_INTERVAL);
        loop {
            ticker.tick().await;
            self.refresh();
        }
    }

    /// 与上次的话题集合比, 新的分配通道号并广播 `advertise`, 没了的广播 `unadvertise`. 持锁广播, 与新连接取快照不交错.
    fn refresh(&self) {
        let topics = self.session.topics();
        let registry = self.session.registry();
        let mut catalog = self.catalog.lock().unwrap();
        let current: HashSet<_> = topics.iter().map(key_of).collect();
        let removed: Vec<u32> = catalog.channels.iter().filter(|(k, _)| !current.contains(*k)).map(|(_, c)| c.id).collect();
        catalog.channels.retain(|k, _| current.contains(k));
        let mut added = Vec::new();
        for topic in &topics {
            let key = key_of(topic);
            if catalog.channels.contains_key(&key) {
                continue;
            }
            catalog.next_id += 1;
            let id = catalog.next_id;
            let json = channel_json(id, topic, registry);
            added.push(json.clone());
            catalog.channels.insert(key, Channel { id, topic: topic.name.clone(), type_name: topic.type_name.clone(), json });
        }
        if !removed.is_empty() {
            let _ = self.events.send(CatalogEvent::Unadvertise(text(&json!({"op": "unadvertise", "channelIds": removed}))));
        }
        if !added.is_empty() {
            let _ = self.events.send(CatalogEvent::Advertise(text(&json!({"op": "advertise", "channels": added}))));
        }
    }

    /// 一个 WebSocket 连接: 先发 serverInfo 与全部通道, 再处理订阅退订, 转发数据帧与目录增量.
    pub async fn serve(self: Arc<Self>, mut socket: WebSocket) {
        self.connections.send_modify(|n| *n += 1);
        let (mut events, hello) = {
            let catalog = self.catalog.lock().unwrap();
            // 按话题名排, 前端目录 (与面板里各路的先后) 每次一致
            let mut channels: Vec<&Channel> = catalog.channels.values().collect();
            channels.sort_by(|a, b| a.topic.cmp(&b.topic));
            let channels: Vec<&Json> = channels.into_iter().map(|c| &c.json).collect();
            (self.events.subscribe(), json!({"op": "advertise", "channels": channels}))
        };
        let info = json!({
            "op": "serverInfo",
            "name": "rosz view",
            "capabilities": [],
            "supportedEncodings": [],
            "metadata": {"startTime": rosz_now_ns().to_string()},
        });
        let outbox = Arc::new(Outbox::default());
        let mut connection = Connection { hub: self.clone(), outbox: outbox.clone(), subscriptions: HashMap::new() };
        let mut ok = socket.send(WsMessage::Text(text(&info))).await.is_ok()
            && socket.send(WsMessage::Text(text(&hello))).await.is_ok();
        while ok {
            ok = tokio::select! {
                incoming = socket.recv() => match incoming {
                    Some(Ok(WsMessage::Text(body))) => {
                        let reply = connection.handle(&body).await;
                        match reply {
                            Some(status) => socket.send(WsMessage::Text(text(&status))).await.is_ok(),
                            None => true,
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => false,
                    Some(Ok(_)) => true,
                },
                event = events.recv() => match event {
                    Ok(CatalogEvent::Advertise(body) | CatalogEvent::Unadvertise(body)) => {
                        socket.send(WsMessage::Text(body)).await.is_ok()
                    }
                    // 落后太多丢了增量: 断开, 前端重连后拿全量
                    Err(_) => false,
                },
                outgoing = outbox.next() => match outgoing {
                    Outgoing::Dropped(status) => socket.send(WsMessage::Text(text(&status))).await.is_ok(),
                    Outgoing::Frame(frame) => {
                        let ok = socket.send(WsMessage::Binary(frame.into())).await.is_ok();
                        outbox.sent();
                        ok
                    }
                },
            };
        }
        drop(connection);
        self.connections.send_modify(|n| *n -= 1);
    }
}

/// 一个连接上的订阅: 订阅号 -> 转发任务 (任务持有 rosz 订阅, 取消即退订), 各订阅的发送队列在 `outbox`
struct Connection {
    hub: Arc<Hub>,
    outbox: Arc<Outbox>,
    subscriptions: HashMap<u32, JoinHandle<()>>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        for task in self.subscriptions.values() {
            task.abort();
        }
    }
}

impl Connection {
    /// 处理一条客户端控制帧; 需要告知客户端时返回 status 帧.
    async fn handle(&mut self, body: &str) -> Option<Json> {
        let request: Json = serde_json::from_str(body).ok()?;
        match request["op"].as_str()? {
            "subscribe" => {
                let mut failures = Vec::new();
                for item in request["subscriptions"].as_array()? {
                    let (Some(id), Some(channel)) = (as_u32(&item["id"]), as_u32(&item["channelId"])) else { continue };
                    if let Err(message) = self.subscribe(id, channel).await {
                        failures.push(message);
                    }
                }
                (!failures.is_empty()).then(|| status(2, &failures.join("; ")))
            }
            "unsubscribe" => {
                for id in request["subscriptionIds"].as_array()?.iter().filter_map(as_u32) {
                    if let Some(task) = self.subscriptions.remove(&id) {
                        task.abort();
                    }
                    self.outbox.close(id);
                }
                None
            }
            _ => None,
        }
    }

    async fn subscribe(&mut self, id: u32, channel: u32) -> Result<(), String> {
        let (topic, type_name) = {
            let catalog = self.hub.catalog.lock().unwrap();
            catalog.channels.values().find(|c| c.id == channel).map(|c| (c.topic.clone(), c.type_name.clone()))
        }
        .ok_or_else(|| format!("没有通道 {channel}"))?;
        let mut subscription = self.hub.session.subscribe(&[&topic]).await.map_err(|e| e.to_string())?;
        if let Some(previous) = self.subscriptions.remove(&id) {
            previous.abort();
        }
        self.outbox.open(id, &topic, &type_name);
        let outbox = self.outbox.clone();
        let task = tokio::spawn(async move {
            while let Some(message) = subscription.recv().await {
                let mut frame = Vec::with_capacity(13 + message.payload.len());
                frame.push(MESSAGE_DATA_OPCODE);
                frame.extend_from_slice(&id.to_le_bytes());
                frame.extend_from_slice(&(message.receive_time_ns as u64).to_le_bytes());
                frame.extend_from_slice(&message.payload);
                outbox.push(id, message.receive_time_ns, frame);
            }
        });
        self.subscriptions.insert(id, task);
        Ok(())
    }
}

fn key_of(topic: &TopicInfo) -> (String, String, String) {
    (topic.name.clone(), topic.type_name.clone(), topic.type_hash.clone())
}

fn channel_json(id: u32, topic: &TopicInfo, registry: &Registry) -> Json {
    let undecodable = topic.decodability.reason();
    json!({
        "id": id,
        "topic": topic.name,
        "encoding": "cdr",
        "schemaName": topic.type_name,
        "schema": if undecodable.is_none() { ros2msg_schema(registry, &topic.type_name) } else { String::new() },
        "schemaEncoding": "ros2msg",
        "typeHash": topic.type_hash,
        "undecodable": undecodable,
        "transientLocal": topic.transient_local,
    })
}

/// ros2msg schema: 本类型 `.msg` 文本, 其后接全部嵌套类型各一次 (`===` 分隔行 + `MSG: 包/msg/类型` + 文本).
fn ros2msg_schema(registry: &Registry, type_name: &str) -> String {
    let Some(root) = registry.get(type_name) else { return String::new() };
    let mut out = root.text.clone();
    let mut seen = HashSet::from([root.name.clone()]);
    let mut pending = vec![root];
    while let Some(def) = pending.pop() {
        for field in &def.fields {
            let BaseType::Message(nested) = &field.ty.base else { continue };
            if !seen.insert(nested.clone()) {
                continue;
            }
            if let Some(nested) = registry.get(nested) {
                out.push_str(&format!("\n{SCHEMA_SEPARATOR}\nMSG: {}\n{}", nested.name, nested.text));
                pending.push(nested);
            }
        }
    }
    out
}

fn status(level: u8, message: &str) -> Json {
    json!({"op": "status", "level": level, "message": message})
}

fn text(value: &Json) -> Utf8Bytes {
    value.to_string().into()
}

fn as_u32(value: &Json) -> Option<u32> {
    value.as_u64()?.try_into().ok()
}

fn rosz_now_ns() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i64)
}
