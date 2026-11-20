//! 消息转人读文本与 JSON.

use std::fmt::Write as _;

use rosz_access::{Message, Value};
use serde_json::{Value as Json, json};

/// 数组超过这么多元素时只显开头几个
const ARRAY_PREVIEW: usize = 8;
const ARRAY_FULL_LIMIT: usize = 16;

/// 消息的 JSON (结构固定): `uint8[]` 一律为 `{"length", "head"}`, 不内联二进制.
pub fn message_json(message: &Message) -> Json {
    let mut out = json!({
        "topic": message.topic,
        "type": message.type_name,
        "receive_time_ns": message.receive_time_ns,
        "sample_time_ns": message.sample_time_ns,
        "source_time_ns": message.source_time_ns,
    });
    match message.value() {
        Ok(value) => out["value"] = value_json(&value),
        Err(error) => out["error"] = error.to_string().into(),
    }
    out
}

pub fn value_json(value: &Value) -> Json {
    match value {
        Value::Bytes(bytes) => json!({"length": bytes.len(), "head": &bytes[..bytes.len().min(ARRAY_FULL_LIMIT)]}),
        Value::Message(fields) => Json::Object(fields.iter().map(|(k, v)| (k.to_string(), value_json(v))).collect()),
        Value::List(items) => Json::Array(items.iter().map(value_json).collect()),
        other => other.to_json(),
    }
}

/// 人读文本: 类 YAML 缩进.
pub fn message_text(message: &Message) -> String {
    match message.value() {
        Ok(value) => {
            let mut out = String::new();
            write_fields(&value, 0, &mut out);
            out
        }
        Err(error) => format!("({} {}: {error})\n", message.topic, message.type_name),
    }
}

fn write_fields(value: &Value, indent: usize, out: &mut String) {
    let Value::Message(fields) = value else { return };
    for (name, field) in fields {
        write!(out, "{:indent$}{name}:", "").unwrap();
        write_value(field, indent, out);
    }
}

fn write_value(value: &Value, indent: usize, out: &mut String) {
    match value {
        Value::Message(_) => {
            out.push('\n');
            write_fields(value, indent + 2, out);
        }
        Value::List(items) if items.iter().any(|v| matches!(v, Value::Message(_))) => {
            out.push('\n');
            for item in items {
                writeln!(out, "{:w$}-", "", w = indent + 2).unwrap();
                write_fields(item, indent + 4, out);
            }
        }
        Value::List(items) => {
            let shown: Vec<String> = items.iter().take(ARRAY_FULL_LIMIT).map(scalar_text).collect();
            let more = if items.len() > ARRAY_FULL_LIMIT { format!(", ... 共 {} 个", items.len()) } else { String::new() };
            writeln!(out, " [{}{more}]", shown.join(", ")).unwrap();
        }
        Value::Bytes(bytes) => {
            let head: Vec<String> = bytes.iter().take(ARRAY_PREVIEW * 2).map(|b| format!("{b:02x}")).collect();
            let more = if bytes.len() > ARRAY_PREVIEW * 2 { " ..." } else { "" };
            writeln!(out, " <{} 字节> {}{more}", bytes.len(), head.join(" ")).unwrap();
        }
        _ => match value.numeric_len() {
            Some(len) => {
                let limit = if len > ARRAY_FULL_LIMIT { ARRAY_PREVIEW } else { len };
                let shown: Vec<String> = (0..limit).map(|i| number_text(value.numeric_at(i).unwrap())).collect();
                let more = if len > limit { format!(", ... 共 {len} 个") } else { String::new() };
                writeln!(out, " [{}{more}]", shown.join(", ")).unwrap();
            }
            None => writeln!(out, " {}", scalar_text(value)).unwrap(),
        },
    }
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Bool(b) => b.to_string(),
        Value::F32(v) => v.to_string(),
        Value::F64(v) => v.to_string(),
        Value::U64(v) => v.to_string(),
        other => other.as_i64().map_or_else(|| format!("{other:?}"), |v| v.to_string()),
    }
}

fn number_text(v: f64) -> String {
    v.to_string()
}
