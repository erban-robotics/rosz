//! `rosz collect`: 按话题清单录 MCAP, 到时长或 Ctrl-C / SIGTERM 停止并封口, 输出每话题统计.

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rosz_access::{CollectOptions, CollectStats, Compression, Session};
use serde_json::{Value, json};

use crate::{Failure, Output};

pub struct Args {
    pub topics: Vec<String>,
    pub out: Option<PathBuf>,
    pub seconds: Option<Duration>,
    pub compression: Compression,
    pub chunk_size: u64,
    pub stats_interval: Option<Duration>,
}

pub async fn run(session: &Session, output: Output, args: Args) -> Result<ExitCode, Failure> {
    let out = args.out.unwrap_or_else(|| {
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        PathBuf::from(format!("rosz-collect-{ms}.mcap"))
    });
    let topics: Vec<&str> = args.topics.iter().map(String::as_str).collect();
    let options = CollectOptions { compression: args.compression, chunk_size: args.chunk_size };
    let collector = session.collect(&out, &topics, options).await.map_err(|e| Failure::new("collect", e.to_string()))?;
    if !output.json {
        eprintln!("采集到 {} (Ctrl-C 停止)", out.display());
    }

    let deadline = async {
        match args.seconds {
            Some(s) => tokio::time::sleep(s).await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(deadline);
    let mut ticker = args.stats_interval.map(|i| tokio::time::interval_at(tokio::time::Instant::now() + i, i));
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            _ = shutdown_signal() => break,
            _ = async { ticker.as_mut().unwrap().tick().await }, if ticker.is_some() => {
                print_stats(output, &collector.stats(), false);
            }
        }
    }
    let stats = collector.stop().await.map_err(|e| Failure::new("collect", e.to_string()))?;
    print_stats(output, &stats, true);
    Ok(ExitCode::SUCCESS)
}

async fn shutdown_signal() {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = async { terminate.as_mut().unwrap().recv().await }, if terminate.is_some() => {}
    }
}

fn print_stats(output: Output, stats: &CollectStats, is_final: bool) {
    if output.json {
        output.print_json(&stats_json(stats));
        return;
    }
    println!("{}", if is_final { "已封口" } else { "---" });
    for (topic, s) in &stats.topics {
        let latency = s.latency.map_or("-".into(), |l| format!("{:.1} ms", l.p50_ns as f64 / 1e6));
        println!("{topic}  收 {}  写 {}  缺 {}  重启 {}  延迟中位 {latency}", s.received, s.written, s.gaps, s.publisher_restarts);
    }
    for error in &stats.errors {
        println!("错误: {error}");
    }
}

/// 与 Python `Collector.stats()` 同结构.
pub fn stats_json(stats: &CollectStats) -> Value {
    let topics: serde_json::Map<String, Value> = stats
        .topics
        .iter()
        .map(|(name, s)| {
            let latency = s.latency.map(|l| json!({"p50": l.p50_ns, "p95": l.p95_ns, "max": l.max_ns}));
            let item = json!({
                "type": s.type_name,
                "received": s.received,
                "written": s.written,
                "gaps": s.gaps,
                "publisher_restarts": s.publisher_restarts,
                "last_receive_time_ns": s.last_receive_time_ns,
                "last_header_stamp_ns": s.last_header_stamp_ns,
                "latency_ns": latency,
            });
            (name.clone(), item)
        })
        .collect();
    json!({
        "topics": topics,
        "written": stats.written,
        "queue_depth": stats.queue_depth,
        "last_write_time_ns": stats.last_write_time_ns,
        "errors": stats.errors,
    })
}
