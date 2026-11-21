/**
 * 视频通道的WebCodecs解码: 每路一个`VideoDecoder` (`optimizeForLatency`, 不flush, 喂完即逐帧出), 只画所要的目标帧.
 * 顺序播放时接着上次喂到的样本增量喂; 跳转, 步进, 循环回绕, 切轴 (状态的不连续计数变了), 关键帧换了, 或目标不在已喂序列之后时
 * `reset`并重新配置, 从关键帧按序喂到目标 (configure之后第一块必须是关键帧). 依据见查看器research 14 §4.
 * codec字符串从关键帧码流推: H.264取SPS的profile/constraint/level拼`avc1.PPCCLL` (Annex B, 不给description);
 * AV1取Sequence Header的profile与首个工作点的level/tier, 位深按8位 (Chromium解码不按codec字符串的位深选路径).
 */
import { useEffect, useEffectEvent, useRef } from 'react'
import type { ImagePayload, Sample } from '../data-source/types'

// AV1 Sequence Header读不出level时用的level (seq_level_idx 8即4.0)
const AV1_FALLBACK_LEVEL = 8
// AV1 OBU类型: Sequence Header
const AV1_OBU_SEQUENCE_HEADER = 1
// H.264 NAL类型: SPS
const H264_NAL_SPS = 7

function hex(value: number) {
  return value.toString(16).padStart(2, '0')
}

// Annex B里首个SPS后的profile_idc, constraint_set标志, level_idc
function h264Codec(bytes: Uint8Array) {
  for (let index = 0; index + 6 < bytes.length; index += 1) {
    if (bytes[index] !== 0 || bytes[index + 1] !== 0 || bytes[index + 2] !== 1) continue
    if ((bytes[index + 3] & 0x1f) !== H264_NAL_SPS) continue
    return `avc1.${hex(bytes[index + 4])}${hex(bytes[index + 5])}${hex(bytes[index + 6])}`
  }
  return null
}

// 读leb128 (AV1 OBU的长度字段)
function readLeb128(bytes: Uint8Array, offset: number) {
  let value = 0
  let length = 0
  for (; length < 8; length += 1) {
    const byte = bytes[offset + length]
    value += (byte & 0x7f) * 2 ** (7 * length)
    if (!(byte & 0x80)) return { value, length: length + 1 }
  }
  return { value, length }
}

// 时间单元里的Sequence Header OBU: seq_profile (3位); 不带timing_info时再读首个工作点的seq_level_idx与tier
function av1Codec(bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes[offset]
    const type = (header >> 3) & 0x0f
    const headerLength = 1 + ((header >> 2) & 1)
    if (!((header >> 1) & 1)) return null
    const size = readLeb128(bytes, offset + headerLength)
    const payload = offset + headerLength + size.length
    if (type === AV1_OBU_SEQUENCE_HEADER) {
      const bits = (bytes[payload] << 8) | bytes[payload + 1]
      const profile = bits >> 13
      const isReduced = (bits >> 11) & 1
      let level = AV1_FALLBACK_LEVEL
      let tier = 'M'
      if (isReduced) level = (bits >> 6) & 0x1f
      else if (!((bits >> 10) & 1)) {
        // timing_info_present为0: initial_display_delay_present(1), operating_points_cnt_minus_1(5), operating_point_idc(12), seq_level_idx(5), seq_tier(1)
        const word = (bytes[payload] << 24) | (bytes[payload + 1] << 16) | (bytes[payload + 2] << 8) | bytes[payload + 3]
        level = (word >>> 3) & 0x1f
        if (level > 7 && (word >>> 2) & 1) tier = 'H'
      }
      return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.08`
    }
    offset = payload + size.value
  }
  return null
}

// 关键帧码流 -> WebCodecs的codec字符串; 推不出为null
export function codecOf(format: string, keyframe: Uint8Array) {
  if (format === 'h264') return h264Codec(keyframe)
  if (format === 'av1') return av1Codec(keyframe)
  return null
}

async function bytesOf(data: Blob | Uint8Array) {
  return data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer())
}

// 各codec字符串可用的配置, 查一次记下: 先要硬解, 不支持退回由浏览器选
const configByCodec = new Map<string, Promise<VideoDecoderConfig | null>>()

function supportedConfig(codec: string) {
  let config = configByCodec.get(codec)
  if (!config) {
    config = (async () => {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
        const candidate: VideoDecoderConfig = { codec, optimizeForLatency: true, hardwareAcceleration }
        const { supported } = await VideoDecoder.isConfigSupported(candidate).catch(() => ({ supported: false }))
        if (supported) return candidate
      }
      return null
    })()
    configByCodec.set(codec, config)
  }
  return config
}

type Request = { plan: Sample<ImagePayload>[]; discontinuity: number }

/**
 * 一路视频的解码器. `show(plan, discontinuity)`: `plan`为从关键帧到目标帧的样本 (见`samplesToDecode`), 解出目标帧交给`onFrame`
 * (由它画完并`close`); 解码中又来新请求时只办最新的. 出错交给`onError`, 下次请求重建解码器. 卸载时`close`.
 */
export function createVideoPainter(onFrame: (frame: VideoFrame) => void, onError: (message: string) => void) {
  let decoder: VideoDecoder | null = null
  // 已喂的序列: 其关键帧, 最后一条, 喂时的不连续计数
  let fed: { keyframe: Sample<ImagePayload>; last: Sample<ImagePayload>; discontinuity: number } | null = null
  let nextTimestamp = 0
  // 所要的目标帧 (按块时间戳); 出一帧即画, 并丢掉比它早的
  const wanted = new Set<number>()
  let pending: Request | null = null
  let isBusy = false
  let isClosed = false

  function createDecoder() {
    return new VideoDecoder({
      output: (frame) => {
        if (!wanted.has(frame.timestamp)) return frame.close()
        for (const timestamp of wanted) if (timestamp <= frame.timestamp) wanted.delete(timestamp)
        onFrame(frame)
      },
      error: (error) => {
        fed = null
        decoder = null
        onError(error.message)
      },
    })
  }

  async function feed({ plan, discontinuity }: Request) {
    const target = plan.at(-1)!
    const lastIndex = fed && fed.discontinuity === discontinuity && fed.keyframe === plan[0] ? plan.indexOf(fed.last) : -1
    const isIncremental = lastIndex >= 0
    const toFeed = isIncremental ? plan.slice(lastIndex + 1) : plan
    if (toFeed.length === 0) return
    const chunks = await Promise.all(toFeed.map((sample) => bytesOf(sample.payload.data)))
    if (isClosed) return
    if (!isIncremental) {
      if (typeof VideoDecoder === 'undefined') throw new Error('浏览器不支持WebCodecs视频解码')
      const { format } = plan[0].payload
      const codec = codecOf(format, chunks[0])
      if (!codec) throw new Error(`关键帧里找不到${format}的序列参数`)
      const config = await supportedConfig(codec)
      if (!config) throw new Error(`浏览器不支持视频编码${codec}`)
      if (isClosed) return
      if (decoder) decoder.reset()
      else decoder = createDecoder()
      wanted.clear()
      decoder.configure(config)
    }
    toFeed.forEach((sample, index) => {
      const timestamp = nextTimestamp++
      if (sample === target) wanted.add(timestamp)
      decoder!.decode(new EncodedVideoChunk({ type: sample.payload.isKeyframe ? 'key' : 'delta', timestamp, data: chunks[index] }))
    })
    fed = { keyframe: plan[0], last: target, discontinuity }
  }

  async function drain() {
    isBusy = true
    while (pending && !isClosed) {
      const request = pending
      pending = null
      try {
        await feed(request)
      } catch (reason) {
        fed = null
        onError((reason as Error).message)
      }
    }
    isBusy = false
  }

  return {
    show(plan: Sample<ImagePayload>[], discontinuity: number) {
      if (isClosed || plan.length === 0) return
      pending = { plan, discontinuity }
      if (!isBusy) void drain()
    },
    close() {
      isClosed = true
      if (decoder?.state !== 'closed') decoder?.close()
      decoder = null
    },
  }
}

export type VideoPainter = ReturnType<typeof createVideoPainter>

/**
 * 面板用的视频解码: `isActive`且有`plan`时交给这一路的解码器 (首次要画时建, 卸载时关); 解出的帧经`onFrame`画, 错误经`onError`报.
 */
export function useVideoPainter(
  plan: Sample<ImagePayload>[] | null,
  discontinuity: number,
  isActive: boolean,
  onFrame: (frame: VideoFrame) => void,
  onError: (message: string) => void,
) {
  const painterRef = useRef<VideoPainter | null>(null)
  const frameEvent = useEffectEvent(onFrame)
  const errorEvent = useEffectEvent(onError)
  useEffect(() => {
    if (!isActive || !plan) return
    painterRef.current ??= createVideoPainter(
      (frame) => frameEvent(frame),
      (message) => errorEvent(message),
    )
    painterRef.current.show(plan, discontinuity)
  }, [plan, discontinuity, isActive])
  useEffect(
    () => () => {
      painterRef.current?.close()
      // StrictMode重跑副作用后组件还在, 下次要画时重建
      painterRef.current = null
    },
    [],
  )
}
