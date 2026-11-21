//! `rosz`: 不装 ROS 查看与采集 ROS 2 话题. 终端里为人读格式, 管道或 `--json` 时为结构固定的 JSON.

mod format;
mod snapshot;
mod stats;
mod topics;

use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Parser, Subcommand};
use rosz_access::{Error, Registry, Session};
use serde_json::json;

#[derive(Parser)]
#[command(name = "rosz", version, about = "不装 ROS 查看 ROS 2 (rmw_zenoh) 话题")]
struct Cli {
    /// Zenoh router 地址, 如 tcp/192.168.1.10:7447 (未给时取环境变量 ROSZ_ROUTER)
    #[arg(long, global = true)]
    router: Option<String>,
    /// 输出 JSON (stdout 不是终端时自动开启)
    #[arg(long, global = true)]
    json: bool,
    /// ROS domain (未给时取 ROS_DOMAIN_ID, 默认 0)
    #[arg(long, global = true)]
    domain: Option<u32>,
    /// 追加 .msg 目录 (内含 <包>/msg/<类型>.msg), 可多次给出
    #[arg(long = "msg-dir", global = true)]
    msg_dirs: Vec<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 列出话题: 名称, 类型, 能否解码, 约 1 秒实测频率
    Topics {
        /// 不测频率 (不订阅任何话题)
        #[arg(long)]
        no_rate: bool,
    },
    /// 打印话题消息; 大数组只显长度与开头几个
    Echo {
        topic: String,
        /// 收到这么多条后退出 (默认一直收)
        #[arg(long, short = 'n')]
        count: Option<usize>,
        /// 等第一条的秒数, 超时报错
        #[arg(long, default_value_t = 5.0)]
        timeout: f64,
    },
    /// 每话题取一条落文件 (彩色 JPEG, 深度 16 位 PNG + 伪彩色预览, 其他 JSON), 输出清单
    Snapshot {
        /// 话题 (默认全部图像话题)
        topics: Vec<String>,
        /// 输出目录 (默认 ./rosz-snapshot-<时刻>)
        #[arg(long)]
        out: Option<PathBuf>,
        /// 每话题等待秒数
        #[arg(long, default_value_t = 3.0)]
        timeout: f64,
    },
    /// 统计一段时间: 频率, 消息大小, 数值字段最小 / 最大 / 均值
    Stats {
        #[arg(required = true)]
        topics: Vec<String>,
        #[arg(long, default_value_t = 3.0)]
        seconds: f64,
    },
    /// 查看器: 以浏览器独立窗口打开 (话题树 + 图像面板), 关窗即退出
    View {
        /// 本机监听端口 (只听 127.0.0.1; 默认 7450, 被占用时随机)
        #[arg(long)]
        port: Option<u16>,
        /// 不拉起浏览器, 只打印地址 (Ctrl+C 退出)
        #[arg(long)]
        no_open: bool,
    },
}

/// 输出方式
#[derive(Clone, Copy)]
pub struct Output {
    pub json: bool,
}

impl Output {
    pub fn print_json(&self, value: &serde_json::Value) {
        println!("{value}");
    }
}

/// 子命令失败: 预期内的错误 (话题不存在, 超时, 连接失败) 统一成 JSON 错误与非零退出码.
pub struct Failure {
    kind: &'static str,
    message: String,
    candidates: Vec<String>,
}

impl Failure {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Failure { kind, message: message.into(), candidates: Vec::new() }
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        let kind = match &error {
            Error::NoRouter => "no_router",
            Error::Connect { .. } => "connect",
            Error::UnknownTopic { .. } => "unknown_topic",
            Error::Zenoh(_) => "zenoh",
        };
        let candidates = match &error {
            Error::UnknownTopic { candidates, .. } => candidates.clone(),
            _ => Vec::new(),
        };
        Failure { kind, message: error.to_string(), candidates }
    }
}

pub fn seconds(s: f64) -> Duration {
    Duration::from_secs_f64(s.max(0.0))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let output = Output { json: cli.json || !std::io::stdout().is_terminal() };
    match run(cli, output).await {
        Ok(code) => code,
        Err(failure) => {
            if output.json {
                let error = json!({"kind": failure.kind, "message": failure.message, "candidates": failure.candidates});
                output.print_json(&json!({ "error": error }));
            } else {
                eprintln!("错误: {}", failure.message);
            }
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli, output: Output) -> Result<ExitCode, Failure> {
    let mut registry = Registry::builtin();
    for dir in &cli.msg_dirs {
        registry.add_dir(dir).map_err(|e| Failure::new("msg_dir", e.to_string()))?;
    }
    let session = Session::open(cli.router.as_deref(), cli.domain, registry).await?;
    match cli.command {
        Command::Topics { no_rate } => topics::run(&session, output, !no_rate).await,
        Command::Echo { topic, count, timeout } => echo(&session, output, &topic, count, seconds(timeout)).await,
        Command::Snapshot { topics, out, timeout } => snapshot::run(&session, output, topics, out, seconds(timeout)).await,
        Command::Stats { topics, seconds: s } => stats::run(&session, output, &topics, seconds(s)).await,
        Command::View { port, no_open } => rosz_view::run(session, rosz_view::Options { port, open: !no_open })
            .await
            .map(|()| ExitCode::SUCCESS)
            .map_err(|e| Failure::new("view", e.to_string())),
    }
}

async fn echo(
    session: &Session,
    output: Output,
    topic: &str,
    count: Option<usize>,
    timeout: Duration,
) -> Result<ExitCode, Failure> {
    let mut subscription = session.subscribe(&[topic]).await?;
    let mut received = 0;
    while count.is_none_or(|n| received < n) {
        let message = if received == 0 {
            tokio::time::timeout(timeout, subscription.recv()).await.map_err(|_| {
                Failure::new("timeout", format!("{} 秒内没收到 {topic} 的消息", timeout.as_secs_f64()))
            })?
        } else {
            subscription.recv().await
        };
        let Some(message) = message else { break };
        received += 1;
        if output.json {
            output.print_json(&format::message_json(&message));
        } else {
            if received > 1 {
                println!("---");
            }
            print!("{}", format::message_text(&message));
        }
    }
    Ok(ExitCode::SUCCESS)
}
