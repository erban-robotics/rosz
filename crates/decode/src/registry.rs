//! `.msg` 注册表: 编译期内置 common_interfaces jazzy 全套与 erban 自定义类型, 运行时可追加目录.

use std::collections::HashMap;
use std::path::Path;
use std::{fs, io};

use thiserror::Error;

use crate::cdr::{self, DecodeError, Lookup};
use crate::hash;
use crate::msg::{self, BaseType, MessageDef, ParseError, normalize_type_name};
use crate::value::Value;

include!(concat!(env!("OUT_DIR"), "/builtin.rs"));

#[derive(Debug, Error)]
pub enum LoadError {
    #[error(transparent)]
    Parse(#[from] ParseError),
    #[error("读 {path} 失败: {source}")]
    Io { path: String, source: io::Error },
}

/// 一个话题的类型能否解码.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decodability {
    Ok,
    /// 没有定义 (或嵌套类型缺定义)
    NoDefinition,
    /// 定义算出的 hash 与发布方声明的不符
    HashMismatch { expected: String, actual: String },
}

impl Decodability {
    pub fn is_ok(&self) -> bool {
        *self == Decodability::Ok
    }

    /// 给人看的原因; 能解码为 None.
    pub fn reason(&self) -> Option<String> {
        match self {
            Decodability::Ok => None,
            Decodability::NoDefinition => Some("无定义".into()),
            Decodability::HashMismatch { expected, actual } => {
                Some(format!("定义与发布方不符 (发布方 {expected}, 本地 {actual})"))
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Registry {
    defs: HashMap<String, MessageDef>,
}

impl Lookup for Registry {
    fn lookup(&self, name: &str) -> Option<&MessageDef> {
        self.defs.get(name)
    }
}

impl Registry {
    /// 空注册表.
    pub fn empty() -> Self {
        Self::default()
    }

    /// 含全部内置类型.
    pub fn builtin() -> Self {
        let mut registry = Self::default();
        for (name, text) in BUILTIN {
            registry.add(name, text).expect("内置 .msg 应能解析");
        }
        registry
    }

    /// 追加一条定义 (同名覆盖). `name` 为 `包/msg/类型` 或 `包/类型`.
    pub fn add(&mut self, name: &str, text: &str) -> Result<(), ParseError> {
        let def = msg::parse(name, text)?;
        self.defs.insert(def.name.clone(), def);
        Ok(())
    }

    /// 追加目录下全部 `<包>/msg/<类型>.msg` (递归查找), 返回条数.
    pub fn add_dir(&mut self, dir: impl AsRef<Path>) -> Result<usize, LoadError> {
        let mut count = 0;
        let mut stack = vec![dir.as_ref().to_path_buf()];
        while let Some(path) = stack.pop() {
            let io_error = |source| LoadError::Io { path: path.display().to_string(), source };
            for entry in fs::read_dir(&path).map_err(io_error)? {
                let entry = entry.map_err(io_error)?.path();
                if entry.is_dir() {
                    stack.push(entry);
                    continue;
                }
                let (Some(stem), Some(parent)) = (entry.file_stem(), entry.parent()) else { continue };
                let is_msg = entry.extension().is_some_and(|e| e == "msg") && parent.file_name().is_some_and(|d| d == "msg");
                let package = parent.parent().and_then(Path::file_name);
                if let (true, Some(package)) = (is_msg, package) {
                    let text = fs::read_to_string(&entry)
                        .map_err(|source| LoadError::Io { path: entry.display().to_string(), source })?;
                    let name = format!("{}/msg/{}", package.to_string_lossy(), stem.to_string_lossy());
                    self.add(&name, &text)?;
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// 按 `包/msg/类型` 或 `包/类型` 取定义.
    pub fn get(&self, name: &str) -> Option<&MessageDef> {
        self.defs.get(normalize_type_name(name, None)?.as_str())
    }

    /// 全部类型名 (无序).
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.defs.keys().map(String::as_str)
    }

    /// 由定义算 RIHS01, 形如 `RIHS01_<64 位十六进制>`.
    pub fn rihs01(&self, name: &str) -> Result<String, DecodeError> {
        let full = normalize_type_name(name, None).ok_or_else(|| DecodeError::MissingType(name.into()))?;
        hash::rihs01(self, &full)
    }

    /// 与发布方声明的 hash 比对. `hash` 为空时只看有无定义.
    pub fn check(&self, name: &str, hash: Option<&str>) -> Decodability {
        match (self.rihs01(name), hash) {
            (Err(_), _) => Decodability::NoDefinition,
            (Ok(actual), Some(expected)) if actual != expected => {
                Decodability::HashMismatch { expected: expected.into(), actual }
            }
            _ => Decodability::Ok,
        }
    }

    /// 按类型名把 CDR 字节 (含 4 字节封装头) 解成值树.
    pub fn decode<'a>(&self, name: &str, payload: &'a [u8]) -> Result<Value<'a>, DecodeError> {
        let def = self.get(name).ok_or_else(|| DecodeError::MissingType(name.into()))?;
        cdr::decode(self, def, payload)
    }

    /// 首字段为 `std_msgs/Header` 时只解其 stamp, 返回纳秒; 否则为 None.
    pub fn header_stamp(&self, name: &str, payload: &[u8]) -> Option<i64> {
        let first = &self.get(name)?.fields.first()?.ty;
        let is_header = first.base == BaseType::Message("std_msgs/msg/Header".into()) && first.array == msg::Array::Single;
        // Header 首字段 stamp: int32 sec + uint32 nanosec, 紧跟封装头, 不需对齐
        let bytes = payload.get(..12).filter(|_| is_header)?;
        let little = bytes[1] == 1;
        let word = |b: &[u8]| {
            let a = b.try_into().unwrap();
            if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) }
        };
        let sec = word(&bytes[4..8]) as i32 as i64;
        let nanosec = word(&bytes[8..12]) as i64;
        Some(sec * 1_000_000_000 + nanosec)
    }
}
