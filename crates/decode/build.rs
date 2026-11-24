//! 把仓库 `messages/jazzy` 与 `messages/erban` 下的全部 `.msg` 与 `.srv` 编进二进制: 生成 `(类型名, 文本)` 表.
//! 文本去掉注释与空行再嵌入 (约 130 KB 减到 20 KB, WASM 体积要紧).

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::{env, fs};

const BUILTIN_DIRS: [&str; 2] = ["jazzy", "erban"];

fn main() {
    let messages = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../messages");
    let mut entries = Vec::new();
    for dir in BUILTIN_DIRS {
        let root = messages.join(dir);
        println!("cargo:rerun-if-changed={}", root.display());
        collect(&root, &mut entries);
    }
    entries.sort();
    let mut out = String::from("pub(crate) static BUILTIN: &[(&str, &str)] = &[\n");
    for (name, path) in &entries {
        println!("cargo:rerun-if-changed={}", path.display());
        let text = strip_comments(&fs::read_to_string(path).unwrap());
        writeln!(out, "    ({name:?}, {text:?}),").unwrap();
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("builtin.rs"), out).unwrap();
}

/// 收集 `<root>/<包>/msg/<类型>.msg` 与 `<root>/<包>/srv/<类型>.srv`, 类型名为 `<包>/msg/<类型>` 或 `<包>/srv/<类型>`.
fn collect(root: &Path, entries: &mut Vec<(String, PathBuf)>) {
    let mut packages: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().path()).collect();
    packages.sort();
    for package in packages {
        let package_name = package.file_name().unwrap().to_str().unwrap().to_owned();
        for kind in ["msg", "srv"] {
            let Ok(files) = fs::read_dir(package.join(kind)) else { continue };
            for file in files {
                let path = file.unwrap().path().canonicalize().unwrap();
                if path.extension().is_some_and(|e| e == kind) {
                    let stem = path.file_stem().unwrap().to_str().unwrap();
                    entries.push((format!("{package_name}/{kind}/{stem}"), path));
                }
            }
        }
    }
}

/// 去掉整行注释, 空行, 以及非字符串行的行尾注释 (字符串常量与默认值里可能有 `#`, 保留原样).
fn strip_comments(text: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let is_string = trimmed.starts_with("string") || trimmed.starts_with("wstring");
        let kept = if is_string { trimmed } else { trimmed.split('#').next().unwrap().trim_end() };
        out.push_str(kept);
        out.push('\n');
    }
    out
}
