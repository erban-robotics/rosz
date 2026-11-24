//! 发布 (仿 rclpy 命名): `Session.create_publisher(msg_type, topic, qos_profile)` 与 `Publisher.publish(dict)`.
//!
//! dict 转值树 ([`to_value`]) 只看 Python 类型, 不看定义: 整数为 I64 (超出时 U64), 浮点 F64, list/tuple 为 List,
//! bytes/bytearray 与 uint8 numpy 数组为字节数组, 其他 numpy 数组按 dtype 成数值数组 (多维按 C 序展平),
//! numpy 标量取 `.item()`. 按定义收窄与校验在 rosz-decode 编码时做, 不合即抛 `rosz.EncodeError` (ValueError 子类, `path` 为字段路径).
//! 服务 (票 08) 的请求/应答构造也复用 [`to_value`] 与 [`encode_error`].

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use numpy::{PyArrayDyn, PyArrayMethods, PyUntypedArray, PyUntypedArrayMethods};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyByteArray, PyBytes, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use rosz_access::{EncodeError as RustEncodeError, QosProfile, Value};

use crate::{RUNTIME, Session, to_py_err};

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

/// 发布端 QoS (首版): `QoSProfile(depth=10, reliability="reliable", durability="volatile")`.
/// reliability 取 `"reliable"` / `"best_effort"`, durability 取 `"volatile"` / `"transient_local"`, history 固定 keep_last(depth).
#[pyclass(module = "rosz", name = "QoSProfile", frozen, from_py_object)]
#[derive(Clone)]
pub(crate) struct PyQosProfile {
    inner: QosProfile,
}

#[pymethods]
impl PyQosProfile {
    #[new]
    #[pyo3(signature = (depth=10, reliability="reliable", durability="volatile"))]
    fn new(depth: usize, reliability: &str, durability: &str) -> PyResult<Self> {
        if depth == 0 {
            return Err(PyValueError::new_err("depth 至少为 1"));
        }
        let reliable = match reliability {
            "reliable" => true,
            "best_effort" => false,
            other => return Err(PyValueError::new_err(format!("reliability 应为 reliable 或 best_effort, 实为 {other}"))),
        };
        let transient_local = match durability {
            "volatile" => false,
            "transient_local" => true,
            other => {
                return Err(PyValueError::new_err(format!("durability 应为 volatile 或 transient_local, 实为 {other}")));
            }
        };
        Ok(PyQosProfile { inner: QosProfile { reliable, transient_local, depth } })
    }

    #[getter]
    fn depth(&self) -> usize {
        self.inner.depth
    }
    #[getter]
    fn reliability(&self) -> &'static str {
        if self.inner.reliable { "reliable" } else { "best_effort" }
    }
    #[getter]
    fn durability(&self) -> &'static str {
        if self.inner.transient_local { "transient_local" } else { "volatile" }
    }
    fn __repr__(&self) -> String {
        format!("QoSProfile(depth={}, reliability={:?}, durability={:?})", self.depth(), self.reliability(), self.durability())
    }
}

/// `qos_profile` 参数: 整数为 keep_last 深度 (reliable, volatile), 或 `QoSProfile`.
#[derive(FromPyObject)]
pub(crate) enum QosArg {
    Depth(usize),
    Profile(PyQosProfile),
}

impl QosArg {
    fn into_profile(self) -> PyResult<QosProfile> {
        match self {
            QosArg::Depth(0) => Err(PyValueError::new_err("depth 至少为 1")),
            QosArg::Depth(depth) => Ok(QosProfile { depth, ..QosProfile::default() }),
            QosArg::Profile(p) => Ok(p.inner),
        }
    }
}

/// `Session.create_publisher` 的实现.
pub(crate) fn create_publisher(
    py: Python<'_>,
    session: &Session,
    msg_type: &str,
    topic: &str,
    qos_profile: Option<QosArg>,
) -> PyResult<Publisher> {
    let qos = qos_profile.map_or(Ok(QosProfile::default()), QosArg::into_profile)?;
    let publisher = py
        .detach(|| RUNTIME.block_on(session.inner.create_publisher(msg_type, topic, qos)))
        .map_err(|e| to_py_err(py, e))?;
    Ok(Publisher { inner: Mutex::new(Some(publisher)) })
}

/// 话题发布端. `destroy()` (或出 `with`) 即撤销.
#[pyclass(module = "rosz", frozen)]
pub(crate) struct Publisher {
    inner: Mutex<Option<rosz_access::Publisher>>,
}

impl Publisher {
    fn with<T>(&self, f: impl FnOnce(&rosz_access::Publisher) -> T) -> PyResult<T> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(f).ok_or_else(|| PyRuntimeError::new_err("发布端已撤销"))
    }
}

#[pymethods]
impl Publisher {
    /// 按定义校验 dict 并发出; 不合定义抛 `rosz.EncodeError`, 什么也不发.
    fn publish(&self, py: Python<'_>, msg: &Bound<'_, PyAny>) -> PyResult<()> {
        let value = to_value(msg)?;
        py.detach(|| self.with(|p| p.publish(&value)))?.map_err(|e| to_py_err(py, e))
    }

    /// 带首 `/` 的话题名
    #[getter]
    fn topic(&self) -> PyResult<String> {
        self.with(|p| p.topic().to_owned())
    }

    /// `包/msg/类型`
    #[getter]
    fn msg_type(&self) -> PyResult<String> {
        self.with(|p| p.type_name().to_owned())
    }

    /// 图里此话题的订阅端个数.
    fn get_subscription_count(&self) -> PyResult<usize> {
        self.with(|p| p.subscription_count())
    }

    /// 撤销发布端 (撤 liveliness token). 再发布抛 RuntimeError.
    fn destroy(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    #[pyo3(signature = (*_args))]
    fn __exit__(&self, _args: &Bound<'_, PyTuple>) {
        self.destroy();
    }

    fn __repr__(&self) -> String {
        self.with(|p| format!("<rosz.Publisher {} {}>", p.topic(), p.type_name()))
            .unwrap_or_else(|_| "<rosz.Publisher 已撤销>".into())
    }
}

pub(crate) fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("EncodeError", m.py().get_type::<EncodeError>())?;
    m.add_class::<PyQosProfile>()?;
    m.add_class::<Publisher>()?;
    Ok(())
}
