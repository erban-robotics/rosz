use std::collections::{BTreeMap, HashMap};
use std::process::ExitCode;
use std::time::Duration;

use rosz_access::{Session, Value};
use serde_json::{Value as Json, json};

use crate::topics::rate_hz;
use crate::{Failure, Output};

/// 数值数组不超过这么多元素时逐元素统计
const ARRAY_STATS_LIMIT: usize = 16;

#[derive(Default)]
struct Summary {
    min: f64,
    max: f64,
    sum: f64,
    count: usize,
}

impl Summary {
    fn add(&mut self, v: f64) {
        if !v.is_finite() {
            return;
        }
        if self.count == 0 {
            (self.min, self.max) = (v, v);
        }
        self.min = self.min.min(v);
        self.max = self.max.max(v);
        self.sum += v;
        self.count += 1;
    }

    fn json(&self) -> Json {
        if self.count == 0 {
            return json!({"min": null, "max": null, "mean": null});
        }
        json!({"min": self.min, "max": self.max, "mean": self.sum / self.count as f64})
    }
}

#[derive(Default)]
struct TopicStats {
    type_name: String,
    times: Vec<i64>,
    size: Summary,
    fields: BTreeMap<String, Summary>,
    error: Option<String>,
}

pub async fn run(session: &Session, output: Output, topics: &[String], window: Duration) -> Result<ExitCode, Failure> {
    let names: Vec<&str> = topics.iter().map(String::as_str).collect();
    let mut subscription = session.subscribe(&names).await?;
    let mut stats: HashMap<String, TopicStats> = HashMap::new();
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(message)) = tokio::time::timeout_at(deadline, subscription.recv()).await {
        let entry = stats.entry(message.topic.clone()).or_default();
        entry.type_name.clone_from(&message.type_name);
        entry.times.push(message.receive_time_ns);
        entry.size.add(message.payload.len() as f64);
        match message.value() {
            Ok(value) => collect(&value, String::new(), &mut entry.fields),
            Err(error) => entry.error = Some(error.to_string()),
        }
    }
    let topic_info = session.topics();
    let mut items = Vec::new();
    for name in topics {
        let normalized = format!("/{}", name.trim_matches('/'));
        let entry = stats.remove(&normalized).unwrap_or_default();
        let type_name = topic_info.iter().find(|t| t.name == normalized).map(|t| t.type_name.clone());
        let fields: serde_json::Map<String, Json> = entry.fields.iter().map(|(k, v)| (k.clone(), v.json())).collect();
        items.push(json!({
            "name": normalized,
            "type": type_name,
            "count": entry.times.len(),
            "rate_hz": rate_hz(&entry.times, window),
            "size_bytes": entry.size.json(),
            "fields": fields,
            "error": entry.error,
        }));
    }
    if output.json {
        output.print_json(&json!({"seconds": window.as_secs_f64(), "topics": items}));
    } else {
        for item in &items {
            println!(
                "{}  {}  {} 条  {:.1} Hz  大小 {}",
                item["name"].as_str().unwrap(),
                item["type"].as_str().unwrap_or("?"),
                item["count"],
                item["rate_hz"].as_f64().unwrap(),
                summary_text(&item["size_bytes"]),
            );
            if let Some(error) = item["error"].as_str() {
                println!("  无法解码: {error}");
            }
            for (path, summary) in item["fields"].as_object().unwrap() {
                println!("  {path}: {}", summary_text(summary));
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn summary_text(s: &Json) -> String {
    match (s["min"].as_f64(), s["max"].as_f64(), s["mean"].as_f64()) {
        (Some(min), Some(max), Some(mean)) => format!("最小 {min} / 最大 {max} / 均值 {mean:.4}"),
        _ => "-".into(),
    }
}

/// 收集数值标量与短数值数组的每个元素, 路径如 `header.stamp.sec`, `position[3]`.
fn collect(value: &Value, path: String, out: &mut BTreeMap<String, Summary>) {
    let join = |name: &str| if path.is_empty() { name.to_owned() } else { format!("{path}.{name}") };
    match value {
        Value::Message(fields) => fields.iter().for_each(|(name, v)| collect(v, join(name), out)),
        Value::List(items) if items.len() <= ARRAY_STATS_LIMIT => {
            items.iter().enumerate().for_each(|(i, v)| collect(v, format!("{path}[{i}]"), out))
        }
        Value::Bytes(_) | Value::List(_) | Value::String(_) | Value::Bool(_) | Value::Bools(_) => {}
        other => match other.numeric_len() {
            Some(len) if len <= ARRAY_STATS_LIMIT => {
                (0..len).for_each(|i| out.entry(format!("{path}[{i}]")).or_default().add(other.numeric_at(i).unwrap()))
            }
            Some(_) => {}
            None => {
                if let Some(v) = other.as_f64() {
                    out.entry(path).or_default().add(v);
                }
            }
        },
    }
}
