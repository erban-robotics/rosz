//! 服务 (仿 rclpy 命名, 无 executor/spin): `Session.create_service` 与 `Session.create_client`.
//!
//! - callback 在服务自有的工作线程里拿 GIL 跑, 参数为请求 dict 与零值应答 dict (值形状同 `Message.value`), 返回应答 dict.
//!   callback 抛异常或返回值不合定义时仍回应答 (见 rosz-access 服务模块: 有 Receipt 回执字段则 `code=5` 并带 traceback,
//!   否则零值应答), 并经 `logging.getLogger("rosz")` 记 error.
//! - client 的 `call` / `wait_for_service` 阻塞时释放 GIL, 每 0.1 s 回 Python 查 Ctrl-C; 超时与服务不可达返回 None / False.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyList, PyTuple};
use rosz_access::{FailureKind, HandlerError, ServiceFailure, ServiceOptions, Value};

use crate::value::to_value;
use crate::{RUNTIME, SIGNAL_POLL, Session, to_py_err, to_python};

/// 在运行时里跑一个 future, 期间释放 GIL 并定时查 Ctrl-C (收到则取消 future 并抛 KeyboardInterrupt).
fn block_on_interruptible<F>(py: Python<'_>, future: F) -> PyResult<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let mut handle = RUNTIME.spawn(future);
    loop {
        let done = py.detach(|| RUNTIME.block_on(async { tokio::time::timeout(SIGNAL_POLL, &mut handle).await }));
        match done {
            Ok(joined) => return joined.map_err(|e| PyRuntimeError::new_err(e.to_string())),
            Err(_) => {
                if let Err(e) = py.check_signals() {
                    handle.abort();
                    return Err(e);
                }
            }
        }
    }
}

/// Python 异常转 handler 失败: 消息为 `类型: 内容`, traceback 为 `traceback.format_exception` 全文.
fn handler_error(py: Python<'_>, err: PyErr) -> HandlerError {
    let traceback = py
        .import("traceback")
        .and_then(|m| m.call_method1("format_exception", (err.get_type(py), err.value(py), err.traceback(py))))
        .and_then(|lines| lines.cast_into::<PyList>().map_err(PyErr::from))
        .and_then(|lines| lines.iter().map(|l| l.extract::<String>()).collect::<PyResult<Vec<_>>>())
        .map(|lines| lines.concat())
        .ok();
    HandlerError { message: err.to_string(), traceback }
}

/// 服务端失败记到 Python logging (logger "rosz").
fn log_failure(failure: &ServiceFailure) {
    Python::attach(|py| {
        let kind = match failure.kind {
            FailureKind::BadRequest => "请求不合定义",
            FailureKind::Handler => "callback 出错",
            FailureKind::BadResponse => "callback 返回值不合定义",
            FailureKind::Reply => "应答发送失败",
        };
        let mut text = format!("服务 {} {kind}: {}", failure.service, failure.message);
        if let Some(traceback) = &failure.traceback {
            text = format!("{text}\n{}", traceback.trim_end());
        }
        let logged = py.import("logging").and_then(|m| m.call_method1("getLogger", ("rosz",))).and_then(|l| l.call_method1("error", (text,)));
        if let Err(e) = logged {
            e.print(py);
        }
    });
}

pub(crate) fn create_service(
    py: Python<'_>,
    session: &Session,
    srv_type: &str,
    srv_name: &str,
    callback: Py<PyAny>,
    workers: usize,
) -> PyResult<Service> {
    if !callback.bind(py).is_callable() {
        return Err(pyo3::exceptions::PyTypeError::new_err("callback 应可调用: callback(request, response) -> response"));
    }
    let handler = move |request: Value<'static>, response: Value<'static>| {
        Python::attach(|py| {
            let call = || -> PyResult<Value<'static>> {
                let args = (to_python(py, &request)?, to_python(py, &response)?);
                let returned = callback.call1(py, args)?;
                to_value(returned.bind(py))
            };
            call().map_err(|e| handler_error(py, e))
        })
    };
    let options = ServiceOptions { workers, on_failure: Some(Arc::new(log_failure)) };
    let service = py
        .detach(|| RUNTIME.block_on(session.inner.create_service(srv_type, srv_name, options, handler)))
        .map_err(|e| to_py_err(py, e))?;
    Ok(Service {
        name: service.name().to_owned(),
        srv_type: service.srv_type().to_owned(),
        inner: Mutex::new(Some(service)),
    })
}

pub(crate) fn create_client(py: Python<'_>, session: &Session, srv_type: &str, srv_name: &str) -> PyResult<Client> {
    let client = py
        .detach(|| RUNTIME.block_on(session.inner.create_client(srv_type, srv_name)))
        .map_err(|e| to_py_err(py, e))?;
    Ok(Client { inner: Mutex::new(Some(client)) })
}

/// 服务端. `destroy()` (或出 `with`) 即撤销, 并等工作线程处理完手上的请求.
#[pyclass(module = "rosz", frozen)]
pub(crate) struct Service {
    inner: Mutex<Option<rosz_access::Service>>,
    name: String,
    srv_type: String,
}

#[pymethods]
impl Service {
    /// 带首 `/` 的服务名
    #[getter]
    fn srv_name(&self) -> &str {
        &self.name
    }

    /// `包/srv/类型`
    #[getter]
    fn srv_type(&self) -> &str {
        &self.srv_type
    }

    /// 撤销 (撤 queryable 与 token), 等工作线程处理完手上的请求后退出.
    fn destroy(&self, py: Python<'_>) {
        let service = self.inner.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(service) = service {
            // 工作线程可能正等 GIL 跑 callback: 等它们时须释放 GIL
            py.detach(|| service.close());
        }
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    #[pyo3(signature = (*_args))]
    fn __exit__(&self, py: Python<'_>, _args: &Bound<'_, PyTuple>) {
        self.destroy(py);
    }

    fn __repr__(&self) -> String {
        format!("<rosz.Service {} {}>", self.name, self.srv_type)
    }
}

/// 通用服务客户端. `destroy()` (或出 `with`) 即撤销.
#[pyclass(module = "rosz", frozen)]
pub(crate) struct Client {
    inner: Mutex<Option<rosz_access::Client>>,
}

impl Client {
    fn client(&self) -> PyResult<rosz_access::Client> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.clone().ok_or_else(|| PyRuntimeError::new_err("客户端已撤销"))
    }
}

fn seconds(timeout_sec: Option<f64>) -> Option<Duration> {
    timeout_sec.map(|t| Duration::from_secs_f64(t.max(0.0)))
}

#[pymethods]
impl Client {
    /// 等到有服务端 (只看 SS token); `timeout_sec` 为 None 时一直等 (同 rclpy). 超时为 False.
    #[pyo3(signature = (timeout_sec=None))]
    fn wait_for_service(&self, py: Python<'_>, timeout_sec: Option<f64>) -> PyResult<bool> {
        let client = self.client()?;
        block_on_interruptible(py, async move { client.wait_for_service(seconds(timeout_sec)).await })
    }

    /// 现在有没有服务端.
    fn service_is_ready(&self) -> PyResult<bool> {
        Ok(self.client()?.service_is_ready())
    }

    /// 按定义校验请求 dict 后调用, 返回应答 dict. 请求不合定义抛 `rosz.EncodeError` (什么也不发).
    /// 超时或没有服务端返回 None; `timeout_sec` 为 None 时同 rclpy 不设本地超时 (查询本身 600 s 后结束, 同 rmw_zenoh 默认).
    #[pyo3(signature = (request, timeout_sec=None))]
    fn call(&self, py: Python<'_>, request: &Bound<'_, PyAny>, timeout_sec: Option<f64>) -> PyResult<Option<Py<PyAny>>> {
        let client = self.client()?;
        let value = to_value(request)?;
        let response = block_on_interruptible(py, async move { client.call(&value, seconds(timeout_sec)).await })?
            .map_err(|e| to_py_err(py, e))?;
        response.map(|v| to_python(py, &v).map(Bound::unbind)).transpose()
    }

    /// 带首 `/` 的服务名
    #[getter]
    fn srv_name(&self) -> PyResult<String> {
        Ok(self.client()?.name().to_owned())
    }

    /// `包/srv/类型`
    #[getter]
    fn srv_type(&self) -> PyResult<String> {
        Ok(self.client()?.srv_type().to_owned())
    }

    /// 撤销 (撤 querier 与 token). 再调用抛 RuntimeError.
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
        match self.client() {
            Ok(c) => format!("<rosz.Client {} {}>", c.name(), c.srv_type()),
            Err(_) => "<rosz.Client 已撤销>".into(),
        }
    }
}

pub(crate) fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Service>()?;
    m.add_class::<Client>()?;
    Ok(())
}
