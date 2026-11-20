use std::collections::HashMap;
use std::process::ExitCode;
use std::time::Duration;

use rosz_access::Session;
use serde_json::json;

use crate::{Failure, Output};

const RATE_WINDOW: Duration = Duration::from_secs(1);

pub async fn run(session: &Session, output: Output, measure_rate: bool) -> Result<ExitCode, Failure> {
    let topics = session.topics();
    let rates = if measure_rate { measure(session, &topics).await? } else { HashMap::new() };
    if output.json {
        let items: Vec<_> = topics
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "type": t.type_name,
                    "type_hash": t.type_hash,
                    "publishers": t.publishers,
                    "transient_local": t.transient_local,
                    "decodable": t.decodability.is_ok(),
                    "reason": t.decodability.reason(),
                    "rate_hz": rates.get(&t.name),
                })
            })
            .collect();
        output.print_json(&json!({ "topics": items }));
        return Ok(ExitCode::SUCCESS);
    }
    let width = topics.iter().map(|t| t.name.len()).max().unwrap_or(0);
    let type_width = topics.iter().map(|t| t.type_name.len()).max().unwrap_or(0);
    for t in &topics {
        let rate = match rates.get(&t.name) {
            _ if t.transient_local => "静态".to_owned(),
            Some(hz) => format!("{hz:.1} Hz"),
            None if measure_rate => "-".to_owned(),
            None => String::new(),
        };
        let note = t.decodability.reason().map(|r| format!("  无法解码: {r}")).unwrap_or_default();
        println!("{:width$}  {:type_width$}  {rate:>8}{note}", t.name, t.type_name);
    }
    Ok(ExitCode::SUCCESS)
}

/// 订阅全部非 transient_local 话题约 1 秒, 按收到条数算频率.
async fn measure(session: &Session, topics: &[rosz_access::TopicInfo]) -> Result<HashMap<String, f64>, Failure> {
    let names: Vec<&str> = topics.iter().filter(|t| !t.transient_local).map(|t| t.name.as_str()).collect();
    let mut arrivals: HashMap<String, Vec<i64>> = HashMap::new();
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let mut subscription = session.subscribe(&names).await?;
    let deadline = tokio::time::Instant::now() + RATE_WINDOW;
    while let Ok(Some(message)) = tokio::time::timeout_at(deadline, subscription.recv()).await {
        arrivals.entry(message.topic).or_default().push(message.receive_time_ns);
    }
    Ok(arrivals.into_iter().map(|(topic, times)| (topic, rate_hz(&times, RATE_WINDOW))).collect())
}

/// 至少 3 条时按首末间隔算, 否则按窗口长度算.
pub fn rate_hz(times: &[i64], window: Duration) -> f64 {
    match times {
        [first, .., last] if times.len() >= 3 && last > first => (times.len() - 1) as f64 * 1e9 / (last - first) as f64,
        _ => times.len() as f64 / window.as_secs_f64(),
    }
}
