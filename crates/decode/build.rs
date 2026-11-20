//! 把仓库 `messages/jazzy` 与 `messages/erban` 下的全部 `.msg` 编进二进制: 生成 `(类型名, 文本)` 表.

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
        writeln!(out, "    ({name:?}, include_str!({:?})),", path.display().to_string()).unwrap();
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("builtin.rs"), out).unwrap();
}

/// 收集 `<root>/<包>/msg/<类型>.msg`, 类型名为 `<包>/msg/<类型>`.
fn collect(root: &Path, entries: &mut Vec<(String, PathBuf)>) {
    let mut packages: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().path()).collect();
    packages.sort();
    for package in packages {
        let Ok(files) = fs::read_dir(package.join("msg")) else { continue };
        let package_name = package.file_name().unwrap().to_str().unwrap().to_owned();
        for file in files {
            let path = file.unwrap().path().canonicalize().unwrap();
            if path.extension().is_some_and(|e| e == "msg") {
                let stem = path.file_stem().unwrap().to_str().unwrap();
                entries.push((format!("{package_name}/msg/{stem}"), path));
            }
        }
    }
}
