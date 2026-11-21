/**
 * 图像话题的样本换成 rosz-ui 图像面板吃的 `ImagePayload` ({format, 压缩字节}).
 * - `CompressedImage`: 原样给; 面板认的格式为 JPEG / PNG 彩色, `16UC1; zstd` 与 `16UC1; compressedDepth` 深度.
 *   别的格式 (zstd_image_transport 的 `zstd`: 整条 Image 经 zstd 压缩) 与空数据给出原因, 不交给面板
 * - 原始 `sensor_msgs/Image`: 面板不吃原始像素, 这里转一道. 深度 (`16UC1` `mono16` 毫米, `32FC1` 米) 包成
 *   `16UC1; zstd` (zstd 帧只用不压缩的原样块, 不费 CPU); 彩色 (`rgb8` `bgr8` `rgba8` `bgra8` `mono8`) 经 OffscreenCanvas
 *   编成 JPEG (异步, 每路同时只编一帧, 编不过来的帧丢掉)
 */
import { type ImagePayload, isDepthFormat } from '@erban-robotics/rosz-ui'

export const COMPRESSED_IMAGE = 'sensor_msgs/msg/CompressedImage'
export const RAW_IMAGE = 'sensor_msgs/msg/Image'
const JPEG_QUALITY = 0.9
// zstd 原样块的最大长度 (规范上限 128 KiB)
const ZSTD_BLOCK = 128 * 1024

export function isImageType(schemaName: string) {
  return schemaName === COMPRESSED_IMAGE || schemaName === RAW_IMAGE
}

/** 一帧的换算结果: 可交给面板的内容, 或面板显示不了的原因 */
export type Converted = { payload: ImagePayload | Promise<ImagePayload> } | { issue: string }

function isColorFormat(format: string) {
  return /png|jpe?g/i.test(format)
}

export function fromCompressed(format: string, data: Uint8Array): Converted {
  if (data.length === 0) return { issue: `消息里没有图像数据 (format "${format}")` }
  if (isDepthFormat(format) || isColorFormat(format)) return { payload: { format, data } }
  if (format.trim().toLowerCase() === 'zstd')
    return { issue: '不支持 zstd_image_transport 的格式 "zstd" (整条 Image 经 zstd 压缩); 可看同一相机的 compressed / compressedDepth 话题' }
  return { issue: `不支持的图像格式 "${format}"` }
}

type RawImage = { width: number; height: number; encoding: string; is_bigendian: number; step: number; data: Uint8Array }

/** zstd 帧 (带内容长度, 单段) 里放原样块: 解压即拷贝 */
function zstdStored(bytes: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(bytes.length / ZSTD_BLOCK))
  const out = new Uint8Array(13 + blocks * 3 + bytes.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0xfd2fb528, true)
  // 帧头描述: 内容长度字段 8 字节, 单段 (无窗口描述), 无校验, 无字典
  out[4] = 0xe0
  view.setBigUint64(5, BigInt(bytes.length), true)
  let at = 13
  for (let index = 0; index < blocks; index += 1) {
    const start = index * ZSTD_BLOCK
    const size = Math.min(ZSTD_BLOCK, bytes.length - start)
    // 块头 3 字节: 末块标志, 类型 (0 为原样), 长度
    const header = size * 8 + (index === blocks - 1 ? 1 : 0)
    out[at] = header & 0xff
    out[at + 1] = (header >> 8) & 0xff
    out[at + 2] = (header >> 16) & 0xff
    out.set(bytes.subarray(start, start + size), at + 3)
    at += 3 + size
  }
  return out
}

/** 深度换成 erban `16UC1; zstd`: 4 字节小端头 (u16 宽, u16 高) + zstd 帧 (小端 uint16 毫米, 行紧排) */
function depthPayload(image: RawImage): ImagePayload {
  const { width, height, step, data } = image
  const millimeters = new Uint16Array(width * height)
  const source = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const isFloat = image.encoding === '32FC1'
  const littleEndian = !image.is_bigendian
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column
      if (isFloat) {
        const meters = source.getFloat32(row * step + column * 4, littleEndian)
        millimeters[index] = Number.isFinite(meters) && meters > 0 ? Math.min(Math.round(meters * 1000), 0xffff) : 0
      } else millimeters[index] = source.getUint16(row * step + column * 2, littleEndian)
    }
  }
  const zstd = zstdStored(new Uint8Array(millimeters.buffer))
  const payload = new Uint8Array(4 + zstd.length)
  const header = new DataView(payload.buffer)
  header.setUint16(0, width, true)
  header.setUint16(2, height, true)
  payload.set(zstd, 4)
  return { format: '16UC1; zstd', data: payload }
}

// 各编码的 (每像素字节, R/G/B 偏移); mono8 三个分量同一字节
const COLOR_LAYOUTS: Record<string, { bytes: number; offsets: [number, number, number] }> = {
  rgb8: { bytes: 3, offsets: [0, 1, 2] },
  bgr8: { bytes: 3, offsets: [2, 1, 0] },
  rgba8: { bytes: 4, offsets: [0, 1, 2] },
  bgra8: { bytes: 4, offsets: [2, 1, 0] },
  mono8: { bytes: 1, offsets: [0, 0, 0] },
}

function colorPayload(image: RawImage): Promise<ImagePayload> {
  const { width, height, step, data } = image
  const { bytes, offsets } = COLOR_LAYOUTS[image.encoding]
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const from = row * step + column * bytes
      const to = (row * width + column) * 4
      rgba[to] = data[from + offsets[0]]
      rgba[to + 1] = data[from + offsets[1]]
      rgba[to + 2] = data[from + offsets[2]]
      rgba[to + 3] = 255
    }
  }
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0)
  return canvas
    .convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
    .then((blob) => ({ format: 'jpeg', data: blob }))
}

const DEPTH_ENCODINGS = new Set(['16UC1', 'mono16', '32FC1'])

export function fromRaw(image: RawImage): Converted {
  const { width, height, step, encoding, data } = image
  if (width === 0 || height === 0 || data.length === 0) return { issue: '消息里没有图像数据' }
  const pixelBytes = DEPTH_ENCODINGS.has(encoding) ? (encoding === '32FC1' ? 4 : 2) : COLOR_LAYOUTS[encoding]?.bytes
  if (pixelBytes === undefined) return { issue: `不支持的 Image encoding "${encoding}"` }
  if (step < width * pixelBytes || data.length < step * height)
    return { issue: `Image ${width}x${height} step ${step} 与数据 ${data.length} 字节不符` }
  return { payload: DEPTH_ENCODINGS.has(encoding) ? depthPayload(image) : colorPayload(image) }
}

/** 面板图注的角色: 按内容的格式定 (话题名靠不住: 如 color/.../compressedDepth) */
export function roleOf(format: string) {
  return isDepthFormat(format) ? 'depth' : 'camera'
}
