//! rosz Python 绑定 (同步接口). 消息值为 dict, 数值数组与图像为 numpy.
//!
//! 预期内失败用返回值: 超时为 None, 解不了的消息 `value` 为 None 且 `error` 为原因;
//! 只有程序错误 (话题不存在, 用法不对) 与连接失败抛异常.

mod publish;

use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use numpy::{PyArray1, PyArrayMethods};
use pyo3::exceptions::{PyConnectionError, PyIndexError, PyLookupError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use rosz_access::{AlignError, Error, Registry, Value};

pyo3::create_exception!(rosz, TopicNotFound, PyLookupError, "话题不存在; `candidates` 为最相近的已知话题");

pub(crate) static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("建 tokio 运行时")
});

/// 阻塞等待时每隔这么久回到 Python 检查一次 Ctrl-C
const SIGNAL_POLL: Duration = Duration::from_millis(100);

pub(crate) fn to_py_err(py: Python<'_>, error: Error) -> PyErr {
    let message = error.to_string();
    match error {
        Error::UnknownTopic { candidates, .. } => {
            let err = TopicNotFound::new_err(message);
            let _ = err.value(py).setattr("candidates", candidates);
            err
        }
        Error::NoRouter | Error::Connect { .. } => PyConnectionError::new_err(message),
        Error::Zenoh(_) => PyRuntimeError::new_err(message),
        Error::UnknownType(_) => PyLookupError::new_err(message),
        Error::Encode(e) => publish::encode_error(py, &e),
    }
}

/// 连 Zenoh router. `router` 未给时取环境变量 `ROSZ_ROUTER`; `msg_dirs` 为追加的 `.msg` 目录.
#[pyfunction]
#[pyo3(signature = (router=None, domain=None, msg_dirs=None))]
fn connect(py: Python<'_>, router: Option<String>, domain: Option<u32>, msg_dirs: Option<Vec<String>>) -> PyResult<Session> {
    let mut registry = Registry::builtin();
    for dir in msg_dirs.unwrap_or_default() {
        registry.add_dir(&dir).map_err(|e| PyValueError::new_err(e.to_string()))?;
    }
    let session = py
        .detach(|| RUNTIME.block_on(rosz_access::Session::open(router.as_deref(), domain, registry)))
        .map_err(|e| to_py_err(py, e))?;
    Ok(Session { inner: session })
}

#[pyclass(module = "rosz", frozen)]
struct Session {
    inner: rosz_access::Session,
}

#[pymethods]
impl Session {
    /// 当前全部有发布端的话题.
    fn topics(&self) -> Vec<Topic> {
        self.inner.topics().into_iter().map(|t| Topic { inner: t }).collect()
    }

    /// 取话题的下一条消息 (transient_local 话题为缓存的历史); 超时为 None.
    #[pyo3(signature = (topic, timeout=2.0))]
    fn latest(&self, py: Python<'_>, topic: &str, timeout: f64) -> PyResult<Option<Message>> {
        let timeout = Duration::from_secs_f64(timeout.max(0.0));
        let message = py.detach(|| RUNTIME.block_on(self.inner.latest(topic, timeout))).map_err(|e| to_py_err(py, e))?;
        Ok(message.map(Message::new))
    }

    /// 订阅若干话题, 返回可迭代的订阅流.
    fn subscribe(&self, py: Python<'_>, topics: Vec<String>) -> PyResult<Subscription> {
        let names: Vec<&str> = topics.iter().map(String::as_str).collect();
        let subscription = py.detach(|| RUNTIME.block_on(self.inner.subscribe(&names))).map_err(|e| to_py_err(py, e))?;
        Ok(Subscription { inner: Mutex::new(Some(subscription)) })
    }

    /// 指定一对已对齐 (视场相同, 分辨率成整数倍) 的深度与彩色话题, 用于按彩色像素查深度.
    fn aligned(&self, py: Python<'_>, depth: String, color: String) -> PyResult<AlignedPair> {
        // 先确认两个话题都在
        let names = [depth.as_str(), color.as_str()];
        let known = self.inner.topics();
        for name in names {
            let normalized = format!("/{}", name.trim_matches('/'));
            if !known.iter().any(|t| t.name == normalized) {
                let candidates = rosz_access::candidates(name, known.iter().map(|t| t.name.as_str()));
                return Err(to_py_err(py, Error::UnknownTopic { topic: name.into(), candidates }));
            }
        }
        Ok(AlignedPair { session: self.inner.clone(), depth, color })
    }

    /// 建话题发布端 (仿 rclpy): `msg_type` 为 `包/msg/类型`, 须为内置或 `connect(msg_dirs=...)` 追加的类型;
    /// `qos_profile` 为 keep_last 深度 (reliable, volatile) 或 `QoSProfile`, 默认 10. 类型未知抛 LookupError.
    #[pyo3(signature = (msg_type, topic, qos_profile=None))]
    fn create_publisher(
        &self,
        py: Python<'_>,
        msg_type: &str,
        topic: &str,
        qos_profile: Option<publish::QosArg>,
    ) -> PyResult<publish::Publisher> {
        publish::create_publisher(py, self, msg_type, topic, qos_profile)
    }

    fn __repr__(&self) -> String {
        format!("<rosz.Session {} 个话题>", self.inner.topics().len())
    }
}

#[pyclass(module = "rosz", frozen)]
struct Topic {
    inner: rosz_access::TopicInfo,
}

#[pymethods]
impl Topic {
    #[getter]
    fn name(&self) -> &str {
        &self.inner.name
    }
    #[getter]
    fn r#type(&self) -> &str {
        &self.inner.type_name
    }
    #[getter]
    fn type_hash(&self) -> &str {
        &self.inner.type_hash
    }
    #[getter]
    fn transient_local(&self) -> bool {
        self.inner.transient_local
    }
    #[getter]
    fn publishers(&self) -> usize {
        self.inner.publishers
    }
    /// 能否解码 (有定义且 hash 与发布方一致)
    #[getter]
    fn decodable(&self) -> bool {
        self.inner.decodability.is_ok()
    }
    /// 不能解码的原因
    #[getter]
    fn reason(&self) -> Option<String> {
        self.inner.decodability.reason()
    }
    fn __repr__(&self) -> String {
        format!("<rosz.Topic {} {}>", self.inner.name, self.inner.type_name)
    }
}

#[pyclass(module = "rosz", frozen)]
struct Subscription {
    inner: Mutex<Option<rosz_access::Subscription>>,
}

#[pymethods]
impl Subscription {
    /// 下一条消息; `timeout` 秒内没有为 None, 不给则一直等.
    #[pyo3(signature = (timeout=None))]
    fn recv(&self, py: Python<'_>, timeout: Option<f64>) -> PyResult<Option<Message>> {
        let deadline = timeout.map(|t| std::time::Instant::now() + Duration::from_secs_f64(t.max(0.0)));
        loop {
            let wait = deadline.map_or(SIGNAL_POLL, |d| d.saturating_duration_since(std::time::Instant::now()).min(SIGNAL_POLL));
            let received = py.detach(|| {
                let mut guard = self.inner.lock().unwrap();
                let subscription = guard.as_mut()?;
                RUNTIME.block_on(async { tokio::time::timeout(wait, subscription.recv()).await.ok() })
            });
            match received {
                Some(Some(message)) => return Ok(Some(Message::new(message))),
                Some(None) => return Ok(None),
                None if deadline.is_some_and(|d| std::time::Instant::now() >= d) => return Ok(None),
                None if self.inner.lock().unwrap().is_none() => return Ok(None),
                None => py.check_signals()?,
            }
        }
    }

    /// 退订.
    fn close(&self) {
        self.inner.lock().unwrap().take();
    }

    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__(&self, py: Python<'_>) -> PyResult<Option<Message>> {
        self.recv(py, None)
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    #[pyo3(signature = (*_args))]
    fn __exit__(&self, _args: &Bound<'_, pyo3::types::PyTuple>) {
        self.close();
    }
}

/// 一条消息. `value` 按需解码并缓存.
#[pyclass(module = "rosz", frozen)]
struct Message {
    inner: rosz_access::Message,
    value: OnceLock<Option<Py<PyAny>>>,
}

impl Message {
    fn new(inner: rosz_access::Message) -> Self {
        Message { inner, value: OnceLock::new() }
    }
}

#[pymethods]
impl Message {
    #[getter]
    fn topic(&self) -> &str {
        &self.inner.topic
    }
    #[getter]
    fn r#type(&self) -> &str {
        &self.inner.type_name
    }
    /// 本机收到时刻, Unix 纳秒
    #[getter]
    fn receive_time_ns(&self) -> i64 {
        self.inner.receive_time_ns
    }
    /// 采样时刻 (Header.stamp), Unix 纳秒; 类型无 Header 为 None
    #[getter]
    fn sample_time_ns(&self) -> Option<i64> {
        self.inner.sample_time_ns
    }
    /// 发布方发出时刻, Unix 纳秒
    #[getter]
    fn source_time_ns(&self) -> Option<i64> {
        self.inner.source_time_ns
    }
    /// 原始 CDR (含 4 字节封装头)
    #[getter]
    fn payload<'py>(&self, py: Python<'py>) -> Bound<'py, pyo3::types::PyBytes> {
        pyo3::types::PyBytes::new(py, &self.inner.payload)
    }
    /// 值树 (dict); 解不了为 None, 原因见 `error`
    #[getter]
    fn value(&self, py: Python<'_>) -> PyResult<Option<Py<PyAny>>> {
        if let Some(cached) = self.value.get() {
            return Ok(cached.as_ref().map(|v| v.clone_ref(py)));
        }
        let converted = match self.inner.value() {
            Ok(value) => Some(to_python(py, &value)?.unbind()),
            Err(_) => None,
        };
        Ok(self.value.get_or_init(|| converted).as_ref().map(|v| v.clone_ref(py)))
    }
    /// 解不了的原因; 能解为 None
    #[getter]
    fn error(&self) -> Option<String> {
        self.inner.value().err().map(|e| e.to_string())
    }
    /// 彩色图为 `(高, 宽, 3)` uint8 RGB 数组.
    fn image<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let rgb = self.inner.image().map_err(|e| PyValueError::new_err(e.to_string()))?;
        let shape = [rgb.height as usize, rgb.width as usize, 3];
        Ok(PyArray1::from_vec(py, rgb.data).reshape(shape)?.into_any())
    }
    /// 深度图为 `(高, 宽)` uint16 数组, 单位毫米, 0 为无效, 原分辨率.
    fn depth<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let depth = self.inner.depth().map_err(|e| PyValueError::new_err(e.to_string()))?;
        let shape = [depth.height as usize, depth.width as usize];
        Ok(PyArray1::from_vec(py, depth.data).reshape(shape)?.into_any())
    }
    fn __repr__(&self) -> String {
        format!("<rosz.Message {} {}>", self.inner.topic, self.inner.type_name)
    }
}

/// 一对已对齐的深度与彩色话题.
#[pyclass(module = "rosz", frozen)]
struct AlignedPair {
    session: rosz_access::Session,
    depth: String,
    color: String,
}

#[pymethods]
impl AlignedPair {
    /// 两边各取最新一条; 任一超时为 None.
    #[pyo3(signature = (timeout=2.0))]
    fn latest(&self, py: Python<'_>, timeout: f64) -> PyResult<Option<AlignedFrame>> {
        let timeout = Duration::from_secs_f64(timeout.max(0.0));
        let (depth, color) = py
            .detach(|| {
                RUNTIME.block_on(async {
                    let (d, c) = tokio::join!(self.session.latest(&self.depth, timeout), self.session.latest(&self.color, timeout));
                    Ok::<_, Error>((d?, c?))
                })
            })
            .map_err(|e| to_py_err(py, e))?;
        let (Some(depth), Some(color)) = (depth, color) else { return Ok(None) };
        let decoded = depth.depth().map_err(|e| e.to_string()).and_then(|d| {
            let rgb_size = color.image().map(|c| (c.width, c.height)).map_err(|e| e.to_string())?;
            Ok((d, rgb_size))
        });
        let (depth_image, color_size, error) = match decoded {
            Ok((d, size)) => {
                // 先用左上角像素检查是否对齐
                let error = d.at_color_pixel(size.0, size.1, 0, 0).err().map(|e| e.to_string());
                (Some(d), size, error)
            }
            Err(error) => (None, (0, 0), Some(error)),
        };
        Ok(Some(AlignedFrame {
            depth_message: depth,
            color_message: color,
            depth_image,
            color_size,
            error,
        }))
    }
}

/// 一帧对齐的深度与彩色.
#[pyclass(module = "rosz", frozen)]
struct AlignedFrame {
    depth_message: rosz_access::Message,
    color_message: rosz_access::Message,
    depth_image: Option<rosz_access::DepthImage>,
    color_size: (u32, u32),
    error: Option<String>,
}

#[pymethods]
impl AlignedFrame {
    #[getter]
    fn depth_message(&self) -> Message {
        Message::new(self.depth_message.clone())
    }
    #[getter]
    fn color_message(&self) -> Message {
        Message::new(self.color_message.clone())
    }
    /// 不支持按彩色像素查深度的原因 (如未对齐); 支持为 None
    #[getter]
    fn error(&self) -> Option<String> {
        self.error.clone()
    }
    /// 彩色图像素 `(u, v)` (u 为列, v 为行) 处的深度, 毫米, 0 为无效; 不支持时 (见 `error`) 为 None.
    fn depth_at(&self, u: u32, v: u32) -> PyResult<Option<u16>> {
        let Some(depth) = self.depth_image.as_ref().filter(|_| self.error.is_none()) else { return Ok(None) };
        match depth.at_color_pixel(self.color_size.0, self.color_size.1, u, v) {
            Ok(d) => Ok(Some(d)),
            Err(e @ AlignError::OutOfImage { .. }) => Err(PyIndexError::new_err(e.to_string())),
            Err(_) => Ok(None),
        }
    }
}

fn to_python<'py>(py: Python<'py>, value: &Value) -> PyResult<Bound<'py, PyAny>> {
    macro_rules! array {
        ($v:expr) => {
            PyArray1::from_slice(py, $v).into_any()
        };
    }
    Ok(match value {
        Value::Bool(v) => v.into_pyobject(py)?.to_owned().into_any(),
        Value::I8(v) => v.into_pyobject(py)?.into_any(),
        Value::U8(v) => v.into_pyobject(py)?.into_any(),
        Value::I16(v) => v.into_pyobject(py)?.into_any(),
        Value::U16(v) => v.into_pyobject(py)?.into_any(),
        Value::I32(v) => v.into_pyobject(py)?.into_any(),
        Value::U32(v) => v.into_pyobject(py)?.into_any(),
        Value::I64(v) => v.into_pyobject(py)?.into_any(),
        Value::U64(v) => v.into_pyobject(py)?.into_any(),
        Value::F32(v) => (*v as f64).into_pyobject(py)?.into_any(),
        Value::F64(v) => v.into_pyobject(py)?.into_any(),
        Value::String(v) => v.into_pyobject(py)?.into_any(),
        Value::Message(fields) => {
            let dict = PyDict::new(py);
            for (name, field) in fields {
                dict.set_item(&**name, to_python(py, field)?)?;
            }
            dict.into_any()
        }
        Value::List(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(to_python(py, item)?)?;
            }
            list.into_any()
        }
        Value::Bytes(v) => array!(v),
        Value::Bools(v) => array!(v),
        Value::I8s(v) => array!(v),
        Value::I16s(v) => array!(v),
        Value::U16s(v) => array!(v),
        Value::I32s(v) => array!(v),
        Value::U32s(v) => array!(v),
        Value::I64s(v) => array!(v),
        Value::U64s(v) => array!(v),
        Value::F32s(v) => array!(v),
        Value::F64s(v) => array!(v),
    })
}

#[pymodule]
fn rosz(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add("TopicNotFound", m.py().get_type::<TopicNotFound>())?;
    m.add_function(wrap_pyfunction!(connect, m)?)?;
    m.add_class::<Session>()?;
    m.add_class::<Topic>()?;
    m.add_class::<Subscription>()?;
    m.add_class::<Message>()?;
    m.add_class::<AlignedPair>()?;
    m.add_class::<AlignedFrame>()?;
    publish::register(m)?;
    Ok(())
}
