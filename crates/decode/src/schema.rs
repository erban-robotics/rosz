//! MCAP ros2 profile 的 schema 文本 (`ros2msg` 编码): 主类型定义在前, 依赖类型以 80 个 `=` 分隔行 + `MSG: 包/类型` 追加.
//!
//! 逐字节对齐 rosbags 0.11 `Typestore.generate_msgdef(.., ros_version=2)` (erban-caring webapp 录制器原用它写 schema):
//! 去注释与默认值, 常量写作 `类型 名字=值`, 嵌套类型写 `包/类型`, 依赖按首次出现先序排列, 每段以换行结尾.

use std::collections::HashSet;

use crate::cdr::DecodeError;
use crate::msg::{Array, BaseType, FieldType, MessageDef, Primitive, normalize_type_name};
use crate::registry::Registry;

const SEPARATOR: &str = "================================================================================";

impl Registry {
    /// 类型的 `ros2msg` schema 文本 (MCAP ros2 profile 用). 类型或其依赖缺定义为错.
    pub fn ros2msg_schema(&self, name: &str) -> Result<String, DecodeError> {
        let full = normalize_type_name(name, None).ok_or_else(|| DecodeError::MissingType(name.into()))?;
        let mut order = Vec::new();
        let mut seen = HashSet::new();
        let main = self.definition_text(&full, &mut order, &mut seen)?;
        let mut text = main;
        for (dependency, body) in order {
            text.push_str(SEPARATOR);
            text.push_str("\nMSG: ");
            text.push_str(&short_name(&dependency));
            text.push('\n');
            text.push_str(&body);
        }
        Ok(text)
    }

    /// 一个类型的定义段; 依赖按先序登记到 `order` (父在子前, 同 rosbags).
    fn definition_text(
        &self,
        name: &str,
        order: &mut Vec<(String, String)>,
        seen: &mut HashSet<String>,
    ) -> Result<String, DecodeError> {
        let def: &MessageDef = self.get(name).ok_or_else(|| DecodeError::MissingType(name.into()))?;
        let mut lines = Vec::new();
        for constant in &def.constants {
            lines.push(format!("{} {}={}", base_name(&constant.ty.base), constant.name.trim_end_matches('_'), constant.value));
        }
        if !def.is_empty {
            for field in &def.fields {
                if let BaseType::Message(nested) = &field.ty.base
                    && seen.insert(nested.clone())
                {
                    // 先占位再递归: 依赖的位置按首次出现, 其依赖排在它后面
                    let slot = order.len();
                    order.push((nested.clone(), String::new()));
                    order[slot].1 = self.definition_text(nested, order, seen)?;
                }
                lines.push(format!("{} {}", type_text(&field.ty), field.name.trim_end_matches('_')));
            }
        }
        lines.push(String::new());
        Ok(lines.join("\n"))
    }
}

/// `包/msg/类型` -> `包/类型`
fn short_name(full: &str) -> String {
    match full.split('/').collect::<Vec<_>>().as_slice() {
        [package, _, ty] => format!("{package}/{ty}"),
        _ => full.into(),
    }
}

fn base_name(base: &BaseType) -> String {
    match base {
        BaseType::Primitive(p) => primitive_name(*p).into(),
        BaseType::String { bound: Some(n) } => format!("string<={n}"),
        BaseType::String { bound: None } => "string".into(),
        // rosbags 不认 wstring 上限
        BaseType::WString { .. } => "wstring".into(),
        BaseType::Message(full) => short_name(full),
    }
}

fn type_text(ty: &FieldType) -> String {
    let base = base_name(&ty.base);
    match ty.array {
        Array::Single => base,
        Array::Fixed(n) => format!("{base}[{n}]"),
        Array::Bounded(n) => format!("{base}[<={n}]"),
        Array::Unbounded => format!("{base}[]"),
    }
}

fn primitive_name(p: Primitive) -> &'static str {
    match p {
        Primitive::Bool => "bool",
        Primitive::Byte => "byte",
        Primitive::Char => "char",
        Primitive::I8 => "int8",
        Primitive::U8 => "uint8",
        Primitive::I16 => "int16",
        Primitive::U16 => "uint16",
        Primitive::I32 => "int32",
        Primitive::U32 => "uint32",
        Primitive::I64 => "int64",
        Primitive::U64 => "uint64",
        Primitive::F32 => "float32",
        Primitive::F64 => "float64",
    }
}
