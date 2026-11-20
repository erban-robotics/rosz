//! rmw_zenoh 线协议 (与现场 rmw_zenoh_cpp 0.2.11 对齐): 数据 keyexpr, liveliness token, attachment.
//!
//! 出处: rmw_zenoh `docs/design.md`, 以及 erban-caring `pc/webapp/data_collector/recording/rmw_zenoh.py`.

pub const LIVELINESS_PREFIX: &str = "@ros2_lv";
/// 订阅端 token 的 QoS 编码: reliable, volatile, keep last 10, 其余默认
pub const DEFAULT_QOS: &str = "::,10:,:,:,,";
/// 同上, durability 为 transient_local
pub const TRANSIENT_LOCAL_QOS: &str = ":1:,10:,:,:,,";
pub const NODE_NAME: &str = "rosz";
const EMPTY_FIELD: &str = "%";
/// `@ros2_lv/domain/zid/nid/eid/kind/enclave/namespace/node/topic/type/hash/qos`
const ENDPOINT_TOKEN_FIELDS: usize = 13;
/// QoS 以 `:` 分段, 第 2 段为 durability; rmw 枚举 TRANSIENT_LOCAL = 1
const DURABILITY_INDEX: usize = 1;

/// 发布端 token 里的信息.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublisherToken {
    pub topic: String,
    pub dds_type: String,
    pub type_hash: String,
    pub transient_local: bool,
}

/// 解析发布端 token; 不是发布端 token 为 None.
pub fn parse_publisher_token(key: &str) -> Option<PublisherToken> {
    let fields: Vec<&str> = key.split('/').collect();
    if fields.len() != ENDPOINT_TOKEN_FIELDS || fields[0] != LIVELINESS_PREFIX || fields[5] != "MP" {
        return None;
    }
    Some(PublisherToken {
        topic: fields[9].replace('%', "/"),
        dds_type: fields[10].into(),
        type_hash: fields[11].into(),
        transient_local: fields[12].split(':').nth(DURABILITY_INDEX) == Some("1"),
    })
}

/// `sensor_msgs::msg::dds_::CompressedImage_` -> `sensor_msgs/msg/CompressedImage`
pub fn ros_type_name(dds_type: &str) -> Option<String> {
    let parts: Vec<&str> = dds_type.split("::").collect();
    match parts.as_slice() {
        [package, kind, "dds_", name] => Some(format!("{package}/{kind}/{}", name.strip_suffix('_').unwrap_or(name))),
        _ => None,
    }
}

/// 数据 keyexpr `<domain>/<话题去首尾 "/">/<dds 类型名>/<hash>`.
pub fn topic_keyexpr(domain: u32, topic: &str, dds_type: &str, type_hash: &str) -> String {
    format!("{domain}/{}/{dds_type}/{type_hash}", topic.trim_matches('/'))
}

pub fn node_token(domain: u32, zid: &str) -> String {
    format!("{LIVELINESS_PREFIX}/{domain}/{zid}/0/0/NN/%/%/{NODE_NAME}")
}

/// 订阅端 token. 按需发布的话题 (image_transport 等) 据此判断有无订阅者, 不声明收不到消息.
pub fn subscription_token(domain: u32, zid: &str, entity: u64, publisher: &PublisherToken) -> String {
    let qos = if publisher.transient_local { TRANSIENT_LOCAL_QOS } else { DEFAULT_QOS };
    let topic = if publisher.topic.is_empty() { EMPTY_FIELD.into() } else { publisher.topic.replace('/', "%") };
    format!(
        "{LIVELINESS_PREFIX}/{domain}/{zid}/0/{entity}/MS/%/%/{NODE_NAME}/{topic}/{}/{}/{qos}",
        publisher.dds_type, publisher.type_hash
    )
}

/// attachment: `i64 序号` + `i64 源时间戳 ns` + `u8 gid 长度` + gid, 小端. 返回源时间戳.
pub fn attachment_source_time(data: &[u8]) -> Option<i64> {
    let bytes: [u8; 8] = data.get(8..16)?.try_into().ok()?;
    let gid_len = *data.get(16)? as usize;
    (data.len() >= 17 + gid_len).then(|| i64::from_le_bytes(bytes))
}
