//! 服务 (仿 rclpy 命名, 无 executor/spin): [`Session::create_service`] 与 [`Session::create_client`].
//!
//! 类型由会话注册表 (内置 + 追加目录的 `.srv`) 运行时解析; 请求/应答按 `包/srv/X_Request` / `_Response` 编解码, 服务 hash 由 `.srv` 算出.
//! 线协议交给 hiroz: server 用其 queryable (`complete=true`) 与 SS token; client 用 hiroz 的实体编号, keyexpr, SC token, gid,
//! attachment, querier 自己声明 (hiroz `ZClient` 的 querier 超时写死 10 s, 不能对齐 rclpy).
//!
//! server: 请求在 zenoh 接收线程里只入队, handler 只在 server 自有工作线程跑 (默认 1 个). 每个请求必回应答, 带回请求序号;
//! 不用 `reply_err` (rmw_zenoh 当作没有应答, rclpy client 一直等). 请求解不了, handler 出错或 panic, 返回值不合定义时
//! 回 "失败应答": 应答类型顶层有 `*/msg/Receipt` 字段 (`code` + `message` + `detail_json`) 时以零值应答为底填回执
//! (请求解不了 `code=1` INVALID_REQUEST, 其余 `code=5` INTERNAL_ERROR, `detail_json` 含 `error` 与 `traceback`/`path`);
//! 没有回执字段时回零值应答. 失败都交给 [`ServiceOptions::on_failure`] (默认 `tracing` 记 warn).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::Duration;

use hiroz::attachment::{Attachment, GidArray};
use hiroz::entity::{EndpointEntity, EndpointKind, Entity, TypeInfo};
use hiroz::msg::ZService;
use hiroz::service::ZServer;
use zenoh::Wait as _;
use zenoh::bytes::ZBytes;
use zenoh::key_expr::KeyExpr;
use zenoh::liveliness::LivelinessToken;
use zenoh::query::{ConsolidationMode, Querier, Query, QueryTarget};

use rosz_decode::msg::{Array, BaseType, FieldType, Primitive};

use crate::session::Session;
use crate::transport::{self, Transport};
use crate::{Error, Registry, Value};

/// 查询超时: 同 rmw_zenoh_cpp 默认配置的 `queries_default_timeout` (600 s). `call` 不给超时时最多等这么久.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(600);

/// 回执约定 (`erban_interfaces/msg/Receipt`) 的公共码: 请求字段缺失/格式错
pub const RECEIPT_INVALID_REQUEST: u8 = 1;
/// 回执约定的公共码: 服务端自身问题 (未捕获异常等)
pub const RECEIPT_INTERNAL_ERROR: u8 = 5;

/// 只有 CDR 封装头 (小端) 的空消息: 零值应答都编不出时的兜底
const CDR_LE_HEADER: [u8; 4] = [0, 1, 0, 0];

/// 原始字节服务类型占位: 请求与应答都是已编码的 CDR, 从不按它序列化.
struct RawSrv;
impl ZService for RawSrv {
    type Request = Vec<u8>;
    type Response = Vec<u8>;
}

/// handler 的失败: 消息给人看, `traceback` 可选 (Python 绑定填异常栈).
#[derive(Clone, Debug, PartialEq)]
pub struct HandlerError {
    pub message: String,
    pub traceback: Option<String>,
}

impl<E: std::error::Error> From<E> for HandlerError {
    fn from(error: E) -> Self {
        HandlerError { message: error.to_string(), traceback: None }
    }
}

/// 一次失败的服务调用 (服务端侧), 交给 [`ServiceOptions::on_failure`].
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceFailure {
    /// 带首 `/` 的服务名
    pub service: String,
    pub kind: FailureKind,
    pub message: String,
    pub traceback: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// 请求缺 attachment (无法应答) 或 payload 不合请求定义 (回 INVALID_REQUEST)
    BadRequest,
    /// handler 返回错误或 panic (回 INTERNAL_ERROR)
    Handler,
    /// handler 返回值不合应答定义 (回 INTERNAL_ERROR)
    BadResponse,
    /// 应答发不出去
    Reply,
}

/// 服务端处理函数: `(请求, 零值应答) -> 应答`. 零值应答同 rclpy 回调拿到的空 response, 可改后返回, 也可返回别的值.
pub type Handler = dyn Fn(Value<'static>, Value<'static>) -> Result<Value<'static>, HandlerError> + Send + Sync;

/// 失败观察者.
pub type FailureHook = dyn Fn(&ServiceFailure) + Send + Sync;

/// 服务端选项.
#[derive(Clone)]
pub struct ServiceOptions {
    /// 工作线程数, 至少 1 (0 按 1). 多于 1 时 handler 可能并发.
    pub workers: usize,
    /// 每次失败调一次 (在工作线程里); None 为 `tracing::warn!`
    pub on_failure: Option<Arc<FailureHook>>,
}

impl Default for ServiceOptions {
    fn default() -> Self {
        ServiceOptions { workers: 1, on_failure: None }
    }
}

/// 一个服务类型的运行时信息.
#[derive(Clone)]
struct SrvType {
    /// `包/srv/类型`
    name: String,
    request: String,
    response: String,
    type_info: TypeInfo,
}

impl SrvType {
    fn resolve(registry: &Registry, srv_type: &str) -> Result<SrvType, Error> {
        let unknown = || Error::UnknownType(srv_type.into());
        let name = srv_type.trim_matches('/');
        let mut parts = name.split('/');
        if !(parts.next().is_some() && parts.next() == Some("srv") && parts.next().is_some() && parts.next().is_none()) {
            return Err(unknown());
        }
        let (request, response) = (format!("{name}_Request"), format!("{name}_Response"));
        if registry.get(&request).is_none() || registry.get(&response).is_none() {
            return Err(unknown());
        }
        let type_info = transport::type_info(registry, name).ok_or_else(unknown)?;
        Ok(SrvType { name: name.into(), request, response, type_info })
    }
}

/// 服务名补全: 相对名按根命名空间补首 `/` (同 rclpy 在根命名空间的节点).
fn qualify(transport: &Transport, name: &str) -> Result<String, Error> {
    let node = transport.node().node_entity();
    hiroz::topic_name::qualify_service_name(name, &node.namespace, &node.name)
        .map_err(|e| Error::InvalidArgument(format!("服务名 {name} 不合法: {e}")))
}

impl Session {
    /// 建服务端并声明 SS token. `srv_type` 为 `包/srv/类型`, 须在会话注册表里 (内置或追加目录的 `.srv`).
    /// handler 只在本服务自有的工作线程里跑, 见模块说明.
    pub async fn create_service<H>(
        &self,
        srv_type: &str,
        name: &str,
        options: ServiceOptions,
        handler: H,
    ) -> Result<Service, Error>
    where
        H: Fn(Value<'static>, Value<'static>) -> Result<Value<'static>, HandlerError> + Send + Sync + 'static,
    {
        let srv = SrvType::resolve(self.registry(), srv_type)?;
        let transport = self.transport().clone();
        let service = qualify(&transport, name)?;
        let builder = transport.node().create_service_impl::<RawSrv>(&service, Some(srv.type_info.clone()));
        let mut entity = builder.entity().clone();
        entity.topic = service.clone();
        let key_expr: KeyExpr<'static> =
            (*transport.node().keyexpr_format().topic_key_expr(&entity).map_err(Error::Zenoh)?).clone();

        let (tx, rx) = mpsc::channel::<Query>();
        let sender = Arc::new(Mutex::new(Some(tx)));
        let queue = sender.clone();
        // zenoh 接收线程里只入队
        let on_query = move |query: Query| {
            if let Some(tx) = queue.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                let _ = tx.send(query);
            }
        };
        let server = transport::blocking(move || builder.build_with_callback(on_query)).await.map_err(Error::Zenoh)?;

        let worker = Arc::new(Worker {
            service: service.clone(),
            srv: srv.clone(),
            registry: self.registry().clone(),
            key_expr,
            handler: Box::new(handler),
            on_failure: options.on_failure,
            queue: Mutex::new(rx),
        });
        let mut workers = Vec::new();
        for i in 0..options.workers.max(1) {
            let worker = worker.clone();
            let thread = thread::Builder::new()
                .name(format!("rosz-srv-{i}"))
                .spawn(move || worker.run())
                .map_err(Error::Spawn)?;
            workers.push(thread);
        }
        Ok(Service { server: Some(server), sender, workers, service, srv_type: srv.name, _transport: transport })
    }

    /// 建通用客户端并声明 SC token. `srv_type` 为 `包/srv/类型`.
    pub async fn create_client(&self, srv_type: &str, name: &str) -> Result<Client, Error> {
        let srv = SrvType::resolve(self.registry(), srv_type)?;
        let transport = self.transport().clone();
        let service = qualify(&transport, name)?;
        let blocking = transport.clone();
        let entity_service = service.clone();
        let type_info = srv.type_info.clone();
        let (querier, token, gid) = transport::blocking(move || {
            let node = blocking.node();
            let entity = EndpointEntity {
                id: node.next_entity_id(),
                node: Some(node.node_entity().clone()),
                kind: EndpointKind::Client,
                topic: entity_service,
                type_info: Some(type_info),
                qos: Default::default(),
            };
            let format = node.keyexpr_format();
            let session = node.session();
            let querier = session
                .declare_querier((*format.topic_key_expr(&entity)?).clone())
                .target(QueryTarget::AllComplete)
                .consolidation(ConsolidationMode::None)
                .timeout(QUERY_TIMEOUT)
                .wait()?;
            let token = session.liveliness().declare_token((*format.liveliness_key_expr(&entity, &session.zid())?).clone()).wait()?;
            let gid = hiroz::entity::endpoint_gid(&entity).ok_or("客户端实体缺节点身份")?;
            Ok((querier, token, gid))
        })
        .await
        .map_err(Error::Zenoh)?;
        Ok(Client {
            inner: Arc::new(ClientInner {
                querier,
                _token: token,
                gid,
                sequence: AtomicI64::new(1),
                service,
                srv,
                registry: self.registry().clone(),
                transport,
            }),
        })
    }
}

/// 服务端. drop 即撤销 (撤 queryable 与 token), 工作线程处理完手上的请求后退出; [`Service::close`] 另等它们退出.
pub struct Service {
    server: Option<ZServer<RawSrv, ()>>,
    sender: Arc<Mutex<Option<Sender<Query>>>>,
    workers: Vec<JoinHandle<()>>,
    service: String,
    srv_type: String,
    // 在 server 之后 drop: 端点先撤, 节点与会话后关
    _transport: Transport,
}

impl Service {
    /// 带首 `/` 的服务名
    pub fn name(&self) -> &str {
        &self.service
    }

    /// `包/srv/类型`
    pub fn srv_type(&self) -> &str {
        &self.srv_type
    }

    fn shutdown(&mut self) {
        self.server.take();
        self.sender.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// 撤销并等工作线程处理完手上的请求后退出 (在本服务的 handler 里调则不等).
    pub fn close(mut self) {
        self.shutdown();
        let current: ThreadId = thread::current().id();
        for worker in self.workers.drain(..) {
            if worker.thread().id() != current {
                let _ = worker.join();
            }
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct Worker {
    service: String,
    srv: SrvType,
    registry: Arc<Registry>,
    key_expr: KeyExpr<'static>,
    handler: Box<Handler>,
    on_failure: Option<Arc<FailureHook>>,
    queue: Mutex<Receiver<Query>>,
}

impl Worker {
    fn run(&self) {
        loop {
            let query = self.queue.lock().unwrap_or_else(|e| e.into_inner()).recv();
            let Ok(query) = query else { return };
            self.serve(query);
        }
    }

    fn fail(&self, kind: FailureKind, message: String, traceback: Option<String>) {
        let failure = ServiceFailure { service: self.service.clone(), kind, message, traceback };
        match &self.on_failure {
            Some(hook) => {
                // 观察者自己出错不能拖垮工作线程
                let _ = catch_unwind(AssertUnwindSafe(|| hook(&failure)));
            }
            None => tracing::warn!(service = %failure.service, kind = ?failure.kind, "{}", failure.message),
        }
    }

    fn serve(&self, query: Query) {
        let Some(attachment) = query.attachment().and_then(|a| Attachment::try_from(a).ok()) else {
            // 没有请求序号就没法让对端认领应答: 只能不回
            return self.fail(FailureKind::BadRequest, "请求缺 rmw_zenoh attachment, 不应答".into(), None);
        };
        let payload = query.payload().map(|p| p.to_bytes().into_owned()).unwrap_or_default();
        let response = self.respond(&payload);
        let reply = query
            .reply(&self.key_expr, response)
            .attachment(ZBytes::from(Attachment::new(attachment.sequence_number, attachment.source_gid)))
            .wait();
        if let Err(e) = reply {
            self.fail(FailureKind::Reply, format!("应答发送失败: {e}"), None);
        }
    }

    /// 请求 payload -> 应答 CDR. 失败一律回失败应答, 不让对端等到超时.
    fn respond(&self, payload: &[u8]) -> Vec<u8> {
        let request = match self.registry.decode(&self.srv.request, payload) {
            Ok(request) => request.into_owned(),
            Err(e) => {
                let message = format!("请求不合 {}: {e}", self.srv.request);
                self.fail(FailureKind::BadRequest, message.clone(), None);
                return self.failure_response(RECEIPT_INVALID_REQUEST, &message, &[]);
            }
        };
        let zero = self.registry.zero_value(&self.srv.response).unwrap_or(Value::Message(Vec::new()));
        let outcome = catch_unwind(AssertUnwindSafe(|| (self.handler)(request, zero)));
        let value = match outcome {
            Ok(Ok(value)) => value,
            Ok(Err(HandlerError { message, traceback })) => {
                self.fail(FailureKind::Handler, message.clone(), traceback.clone());
                let detail = traceback.map(|t| ("traceback", t));
                return self.failure_response(RECEIPT_INTERNAL_ERROR, &message, detail.as_slice());
            }
            Err(panic) => {
                let message = panic_message(panic.as_ref());
                self.fail(FailureKind::Handler, message.clone(), None);
                return self.failure_response(RECEIPT_INTERNAL_ERROR, &message, &[]);
            }
        };
        match self.registry.encode(&self.srv.response, &value) {
            Ok(bytes) => bytes,
            Err(e) => {
                let message = format!("handler 返回值不合 {}: {e}", self.srv.response);
                self.fail(FailureKind::BadResponse, message.clone(), None);
                self.failure_response(RECEIPT_INTERNAL_ERROR, &message, &[("path", e.path().into())])
            }
        }
    }

    /// 零值应答; 顶层有回执字段时填回执. `detail` 并入 `detail_json` (另有 `error` 为 `message`).
    fn failure_response(&self, code: u8, message: &str, detail: &[(&str, String)]) -> Vec<u8> {
        let mut zero = self.registry.zero_value(&self.srv.response).unwrap_or(Value::Message(Vec::new()));
        if let (Some(field), Value::Message(fields)) = (self.receipt_field(), &mut zero) {
            let mut json = serde_json::Map::new();
            json.insert("error".into(), message.into());
            for (key, value) in detail {
                json.insert((*key).into(), value.as_str().into());
            }
            let detail_json = serde_json::Value::Object(json).to_string();
            if let Some((_, Value::Message(receipt))) = fields.iter_mut().find(|(name, _)| **name == *field) {
                for (name, value) in receipt.iter_mut() {
                    match &**name {
                        "code" => *value = Value::U8(code),
                        "message" => *value = Value::String(message.into()),
                        "detail_json" => *value = Value::String(detail_json.clone()),
                        _ => {}
                    }
                }
            }
        }
        self.registry.encode(&self.srv.response, &zero).unwrap_or_else(|_| CDR_LE_HEADER.to_vec())
    }

    /// 应答类型顶层的回执字段名: 类型为 `*/msg/Receipt` 且有 `code` (uint8), `message`, `detail_json` (string).
    fn receipt_field(&self) -> Option<String> {
        let def = self.registry.get(&self.srv.response)?;
        def.fields.iter().find(|f| is_receipt(&self.registry, &f.ty)).map(|f| f.name.to_string())
    }
}

fn is_receipt(registry: &Registry, ty: &FieldType) -> bool {
    let BaseType::Message(name) = &ty.base else { return false };
    let Some(def) = registry.get(name).filter(|_| ty.array == Array::Single && name.ends_with("/msg/Receipt")) else {
        return false;
    };
    let has = |field: &str, base: BaseType| {
        def.fields.iter().any(|f| &*f.name == field && f.ty == FieldType { base: base.clone(), array: Array::Single })
    };
    let string = BaseType::String { bound: None };
    has("code", BaseType::Primitive(Primitive::U8)) && has("message", string.clone()) && has("detail_json", string)
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    let text = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
    format!("handler panic: {}", text.unwrap_or_default())
}

/// 通用服务客户端. 克隆共享; 最后一个 drop 即撤销 (撤 querier 与 token).
#[derive(Clone)]
pub struct Client {
    inner: Arc<ClientInner>,
}

struct ClientInner {
    querier: Querier<'static>,
    _token: LivelinessToken,
    gid: GidArray,
    sequence: AtomicI64,
    service: String,
    srv: SrvType,
    registry: Arc<Registry>,
    // 在 querier 与 token 之后 drop
    transport: Transport,
}

impl Client {
    /// 带首 `/` 的服务名
    pub fn name(&self) -> &str {
        &self.inner.service
    }

    /// `包/srv/类型`
    pub fn srv_type(&self) -> &str {
        &self.inner.srv.name
    }

    /// 图里有没有同名同类型的服务端 (只看 SS token; 同 rclpy `service_is_ready`).
    pub fn service_is_ready(&self) -> bool {
        let graph = self.inner.transport.node().graph();
        graph.get_entities_by_service(EndpointKind::Service, &self.inner.service).iter().any(|entity| match &**entity {
            Entity::Endpoint(e) => e.type_info.as_ref().is_some_and(|t| t.name == self.inner.srv.type_info.name),
            Entity::Node(_) => false,
        })
    }

    /// 等到有服务端 (只看 SS token); `timeout` 为 None 时一直等. 超时为 false.
    pub async fn wait_for_service(&self, timeout: Option<Duration>) -> bool {
        let deadline = timeout.map(|t| tokio::time::Instant::now() + t);
        let notify = self.inner.transport.graph_changed();
        loop {
            let changed = notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.service_is_ready() {
                return true;
            }
            match deadline {
                Some(deadline) => {
                    if tokio::time::timeout_at(deadline, changed).await.is_err() {
                        return self.service_is_ready();
                    }
                }
                None => changed.await,
            }
        }
    }

    /// 按定义校验并编码请求后调用, 返回应答值树. 请求不合定义为 [`Error::Encode`] (什么也不发).
    /// 预期内失败为 `Ok(None)`: `timeout` 到了 (None 时同 rclpy 不设本地超时, 但查询本身 600 s 后结束, 同 rmw_zenoh 默认),
    /// 或没有服务端 (查询立即结束). 应答解不了为 [`Error::Decode`].
    pub async fn call(&self, request: &Value<'_>, timeout: Option<Duration>) -> Result<Option<Value<'static>>, Error> {
        let inner = &self.inner;
        let payload = inner.registry.encode(&inner.srv.request, request)?;
        let sequence = inner.sequence.fetch_add(1, Ordering::AcqRel);
        let attachment = ZBytes::from(Attachment::new(sequence, inner.gid));
        let replies = inner.querier.get().payload(payload).attachment(attachment).await.map_err(Error::Zenoh)?;
        let first = async {
            while let Ok(reply) = replies.recv_async().await {
                // reply_err 不算应答 (同 rmw_zenoh)
                if let Ok(sample) = reply.result() {
                    return Some(sample.payload().to_bytes().into_owned());
                }
            }
            None
        };
        let payload = match timeout {
            Some(timeout) => tokio::time::timeout(timeout, first).await.ok().flatten(),
            None => first.await,
        };
        let Some(payload) = payload else { return Ok(None) };
        Ok(Some(inner.registry.decode(&inner.srv.response, &payload)?.into_owned()))
    }
}
