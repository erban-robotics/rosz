//! 打开查看器窗口: Chromium 系浏览器以独立 `--user-data-dir` 的 `--app` 窗口打开, 找不到退回默认浏览器 (`xdg-open`).
//!
//! 探测顺序 (见 erban-caring viewer research 02): xdg 默认浏览器的 desktop id 在 Chromium 系白名单内则用其 desktop 文件的
//! `Exec` (覆盖 flatpak / snap / 玲珑这类包装启动) -> 按序扫 PATH -> 玲珑的 Deepin 浏览器 -> `xdg-open`.
//! 独立 user-data-dir 下拉起的子进程即浏览器主进程, 关窗时退出; 退回 `xdg-open` 时只能靠 WebSocket 判断关窗.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};

use tokio::process::{Child, Command};

/// Chromium 系的 desktop id
const CHROMIUM_DESKTOP_IDS: &[&str] = &[
    "google-chrome.desktop",
    "com.google.Chrome.desktop",
    "chromium.desktop",
    "chromium-browser.desktop",
    "chromium_chromium.desktop",
    "org.chromium.Chromium.desktop",
    "microsoft-edge.desktop",
    "com.microsoft.Edge.desktop",
    "brave-browser.desktop",
    "vivaldi-stable.desktop",
    "org.deepin.browser.desktop",
];
/// 默认浏览器不是 Chromium 系时按序在 PATH 里找
const CHROMIUM_EXECUTABLES: &[&str] = &[
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge-stable",
    "brave-browser",
    "vivaldi-stable",
];
/// 玲珑包不在 PATH, 按 desktop 文件找
const DEEPIN_BROWSER_DESKTOP_ID: &str = "org.deepin.browser.desktop";

/// Chromium 系 `--app` 窗口: 浏览器程序与子进程 (子进程退出即关窗)
pub struct AppWindow {
    pub browser: String,
    pub child: Child,
}

/// 打开 `url`: Chromium 系为 `Some(AppWindow)`; 退回默认浏览器标签页 (`xdg-open`) 为 None, 关窗只能靠 WebSocket 判断.
/// 连默认浏览器都开不了时报错, 调用方让用户自己打开.
pub fn open(url: &str) -> Result<Option<AppWindow>, String> {
    if let Some(command) = find_chromium() {
        let profile = profile_dir();
        let _ = fs::create_dir_all(&profile);
        let mut args = command[1..].to_vec();
        args.push(format!("--app={url}").into());
        args.push(format!("--user-data-dir={}", profile.display()).into());
        args.push("--no-first-run".into());
        args.push("--no-default-browser-check".into());
        let child = Command::new(&command[0])
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(child) = child {
            return Ok(Some(AppWindow { browser: command[0].to_string_lossy().into_owned(), child }));
        }
    }
    StdCommand::new("xdg-open")
        .arg(url)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| None)
        .map_err(|e| format!("xdg-open 失败: {e}"))
}

/// 查看器专用的浏览器配置目录, 固定一处: 保留窗口尺寸, 免首启向导
fn profile_dir() -> PathBuf {
    data_home().join("rosz").join("browser-profile")
}

fn data_home() -> PathBuf {
    env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/share"))
}

/// Chromium 系浏览器的启动命令 (程序 + 前置参数)
fn find_chromium() -> Option<Vec<OsString>> {
    let default = StdCommand::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .stderr(Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
    if let Some(id) = default.filter(|id| CHROMIUM_DESKTOP_IDS.contains(&id.as_str()))
        && let Some(command) = desktop_exec(&id)
    {
        return Some(command);
    }
    for name in CHROMIUM_EXECUTABLES {
        if let Some(path) = in_path(name) {
            return Some(vec![path.into()]);
        }
    }
    desktop_exec(DEEPIN_BROWSER_DESKTOP_ID)
}

fn in_path(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}

/// `$XDG_DATA_HOME` 与 `$XDG_DATA_DIRS` 下 `applications/<id>` 的 `[Desktop Entry]` 段 `Exec`, 去掉字段码
fn desktop_exec(id: &str) -> Option<Vec<OsString>> {
    let dirs = env::var("XDG_DATA_DIRS").ok().filter(|v| !v.is_empty()).unwrap_or("/usr/local/share:/usr/share".into());
    let candidates = std::iter::once(data_home()).chain(dirs.split(':').map(PathBuf::from));
    let text = candidates.map(|d| d.join("applications").join(id)).find_map(|p| fs::read_to_string(p).ok())?;
    let exec = entry_exec(&text)?;
    let words: Vec<OsString> = split_exec(&exec)
        .into_iter()
        .filter(|w| !(w.starts_with('%') || w.starts_with("@@")))
        .map(OsString::from)
        .collect();
    let program = Path::new(words.first()?);
    (program.is_absolute() && program.is_file() || in_path(&program.to_string_lossy()).is_some()).then_some(words)
}

fn entry_exec(text: &str) -> Option<String> {
    let mut in_entry = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
        } else if in_entry && let Some(value) = line.strip_prefix("Exec=") {
            return Some(value.to_owned());
        }
    }
    None
}

/// 按 desktop entry 规范拆 Exec: 空白分词, 双引号内保留空白, 反斜杠转义下一个字符
fn split_exec(exec: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut has_word) = (false, false);
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has_word = true;
            }
            '\\' if quoted => word.extend(chars.next()),
            c if c.is_whitespace() && !quoted => {
                if has_word {
                    words.push(std::mem::take(&mut word));
                    has_word = false;
                }
            }
            c => {
                word.push(c);
                has_word = true;
            }
        }
    }
    if has_word {
        words.push(word);
    }
    words
}
