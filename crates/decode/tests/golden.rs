//! 金样本回归: 样本由一次性 jazzy 容器生成 (`scripts/jazzy/golden.sh`), 参照值与 hash 取自 rclpy / rosidl.

use std::fs;
use std::path::{Path, PathBuf};

use rosz_decode::Registry;
use serde_json::Value as Json;

fn messages() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../messages")
}

/// 内置类型 + test_msgs (运行时追加, 也走了追加目录的接口).
fn registry() -> Registry {
    let mut registry = Registry::builtin();
    registry.add_dir(messages().join("test")).unwrap();
    registry
}

fn read_json(name: &str) -> serde_json::Map<String, Json> {
    let text = fs::read_to_string(messages().join("golden").join(name)).unwrap();
    serde_json::from_str::<Json>(&text).unwrap().as_object().unwrap().clone()
}

/// 每个样例: (rmw/样例, 类型, 参照值, CDR 字节)
fn samples() -> Vec<(String, String, Json, Vec<u8>)> {
    let expected = read_json("expected.json");
    let mut out = Vec::new();
    for rmw in ["rmw_zenoh_cpp", "rmw_fastrtps_cpp"] {
        for (case, sample) in &expected {
            let bytes = fs::read(messages().join(format!("golden/{rmw}/{case}.cdr"))).unwrap();
            out.push((format!("{rmw}/{case}"), sample["type"].as_str().unwrap().into(), sample["value"].clone(), bytes));
        }
    }
    out
}

#[test]
fn rihs01_matches_rosidl() {
    let registry = registry();
    let mismatched: Vec<_> = read_json("hashes.json")
        .into_iter()
        .filter(|(name, hash)| registry.rihs01(name).ok().as_deref() != hash.as_str())
        .map(|(name, _)| name)
        .collect();
    assert_eq!(mismatched, Vec::<String>::new());
}

/// 两种 rmw 的样本只在 padding 内容上不同 (rmw_zenoh 不清零), JointState 以空 float64[] 结尾多 4 字节: 都应解对.
#[test]
fn decodes_golden_samples_like_rclpy() {
    let registry = registry();
    let wrong: Vec<_> = samples()
        .into_iter()
        .filter(|(_, ty, expected, bytes)| registry.decode(ty, bytes).map(|v| v.to_json()).ok().as_ref() != Some(expected))
        .map(|(case, ..)| case)
        .collect();
    assert_eq!(wrong, Vec::<String>::new());
}

/// 严格: 截掉后一半, 或长度声明超过剩余字节, 都返回错误; 任意截断都不 panic.
/// (rmw 序列化缓冲尾部可能带几十字节未初始化内容, 所以只截一半, 不逐字节要求报错)
#[test]
fn malformed_input_is_an_error() {
    let registry = registry();
    let samples: Vec<_> = samples().into_iter().filter(|(case, ..)| case.starts_with("rmw_zenoh_cpp/")).collect();
    let mut accepted: Vec<String> = Vec::new();
    for (case, ty, expected, bytes) in &samples {
        if bytes.len() <= 2048 {
            (0..bytes.len()).for_each(|n| drop(registry.decode(ty, &bytes[..n])));
        }
        if registry.decode(ty, &bytes[..bytes.len() / 2]).is_ok() {
            accepted.push(format!("{case} 截一半"));
        }
        // CompressedImage.data 的长度声明改成远超剩余字节
        if ty == "sensor_msgs/msg/CompressedImage" {
            let len = (expected["data"].as_array().unwrap().len() as u32).to_le_bytes();
            let at = bytes.windows(4).rposition(|w| w == len).unwrap();
            let mut bad = bytes.clone();
            bad[at..at + 4].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
            if registry.decode(ty, &bad).is_ok() {
                accepted.push(format!("{case} 超长声明"));
            }
        }
    }
    assert_eq!(accepted, Vec::<String>::new());
}

#[test]
fn ros2msg_schema_matches_erban_recorder() {
    // 参照由 tests/e2e/gen_message_schema.py 从 erban-caring 录制器的 episode_data.message_schema (rosbags) 生成
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/e2e/message_schema.json");
    let expected: serde_json::Map<String, Json> = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let registry = Registry::builtin();
    let wrong: Vec<&String> = expected
        .iter()
        .filter(|(ty, text)| registry.ros2msg_schema(ty).ok().as_deref() != text.as_str())
        .map(|(ty, _)| ty)
        .collect();
    assert_eq!(wrong, Vec::<&String>::new());
}
