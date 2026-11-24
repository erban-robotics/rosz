//! 采集: `Session.collect(...)` 返回的 `Collector`. 统计为 dict, 字段见 `stats_dict`.

use std::sync::Mutex;

use pyo3::exceptions::{PyOSError, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use rosz_access::{CollectError, CollectOptions, CollectStats, Compression, DEFAULT_CHUNK_SIZE};

use crate::RUNTIME;

fn to_py_err(error: CollectError) -> PyErr {
    match error {
        CollectError::Create { .. } => PyOSError::new_err(error.to_string()),
        // 建线程失败同 Python threading (RuntimeError)
        CollectError::Spawn(_) | CollectError::Mcap(_) | CollectError::WriterPanicked => PyRuntimeError::new_err(error.to_string()),
    }
}

/// 开始采集; 见 `Session.collect`.
pub(crate) fn start(
    py: Python<'_>,
    session: &rosz_access::Session,
    path: std::path::PathBuf,
    topics: Vec<String>,
    compression: Option<String>,
    chunk_size: Option<u64>,
) -> PyResult<Collector> {
    let compression = match compression.as_deref() {
        None => Compression::None,
        Some(name) => name.parse::<Compression>().map_err(PyValueError::new_err)?,
    };
    let options = CollectOptions { compression, chunk_size: chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE) };
    let names: Vec<&str> = topics.iter().map(String::as_str).collect();
    let collector = py.detach(|| RUNTIME.block_on(session.collect(&path, &names, options))).map_err(to_py_err)?;
    Ok(Collector { inner: Mutex::new(Some(collector)), last: Mutex::new(None) })
}

/// 进行中的采集. `stop()` 写完已收到的消息并封口; 可用作上下文管理器 (退出时 stop).
#[pyclass(module = "rosz", frozen)]
pub(crate) struct Collector {
    inner: Mutex<Option<rosz_access::Collector>>,
    /// stop 后的最终统计
    last: Mutex<Option<CollectStats>>,
}

#[pymethods]
impl Collector {
    /// 当前统计 (stop 后为最终统计):
    /// `{"topics": {话题: {type, received, written, gaps, publisher_restarts, last_receive_time_ns,
    /// last_header_stamp_ns, latency_ns: {p50, p95, max} 或 None}}, "written", "queue_depth", "last_write_time_ns", "errors"}`.
    /// 清单里还没有发布端的话题不在 `topics` 里. `latency_ns` 只算每话题最近 1000 条 (滑动窗口).
    fn stats<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let stats = match self.inner.lock().unwrap().as_ref() {
            Some(collector) => collector.stats(),
            None => self.last.lock().unwrap().clone().unwrap_or_default(),
        };
        stats_dict(py, &stats)
    }

    /// 停止订阅, 写完队列并封口, 返回最终统计; 重复调用返回同一份.
    fn stop<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let collector = self.inner.lock().unwrap().take();
        if let Some(collector) = collector {
            let stats = py.detach(|| RUNTIME.block_on(collector.stop())).map_err(to_py_err)?;
            *self.last.lock().unwrap() = Some(stats);
        }
        self.stats(py)
    }

    fn __enter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    #[pyo3(signature = (*_args))]
    fn __exit__(&self, py: Python<'_>, _args: &Bound<'_, pyo3::types::PyTuple>) -> PyResult<()> {
        self.stop(py).map(|_| ())
    }

    fn __repr__(&self) -> String {
        match self.inner.lock().unwrap().as_ref() {
            Some(collector) => format!("<rosz.Collector {} 采集中>", collector.path().display()),
            None => "<rosz.Collector 已停止>".into(),
        }
    }
}

fn stats_dict<'py>(py: Python<'py>, stats: &CollectStats) -> PyResult<Bound<'py, PyDict>> {
    let topics = PyDict::new(py);
    for (name, topic) in &stats.topics {
        let item = PyDict::new(py);
        item.set_item("type", &topic.type_name)?;
        item.set_item("received", topic.received)?;
        item.set_item("written", topic.written)?;
        item.set_item("gaps", topic.gaps)?;
        item.set_item("publisher_restarts", topic.publisher_restarts)?;
        item.set_item("last_receive_time_ns", topic.last_receive_time_ns)?;
        item.set_item("last_header_stamp_ns", topic.last_header_stamp_ns)?;
        let latency = match topic.latency {
            Some(l) => {
                let d = PyDict::new(py);
                d.set_item("p50", l.p50_ns)?;
                d.set_item("p95", l.p95_ns)?;
                d.set_item("max", l.max_ns)?;
                Some(d)
            }
            None => None,
        };
        item.set_item("latency_ns", latency)?;
        topics.set_item(name, item)?;
    }
    let out = PyDict::new(py);
    out.set_item("topics", topics)?;
    out.set_item("written", stats.written)?;
    out.set_item("queue_depth", stats.queue_depth)?;
    out.set_item("last_write_time_ns", stats.last_write_time_ns)?;
    out.set_item("errors", stats.errors.clone())?;
    Ok(out)
}
