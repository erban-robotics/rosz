//! XCDR1 编码 (解码 [`crate::cdr`] 的反方向): 值树按 `.msg` 定义写成 CDR, 小端, 含 4 字节封装头.
//!
//! 与 rclpy (fastcdr) 序列化的字节一致: 空数组前不写 padding; padding 写 0 (fastcdr 不清零, 内容不定);
//! 长度为实际写出的长度 (rmw_zenoh_cpp 发布时同此; `serialize_message` 返回的是 fastcdr 预估长度, 某些类型尾部偏大).
//! 输入宽松, 校验严格: 值树可以是解码结果, 也可以是 dict 转来的宽松形状 (整数统一 `I64`/`U64`, 浮点 `F64`,
//! 数组为 `List` 或任意数值数组变体), 按字段类型收窄; 字段缺失, 多出, 类型不符, 整数越界, float32 溢出,
//! 定长数组长度不符, 有界序列/字符串超界都立即返回 [`EncodeError::Field`], 指出字段路径.

use thiserror::Error;

use crate::cdr::Lookup;
use crate::msg::{Array, BaseType, FieldType, MessageDef, Primitive};
use crate::value::Value;

const HEADER: [u8; 4] = [0, 1, 0, 0];

#[derive(Debug, Error, PartialEq)]
pub enum EncodeError {
    #[error("没有类型 {0} 的定义")]
    MissingType(String),
    #[error("字段 {path}: {reason}")]
    Field { path: String, reason: String },
}

impl EncodeError {
    /// 出错字段的路径 (如 `header.stamp.sec`, `points.2.x`); 缺类型定义时为空.
    pub fn path(&self) -> &str {
        match self {
            EncodeError::Field { path, .. } => path,
            EncodeError::MissingType(_) => "",
        }
    }
}

pub(crate) fn encode(lookup: &impl Lookup, def: &MessageDef, value: &Value) -> Result<Vec<u8>, EncodeError> {
    let mut writer = Writer { buf: HEADER.to_vec(), path: Vec::new() };
    writer.message(lookup, def, value)?;
    Ok(writer.buf)
}

/// 数组元素或标量的数值视图.
#[derive(Clone, Copy)]
enum Num {
    Bool(bool),
    Int(i128),
    Float(f64),
}

impl Num {
    fn of(value: &Value) -> Option<Num> {
        Some(match *value {
            Value::Bool(v) => Num::Bool(v),
            Value::U64(v) => Num::Int(v.into()),
            Value::F32(v) => Num::Float(v.into()),
            Value::F64(v) => Num::Float(v),
            _ => Num::Int(value.as_i64()?.into()),
        })
    }

    fn kind(self) -> &'static str {
        match self {
            Num::Bool(_) => "布尔",
            Num::Int(_) => "整数",
            Num::Float(_) => "浮点数",
        }
    }
}

struct Writer {
    buf: Vec<u8>,
    path: Vec<String>,
}

impl Writer {
    fn error(&self, reason: impl Into<String>) -> EncodeError {
        EncodeError::Field { path: self.path.join("."), reason: reason.into() }
    }

    fn align(&mut self, n: usize) {
        let rel = self.buf.len() - HEADER.len();
        self.buf.resize(self.buf.len() + (n - rel % n) % n, 0);
    }

    fn u32(&mut self, v: u32) {
        self.align(4);
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    fn length(&mut self, n: usize) -> Result<(), EncodeError> {
        let n = u32::try_from(n).map_err(|_| self.error(format!("长度 {n} 超出 uint32")))?;
        self.u32(n);
        Ok(())
    }

    fn message(&mut self, lookup: &impl Lookup, def: &MessageDef, value: &Value) -> Result<(), EncodeError> {
        let Value::Message(given) = value else {
            return Err(self.error(format!("应为消息 {} (dict), 实为 {}", def.name, describe(value))));
        };
        if let Some((extra, _)) = given.iter().find(|(name, _)| !def.fields.iter().any(|f| f.name == *name) || def.is_empty) {
            self.path.push(extra.to_string());
            return Err(self.error(format!("{} 没有此字段", def.name)));
        }
        if def.is_empty {
            self.buf.push(0);
            return Ok(());
        }
        for field in &def.fields {
            self.path.push(field.name.to_string());
            let found = given.iter().find(|(name, _)| *name == field.name).map(|(_, v)| v);
            let Some(field_value) = found else { return Err(self.error("缺字段")) };
            self.field(lookup, &field.ty, field_value)?;
            self.path.pop();
        }
        Ok(())
    }

    fn field(&mut self, lookup: &impl Lookup, ty: &FieldType, value: &Value) -> Result<(), EncodeError> {
        let len = match value {
            Value::List(items) => items.len(),
            Value::Bytes(v) => v.len(),
            _ => match value.numeric_len() {
                Some(n) => n,
                None if ty.array == Array::Single => return self.single(lookup, &ty.base, value),
                None => return Err(self.error(format!("应为数组, 实为 {}", describe(value)))),
            },
        };
        match ty.array {
            Array::Single => return self.single(lookup, &ty.base, value),
            Array::Fixed(n) if len != n => return Err(self.error(format!("定长数组应有 {n} 个元素, 实有 {len}"))),
            Array::Bounded(bound) if len > bound => return Err(self.error(format!("至多 {bound} 个元素, 实有 {len}"))),
            Array::Fixed(_) => {}
            Array::Bounded(_) | Array::Unbounded => self.length(len)?,
        }
        if len == 0 {
            return Ok(());
        }
        match (&ty.base, value) {
            (BaseType::Primitive(Primitive::Byte | Primitive::Char | Primitive::U8), Value::Bytes(bytes)) => {
                self.buf.extend_from_slice(bytes);
            }
            (BaseType::Primitive(p), Value::List(items)) => {
                for (i, item) in items.iter().enumerate() {
                    self.path.push(i.to_string());
                    self.primitive(*p, item)?;
                    self.path.pop();
                }
            }
            (BaseType::Primitive(p), _) => {
                for i in 0..len {
                    self.path.push(i.to_string());
                    let num = numeric_item(value, i);
                    self.number(*p, num)?;
                    self.path.pop();
                }
            }
            (base, Value::List(items)) => {
                for (i, item) in items.iter().enumerate() {
                    self.path.push(i.to_string());
                    self.single(lookup, base, item)?;
                    self.path.pop();
                }
            }
            (_, _) => return Err(self.error(format!("应为字符串或消息的列表, 实为 {}", describe(value)))),
        }
        Ok(())
    }

    fn single(&mut self, lookup: &impl Lookup, base: &BaseType, value: &Value) -> Result<(), EncodeError> {
        match base {
            BaseType::Primitive(p) => self.primitive(*p, value),
            BaseType::String { bound } => {
                let Value::String(s) = value else { return Err(self.error(format!("应为字符串, 实为 {}", describe(value)))) };
                self.check_bound(*bound, s)?;
                self.length(s.len() + 1)?;
                self.buf.extend_from_slice(s.as_bytes());
                self.buf.push(0);
                Ok(())
            }
            BaseType::WString { bound } => {
                let Value::String(s) = value else { return Err(self.error(format!("应为字符串, 实为 {}", describe(value)))) };
                self.check_bound(*bound, s)?;
                self.length(s.chars().count())?;
                for c in s.chars() {
                    self.buf.extend_from_slice(&(c as u32).to_le_bytes());
                }
                Ok(())
            }
            BaseType::Message(name) => {
                let def = lookup.lookup(name).ok_or_else(|| EncodeError::MissingType(name.clone()))?;
                self.message(lookup, def, value)
            }
        }
    }

    /// 上限按字符数 (同 rclpy).
    fn check_bound(&self, bound: Option<usize>, s: &str) -> Result<(), EncodeError> {
        match bound {
            Some(bound) if s.chars().count() > bound => {
                Err(self.error(format!("字符串至多 {bound} 个字符, 实有 {}", s.chars().count())))
            }
            _ => Ok(()),
        }
    }

    fn primitive(&mut self, p: Primitive, value: &Value) -> Result<(), EncodeError> {
        let num = Num::of(value).ok_or_else(|| self.error(format!("应为数值, 实为 {}", describe(value))))?;
        self.number(p, num)
    }

    fn number(&mut self, p: Primitive, num: Num) -> Result<(), EncodeError> {
        macro_rules! int {
            ($t:ty) => {{
                let Num::Int(v) = num else { return Err(self.error(format!("应为整数, 实为{}", num.kind()))) };
                let v = <$t>::try_from(v).map_err(|_| self.error(format!("{v} 超出 {} 范围", stringify!($t))))?;
                self.align(size_of::<$t>());
                self.buf.extend_from_slice(&v.to_le_bytes());
            }};
        }
        match p {
            Primitive::Bool => {
                let Num::Bool(v) = num else { return Err(self.error(format!("应为布尔, 实为{}", num.kind()))) };
                self.buf.push(v as u8);
            }
            Primitive::Byte | Primitive::Char | Primitive::U8 => int!(u8),
            Primitive::I8 => int!(i8),
            Primitive::I16 => int!(i16),
            Primitive::U16 => int!(u16),
            Primitive::I32 => int!(i32),
            Primitive::U32 => int!(u32),
            Primitive::I64 => int!(i64),
            Primitive::U64 => int!(u64),
            Primitive::F32 => {
                let v = self.float(num)?;
                if v.is_finite() && v.abs() > f32::MAX as f64 {
                    return Err(self.error(format!("{v} 超出 float32 范围")));
                }
                self.align(4);
                self.buf.extend_from_slice(&(v as f32).to_le_bytes());
            }
            Primitive::F64 => {
                let v = self.float(num)?;
                self.align(8);
                self.buf.extend_from_slice(&v.to_le_bytes());
            }
        }
        Ok(())
    }

    /// 浮点字段也收整数.
    fn float(&self, num: Num) -> Result<f64, EncodeError> {
        match num {
            Num::Float(v) => Ok(v),
            Num::Int(v) => Ok(v as f64),
            Num::Bool(_) => Err(self.error("应为浮点数, 实为布尔")),
        }
    }
}

/// 数值数组第 `i` 个元素 (调用方保证 `i` 在范围内).
fn numeric_item(value: &Value, i: usize) -> Num {
    match value {
        Value::Bytes(v) => Num::Int(v[i].into()),
        Value::Bools(v) => Num::Bool(v[i]),
        Value::I8s(v) => Num::Int(v[i].into()),
        Value::I16s(v) => Num::Int(v[i].into()),
        Value::U16s(v) => Num::Int(v[i].into()),
        Value::I32s(v) => Num::Int(v[i].into()),
        Value::U32s(v) => Num::Int(v[i].into()),
        Value::I64s(v) => Num::Int(v[i].into()),
        Value::U64s(v) => Num::Int(v[i].into()),
        Value::F32s(v) => Num::Float(v[i].into()),
        Value::F64s(v) => Num::Float(v[i]),
        _ => unreachable!("numeric_item 只用于数值数组"),
    }
}

fn describe(value: &Value) -> &'static str {
    match value {
        Value::Bool(_) => "布尔",
        Value::F32(_) | Value::F64(_) => "浮点数",
        Value::String(_) => "字符串",
        Value::Message(_) => "消息",
        Value::List(_) => "列表",
        Value::Bytes(_) => "字节数组",
        v if v.numeric_len().is_some() => "数值数组",
        _ => "整数",
    }
}
