//! `.srv` 的零值应答 (服务端预填给 handler, 也是失败回执的底子). 服务 hash 对照 rosidl 见 golden.rs (hashes.json 含 .srv).

use std::sync::Arc;

use rosz_decode::{Registry, Value};

fn message(fields: Vec<(&str, Value<'static>)>) -> Value<'static> {
    Value::Message(fields.into_iter().map(|(k, v)| (Arc::from(k), v)).collect())
}

/// 零值同 rclpy 无默认值时的字段初值: 数值 0, bool false, 字符串空, 不定长数组空, 定长数组 N 个零值, 嵌套消息逐字段零值.
#[test]
fn zero_value_of_service_response() {
    let registry = Registry::builtin();
    let zero = registry.zero_value("sensor_msgs/srv/SetCameraInfo_Response").unwrap();
    let camera = registry.zero_value("sensor_msgs/msg/CameraInfo").unwrap();
    assert_eq!(
        (zero, camera.get("k").cloned(), camera.get("d").cloned(), camera.get("roi").and_then(|r| r.get("do_rectify")).cloned()),
        (
            message(vec![("success", Value::Bool(false)), ("status_message", Value::String(String::new()))]),
            Some(Value::F64s(vec![0.0; 9])),
            Some(Value::F64s(vec![])),
            Some(Value::Bool(false)),
        )
    );
}
