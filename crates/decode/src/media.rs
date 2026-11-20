//! 相机消息的媒体解码: 彩色图转 RGB, 深度转 uint16 毫米.
//!
//! 支持:
//! - `sensor_msgs/msg/CompressedImage`: JPEG (编译开关 `jpeg`) 与 PNG 彩色; `16UC1; zstd` (erban sensors 载荷:
//!   4 字节小端头 `u16 宽, u16 高` + 一个 zstd 帧, 解压后为小端 uint16 毫米); `16UC1; compressedDepth` (12 字节
//!   ConfigHeader + 16 位灰度 PNG)
//! - `sensor_msgs/msg/Image`: `rgb8` `bgr8` `rgba8` `bgra8` `mono8` 彩色; `16UC1` `mono16` 深度 (毫米),
//!   `32FC1` 深度 (米, 转毫米, 无效值为 0)

use std::io::Cursor;

use thiserror::Error;

use crate::value::Value;

pub const COMPRESSED_IMAGE: &str = "sensor_msgs/msg/CompressedImage";
pub const IMAGE: &str = "sensor_msgs/msg/Image";

#[derive(Debug, Error, PartialEq)]
pub enum MediaError {
    #[error("{0} 不是图像消息")]
    NotImage(String),
    #[error("不支持的格式: {0}")]
    Unsupported(String),
    #[error("数据损坏: {0}")]
    Corrupt(String),
}

/// RGB 图像, 行优先 `高 x 宽 x 3`.
#[derive(Clone, Debug, PartialEq)]
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// 深度图, 行优先 `高 x 宽`, 单位毫米, 0 为无效.
#[derive(Clone, Debug, PartialEq)]
pub struct DepthImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u16>,
}

/// 消息是彩色还是深度.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    Color,
    Depth,
}

/// 按类型名与值树判断是彩色还是深度; 非图像消息为 None.
pub fn kind(type_name: &str, value: &Value) -> Option<ImageKind> {
    let text = |f| value.get(f).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    match type_name {
        COMPRESSED_IMAGE => {
            let format = text("format");
            Some(if format.contains("zstd") || format.contains("compresseddepth") {
                ImageKind::Depth
            } else {
                ImageKind::Color
            })
        }
        IMAGE => Some(match text("encoding").as_str() {
            "16uc1" | "mono16" | "32fc1" => ImageKind::Depth,
            _ => ImageKind::Color,
        }),
        _ => None,
    }
}

/// 彩色图转 RGB.
pub fn image(type_name: &str, value: &Value) -> Result<RgbImage, MediaError> {
    match kind(type_name, value) {
        None => Err(MediaError::NotImage(type_name.into())),
        Some(ImageKind::Depth) => Err(MediaError::Unsupported("深度图请用 depth()".into())),
        Some(ImageKind::Color) if type_name == COMPRESSED_IMAGE => {
            let format = field_str(value, "format")?.to_ascii_lowercase();
            let data = field_bytes(value, "data")?;
            if format.contains("png") { decode_png_color(data) } else { decode_jpeg(data) }
        }
        Some(ImageKind::Color) => raw_color(value),
    }
}

/// 深度图转 uint16 毫米, 保持原分辨率.
pub fn depth(type_name: &str, value: &Value) -> Result<DepthImage, MediaError> {
    match kind(type_name, value) {
        None => Err(MediaError::NotImage(type_name.into())),
        Some(ImageKind::Color) => Err(MediaError::Unsupported("彩色图请用 image()".into())),
        Some(ImageKind::Depth) if type_name == COMPRESSED_IMAGE => {
            depth_from_compressed(field_str(value, "format")?, field_bytes(value, "data")?)
        }
        Some(ImageKind::Depth) => raw_depth(value),
    }
}

/// 按 `CompressedImage.format` 解压缩深度载荷.
pub fn depth_from_compressed(format: &str, data: &[u8]) -> Result<DepthImage, MediaError> {
    let format = format.to_ascii_lowercase();
    if format.contains("zstd") {
        decode_zstd_depth(data)
    } else if format.contains("compresseddepth") && !format.contains("rvl") {
        decode_compressed_depth(data)
    } else {
        Err(MediaError::Unsupported(format))
    }
}

/// erban `16UC1; zstd`: 4 字节小端头 (`u16 宽`, `u16 高`) + zstd 帧.
pub fn decode_zstd_depth(data: &[u8]) -> Result<DepthImage, MediaError> {
    let header = data.get(..4).ok_or_else(|| MediaError::Corrupt("zstd 深度缺 4 字节头".into()))?;
    let width = u16::from_le_bytes([header[0], header[1]]) as u32;
    let height = u16::from_le_bytes([header[2], header[3]]) as u32;
    let expected = width as usize * height as usize * 2;
    let raw = zstd::bulk::decompress(&data[4..], expected).map_err(|e| MediaError::Corrupt(format!("zstd: {e}")))?;
    if raw.len() != expected {
        return Err(MediaError::Corrupt(format!("zstd 解压得 {} 字节, 应为 {width}x{height}x2", raw.len())));
    }
    let data = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Ok(DepthImage { width, height, data })
}

/// compressed_depth_image_transport: 12 字节 ConfigHeader (`int32 格式`, `float32[2] 量化参数`) + 16 位 PNG.
pub fn decode_compressed_depth(data: &[u8]) -> Result<DepthImage, MediaError> {
    const CONFIG_HEADER_LEN: usize = 12;
    let png = data.get(CONFIG_HEADER_LEN..).ok_or_else(|| MediaError::Corrupt("compressedDepth 缺头".into()))?;
    decode_png_depth(png)
}

/// 16 位灰度 PNG 转毫米深度.
pub fn decode_png_depth(png: &[u8]) -> Result<DepthImage, MediaError> {
    let (info, buf) = read_png(png, png::Transformations::IDENTITY)?;
    if info.color_type != png::ColorType::Grayscale || info.bit_depth != png::BitDepth::Sixteen {
        return Err(MediaError::Unsupported(format!("深度 PNG 应为 16 位灰度, 实为 {:?} {:?}", info.color_type, info.bit_depth)));
    }
    // PNG 内 16 位为大端
    let data = buf.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
    Ok(DepthImage { width: info.width, height: info.height, data })
}

/// 毫米深度编码为 16 位灰度 PNG (读回值不变).
pub fn encode_png_depth(depth: &DepthImage) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, depth.width, depth.height);
    encoder.set_color(png::ColorType::Grayscale);
    encoder.set_depth(png::BitDepth::Sixteen);
    let bytes: Vec<u8> = depth.data.iter().flat_map(|v| v.to_be_bytes()).collect();
    let mut writer = encoder.write_header().expect("写内存不会失败");
    writer.write_image_data(&bytes).expect("尺寸与数据一致");
    writer.finish().expect("写内存不会失败");
    out
}

/// RGB 编码为 PNG.
pub fn encode_png_rgb(image: &RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("写内存不会失败");
    writer.write_image_data(&image.data).expect("尺寸与数据一致");
    writer.finish().expect("写内存不会失败");
    out
}

/// 已对齐深度 (与彩色视场相同, 分辨率成整数倍) 按彩色像素坐标取深度, 最近邻换算.
#[derive(Debug, Error, PartialEq)]
pub enum AlignError {
    #[error("深度 {depth_w}x{depth_h} 与彩色 {color_w}x{color_h} 不成同一整数倍, 未对齐深度不支持")]
    Unaligned { depth_w: u32, depth_h: u32, color_w: u32, color_h: u32 },
    #[error("像素 ({u}, {v}) 超出彩色图 {color_w}x{color_h}")]
    OutOfImage { u: u32, v: u32, color_w: u32, color_h: u32 },
}

impl DepthImage {
    /// 彩色图 `color_w x color_h` 上像素 `(u, v)` 处的深度 (毫米, 0 为无效).
    pub fn at_color_pixel(&self, color_w: u32, color_h: u32, u: u32, v: u32) -> Result<u16, AlignError> {
        let unaligned =
            AlignError::Unaligned { depth_w: self.width, depth_h: self.height, color_w, color_h };
        let (dw, dh) = (self.width, self.height);
        if dw == 0 || dh == 0 || color_w == 0 || color_h == 0 {
            return Err(unaligned);
        }
        if u >= color_w || v >= color_h {
            return Err(AlignError::OutOfImage { u, v, color_w, color_h });
        }
        let (x, y) = if color_w >= dw {
            let k = color_w / dw;
            if color_w % dw != 0 || color_h != dh * k {
                return Err(unaligned);
            }
            (u / k, v / k)
        } else {
            let k = dw / color_w;
            if dw % color_w != 0 || dh != color_h * k {
                return Err(unaligned);
            }
            (u * k, v * k)
        };
        Ok(self.data[(y * dw + x) as usize])
    }
}

fn field_str<'v>(value: &'v Value, name: &str) -> Result<&'v str, MediaError> {
    value.get(name).and_then(Value::as_str).ok_or_else(|| MediaError::Corrupt(format!("缺字段 {name}")))
}

fn field_bytes<'v>(value: &'v Value, name: &str) -> Result<&'v [u8], MediaError> {
    value.get(name).and_then(Value::as_bytes).ok_or_else(|| MediaError::Corrupt(format!("缺字段 {name}")))
}

fn field_u32(value: &Value, name: &str) -> Result<u32, MediaError> {
    match value.get(name) {
        Some(Value::U32(v)) => Ok(*v),
        Some(Value::U8(v)) => Ok((*v).into()),
        _ => Err(MediaError::Corrupt(format!("缺字段 {name}"))),
    }
}

#[cfg(feature = "jpeg")]
fn decode_jpeg(data: &[u8]) -> Result<RgbImage, MediaError> {
    use zune_jpeg::JpegDecoder;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGB);
    let mut decoder = JpegDecoder::new_with_options(data, options);
    let pixels = decoder.decode().map_err(|e| MediaError::Corrupt(format!("JPEG: {e:?}")))?;
    let info = decoder.info().ok_or_else(|| MediaError::Corrupt("JPEG 无尺寸".into()))?;
    let (width, height) = (info.width as u32, info.height as u32);
    let data = match decoder.get_output_colorspace() {
        Some(ColorSpace::RGB) => pixels,
        Some(ColorSpace::Luma) => pixels.iter().flat_map(|g| [*g; 3]).collect(),
        other => return Err(MediaError::Unsupported(format!("JPEG 输出色彩空间 {other:?}"))),
    };
    Ok(RgbImage { width, height, data })
}

#[cfg(not(feature = "jpeg"))]
fn decode_jpeg(_: &[u8]) -> Result<RgbImage, MediaError> {
    Err(MediaError::Unsupported("本构建未带 JPEG 解码".into()))
}

fn read_png(data: &[u8], transformations: png::Transformations) -> Result<(png::OutputInfo, Vec<u8>), MediaError> {
    let corrupt = |e: png::DecodingError| MediaError::Corrupt(format!("PNG: {e}"));
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(transformations);
    let mut reader = decoder.read_info().map_err(corrupt)?;
    let mut buf = vec![0; reader.output_buffer_size().ok_or_else(|| MediaError::Corrupt("PNG 过大".into()))?];
    let info = reader.next_frame(&mut buf).map_err(corrupt)?;
    buf.truncate(info.buffer_size());
    Ok((info, buf))
}

fn decode_png_color(data: &[u8]) -> Result<RgbImage, MediaError> {
    let (info, buf) = read_png(data, png::Transformations::normalize_to_color8())?;
    let channels = info.color_type.samples();
    let data = match info.color_type {
        png::ColorType::Rgb => buf,
        png::ColorType::Rgba => buf.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect(),
        png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha => {
            buf.chunks_exact(channels).flat_map(|p| [p[0]; 3]).collect()
        }
        other => return Err(MediaError::Unsupported(format!("PNG {other:?}"))),
    };
    Ok(RgbImage { width: info.width, height: info.height, data })
}

/// `sensor_msgs/Image` 的行: 按 `step` 切出每行前 `row_bytes` 字节.
fn rows<'v>(value: &'v Value, bytes_per_pixel: u32) -> Result<(u32, u32, Vec<&'v [u8]>), MediaError> {
    let (width, height, step) = (field_u32(value, "width")?, field_u32(value, "height")?, field_u32(value, "step")?);
    let data = field_bytes(value, "data")?;
    let row_bytes = (width * bytes_per_pixel) as usize;
    if (step as usize) < row_bytes || data.len() < step as usize * height as usize {
        return Err(MediaError::Corrupt(format!("Image {width}x{height} step {step} 与数据 {} 字节不符", data.len())));
    }
    let rows = (0..height as usize).map(|y| &data[y * step as usize..][..row_bytes]).collect();
    Ok((width, height, rows))
}

fn raw_color(value: &Value) -> Result<RgbImage, MediaError> {
    let encoding = field_str(value, "encoding")?.to_ascii_lowercase();
    let (channels, order): (u32, [usize; 3]) = match encoding.as_str() {
        "rgb8" => (3, [0, 1, 2]),
        "bgr8" => (3, [2, 1, 0]),
        "rgba8" => (4, [0, 1, 2]),
        "bgra8" => (4, [2, 1, 0]),
        "mono8" | "8uc1" => (1, [0, 0, 0]),
        _ => return Err(MediaError::Unsupported(format!("Image encoding {encoding}"))),
    };
    let (width, height, rows) = rows(value, channels)?;
    let data = rows
        .iter()
        .flat_map(|row| row.chunks_exact(channels as usize).flat_map(|p| order.map(|i| p[i])))
        .collect();
    Ok(RgbImage { width, height, data })
}

fn raw_depth(value: &Value) -> Result<DepthImage, MediaError> {
    let encoding = field_str(value, "encoding")?.to_ascii_lowercase();
    let big_endian = matches!(value.get("is_bigendian"), Some(Value::U8(v)) if *v != 0);
    let is_float = encoding == "32fc1";
    let (width, height, rows) = rows(value, if is_float { 4 } else { 2 })?;
    let data = if is_float {
        rows.iter()
            .flat_map(|row| row.chunks_exact(4))
            .map(|c| {
                let bytes = [c[0], c[1], c[2], c[3]];
                let meters = if big_endian { f32::from_be_bytes(bytes) } else { f32::from_le_bytes(bytes) };
                if meters.is_finite() && meters > 0.0 { (meters * 1000.0).round().min(u16::MAX as f32) as u16 } else { 0 }
            })
            .collect()
    } else {
        rows.iter()
            .flat_map(|row| row.chunks_exact(2))
            .map(|c| if big_endian { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
            .collect()
    };
    Ok(DepthImage { width, height, data })
}
