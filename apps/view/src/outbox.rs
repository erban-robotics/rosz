//! 一个 WebSocket 连接的发送背压: 每个订阅一个发送队列, 连接的发送循环从中取帧.
//!
//! - 大消息 (图像, 点云, 视频包, 见 [`is_large`]) 每路只留最新一条; 该路没有待发帧时, 连接待发字节 (各队列里的加正在发的)
//!   低于 [`LARGE_PENDING_LIMIT`] 才入队, 否则丢掉. 降帧是常态, 不通知
//! - 其余每路为约 [`SMALL_QUEUE_SPAN`] 的有界队列 (按接收时间, 另有条数上限); 满了丢最旧的, 累计条数在该路下一帧前以
//!   status 帧 (`dropped` 字段) 告知前端, 前端据此记一次不连续
//! - 发送次序: 先轮流发各路小消息, 再轮流发大消息, 图像不挡在小消息前面
//!
//! 转发任务往这里推不等待, rosz 订阅的接收队列 (rosz-access 里满丢新) 因此总被及时取走, 不会在那里丢.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;

use serde_json::{Value as Json, json};
use tokio::sync::Notify;

/// 只留最新一条的类型: 单条大, 晚到的旧帧没有用
const LARGE_TYPES: [&str; 4] = [
    "sensor_msgs/msg/CompressedImage",
    "sensor_msgs/msg/Image",
    "sensor_msgs/msg/PointCloud2",
    "foxglove_msgs/msg/CompressedVideo",
];
/// 连接待发字节达到这么多时新的大消息不入队 (约两帧 720p 原始彩色)
const LARGE_PENDING_LIMIT: usize = 4 << 20;
/// 小消息队列留的时长 (纳秒, 按接收时间): 超出即丢最旧的
const SMALL_QUEUE_SPAN: i64 = 1_000_000_000;
/// 小消息队列的条数上限 (时长之外的兜底, 防高频话题攒太多)
const SMALL_QUEUE_LIMIT: usize = 2000;

pub fn is_large(type_name: &str) -> bool {
    LARGE_TYPES.contains(&type_name)
}

/// 发送循环取出的下一项
pub enum Outgoing {
    /// 某路丢了帧的通知 (status 文本帧)
    Dropped(Json),
    /// 数据帧 (MessageData 二进制)
    Frame(Vec<u8>),
}

struct Queue {
    topic: String,
    large: bool,
    /// (接收时间纳秒, 帧)
    frames: VecDeque<(i64, Vec<u8>)>,
    dropped: u64,
}

#[derive(Default)]
struct State {
    /// 订阅号 -> 队列; 有序, 轮流取时次序稳定
    queues: BTreeMap<u32, Queue>,
    /// 各队列里待发的字节
    queued_bytes: usize,
    /// 正在发的帧的字节 (发完由 [`Outbox::sent`] 清零)
    in_flight: usize,
    /// 小消息与大消息各自上次取到的订阅号, 轮流取从它之后开始
    cursors: [u32; 2],
}

#[derive(Default)]
pub struct Outbox {
    state: Mutex<State>,
    ready: Notify,
}

impl Outbox {
    /// 新订阅 (或同一订阅号重订) 建一个空队列
    pub fn open(&self, subscription: u32, topic: &str, type_name: &str) {
        let mut state = self.state.lock().unwrap();
        let queue = Queue { topic: topic.into(), large: is_large(type_name), frames: VecDeque::new(), dropped: 0 };
        if let Some(previous) = state.queues.insert(subscription, queue) {
            state.queued_bytes -= previous.frames.iter().map(|(_, f)| f.len()).sum::<usize>();
        }
    }

    /// 退订: 丢掉该路待发的帧
    pub fn close(&self, subscription: u32) {
        let mut state = self.state.lock().unwrap();
        if let Some(queue) = state.queues.remove(&subscription) {
            state.queued_bytes -= queue.frames.iter().map(|(_, f)| f.len()).sum::<usize>();
        }
    }

    /// 转发任务推一帧; 不等待. 订阅已关掉的丢弃
    pub fn push(&self, subscription: u32, receive_time_ns: i64, frame: Vec<u8>) {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let pending = state.queued_bytes + state.in_flight;
        let Some(queue) = state.queues.get_mut(&subscription) else { return };
        let len = frame.len();
        if queue.large {
            match queue.frames.front_mut() {
                // 换成最新的, 待发字节只差两帧之差
                Some(old) => {
                    state.queued_bytes = state.queued_bytes - old.1.len() + len;
                    *old = (receive_time_ns, frame);
                }
                None if pending < LARGE_PENDING_LIMIT => {
                    state.queued_bytes += len;
                    queue.frames.push_back((receive_time_ns, frame));
                }
                None => return,
            }
        } else {
            queue.frames.push_back((receive_time_ns, frame));
            state.queued_bytes += len;
            while let Some((oldest, _)) = queue.frames.front()
                && (receive_time_ns - oldest > SMALL_QUEUE_SPAN || queue.frames.len() > SMALL_QUEUE_LIMIT)
            {
                let (_, old) = queue.frames.pop_front().unwrap();
                state.queued_bytes -= old.len();
                queue.dropped += 1;
            }
        }
        drop(guard);
        self.ready.notify_one();
    }

    /// 等下一项. 取出数据帧后须在发完时调 [`Outbox::sent`]. 可在 `select!` 里用: 只在等待处让出, 取出后不再让出
    pub async fn next(&self) -> Outgoing {
        loop {
            if let Some(item) = self.take() {
                return item;
            }
            self.ready.notified().await;
        }
    }

    /// 上一个数据帧发完了
    pub fn sent(&self) {
        self.state.lock().unwrap().in_flight = 0;
    }

    fn take(&self) -> Option<Outgoing> {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        // 先小后大; 同类里从上次那路之后轮流
        let (pick, large) = [false, true].into_iter().find_map(|large| {
            let cursor = state.cursors[large as usize];
            let ready = |(id, queue): (&u32, &Queue)| (queue.large == large && !queue.frames.is_empty()).then_some(*id);
            let pick = state.queues.range(cursor + 1..).find_map(ready).or_else(|| state.queues.range(..=cursor).find_map(ready));
            pick.map(|pick| (pick, large))
        })?;
        let queue = state.queues.get_mut(&pick).unwrap();
        if queue.dropped > 0 {
            let dropped = std::mem::take(&mut queue.dropped);
            return Some(Outgoing::Dropped(json!({
                "op": "status",
                "level": 1,
                "message": format!("{} 已丢 {dropped} 条 (前端处理不过来)", queue.topic),
                "subscriptionId": pick,
                "dropped": dropped,
            })));
        }
        let (_, frame) = queue.frames.pop_front().unwrap();
        state.queued_bytes -= frame.len();
        state.in_flight = frame.len();
        state.cursors[large as usize] = pick;
        Some(Outgoing::Frame(frame))
    }
}
