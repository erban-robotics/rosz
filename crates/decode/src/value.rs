//! 解码结果: 保持 `.msg` 字段顺序的值树.

use std::borrow::Cow;
use std::sync::Arc;

/// 一个字段的值. 数值数组按元素类型成独立变体; `uint8[]` / `byte[]` / `char[]` 借用输入, 零拷贝.
#[derive(Clone, Debug, PartialEq)]
pub enum Value<'a> {
    Bool(bool),
    I8(i8),
    /// 也用于 `byte` 与 `char`
    U8(u8),
    I16(i16),
    U16(u16),
    I32(i32),
    U32(u32),
    I64(i64),
    U64(u64),
    F32(f32),
    F64(f64),
    /// `string` 与 `wstring`
    String(String),
    /// 字段按 `.msg` 顺序; 字段名与定义表共享
    Message(Vec<(Arc<str>, Value<'a>)>),
    /// `uint8[]` / `byte[]` / `char[]` (含定长与有界)
    Bytes(Cow<'a, [u8]>),
    Bools(Vec<bool>),
    I8s(Vec<i8>),
    I16s(Vec<i16>),
    U16s(Vec<u16>),
    I32s(Vec<i32>),
    U32s(Vec<u32>),
    I64s(Vec<i64>),
    U64s(Vec<u64>),
    F32s(Vec<f32>),
    F64s(Vec<f64>),
    /// 字符串数组与消息数组
    List(Vec<Value<'a>>),
}

impl<'a> Value<'a> {
    /// 脱离输入缓冲 (借用的字节数组复制一份).
    pub fn into_owned(self) -> Value<'static> {
        match self {
            Value::Bool(v) => Value::Bool(v),
            Value::I8(v) => Value::I8(v),
            Value::U8(v) => Value::U8(v),
            Value::I16(v) => Value::I16(v),
            Value::U16(v) => Value::U16(v),
            Value::I32(v) => Value::I32(v),
            Value::U32(v) => Value::U32(v),
            Value::I64(v) => Value::I64(v),
            Value::U64(v) => Value::U64(v),
            Value::F32(v) => Value::F32(v),
            Value::F64(v) => Value::F64(v),
            Value::String(v) => Value::String(v),
            Value::Message(fields) => Value::Message(fields.into_iter().map(|(k, v)| (k, v.into_owned())).collect()),
            Value::Bytes(v) => Value::Bytes(Cow::Owned(v.into_owned())),
            Value::Bools(v) => Value::Bools(v),
            Value::I8s(v) => Value::I8s(v),
            Value::I16s(v) => Value::I16s(v),
            Value::U16s(v) => Value::U16s(v),
            Value::I32s(v) => Value::I32s(v),
            Value::U32s(v) => Value::U32s(v),
            Value::I64s(v) => Value::I64s(v),
            Value::U64s(v) => Value::U64s(v),
            Value::F32s(v) => Value::F32s(v),
            Value::F64s(v) => Value::F64s(v),
            Value::List(v) => Value::List(v.into_iter().map(Value::into_owned).collect()),
        }
    }

    /// 消息的字段; 非消息或无此字段为 None.
    pub fn get(&self, field: &str) -> Option<&Value<'a>> {
        match self {
            Value::Message(fields) => fields.iter().find(|(name, _)| &**name == field).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Value::Bytes(b) => Some(b),
            _ => None,
        }
    }

    /// 整数标量转 i64 (u64 超出时为 None).
    pub fn as_i64(&self) -> Option<i64> {
        Some(match *self {
            Value::I8(v) => v.into(),
            Value::U8(v) => v.into(),
            Value::I16(v) => v.into(),
            Value::U16(v) => v.into(),
            Value::I32(v) => v.into(),
            Value::U32(v) => v.into(),
            Value::I64(v) => v,
            Value::U64(v) => v.try_into().ok()?,
            _ => return None,
        })
    }

    /// 数值标量转 f64 (bool 不算数值).
    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            Value::F32(v) => Some(v.into()),
            Value::F64(v) => Some(v),
            Value::U64(v) => Some(v as f64),
            _ => self.as_i64().map(|v| v as f64),
        }
    }

    /// 数值数组的元素个数; 非数值数组为 None.
    pub fn numeric_len(&self) -> Option<usize> {
        Some(match self {
            Value::Bytes(v) => v.len(),
            Value::Bools(v) => v.len(),
            Value::I8s(v) => v.len(),
            Value::I16s(v) => v.len(),
            Value::U16s(v) => v.len(),
            Value::I32s(v) => v.len(),
            Value::U32s(v) => v.len(),
            Value::I64s(v) => v.len(),
            Value::U64s(v) => v.len(),
            Value::F32s(v) => v.len(),
            Value::F64s(v) => v.len(),
            _ => return None,
        })
    }

    /// 数值数组第 `i` 个元素转 f64.
    pub fn numeric_at(&self, i: usize) -> Option<f64> {
        Some(match self {
            Value::Bytes(v) => *v.get(i)? as f64,
            Value::Bools(v) => *v.get(i)? as u8 as f64,
            Value::I8s(v) => *v.get(i)? as f64,
            Value::I16s(v) => *v.get(i)? as f64,
            Value::U16s(v) => *v.get(i)? as f64,
            Value::I32s(v) => *v.get(i)? as f64,
            Value::U32s(v) => *v.get(i)? as f64,
            Value::I64s(v) => *v.get(i)? as f64,
            Value::U64s(v) => *v.get(i)? as f64,
            Value::F32s(v) => *v.get(i)? as f64,
            Value::F64s(v) => *v.get(i)?,
            _ => return None,
        })
    }

    /// 转 JSON. 浮点 NaN / 无穷为 null; 整数保持精度 (serde_json 支持 64 位整数).
    #[cfg(feature = "json")]
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as J;
        fn arr<T: Copy>(v: &[T], f: impl Fn(T) -> J) -> J {
            J::Array(v.iter().map(|x| f(*x)).collect())
        }
        let float = |v: f64| serde_json::Number::from_f64(v).map_or(J::Null, J::Number);
        match self {
            Value::Bool(v) => J::Bool(*v),
            Value::I8(v) => (*v).into(),
            Value::U8(v) => (*v).into(),
            Value::I16(v) => (*v).into(),
            Value::U16(v) => (*v).into(),
            Value::I32(v) => (*v).into(),
            Value::U32(v) => (*v).into(),
            Value::I64(v) => (*v).into(),
            Value::U64(v) => (*v).into(),
            Value::F32(v) => float((*v).into()),
            Value::F64(v) => float(*v),
            Value::String(v) => J::String(v.clone()),
            Value::Message(fields) => J::Object(fields.iter().map(|(k, v)| (k.to_string(), v.to_json())).collect()),
            Value::Bytes(v) => arr(v, J::from),
            Value::Bools(v) => arr(v, J::Bool),
            Value::I8s(v) => arr(v, J::from),
            Value::I16s(v) => arr(v, J::from),
            Value::U16s(v) => arr(v, J::from),
            Value::I32s(v) => arr(v, J::from),
            Value::U32s(v) => arr(v, J::from),
            Value::I64s(v) => arr(v, J::from),
            Value::U64s(v) => arr(v, J::from),
            Value::F32s(v) => arr(v, |x| float(x.into())),
            Value::F64s(v) => arr(v, float),
            Value::List(v) => J::Array(v.iter().map(Value::to_json).collect()),
        }
    }
}
