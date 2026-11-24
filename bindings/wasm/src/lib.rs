//! rosz 浏览器解码模块: CDR 解码, RIHS01, 深度 (zstd 与 16 位 PNG) 同一个 WASM.
//!
//! `decode` 输出 `{ tree, arrays }`: `tree` 为 JSON.parse 得到的对象树, 数值数组在树里为 TypedArray,
//! 并按字段路径 (如 `transforms.0.header.frame_id`) 单列在 `arrays`; 64 位整数为 BigInt.

use std::fmt::Write as _;

use js_sys::{BigInt, Object, Reflect};
use rosz_decode::{Registry, Value, media};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Decoder {
    registry: Registry,
}

#[wasm_bindgen]
impl Decoder {
    /// 含全部内置类型 (common_interfaces jazzy + audio_common_msgs + erban 自定义).
    #[wasm_bindgen(constructor)]
    pub fn new() -> Decoder {
        Decoder { registry: Registry::builtin() }
    }

    /// 追加一条定义: `name` 为 `包/msg/类型` 时 `text` 按 `.msg` 解析; 为 `包/srv/类型` 时按 `.srv` 解析,
    /// 登记 `类型_Request`, `类型_Response` (可解码) 与只用于算 hash 的 `类型_Event`, `类型`.
    #[wasm_bindgen(js_name = addDefinition)]
    pub fn add_definition(&mut self, name: &str, text: &str) -> Result<(), JsError> {
        self.registry.add(name, text).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 由定义算 RIHS01.
    pub fn rihs01(&self, name: &str) -> Result<String, JsError> {
        self.registry.rihs01(name).map_err(|e| JsError::new(&e.to_string()))
    }

    /// 与发布方声明的 hash 比对: 能解码为 undefined, 否则为原因.
    #[wasm_bindgen(js_name = undecodableReason)]
    pub fn undecodable_reason(&self, name: &str, hash: Option<String>) -> Option<String> {
        self.registry.check(name, hash.as_deref()).reason()
    }

    /// 首字段为 Header 时的采样时刻 (Unix 纳秒); 否则为 undefined.
    #[wasm_bindgen(js_name = sampleTime)]
    pub fn sample_time(&self, name: &str, payload: &[u8]) -> Option<i64> {
        self.registry.header_stamp(name, payload)
    }

    /// 解码 CDR (含 4 字节封装头), 返回 `{ tree, arrays }`.
    pub fn decode(&self, name: &str, payload: &[u8]) -> Result<Object, JsError> {
        let value = self.registry.decode(name, payload).map_err(|e| JsError::new(&e.to_string()))?;
        let mut json = String::new();
        let mut patches = Vec::new();
        write_json(&value, &mut Vec::new(), &mut json, &mut patches);
        let tree = js_sys::JSON::parse(&json).map_err(|_| JsError::new("内部错误: JSON 不合法"))?;
        let arrays = Object::new();
        for (path, patch) in patches {
            let (parent, key) = walk(&tree, &path)?;
            let is_array = !matches!(patch, Patch::BigInt(_));
            let value = patch.into_js();
            Reflect::set(&parent, &key, &value).map_err(|_| JsError::new("内部错误: 路径不存在"))?;
            if is_array {
                Reflect::set(&arrays, &JsValue::from_str(&path.join(".")), &value).unwrap();
            }
        }
        let out = Object::new();
        Reflect::set(&out, &"tree".into(), &tree).unwrap();
        Reflect::set(&out, &"arrays".into(), &arrays).unwrap();
        Ok(out)
    }
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

/// 解压缩深度 (`CompressedImage.format` 为 `16UC1; zstd` 或 `16UC1; compressedDepth png`), 单位毫米.
#[wasm_bindgen(js_name = decodeDepth)]
pub fn decode_depth(format: &str, data: &[u8]) -> Result<Depth, JsError> {
    let depth = media::depth_from_compressed(format, data).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(Depth { width: depth.width, height: depth.height, data: depth.data })
}

#[wasm_bindgen]
pub struct Depth {
    #[wasm_bindgen(readonly)]
    pub width: u32,
    #[wasm_bindgen(readonly)]
    pub height: u32,
    data: Vec<u16>,
}

#[wasm_bindgen]
impl Depth {
    /// `高 x 宽` 行优先, 拷出到 JS (不是 WASM 内存视图, 内存增长后仍有效)
    #[wasm_bindgen(getter)]
    pub fn data(&self) -> js_sys::Uint16Array {
        js_sys::Uint16Array::from(&self.data[..])
    }
}

enum Patch<'v> {
    BigInt(JsValue),
    Array(&'v Value<'v>),
}

impl Patch<'_> {
    fn into_js(self) -> JsValue {
        macro_rules! typed {
            ($t:ty, $v:expr) => {
                <$t>::from(&$v[..]).into()
            };
        }
        match self {
            Patch::BigInt(v) => v,
            Patch::Array(value) => match value {
                Value::Bytes(v) => typed!(js_sys::Uint8Array, v),
                Value::I8s(v) => typed!(js_sys::Int8Array, v),
                Value::I16s(v) => typed!(js_sys::Int16Array, v),
                Value::U16s(v) => typed!(js_sys::Uint16Array, v),
                Value::I32s(v) => typed!(js_sys::Int32Array, v),
                Value::U32s(v) => typed!(js_sys::Uint32Array, v),
                Value::I64s(v) => typed!(js_sys::BigInt64Array, v),
                Value::U64s(v) => typed!(js_sys::BigUint64Array, v),
                Value::F32s(v) => typed!(js_sys::Float32Array, v),
                Value::F64s(v) => typed!(js_sys::Float64Array, v),
                _ => unreachable!("只有数值数组走 TypedArray"),
            },
        }
    }
}

/// 按路径找到父节点与键.
fn walk(tree: &JsValue, path: &[String]) -> Result<(JsValue, JsValue), JsError> {
    let key = |s: &String| s.parse::<u32>().map_or_else(|_| JsValue::from_str(s), JsValue::from);
    let mut node = tree.clone();
    for segment in &path[..path.len() - 1] {
        node = Reflect::get(&node, &key(segment)).map_err(|_| JsError::new("内部错误: 路径不存在"))?;
    }
    Ok((node, key(path.last().unwrap())))
}

/// 值树写成 JSON; 数值数组与 64 位整数先写 null, 记下路径, 解析后再换成 TypedArray / BigInt.
fn write_json<'v>(value: &'v Value<'v>, path: &mut Vec<String>, out: &mut String, patches: &mut Vec<(Vec<String>, Patch<'v>)>) {
    let float = |v: f64, out: &mut String| {
        if v.is_finite() { write!(out, "{v:?}").unwrap() } else { out.push_str("null") }
    };
    match value {
        Value::Bool(v) => write!(out, "{v}").unwrap(),
        Value::I8(v) => write!(out, "{v}").unwrap(),
        Value::U8(v) => write!(out, "{v}").unwrap(),
        Value::I16(v) => write!(out, "{v}").unwrap(),
        Value::U16(v) => write!(out, "{v}").unwrap(),
        Value::I32(v) => write!(out, "{v}").unwrap(),
        Value::U32(v) => write!(out, "{v}").unwrap(),
        Value::I64(v) => {
            out.push_str("null");
            patches.push((path.clone(), Patch::BigInt(BigInt::from(*v).into())));
        }
        Value::U64(v) => {
            out.push_str("null");
            patches.push((path.clone(), Patch::BigInt(BigInt::from(*v).into())));
        }
        // f32 按 f64 展开 (同 Python 侧)
        Value::F32(v) => float(*v as f64, out),
        Value::F64(v) => float(*v, out),
        Value::String(s) => write_string(s, out),
        Value::Message(fields) => {
            out.push('{');
            for (i, (name, field)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(name, out);
                out.push(':');
                path.push(name.to_string());
                write_json(field, path, out, patches);
                path.pop();
            }
            out.push('}');
        }
        Value::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                path.push(i.to_string());
                write_json(item, path, out, patches);
                path.pop();
            }
            out.push(']');
        }
        Value::Bools(v) => {
            let items: Vec<&str> = v.iter().map(|b| if *b { "true" } else { "false" }).collect();
            write!(out, "[{}]", items.join(",")).unwrap();
        }
        array => {
            out.push_str("null");
            patches.push((path.clone(), Patch::Array(array)));
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
}
