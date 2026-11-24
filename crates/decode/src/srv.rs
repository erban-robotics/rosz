//! `.srv` 文本解析: 按 `---` 行拆成请求与应答两段, 各按 `.msg` 规则解析; 再按 rosidl (jazzy) 合成
//! `_Event` 与顶层服务类型, 以便用同一套 RIHS01 算法得出服务的 type hash (rmw_zenoh 的服务 keyexpr 与 token 里用它).
//!
//! `包/srv/X` 得 4 个类型:
//! - `包/srv/X_Request`, `包/srv/X_Response`: 线上的请求与应答
//! - `包/srv/X_Event`: `info` (service_msgs/ServiceEventInfo), `request` (`X_Request[<=1]`), `response` (`X_Response[<=1]`)
//! - `包/srv/X`: `request_message`, `response_message`, `event_message` 三个嵌套字段, 只用于算服务 hash

use crate::msg::{self, Array, BaseType, Field, FieldType, MessageDef, ParseError};

const EVENT_INFO: &str = "service_msgs/msg/ServiceEventInfo";

/// 解析一条 `.srv`. `name` 为 `包/srv/类型`. 返回 [请求, 应答, 事件, 顶层] 4 个定义.
pub fn parse(name: &str, text: &str) -> Result<[MessageDef; 4], ParseError> {
    let error = |reason: &str| ParseError { type_name: name.into(), line: 0, reason: reason.into() };
    match name.split('/').collect::<Vec<_>>().as_slice() {
        [_, "srv", _] if msg::normalize_type_name(name, None).is_some() => {}
        _ => return Err(error("类型名应为 包/srv/类型")),
    }
    let lines: Vec<&str> = text.lines().collect();
    let separator = lines.iter().position(|l| l.trim() == "---").ok_or_else(|| error("缺 `---` 分隔行"))?;
    let request_text = lines[..separator].join("\n");
    let response_text = lines[separator + 1..].join("\n");
    let request = msg::parse(&format!("{name}_Request"), &request_text)?;
    let response = msg::parse(&format!("{name}_Response"), &response_text)
        .map_err(|e| ParseError { line: e.line + separator + 1, ..e })?;
    let event = synthesized(
        &format!("{name}_Event"),
        &[
            ("info", EVENT_INFO, Array::Single),
            ("request", &request.name, Array::Bounded(1)),
            ("response", &response.name, Array::Bounded(1)),
        ],
    );
    let top = synthesized(
        name,
        &[
            ("request_message", &request.name, Array::Single),
            ("response_message", &response.name, Array::Single),
            ("event_message", &event.name, Array::Single),
        ],
    );
    Ok([request, response, event, top])
}

fn synthesized(name: &str, fields: &[(&str, &str, Array)]) -> MessageDef {
    MessageDef {
        name: name.into(),
        fields: fields
            .iter()
            .map(|(field, ty, array)| Field {
                name: (*field).into(),
                ty: FieldType { base: BaseType::Message((*ty).into()), array: *array },
            })
            .collect(),
        constants: Vec::new(),
        text: String::new(),
        is_empty: false,
    }
}
