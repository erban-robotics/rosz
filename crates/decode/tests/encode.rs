//! 编码: 金样本反向回归 (解码再编码, 与 rclpy `serialize_message` 逐字节一致) 与字段校验拒收.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rosz_decode::{EncodeError, Registry, Value};
use serde_json::Value as Json;

fn messages() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../messages")
}

fn registry() -> Registry {
    let mut registry = Registry::builtin();
    registry.add_dir(messages().join("test")).unwrap();
    registry
}

/// 金样本 padding 未清零 (两种 rmw 都是, 内容各异), 且 `serialize_message` 的长度是 fastcdr 预估的序列化长度
/// (空的 8 字节元素序列, wstring 等处偏大, 尾部多出未写的字节); rosz 写实际长度 (同 rmw_zenoh_cpp 发布时上线的长度),
/// padding 写 0. 所以逐字节比对时: 实际写出的范围内, 除 rosz 写 0 的 padding 位置外须一致, 且两种 rmw 的样本都满足;
/// 再解码回来须与原值相同 (排除数据字节恰为 0 被当成 padding 放过).
#[test]
fn reencoding_golden_samples_matches_serialize_message() {
    let registry = registry();
    let text = fs::read_to_string(messages().join("golden/expected.json")).unwrap();
    let expected: serde_json::Map<String, Json> = serde_json::from_str(&text).unwrap();
    let mut wrong = Vec::new();
    for (case, sample) in &expected {
        let ty = sample["type"].as_str().unwrap();
        let bytes = fs::read(messages().join(format!("golden/rmw_fastrtps_cpp/{case}.cdr"))).unwrap();
        let value = registry.decode(ty, &bytes).unwrap();
        let encoded = registry.encode(ty, &value).unwrap();
        for rmw in ["rmw_fastrtps_cpp", "rmw_zenoh_cpp"] {
            let golden = fs::read(messages().join(format!("golden/{rmw}/{case}.cdr"))).unwrap();
            let same = encoded.len() <= golden.len()
                && encoded.iter().zip(&golden).all(|(a, b)| a == b || *a == 0)
                && registry.decode(ty, &encoded).as_ref() == Ok(&value);
            if !same {
                let diff = encoded.iter().zip(&golden).position(|(a, b)| a != b && *a != 0);
                wrong.push(format!("{rmw}/{case}: 长 {} / {}, 首个不同 {diff:?}", encoded.len(), golden.len()));
            }
        }
    }
    assert_eq!(wrong, Vec::<String>::new());
}

fn message(fields: Vec<(&str, Value<'static>)>) -> Value<'static> {
    Value::Message(fields.into_iter().map(|(k, v)| (Arc::from(k), v)).collect())
}

fn stamp() -> Value<'static> {
    message(vec![("sec", Value::I64(1)), ("nanosec", Value::I64(2))])
}

fn header() -> Value<'static> {
    message(vec![("stamp", stamp()), ("frame_id", Value::String("base".into()))])
}

/// 宽松的输入形状 (Python dict 转来的): 整数统一 I64, 浮点 F64, 数组为 List; 按定义收窄后与 rclpy 一致.
#[test]
fn loose_values_are_coerced_to_field_types() {
    let registry = registry();
    let joint_state = message(vec![
        ("header", header()),
        ("name", Value::List(vec![Value::String("a".into())])),
        ("position", Value::List(vec![Value::I64(1), Value::F64(0.5)])),
        ("velocity", Value::F32s(vec![2.0])),
        ("effort", Value::List(vec![])),
    ]);
    let encoded = registry.encode("sensor_msgs/msg/JointState", &joint_state).unwrap();
    let decoded = registry.decode("sensor_msgs/msg/JointState", &encoded).unwrap();
    assert_eq!(decoded.get("position"), Some(&Value::F64s(vec![1.0, 0.5])));
}

/// 坏值一律在编码时拒收, 错误指出字段路径.
#[test]
fn invalid_values_are_rejected_with_field_path() {
    let registry = registry();
    let basic = |field: &str, value: Value<'static>| {
        let mut fields: Vec<(&str, Value<'static>)> = [
            "bool_value", "byte_value", "char_value", "float32_value", "float64_value", "int8_value", "uint8_value",
            "int16_value", "uint16_value", "int32_value", "uint32_value", "int64_value", "uint64_value",
        ]
        .into_iter()
        .map(|name| (name, if name == "bool_value" { Value::Bool(true) } else { Value::I64(0) }))
        .collect();
        fields.iter_mut().find(|(name, _)| *name == field).unwrap().1 = value;
        ("test_msgs/msg/BasicTypes", message(fields))
    };
    let without_frame = message(vec![("stamp", stamp())]);
    let cases: Vec<(&str, Value<'static>)> = vec![
        basic("int8_value", Value::I64(128)),
        basic("uint8_value", Value::I64(-1)),
        basic("uint64_value", Value::F64(1.0)),
        basic("int32_value", Value::String("1".into())),
        basic("bool_value", Value::I64(1)),
        basic("float32_value", Value::F64(1e300)),
        ("std_msgs/msg/Header", without_frame),
        ("std_msgs/msg/Header", message(vec![("stamp", stamp()), ("frame_id", Value::String("x".into())), ("extra", Value::I64(0))])),
        ("std_msgs/msg/Header", message(vec![("stamp", Value::I64(0)), ("frame_id", Value::String("x".into()))])),
        (
            "sensor_msgs/msg/CameraInfo",
            camera_info_with("d", Value::F64s(vec![])).with("k", Value::F64s(vec![0.0; 8])),
        ),
        ("test_msgs/msg/BoundedSequences", bounded_with("int32_values", Value::I32s(vec![0; 4]))),
        ("test_msgs/msg/Strings", strings_with("bounded_string_value", Value::String("x".repeat(23)))),
        ("geometry_msgs/msg/Point", message(vec![("x", Value::F64(0.0)), ("y", Value::F64(0.0)), ("z", Value::Bytes(Cow::Borrowed(&[1])))])),
    ];
    let got: Vec<String> = cases.iter().map(|(ty, v)| registry.encode(ty, v).map_err(|e| e.path().to_owned()).err().unwrap_or_default()).collect();
    assert_eq!(
        got,
        [
            "int8_value", "uint8_value", "uint64_value", "int32_value", "bool_value", "float32_value", "frame_id",
            "extra", "stamp", "k", "int32_values", "bounded_string_value", "z",
        ]
    );
}

trait With {
    fn with(self, field: &str, value: Value<'static>) -> Self;
}

impl With for Value<'static> {
    fn with(mut self, field: &str, value: Value<'static>) -> Self {
        if let Value::Message(fields) = &mut self {
            fields.iter_mut().find(|(name, _)| &**name == field).unwrap().1 = value;
        }
        self
    }
}

/// 金样本里某类型的一条值, 改一个字段.
fn golden(case: &str) -> Value<'static> {
    let registry = registry();
    let text = fs::read_to_string(messages().join("golden/expected.json")).unwrap();
    let expected: serde_json::Map<String, Json> = serde_json::from_str(&text).unwrap();
    let ty = expected[case]["type"].as_str().unwrap();
    let bytes = fs::read(messages().join(format!("golden/rmw_fastrtps_cpp/{case}.cdr"))).unwrap();
    registry.decode(ty, &bytes).unwrap().into_owned()
}

fn camera_info_with(field: &str, value: Value<'static>) -> Value<'static> {
    golden("sensor_msgs.CameraInfo").with(field, value)
}

fn bounded_with(field: &str, value: Value<'static>) -> Value<'static> {
    golden("test_msgs.BoundedSequences.0").with(field, value)
}

fn strings_with(field: &str, value: Value<'static>) -> Value<'static> {
    golden("test_msgs.Strings.0").with(field, value)
}

#[test]
fn encode_error_names_the_type_when_unknown() {
    let error = registry().encode("nope/msg/Nope", &message(vec![])).unwrap_err();
    assert_eq!(error, EncodeError::MissingType("nope/msg/Nope".into()));
}
