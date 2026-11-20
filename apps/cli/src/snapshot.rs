use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use rosz_access::{DepthImage, ImageKind, Message, Session};
use rosz_decode::media::{self, COMPRESSED_IMAGE, IMAGE};
use serde_json::{Value as Json, json};

use crate::{Failure, Output, format};

const JPEG_QUALITY: u8 = 90;

pub async fn run(
    session: &Session,
    output: Output,
    topics: Vec<String>,
    out: Option<PathBuf>,
    timeout: Duration,
) -> Result<ExitCode, Failure> {
    let snapshot_ns = now_ns();
    let topics = if topics.is_empty() {
        let images: Vec<String> = session
            .topics()
            .into_iter()
            .filter(|t| t.decodability.is_ok() && (t.type_name == COMPRESSED_IMAGE || t.type_name == IMAGE))
            .map(|t| t.name)
            .collect();
        if images.is_empty() {
            return Err(Failure::new("no_topics", "没有可解码的图像话题; 请指定话题"));
        }
        images
    } else {
        topics
    };
    // 先确认话题都在, 写错的直接报错并给候选
    let known = session.topics();
    for topic in &topics {
        let normalized = format!("/{}", topic.trim_matches('/'));
        if !known.iter().any(|t| t.name == normalized) {
            session.subscribe(&[topic]).await?;
        }
    }
    let out = out.unwrap_or_else(|| PathBuf::from(format!("rosz-snapshot-{}", snapshot_ns / 1_000_000)));
    fs::create_dir_all(&out).map_err(|e| Failure::new("io", format!("建目录 {} 失败: {e}", out.display())))?;

    let mut tasks = tokio::task::JoinSet::new();
    for (index, topic) in topics.iter().enumerate() {
        let (session, topic) = (session.clone(), topic.clone());
        tasks.spawn(async move { (index, topic.clone(), session.latest(&topic, timeout).await) });
    }
    let mut items = vec![Json::Null; topics.len()];
    while let Some(joined) = tasks.join_next().await {
        let (index, topic, result) = joined.map_err(|e| Failure::new("internal", e.to_string()))?;
        items[index] = match result? {
            Some(message) => save(&message, &out, snapshot_ns),
            None => json!({"topic": topic, "error": format!("{} 秒内没收到消息", timeout.as_secs_f64())}),
        };
    }
    let all_ok = items.iter().all(|i| i.get("error").is_none_or(Json::is_null));
    let manifest = json!({"snapshot_time_ns": snapshot_ns, "out_dir": out.display().to_string(), "items": items});
    let manifest_path = out.join("manifest.json");
    fs::write(&manifest_path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| Failure::new("io", format!("写 {} 失败: {e}", manifest_path.display())))?;
    if output.json {
        output.print_json(&manifest);
    } else {
        for item in manifest["items"].as_array().unwrap() {
            let topic = item["topic"].as_str().unwrap_or("?");
            match item["error"].as_str() {
                Some(error) => println!("{topic}: 失败: {error}"),
                None => {
                    let files: Vec<&str> = item["files"].as_array().unwrap().iter().filter_map(Json::as_str).collect();
                    let offset = |key: &str| item[key].as_f64().map_or("-".into(), |v| format!("{v:+.1} ms"));
                    println!(
                        "{topic}: {}  接收 {}  采样 {}",
                        files.join(", "),
                        offset("receive_offset_ms"),
                        offset("sample_offset_ms")
                    );
                }
            }
        }
        println!("清单: {}", manifest_path.display());
    }
    Ok(if all_ok { ExitCode::SUCCESS } else { ExitCode::FAILURE })
}

/// 落一条消息, 返回清单条目.
fn save(message: &Message, out: &Path, snapshot_ns: i64) -> Json {
    let offset_ms = |t: i64| (t - snapshot_ns) as f64 / 1e6;
    let mut item = json!({
        "topic": message.topic,
        "type": message.type_name,
        "receive_time_ns": message.receive_time_ns,
        "sample_time_ns": message.sample_time_ns,
        "receive_offset_ms": offset_ms(message.receive_time_ns),
        "sample_offset_ms": message.sample_time_ns.map(offset_ms),
    });
    let stem = message.topic.trim_matches('/').replace('/', "__");
    match write_files(message, out, &stem) {
        Ok((kind, files)) => {
            item["kind"] = kind.into();
            item["files"] = files.iter().map(|p| p.display().to_string()).collect();
        }
        Err(error) => item["error"] = error.into(),
    }
    item
}

fn write_files(message: &Message, out: &Path, stem: &str) -> Result<(&'static str, Vec<PathBuf>), String> {
    let write = |name: String, bytes: &[u8]| {
        let path = out.join(name);
        fs::write(&path, bytes).map(|_| path.clone()).map_err(|e| format!("写 {} 失败: {e}", path.display()))
    };
    let value = message.value().map_err(|e| e.to_string())?;
    match message.image_kind() {
        Some(ImageKind::Color) => {
            let format = value.get("format").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
            // 压缩彩色图原样落盘, 不重编码
            if message.type_name == COMPRESSED_IMAGE {
                let data = value.get("data").and_then(|v| v.as_bytes()).unwrap_or(&[]);
                message.image().map_err(|e| e.to_string())?;
                let ext = if format.contains("png") { "png" } else { "jpg" };
                return Ok(("color", vec![write(format!("{stem}.{ext}"), data)?]));
            }
            let rgb = message.image().map_err(|e| e.to_string())?;
            let mut jpeg = Vec::new();
            jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY)
                .encode(&rgb.data, rgb.width as u16, rgb.height as u16, jpeg_encoder::ColorType::Rgb)
                .map_err(|e| format!("JPEG 编码: {e}"))?;
            Ok(("color", vec![write(format!("{stem}.jpg"), &jpeg)?]))
        }
        Some(ImageKind::Depth) => {
            let depth = message.depth().map_err(|e| e.to_string())?;
            let png = write(format!("{stem}.depth.png"), &media::encode_png_depth(&depth))?;
            let preview = write(format!("{stem}.preview.png"), &media::encode_png_rgb(&colorize(&depth)))?;
            Ok(("depth", vec![png, preview]))
        }
        None => {
            let json = serde_json::to_string_pretty(&format::value_json(&value)).unwrap();
            Ok(("message", vec![write(format!("{stem}.json"), json.as_bytes())?]))
        }
    }
}

/// 深度伪彩色预览 (turbo): 按有效值 2% ~ 98% 分位拉伸, 无效 (0) 为黑.
fn colorize(depth: &DepthImage) -> rosz_access::RgbImage {
    let mut valid: Vec<u16> = depth.data.iter().copied().filter(|&d| d > 0).collect();
    valid.sort_unstable();
    let pick = |q: f64| valid.get(((valid.len().max(1) - 1) as f64 * q) as usize).copied().unwrap_or(0) as f64;
    let (lo, hi) = (pick(0.02), pick(0.98).max(pick(0.02) + 1.0));
    let data = depth
        .data
        .iter()
        .flat_map(|&d| if d == 0 { [0, 0, 0] } else { turbo(((d as f64 - lo) / (hi - lo)).clamp(0.0, 1.0)) })
        .collect();
    rosz_access::RgbImage { width: depth.width, height: depth.height, data }
}

/// Google turbo 色图的多项式近似.
fn turbo(t: f64) -> [u8; 3] {
    let poly = |c: [f64; 6]| c[0] + t * (c[1] + t * (c[2] + t * (c[3] + t * (c[4] + t * c[5]))));
    let r = poly([0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943]);
    let g = poly([0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604]);
    let b = poly([0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973]);
    [r, g, b].map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)
}

fn now_ns() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as i64)
}
