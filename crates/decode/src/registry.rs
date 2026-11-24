//! `.msg` / `.srv` 注册表: 编译期内置 common_interfaces jazzy 全套 (含其 `.srv`) 与 erban 自定义类型, 运行时可追加目录.
//!
//! `.srv` 登记为 4 个类型 (见 [`crate::srv`]): `包/srv/X_Request` 与 `包/srv/X_Response` 可直接编解码,
//! `rihs01("包/srv/X")` 为服务的 type hash.

use std::collections::HashMap;
use std::path::Path;
use std::{fs, io};

use thiserror::Error;

use crate::cdr::{self, DecodeError, Lookup};
use crate::encode::{self, EncodeError};
use crate::hash;
use crate::srv;
use crate::msg::{self, BaseType, FieldType, MessageDef, ParseError, Primitive, normalize_type_name};
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
            registry.add(name, text).expect("内置 .msg/.srv 应能解析");
        }
        registry
    }

    /// 追加一条定义 (同名覆盖). `name` 为 `包/msg/类型` 或 `包/类型` (`.msg` 文本), 或 `包/srv/类型` (`.srv` 文本).
    pub fn add(&mut self, name: &str, text: &str) -> Result<(), ParseError> {
        let defs = if name.split('/').nth(1) == Some("srv") {
            srv::parse(name, text)?.into()
        } else {
            vec![msg::parse(name, text)?]
        };
        for def in defs {
            self.defs.insert(def.name.clone(), def);
        }
        Ok(())
    }

    /// 追加目录下全部 `<包>/msg/<类型>.msg` 与 `<包>/srv/<类型>.srv` (递归查找), 返回文件数.
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
                let kind = entry.extension().and_then(|e| e.to_str()).filter(|e| *e == "msg" || *e == "srv");
                let kind = kind.filter(|k| parent.file_name().is_some_and(|d| d == *k));
                let package = parent.parent().and_then(Path::file_name);
                if let (Some(kind), Some(package)) = (kind, package) {
                    let text = fs::read_to_string(&entry)
                        .map_err(|source| LoadError::Io { path: entry.display().to_string(), source })?;
                    let name = format!("{}/{kind}/{}", package.to_string_lossy(), stem.to_string_lossy());
                    self.add(&name, &text)?;
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// 按 `包/msg/类型`, `包/类型` 或 `包/srv/类型_Request` 等取定义.
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

    /// 按类型名把值树编码为 CDR 字节 (含 4 字节封装头, 小端), 与 rclpy (fastcdr) 序列化逐字节一致 (padding 写 0).
    /// 值树可以是解码结果, 也可以是宽松形状 (见 [`EncodeError`] 所在模块说明): 按定义收窄并校验, 坏值不编出字节.
    pub fn encode(&self, name: &str, value: &Value) -> Result<Vec<u8>, EncodeError> {
        let def = self.get(name).ok_or_else(|| EncodeError::MissingType(name.into()))?;
        encode::encode(self, def, value)
    }

    /// 类型的零值: 数值 0, bool false, 字符串空, 不定长与有界数组空, 定长数组 N 个零值, 嵌套消息逐字段零值
    /// (同 rclpy 新建消息对象; `.msg` 里声明的默认值不取). 形状同解码结果, 可直接编码.
    pub fn zero_value(&self, name: &str) -> Result<Value<'static>, DecodeError> {
        let def = self.get(name).ok_or_else(|| DecodeError::MissingType(name.into()))?;
        self.zero_message(def)
    }

    fn zero_message(&self, def: &MessageDef) -> Result<Value<'static>, DecodeError> {
        if def.is_empty {
            return Ok(Value::Message(Vec::new()));
        }
        let fields = def.fields.iter().map(|f| Ok((f.name.clone(), self.zero_field(&f.ty)?)));
        Ok(Value::Message(fields.collect::<Result<_, DecodeError>>()?))
    }

    fn zero_field(&self, ty: &FieldType) -> Result<Value<'static>, DecodeError> {
        let n = match ty.array {
            msg::Array::Single => return self.zero_single(&ty.base),
            msg::Array::Fixed(n) => n,
            msg::Array::Bounded(_) | msg::Array::Unbounded => 0,
        };
        Ok(match &ty.base {
            BaseType::Primitive(p) => match p {
                Primitive::Bool => Value::Bools(vec![false; n]),
                Primitive::Byte | Primitive::Char | Primitive::U8 => Value::Bytes(vec![0; n].into()),
                Primitive::I8 => Value::I8s(vec![0; n]),
                Primitive::I16 => Value::I16s(vec![0; n]),
                Primitive::U16 => Value::U16s(vec![0; n]),
                Primitive::I32 => Value::I32s(vec![0; n]),
                Primitive::U32 => Value::U32s(vec![0; n]),
                Primitive::I64 => Value::I64s(vec![0; n]),
                Primitive::U64 => Value::U64s(vec![0; n]),
                Primitive::F32 => Value::F32s(vec![0.0; n]),
                Primitive::F64 => Value::F64s(vec![0.0; n]),
            },
            base => Value::List((0..n).map(|_| self.zero_single(base)).collect::<Result<_, _>>()?),
        })
    }

    fn zero_single(&self, base: &BaseType) -> Result<Value<'static>, DecodeError> {
        Ok(match base {
            BaseType::Primitive(p) => match p {
                Primitive::Bool => Value::Bool(false),
                Primitive::Byte | Primitive::Char | Primitive::U8 => Value::U8(0),
                Primitive::I8 => Value::I8(0),
                Primitive::I16 => Value::I16(0),
                Primitive::U16 => Value::U16(0),
                Primitive::I32 => Value::I32(0),
                Primitive::U32 => Value::U32(0),
                Primitive::I64 => Value::I64(0),
                Primitive::U64 => Value::U64(0),
                Primitive::F32 => Value::F32(0.0),
                Primitive::F64 => Value::F64(0.0),
            },
            BaseType::String { .. } | BaseType::WString { .. } => Value::String(String::new()),
            BaseType::Message(name) => {
                let def = self.defs.get(name).ok_or_else(|| DecodeError::MissingType(name.clone()))?;
                self.zero_message(def)?
            }
        })
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
