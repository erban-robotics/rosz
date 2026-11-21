//! `rosz view`: 本机起 HTTP + WebSocket 服务 (嵌入的前端 + `foxglove.websocket.v1` 子集, 见 [`protocol`]),
//! 以浏览器独立窗口打开, 关窗即退出. 后端只转原始 CDR, 解码与渲染在前端 (rosz-ui + rosz-wasm).
//!
//! 退出判定 (先到者): Chromium `--app` 子进程退出且已无连接; 或曾有连接而现在全断超过 [`DISCONNECT_GRACE`];
//! 或 Ctrl+C. 子进程在首个连接前就退出 (同一配置目录已有实例, 窗口归了它) 时不算关窗, 只看 WebSocket.

mod browser;
mod protocol;

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rosz_access::Session;
use rust_embed::RustEmbed;
use thiserror::Error;
use tokio::net::TcpListener;

use crate::browser::AppWindow;
use crate::protocol::{Hub, SUBPROTOCOL};

/// 默认端口: 固定端口使页面同源, 浏览器的本地存储 (布局记忆) 跨次保留; 被占用时退回随机端口
pub const DEFAULT_PORT: u16 = 7450;
/// WebSocket 全断后等这么久仍无连接即退出 (容许刷新页面)
pub const DISCONNECT_GRACE: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(RustEmbed)]
#[folder = "web/dist"]
#[allow_missing = true]
struct Assets;

pub struct Options {
    /// 监听端口 (只听 127.0.0.1); None 为 [`DEFAULT_PORT`], 占用时随机
    pub port: Option<u16>,
    /// 是否拉起浏览器窗口; false 时只打印地址, 不因关窗退出 (前端开发, 无头验证用)
    pub open: bool,
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("监听 127.0.0.1:{port} 失败: {source}")]
    Bind { port: u16, source: std::io::Error },
    #[error("HTTP 服务: {0}")]
    Serve(std::io::Error),
}

/// 起服务, 打开窗口, 直到关窗或 Ctrl+C.
pub async fn run(session: Session, options: Options) -> Result<(), Error> {
    let listener = bind(options.port).await?;
    let port = listener.local_addr().map_err(Error::Serve)?.port();
    let url = format!("http://127.0.0.1:{port}/");
    let hub = Hub::new(session);
    tokio::spawn(hub.clone().discover());
    let mut connections = hub.connections();
    let app = Router::new().route("/ws", get(websocket)).fallback(get(asset)).with_state(hub);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });

    if Assets::get("index.html").is_none() {
        eprintln!("注意: 前端未构建 (apps/view/web/dist 为空), 页面无内容; 先在 apps/view/web 里 npm run build 再编译");
    }
    let mut window = None;
    if options.open {
        match browser::open(&url) {
            Ok(Some(AppWindow { browser, child })) => {
                eprintln!("查看器: {url} (以 {browser} 独立窗口打开, 关窗即退出)");
                window = Some(child);
            }
            Ok(None) => eprintln!("查看器: {url} (没找到 Chromium 系浏览器, 已在默认浏览器打开; 关掉标签页即退出)"),
            Err(e) => eprintln!("查看器: {url} (打不开浏览器: {e}; 请手动打开)"),
        }
    } else {
        eprintln!("查看器: {url} (Ctrl+C 退出)");
    }

    let mut ever_connected = false;
    let mut child_exited = false;
    let mut idle_since: Option<tokio::time::Instant> = None;
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    let mut interrupt = std::pin::pin!(tokio::signal::ctrl_c());
    let mut interrupted = false;
    loop {
        tokio::select! {
            _ = &mut interrupt => {
                interrupted = true;
                break;
            }
            result = async { window.as_mut().unwrap().wait().await }, if window.is_some() && !child_exited => {
                let _ = result;
                child_exited = true;
            }
            _ = connections.changed() => {}
            _ = ticker.tick() => {}
        }
        if server.is_finished() {
            break;
        }
        if !options.open {
            continue;
        }
        let active = *connections.borrow();
        if active > 0 {
            ever_connected = true;
            idle_since = None;
            continue;
        }
        if !ever_connected {
            continue;
        }
        if child_exited {
            break;
        }
        let since = *idle_since.get_or_insert_with(tokio::time::Instant::now);
        if since.elapsed() >= DISCONNECT_GRACE {
            break;
        }
    }
    // Ctrl+C 时窗口一并关掉. 关窗退出时子进程还在, 说明同一配置目录里另一个查看器的窗口还开着 (浏览器主进程归本进程拉起), 不动它
    if let Some(mut child) = window
        && interrupted
        && !child_exited
    {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    if server.is_finished() {
        return match server.await {
            Ok(Err(e)) => Err(Error::Serve(e)),
            _ => Ok(()),
        };
    }
    server.abort();
    Ok(())
}

async fn bind(port: Option<u16>) -> Result<TcpListener, Error> {
    let at = |port| SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    match port {
        Some(port) => TcpListener::bind(at(port)).await.map_err(|source| Error::Bind { port, source }),
        None => match TcpListener::bind(at(DEFAULT_PORT)).await {
            Ok(listener) => Ok(listener),
            Err(_) => TcpListener::bind(at(0)).await.map_err(|source| Error::Bind { port: 0, source }),
        },
    }
}

async fn websocket(State(hub): State<Arc<Hub>>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.protocols([SUBPROTOCOL]).on_upgrade(move |socket| hub.serve(socket))
}

/// 嵌入的前端文件; 路径不存在时回 index.html (单页应用)
async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let (path, file) = match Assets::get(path) {
        Some(file) if !path.is_empty() => (path, file),
        _ => match Assets::get("index.html") {
            Some(file) => ("index.html", file),
            None => return (StatusCode::NOT_FOUND, "前端未构建: 在 apps/view/web 里 npm run build 后重新编译").into_response(),
        },
    };
    // 带内容 hash 的构建产物可长期缓存, index.html 每次取新的
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    (
        [(header::CONTENT_TYPE, file.metadata.mimetype().to_owned()), (header::CACHE_CONTROL, cache.to_owned())],
        file.data,
    )
        .into_response()
}
