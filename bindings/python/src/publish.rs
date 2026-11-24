//! 发布 (仿 rclpy 命名): `Session.create_publisher(msg_type, topic, qos_profile)` 与 `Publisher.publish(dict)`.
//! dict 转值树见 [`crate::value`].

use std::sync::Mutex;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyTuple;
use rosz_access::QosProfile;

use crate::value::to_value;
use crate::{RUNTIME, Session, to_py_err};

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
    m.add_class::<PyQosProfile>()?;
    m.add_class::<Publisher>()?;
    Ok(())
}
