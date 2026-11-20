//! RIHS01 type hash, 算法同 rosidl_generator_type_description (jazzy):
//! 类型描述 (去掉 `default_value`) 按 Python `json.dumps` 默认分隔符序列化后做 sha256.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use crate::cdr::{DecodeError, Lookup};
use crate::msg::{Array, BaseType, MessageDef, Primitive};

pub(crate) fn rihs01(lookup: &impl Lookup, name: &str) -> Result<String, DecodeError> {
    let root = lookup.lookup(name).ok_or_else(|| DecodeError::MissingType(name.into()))?;
    let mut referenced = BTreeMap::new();
    collect_references(lookup, root, &mut referenced)?;
    let mut json = String::from("{\"type_description\": ");
    describe(root, &mut json);
    json.push_str(", \"referenced_type_descriptions\": [");
    for (i, def) in referenced.values().enumerate() {
        if i > 0 {
            json.push_str(", ");
        }
        describe(def, &mut json);
    }
    json.push_str("]}");
    let digest = Sha256::digest(json.as_bytes());
    let mut out = String::from("RIHS01_");
    for byte in digest {
        write!(out, "{byte:02x}").unwrap();
    }
    Ok(out)
}

fn collect_references<'d>(
    lookup: &'d impl Lookup,
    def: &MessageDef,
    out: &mut BTreeMap<String, &'d MessageDef>,
) -> Result<(), DecodeError> {
    for field in &def.fields {
        if let BaseType::Message(name) = &field.ty.base
            && !out.contains_key(name)
        {
            let nested = lookup.lookup(name).ok_or_else(|| DecodeError::MissingType(name.clone()))?;
            out.insert(name.clone(), nested);
            collect_references(lookup, nested, out)?;
        }
    }
    Ok(())
}

fn describe(def: &MessageDef, json: &mut String) {
    write!(json, "{{\"type_name\": \"{}\", \"fields\": [", def.name).unwrap();
    for (i, field) in def.fields.iter().enumerate() {
        if i > 0 {
            json.push_str(", ");
        }
        let (base_id, string_capacity, nested) = match &field.ty.base {
            BaseType::Primitive(p) => (primitive_id(*p), 0, ""),
            BaseType::String { bound: None } => (17, 0, ""),
            BaseType::WString { bound: None } => (18, 0, ""),
            BaseType::String { bound: Some(n) } => (21, *n, ""),
            BaseType::WString { bound: Some(n) } => (22, *n, ""),
            BaseType::Message(name) => (1, 0, name.as_str()),
        };
        let (offset, capacity) = match field.ty.array {
            Array::Single => (0, 0),
            Array::Fixed(n) => (48, n),
            Array::Bounded(n) => (96, n),
            Array::Unbounded => (144, 0),
        };
        write!(
            json,
            "{{\"name\": \"{}\", \"type\": {{\"type_id\": {}, \"capacity\": {capacity}, \"string_capacity\": {string_capacity}, \"nested_type_name\": \"{nested}\"}}}}",
            field.name,
            base_id + offset
        )
        .unwrap();
    }
    json.push_str("]}");
}

/// rosidl `FieldType` 常量. `char` 映射为 IDL uint8, `byte` 为 octet.
fn primitive_id(p: Primitive) -> usize {
    match p {
        Primitive::I8 => 2,
        Primitive::U8 | Primitive::Char => 3,
        Primitive::I16 => 4,
        Primitive::U16 => 5,
        Primitive::I32 => 6,
        Primitive::U32 => 7,
        Primitive::I64 => 8,
        Primitive::U64 => 9,
        Primitive::F32 => 10,
        Primitive::F64 => 11,
        Primitive::Bool => 15,
        Primitive::Byte => 16,
    }
}
