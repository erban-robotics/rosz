//! rosz 解码: 按 `.msg` / `.srv` 定义把 ROS 2 消息 (XCDR1) 解成值树 (及反向编码), 由定义算 RIHS01, 解码相机图像与深度.
//!
//! 不依赖 zenoh, 可编 WASM.

mod cdr;
mod encode;
mod hash;
pub mod media;
pub mod msg;
mod registry;
pub mod srv;
mod value;

pub use cdr::DecodeError;
pub use encode::EncodeError;
pub use registry::{Decodability, LoadError, Registry};
pub use value::Value;
