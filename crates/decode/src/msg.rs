//! `.msg` 文本解析. 规则依 rosidl_adapter (jazzy): 行为 `类型 名字 [默认值]` 或 `类型 名字=值` (常量);
//! 无字段的消息补 `uint8 structure_needs_at_least_one_member`, 线上占 1 字节, hash 也算它.

use std::sync::Arc;

use thiserror::Error;

#[derive(Debug, Error)]
#[error("{type_name} 第 {line} 行: {reason}")]
pub struct ParseError {
    pub type_name: String,
    pub line: usize,
    pub reason: String,
}

/// 基础类型. `char` 在 IDL 里是 uint8, `byte` 是 octet: 线上都占 1 字节, 区别只在 hash 与语义.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Primitive {
    Bool,
    Byte,
    Char,
    I8,
    U8,
    I16,
    U16,
    I32,
    U32,
    I64,
    U64,
    F32,
    F64,
}

impl Primitive {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "bool" => Self::Bool,
            "byte" => Self::Byte,
            "char" => Self::Char,
            "int8" => Self::I8,
            "uint8" => Self::U8,
            "int16" => Self::I16,
            "uint16" => Self::U16,
            "int32" => Self::I32,
            "uint32" => Self::U32,
            "int64" => Self::I64,
            "uint64" => Self::U64,
            "float32" => Self::F32,
            "float64" => Self::F64,
            _ => return None,
        })
    }

    /// 线上字节数, 也是 XCDR1 的对齐字节数.
    pub fn size(self) -> usize {
        match self {
            Self::Bool | Self::Byte | Self::Char | Self::I8 | Self::U8 => 1,
            Self::I16 | Self::U16 => 2,
            Self::I32 | Self::U32 | Self::F32 => 4,
            Self::I64 | Self::U64 | Self::F64 => 8,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BaseType {
    Primitive(Primitive),
    /// `string` 或 `string<=N`
    String { bound: Option<usize> },
    /// `wstring` 或 `wstring<=N`
    WString { bound: Option<usize> },
    /// 嵌套消息, 全名 `包/msg/类型`
    Message(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Array {
    Single,
    /// `[N]`, 线上不写长度
    Fixed(usize),
    /// `[<=N]`, 线上与不定长相同, 上限只在 hash 里体现
    Bounded(usize),
    /// `[]`
    Unbounded,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldType {
    pub base: BaseType,
    pub array: Array,
}

#[derive(Clone, Debug)]
pub struct Field {
    pub name: Arc<str>,
    pub ty: FieldType,
}

#[derive(Clone, Debug)]
pub struct Constant {
    pub ty: FieldType,
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug)]
pub struct MessageDef {
    /// `包/msg/类型`
    pub name: String,
    pub fields: Vec<Field>,
    pub constants: Vec<Constant>,
    /// 原 `.msg` 文本
    pub text: String,
    /// 原文无字段: `fields` 只有补的占位字段, 线上占 1 字节, 值树里不出现 (同 rclpy)
    pub is_empty: bool,
}

const EMPTY_MESSAGE_FIELD: &str = "structure_needs_at_least_one_member";

/// 解析一条 `.msg`. `name` 为 `包/msg/类型` (也接受 `包/类型`).
pub fn parse(name: &str, text: &str) -> Result<MessageDef, ParseError> {
    let name = normalize_type_name(name, None)
        .ok_or_else(|| ParseError { type_name: name.into(), line: 0, reason: "类型名应为 包/msg/类型".into() })?;
    let package = name.split('/').next().unwrap().to_owned();
    let mut fields = Vec::new();
    let mut constants = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let error = |reason: String| ParseError { type_name: name.clone(), line: index + 1, reason };
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 只取类型与名字两段; 默认值与常量值可能含 `#`, 不按注释剥, 也不参与解码与 hash
        let (type_text, rest) = line.split_once(char::is_whitespace).ok_or_else(|| error("缺字段名".into()))?;
        let rest = rest.trim_start();
        let name_end = rest.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(rest.len());
        let field_name = &rest[..name_end];
        if field_name.is_empty() {
            return Err(error("缺字段名".into()));
        }
        let ty = parse_field_type(type_text, &package).map_err(error)?;
        let after = rest[name_end..].trim_start();
        if let Some(value) = after.strip_prefix('=') {
            constants.push(Constant { ty, name: field_name.into(), value: value.trim().into() });
        } else {
            fields.push(Field { name: field_name.into(), ty });
        }
    }
    let is_empty = fields.is_empty();
    if is_empty {
        fields.push(Field {
            name: EMPTY_MESSAGE_FIELD.into(),
            ty: FieldType { base: BaseType::Primitive(Primitive::U8), array: Array::Single },
        });
    }
    Ok(MessageDef { name, fields, constants, text: text.into(), is_empty })
}

/// `包/类型` 补成 `包/msg/类型`; 只有 `类型` 时按 `package` 补. 不合法返回 None.
pub fn normalize_type_name(name: &str, package: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = name.split('/').collect();
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    match parts.as_slice() {
        [pkg, "msg", ty] if valid(pkg) && valid(ty) => Some(name.into()),
        [pkg, ty] if valid(pkg) && valid(ty) => Some(format!("{pkg}/msg/{ty}")),
        [ty] if valid(ty) => package.map(|p| format!("{p}/msg/{ty}")),
        _ => None,
    }
}

fn parse_field_type(text: &str, package: &str) -> Result<FieldType, String> {
    let (base_text, array) = match text.find('[') {
        Some(open) => {
            let inner = text[open..].strip_prefix('[').and_then(|s| s.strip_suffix(']'));
            let inner = inner.ok_or_else(|| format!("数组后缀不合法: {text}"))?;
            let array = if inner.is_empty() {
                Array::Unbounded
            } else if let Some(bound) = inner.strip_prefix("<=") {
                Array::Bounded(parse_size(bound, text)?)
            } else {
                Array::Fixed(parse_size(inner, text)?)
            };
            (&text[..open], array)
        }
        None => (text, Array::Single),
    };
    let base = if let Some(p) = Primitive::parse(base_text) {
        BaseType::Primitive(p)
    } else if base_text == "string" {
        BaseType::String { bound: None }
    } else if base_text == "wstring" {
        BaseType::WString { bound: None }
    } else if let Some(bound) = base_text.strip_prefix("string<=") {
        BaseType::String { bound: Some(parse_size(bound, text)?) }
    } else if let Some(bound) = base_text.strip_prefix("wstring<=") {
        BaseType::WString { bound: Some(parse_size(bound, text)?) }
    } else {
        let full = normalize_type_name(base_text, Some(package)).ok_or_else(|| format!("类型不合法: {text}"))?;
        BaseType::Message(full)
    };
    Ok(FieldType { base, array })
}

fn parse_size(s: &str, text: &str) -> Result<usize, String> {
    s.parse().map_err(|_| format!("长度不合法: {text}"))
}
