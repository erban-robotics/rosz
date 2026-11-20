//! XCDR1 (rmw_zenoh 用 fastcdr `DDS_CDR`) 解码.
//!
//! 4 字节封装头, `[1]` 为 1 表示小端; 对齐以头之后为 0 点, 基础类型按自身大小对齐 (最大 8).
//! 宽容: 不校验 padding 内容 (rmw_zenoh 不清零), 不校验尾部多余字节 (以空 `float64[]` 结尾时多 4 字节).
//! 严格: 每次读查越界, 声明长度不得超过剩余字节.

use std::borrow::Cow;

use thiserror::Error;

use crate::msg::{Array, BaseType, FieldType, MessageDef, Primitive};
use crate::value::Value;

const HEADER_LEN: usize = 4;

#[derive(Debug, Error, PartialEq)]
pub enum DecodeError {
    #[error("没有类型 {0} 的定义")]
    MissingType(String),
    #[error("消息过短: 不足 4 字节封装头")]
    NoHeader,
    #[error("不支持的封装 {0:#04x} {1:#04x}")]
    Encapsulation(u8, u8),
    #[error("字段 {field}: 偏移 {offset} 处需要 {need} 字节, 只剩 {left}")]
    OutOfBounds { field: String, offset: usize, need: usize, left: usize },
    #[error("字段 {field}: 字符串不是合法 UTF-8")]
    InvalidString { field: String },
}

/// 按名取定义, 解码时查嵌套类型.
pub(crate) trait Lookup {
    fn lookup(&self, name: &str) -> Option<&MessageDef>;
}

pub(crate) fn decode<'a>(lookup: &impl Lookup, def: &MessageDef, payload: &'a [u8]) -> Result<Value<'a>, DecodeError> {
    if payload.len() < HEADER_LEN {
        return Err(DecodeError::NoHeader);
    }
    let little = match (payload[0], payload[1]) {
        (0, 1) => true,
        (0, 0) => false,
        (a, b) => return Err(DecodeError::Encapsulation(a, b)),
    };
    let mut reader = Reader { buf: payload, pos: HEADER_LEN, little, path: Vec::new() };
    reader.message(lookup, def)
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    little: bool,
    /// 当前字段路径, 只用于报错
    path: Vec<String>,
}

macro_rules! read_num {
    ($self:ident, $t:ty) => {{
        let bytes: [u8; size_of::<$t>()] = $self.take_aligned(size_of::<$t>(), size_of::<$t>())?.try_into().unwrap();
        if $self.little { <$t>::from_le_bytes(bytes) } else { <$t>::from_be_bytes(bytes) }
    }};
}

macro_rules! read_vec {
    ($self:ident, $n:expr, $t:ty) => {{
        let size = size_of::<$t>();
        let bytes = $self.take_aligned($n * size, size)?;
        let little = $self.little;
        bytes
            .chunks_exact(size)
            .map(|c| {
                let a = c.try_into().unwrap();
                if little { <$t>::from_le_bytes(a) } else { <$t>::from_be_bytes(a) }
            })
            .collect::<Vec<$t>>()
    }};
}

impl<'a> Reader<'a> {
    fn left(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    fn out_of_bounds(&self, need: usize) -> DecodeError {
        DecodeError::OutOfBounds { field: self.path.join("."), offset: self.pos, need, left: self.left() }
    }

    fn align(&mut self, n: usize) {
        let rel = self.pos - HEADER_LEN;
        self.pos += (n - rel % n) % n;
    }

    /// 先对齐到 `align` 再取 `n` 字节; `n` 为 0 时不对齐 (fastcdr 对空数组不写 padding).
    fn take_aligned(&mut self, n: usize, align: usize) -> Result<&'a [u8], DecodeError> {
        if n == 0 {
            return Ok(&[]);
        }
        let start = self.pos;
        self.align(align);
        if n > self.left() {
            let error = self.out_of_bounds(n);
            self.pos = start;
            return Err(error);
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    /// 读 u32 长度, 并检查 `count * min_size` 不超过剩余字节 (防坏包巨量分配).
    fn length(&mut self, min_size: usize) -> Result<usize, DecodeError> {
        let count = read_num!(self, u32) as usize;
        if count.saturating_mul(min_size) > self.left() {
            return Err(self.out_of_bounds(count.saturating_mul(min_size)));
        }
        Ok(count)
    }

    fn message(&mut self, lookup: &impl Lookup, def: &MessageDef) -> Result<Value<'a>, DecodeError> {
        let mut fields = Vec::with_capacity(def.fields.len());
        for field in &def.fields {
            self.path.push(field.name.to_string());
            let value = self.field(lookup, &field.ty)?;
            self.path.pop();
            fields.push((field.name.clone(), value));
        }
        if def.is_empty {
            fields.clear();
        }
        Ok(Value::Message(fields))
    }

    fn field(&mut self, lookup: &impl Lookup, ty: &FieldType) -> Result<Value<'a>, DecodeError> {
        let count = match ty.array {
            Array::Single => return self.single(lookup, &ty.base),
            Array::Fixed(n) => n,
            Array::Bounded(_) | Array::Unbounded => self.length(min_size(&ty.base))?,
        };
        if count.saturating_mul(min_size(&ty.base)) > self.left() {
            return Err(self.out_of_bounds(count.saturating_mul(min_size(&ty.base))));
        }
        Ok(match &ty.base {
            BaseType::Primitive(p) => self.primitives(*p, count)?,
            base => {
                let mut items = Vec::with_capacity(count);
                for i in 0..count {
                    self.path.push(i.to_string());
                    items.push(self.single(lookup, base)?);
                    self.path.pop();
                }
                Value::List(items)
            }
        })
    }

    fn single(&mut self, lookup: &impl Lookup, base: &BaseType) -> Result<Value<'a>, DecodeError> {
        Ok(match base {
            BaseType::Primitive(p) => self.primitive(*p)?,
            BaseType::String { .. } => Value::String(self.string()?),
            BaseType::WString { .. } => Value::String(self.wstring()?),
            BaseType::Message(name) => {
                let def = lookup.lookup(name).ok_or_else(|| DecodeError::MissingType(name.clone()))?;
                self.message(lookup, def)?
            }
        })
    }

    fn primitive(&mut self, p: Primitive) -> Result<Value<'a>, DecodeError> {
        Ok(match p {
            Primitive::Bool => Value::Bool(read_num!(self, u8) != 0),
            Primitive::Byte | Primitive::Char | Primitive::U8 => Value::U8(read_num!(self, u8)),
            Primitive::I8 => Value::I8(read_num!(self, i8)),
            Primitive::I16 => Value::I16(read_num!(self, i16)),
            Primitive::U16 => Value::U16(read_num!(self, u16)),
            Primitive::I32 => Value::I32(read_num!(self, i32)),
            Primitive::U32 => Value::U32(read_num!(self, u32)),
            Primitive::I64 => Value::I64(read_num!(self, i64)),
            Primitive::U64 => Value::U64(read_num!(self, u64)),
            Primitive::F32 => Value::F32(read_num!(self, f32)),
            Primitive::F64 => Value::F64(read_num!(self, f64)),
        })
    }

    fn primitives(&mut self, p: Primitive, n: usize) -> Result<Value<'a>, DecodeError> {
        Ok(match p {
            Primitive::Byte | Primitive::Char | Primitive::U8 => Value::Bytes(Cow::Borrowed(self.take_aligned(n, 1)?)),
            Primitive::Bool => Value::Bools(self.take_aligned(n, 1)?.iter().map(|b| *b != 0).collect()),
            Primitive::I8 => Value::I8s(read_vec!(self, n, i8)),
            Primitive::I16 => Value::I16s(read_vec!(self, n, i16)),
            Primitive::U16 => Value::U16s(read_vec!(self, n, u16)),
            Primitive::I32 => Value::I32s(read_vec!(self, n, i32)),
            Primitive::U32 => Value::U32s(read_vec!(self, n, u32)),
            Primitive::I64 => Value::I64s(read_vec!(self, n, i64)),
            Primitive::U64 => Value::U64s(read_vec!(self, n, u64)),
            Primitive::F32 => Value::F32s(read_vec!(self, n, f32)),
            Primitive::F64 => Value::F64s(read_vec!(self, n, f64)),
        })
    }

    /// `u32 长度 (含结尾 NUL)` + 字节.
    fn string(&mut self) -> Result<String, DecodeError> {
        let len = self.length(1)?;
        let bytes = self.take_aligned(len, 1)?;
        let bytes = bytes.strip_suffix(&[0]).unwrap_or(bytes);
        String::from_utf8(bytes.to_vec()).map_err(|_| DecodeError::InvalidString { field: self.path.join(".") })
    }

    /// fastcdr: `u32 字符数 (不含结尾)` + 每字符 4 字节.
    fn wstring(&mut self) -> Result<String, DecodeError> {
        let len = self.length(4)?;
        let chars = read_vec!(self, len, u32);
        chars
            .into_iter()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or_else(|| DecodeError::InvalidString { field: self.path.join(".") })
    }
}

/// 一个元素线上至少占的字节数, 用于长度合理性检查.
fn min_size(base: &BaseType) -> usize {
    match base {
        BaseType::Primitive(p) => p.size(),
        BaseType::String { .. } | BaseType::WString { .. } => 4,
        BaseType::Message(_) => 1,
    }
}
