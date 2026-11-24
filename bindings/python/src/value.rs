//! Python 值转值树里发布与服务共用的部分: dict 等转值树 ([`to_value`]) 与编码错误 ([`encode_error`]).
//!
//! 转值树只看 Python 类型, 不看定义: 整数为 I64 (超出时 U64), 浮点 F64, list/tuple 为 List,
//! bytes/bytearray 与 uint8 numpy 数组为字节数组, 其他 numpy 数组按 dtype 成数值数组 (多维按 C 序展平),
//! numpy 标量取 `.item()`. 按定义收窄与校验在 rosz-decode 编码时做, 不合即抛 `rosz.EncodeError` (ValueError 子类, `path` 为字段路径).

use std::borrow::Cow;
use std::sync::Arc;

use numpy::{PyArrayDyn, PyArrayMethods, PyUntypedArray, PyUntypedArrayMethods};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyByteArray, PyBytes, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use rosz_access::{EncodeError as RustEncodeError, Value};

pyo3::create_exception!(rosz, EncodeError, PyValueError, "值不合消息定义 (字段缺失, 多出, 类型不符, 越界等); `path` 为字段路径");

/// 抛给 Python 的编码错误, 带 `path` 属性.
pub(crate) fn encode_error(py: Python<'_>, error: &RustEncodeError) -> PyErr {
    let err = EncodeError::new_err(error.to_string());
    let _ = err.value(py).setattr("path", error.path());
    err
}

/// Python 值 (dict 等) 转值树; 不支持的 Python 类型抛 `rosz.EncodeError`.
pub(crate) fn to_value(obj: &Bound<'_, PyAny>) -> PyResult<Value<'static>> {
    let mut path = Vec::new();
    convert(obj, &mut path)
        .map_err(|reason| encode_error(obj.py(), &RustEncodeError::Field { path: path.join("."), reason }))
}

fn convert(obj: &Bound<'_, PyAny>, path: &mut Vec<String>) -> Result<Value<'static>, String> {
    let py_err = |e: PyErr| e.to_string();
    if obj.is_instance_of::<PyBool>() {
        return Ok(Value::Bool(obj.extract().map_err(py_err)?));
    }
    if obj.is_instance_of::<PyInt>() {
        if let Ok(v) = obj.extract::<i64>() {
            return Ok(Value::I64(v));
        }
        return obj.extract::<u64>().map(Value::U64).map_err(|_| format!("整数 {obj} 超出 64 位"));
    }
    if obj.is_instance_of::<PyFloat>() {
        return Ok(Value::F64(obj.extract().map_err(py_err)?));
    }
    if obj.is_instance_of::<PyString>() {
        return Ok(Value::String(obj.extract().map_err(py_err)?));
    }
    if let Ok(dict) = obj.cast::<PyDict>() {
        let mut fields = Vec::with_capacity(dict.len());
        for (key, item) in dict.iter() {
            let name: String = key.extract().map_err(|_| format!("dict 的键应为字符串, 实为 {key}"))?;
            path.push(name.clone());
            let value = convert(&item, path)?;
            path.pop();
            fields.push((Arc::from(name), value));
        }
        return Ok(Value::Message(fields));
    }
    if let Ok(bytes) = obj.cast::<PyBytes>() {
        return Ok(Value::Bytes(Cow::Owned(bytes.as_bytes().to_vec())));
    }
    if let Ok(bytes) = obj.cast::<PyByteArray>() {
        return Ok(Value::Bytes(Cow::Owned(bytes.to_vec())));
    }
    if obj.is_instance_of::<PyList>() || obj.is_instance_of::<PyTuple>() {
        let mut items = Vec::new();
        for (i, item) in obj.try_iter().map_err(py_err)?.enumerate() {
            path.push(i.to_string());
            items.push(convert(&item.map_err(py_err)?, path)?);
            path.pop();
        }
        return Ok(Value::List(items));
    }
    if let Ok(array) = obj.cast::<PyUntypedArray>()
        && array.ndim() > 0
    {
        if let Some(value) = numpy_array(obj) {
            return Ok(value);
        }
        // 其他 dtype (如 object, float16): 转 list 再逐个转
        return convert(&obj.call_method0("tolist").map_err(py_err)?, path);
    }
    // numpy 标量与 0 维数组
    if obj.hasattr("dtype").unwrap_or(false) && obj.hasattr("item").unwrap_or(false) {
        return convert(&obj.call_method0("item").map_err(py_err)?, path);
    }
    let type_name = obj.get_type().name().map(|n| n.to_string()).unwrap_or_default();
    Err(format!("不支持的 Python 类型 {type_name}"))
}

/// 常见 dtype 的 numpy 数组转数值数组 (C 序展平); 其他 dtype 为 None.
fn numpy_array(obj: &Bound<'_, PyAny>) -> Option<Value<'static>> {
    macro_rules! try_dtype {
        ($t:ty, $variant:expr) => {
            if let Ok(array) = obj.cast::<PyArrayDyn<$t>>() {
                let array = array.readonly();
                let data: Vec<$t> = match array.as_slice() {
                    Ok(slice) => slice.to_vec(),
                    Err(_) => array.as_array().iter().copied().collect(),
                };
                return Some($variant(data));
            }
        };
    }
    try_dtype!(u8, |v| Value::Bytes(Cow::Owned(v)));
    try_dtype!(bool, Value::Bools);
    try_dtype!(i8, Value::I8s);
    try_dtype!(i16, Value::I16s);
    try_dtype!(u16, Value::U16s);
    try_dtype!(i32, Value::I32s);
    try_dtype!(u32, Value::U32s);
    try_dtype!(i64, Value::I64s);
    try_dtype!(u64, Value::U64s);
    try_dtype!(f32, Value::F32s);
    try_dtype!(f64, Value::F64s);
    None
}

pub(crate) fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("EncodeError", m.py().get_type::<EncodeError>())
}
