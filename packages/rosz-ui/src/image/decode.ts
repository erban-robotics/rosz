/**
 * 图像样本的解码, 渲染时才做: 彩色 (JPEG, PNG) 由浏览器解, 支持WebCodecs `ImageDecoder`时用它 (Chromium上CPU约为
 * `createImageBitmap`的一半, 产出I420的VideoFrame, 颜色转换交给GPU), 否则退回`createImageBitmap` (Firefox);
 * 深度 (`16UC1; zstd`, `16UC1; compressedDepth`) 由rosz核心库WASM解成uint16毫米. 依据见查看器research 03.
 */
import type { ImagePayload } from '../data-source/types'
import { loadRosz } from '../message/rosz'

// 解好的彩色帧: 画到2D canvas上后调`close`释放 (VideoFrame不及时关会卡住解码器)
export type ColorFrame = { kind: 'color'; image: CanvasImageSource; width: number; height: number; close: () => void }
// 解好的深度帧: 行优先`高 x 宽`, 单位毫米, 0为无效
export type DepthFrame = { kind: 'depth'; width: number; height: number; data: Uint16Array }
export type DecodedFrame = ColorFrame | DepthFrame

// 深度格式: `16UC1; zstd` (erban sensors) 与`16UC1; compressedDepth` (image_transport的16位PNG)
export function isDepthFormat(format: string) {
  return format.startsWith('16UC1') && (format.includes('zstd') || format.includes('compressedDepth'))
}

// 彩色格式的MIME: `CompressedImage.format`可能是`jpeg`或image_transport的`bgr8; jpeg compressed bgr8`写法
function mimeOf(format: string) {
  const lower = format.toLowerCase()
  if (lower.includes('png')) return 'image/png'
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'image/jpeg'
  return null
}

async function bytesOf(data: Blob | Uint8Array) {
  return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())
}

// 各MIME是否走ImageDecoder, 查一次记下
const imageDecoderSupport = new Map<string, Promise<boolean>>()

function supportsImageDecoder(mime: string) {
  if (typeof ImageDecoder === 'undefined') return Promise.resolve(false)
  let support = imageDecoderSupport.get(mime)
  if (!support) {
    support = ImageDecoder.isTypeSupported(mime).catch(() => false)
    imageDecoderSupport.set(mime, support)
  }
  return support
}

async function decodeColor(payload: ImagePayload, mime: string): Promise<ColorFrame> {
  if (await supportsImageDecoder(mime)) {
    const decoder = new ImageDecoder({ data: await bytesOf(payload.data), type: mime })
    try {
      const { image } = await decoder.decode()
      return { kind: 'color', image, width: image.displayWidth, height: image.displayHeight, close: () => image.close() }
    } finally {
      decoder.close()
    }
  }
  const blob = payload.data instanceof Blob ? payload.data : new Blob([payload.data as Uint8Array<ArrayBuffer>], { type: mime })
  const bitmap = await createImageBitmap(blob)
  return { kind: 'color', image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
}

async function decodeDepth(payload: ImagePayload): Promise<DepthFrame> {
  const rosz = await loadRosz()
  const depth = rosz.decodeDepth(payload.format, await bytesOf(payload.data))
  try {
    return { kind: 'depth', width: depth.width, height: depth.height, data: depth.data }
  } finally {
    depth.free()
  }
}

// 解一帧图像; 格式不认识或数据坏了即抛错, 面板显示原因
export function decodeImage(payload: ImagePayload): Promise<DecodedFrame> {
  if (isDepthFormat(payload.format)) return decodeDepth(payload)
  const mime = mimeOf(payload.format)
  if (!mime) return Promise.reject(new Error(`不支持的图像格式: ${payload.format}`))
  return decodeColor(payload, mime)
}
