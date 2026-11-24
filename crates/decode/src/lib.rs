//! rosz 解码: 按 `.msg` 定义把 ROS 2 消息 (XCDR1) 解成值树, 由定义算 RIHS01, 解码相机图像与深度.
//!
//! 不依赖 zenoh, 可编 WASM.

mod cdr;
mod hash;
pub mod media;
pub mod msg;
mod registry;
mod schema;
mod value;

pub use cdr::DecodeError;
pub use registry::{Decodability, LoadError, Registry};
pub use value::Value;
