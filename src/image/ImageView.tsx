import { type PointerEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { nanosecondsAt, secondsAt } from '../data-source/clock'
import { useAxis, useChannelPayloads, useChannels, useDataSource, useDiscontinuity } from '../data-source/react'
import { frameTimesOn } from '../data-source/time-axis'
import type { ChannelInfo, ImagePayload, Sample } from '../data-source/types'
import { useClockListener, useClockSelector } from '../playback/use-playback'
import { latestIndexAtOrBefore } from '../timeline/timeline'
import { useViewComposition } from '../views/view-context'
import { type DecodedFrame, decodeImage } from './decode'
import { createDepthRenderer, DEPTH_FAR_MILLIMETERS, DEPTH_NEAR_MILLIMETERS, type DepthRenderer } from './depth-renderer'
import { type ImageOverlay, isOverlayKind, type KeypointsFrame, overlayFrameAt, type SegmentationFrame } from './image-overlay'
import { useVideoPainter } from './video-decoder'
import { demandStartOf, isVideoFormat, samplesToDecode } from './video-keyframes'

const ROLE_LABELS: Record<string, string> = { camera: '相机', depth: '深度' }
// 排布按的画面宽高比; 实际画面在格子里等比缩放
const FRAME_ASPECT = 4 / 3
// 尺寸未知 (首次测量前, jsdom) 时一行最多几路
const FALLBACK_MAXIMUM_COLUMNS = 4
// 关键点直径 (屏幕像素), 不随画面缩放
const KEYPOINT_DIAMETER_PIXELS = 7
const KEYPOINT_OUTLINE_PIXELS = 2
// 播放时需求窗口向前延伸的时长 (纳秒): 15Hz下即当前块之后再预取两块; 暂停时窗口只是播放头
const PREFETCH_NANOSECONDS = 2_000_000_000n
const NANOSECONDS_PER_MILLISECOND = 1e6
const NO_CHANNELS: string[] = []

type OverlayOnStream = Exclude<ImageOverlay, { kind: 'invalid' }> & { channel: string }
type Size = { width: number; height: number }

// 让每路画面最大的列数: 逐个列数试, 取格子里4:3画面缩放后最大的
function bestColumnCount(count: number, size: Size | null) {
  if (!size || size.width === 0 || size.height === 0) return Math.min(count, FALLBACK_MAXIMUM_COLUMNS)
  let best = 1
  let bestScale = 0
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns)
    const scale = Math.min(size.width / columns / FRAME_ASPECT, size.height / rows)
    if (scale > bestScale) {
      best = columns
      bestScale = scale
    }
  }
  return best
}

// 回调ref: 网格在有图像流后才挂上, 挂上时再开始测量
function useElementSize() {
  const [element, ref] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  useEffect(() => {
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [ref, size] as const
}

function KeypointsLayer({ overlay, frame }: { overlay: OverlayOnStream; frame: KeypointsFrame }) {
  return (
    <svg
      role="img"
      aria-label={`2D关键点 ${overlay.name}`}
      viewBox={`0 0 ${overlay.width} ${overlay.height}`}
      preserveAspectRatio="xMidYMid meet"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <g role="list">
        {frame.points.map((point, index) => (
          // 零长线段配圆头与不缩放描边, 画成固定屏幕大小的点; 外圈深色描边保证在亮画面上可见
          <g key={index} role="listitem" strokeLinecap="round">
            {point.label && <title>{point.label}</title>}
            {(
              [
                ['var(--surface-0)', KEYPOINT_DIAMETER_PIXELS + KEYPOINT_OUTLINE_PIXELS * 2],
                ['var(--series-2)', KEYPOINT_DIAMETER_PIXELS],
              ] as const
            ).map(([color, width]) => (
              <line
                key={color}
                x1={point.x}
                y1={point.y}
                x2={point.x}
                y2={point.y}
                stroke={color}
                strokeWidth={width}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        ))}
      </g>
    </svg>
  )
}

function SegmentationLayer({ overlay, frame }: { overlay: OverlayOnStream; frame: SegmentationFrame }) {
  return (
    <img
      src={frame.mask}
      alt={`分割 ${overlay.name}`}
      className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-50"
    />
  )
}

function OverlayNotices({ notices, className = '' }: { notices: string[]; className?: string }) {
  if (notices.length === 0) return null
  return (
    <ul role="status" className={`flex flex-col gap-0.5 text-xs text-status-warning ${className}`}>
      {notices.map((notice) => (
        <li key={notice}>{notice}</li>
      ))}
    </ul>
  )
}


// 叠加层的一帧: 从状态的叠加通道读 (采样轴上没有, 叠加只有接收时刻), 按底图这一帧的采样时刻 (源帧时间戳) 对上
function OverlayLayer({ overlay, frameTime }: { overlay: OverlayOnStream; frameTime: number }) {
  const { state } = useDataSource()
  const frames = useChannelPayloads<KeypointsFrame | SegmentationFrame>(state, [overlay.channel])
  const frame = overlayFrameAt(frames, frameTime)
  if (!frame) return null
  if (overlay.kind === 'keypoints_2d') return <KeypointsLayer overlay={overlay} frame={frame as KeypointsFrame} />
  return <SegmentationLayer overlay={overlay} frame={frame as SegmentationFrame} />
}

// 采样时间轴上这一路所显示帧与播放头的偏差 (毫秒, 帧在播放头之前为负); 随时钟直接改文字, 不经React重渲
function SampleDeviation({ sampleTime }: { sampleTime: bigint }) {
  const { playback } = useViewComposition()
  const { zero } = useDataSource()
  const textRef = useRef<HTMLSpanElement>(null)
  useClockListener(playback.clock, (time) => {
    if (!textRef.current) return
    const deviation = Number(sampleTime - nanosecondsAt(zero, time)) / NANOSECONDS_PER_MILLISECOND
    textRef.current.textContent = `${deviation >= 0 ? '+' : ''}${deviation.toFixed(0)}ms`
  })
  return <span ref={textRef} aria-label="与播放头的偏差" className="font-mono text-foreground-tertiary" />
}

// 画在canvas上的一帧: 彩色画2D, 深度用WebGL2伪彩色; 深度另留毫米值供悬停读
type Painted = { width: number; height: number; depth: { data: Uint16Array } | null }

/**
 * 把一个图像样本解码画到canvas上, 换样本即重解; `isActive`为false (tab未显示) 时不解. 解码中又来新样本时只解最新的,
 * 中间的跳过; 迟到的旧结果丢弃. 彩色与深度各用一个canvas (同一canvas不能先取2D再取WebGL2上下文).
 * 视频不逐样本解: 给`videoPlan` (关键帧到目标帧的样本), 由这一路的视频解码器按序喂, 只画目标帧; 此时`payload`不用.
 */
function useDecodedCanvas(payload: ImagePayload | undefined, videoPlan: Sample<ImagePayload>[] | null, isActive: boolean) {
  const { state } = useDataSource()
  const discontinuity = useDiscontinuity(state)
  const colorRef = useRef<HTMLCanvasElement>(null)
  const depthRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<DepthRenderer | null | undefined>(undefined)
  const [painted, setPainted] = useState<Painted | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latestRef = useRef<ImagePayload | undefined>(undefined)
  const busyRef = useRef(false)
  const isActiveRef = useRef(isActive)
  useLayoutEffect(() => {
    isActiveRef.current = isActive
  })

  const paint = useCallback((frame: DecodedFrame) => {
    if (frame.kind === 'color') {
      const canvas = colorRef.current
      if (!canvas) return frame.close()
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width
        canvas.height = frame.height
      }
      canvas.getContext('2d')!.drawImage(frame.image, 0, 0)
      frame.close()
      setPainted((previous) =>
        previous?.width === frame.width && previous.height === frame.height && previous.depth === null
          ? previous
          : { width: frame.width, height: frame.height, depth: null },
      )
      return
    }
    const canvas = depthRef.current
    if (!canvas) return
    if (rendererRef.current === undefined) rendererRef.current = createDepthRenderer(canvas)
    if (!rendererRef.current) throw new Error('浏览器不支持WebGL2, 无法显示深度')
    rendererRef.current.draw(frame, DEPTH_NEAR_MILLIMETERS, DEPTH_FAR_MILLIMETERS)
    setPainted({ width: frame.width, height: frame.height, depth: { data: frame.data } })
  }, [])

  useEffect(() => {
    latestRef.current = payload
    if (!isActive || !payload || videoPlan || busyRef.current) return
    let isCurrent = true
    const run = async (next: ImagePayload) => {
      busyRef.current = true
      try {
        const frame = await decodeImage(next)
        if (!isCurrent && latestRef.current !== next) {
          if (frame.kind === 'color') frame.close()
        } else {
          paint(frame)
          setError(null)
        }
      } catch (reason) {
        setError((reason as Error).message)
      } finally {
        busyRef.current = false
      }
      // 解码期间来了更新的样本: 接着解它
      const pending = latestRef.current
      if (pending && pending !== next && isActiveRef.current) void run(pending)
    }
    void run(payload)
    return () => {
      isCurrent = false
    }
  }, [payload, videoPlan, isActive, paint])

  useVideoPainter(
    videoPlan,
    discontinuity,
    isActive,
    (frame) => {
      paint({ kind: 'color', image: frame, width: frame.displayWidth, height: frame.displayHeight, close: () => frame.close() })
      setError(null)
    },
    setError,
  )

  useEffect(
    () => () => {
      rendererRef.current?.dispose()
      // 清理后组件可能留着 (StrictMode重跑副作用, 热更新), 下次画时重建
      rendererRef.current = undefined
    },
    [],
  )
  return { colorRef, depthRef, painted, error }
}

// 悬停读深度: 指针在canvas (object-contain, 有留边) 上的位置换成像素, 读毫米值; 不在画面上为null
function pixelAt(event: PointerEvent<HTMLElement>, size: Size) {
  const rect = event.currentTarget.getBoundingClientRect()
  const scale = Math.min(rect.width / size.width, rect.height / size.height)
  const x = Math.floor((event.clientX - rect.left - (rect.width - size.width * scale) / 2) / scale)
  const y = Math.floor((event.clientY - rect.top - (rect.height - size.height * scale) / 2) / scale)
  return x >= 0 && y >= 0 && x < size.width && y < size.height ? { x, y } : null
}

function DepthReadout({ painted, hover }: { painted: Painted; hover: { x: number; y: number } | null }) {
  const depth = painted.depth!
  const value = hover ? depth.data[hover.y * painted.width + hover.x] : null
  return (
    <span className="pointer-events-none absolute top-1 left-1 rounded-sm bg-surface-2/90 px-1.5 font-mono text-xs text-foreground-secondary">
      {hover
        ? `(${hover.x}, ${hover.y}) ${value === 0 ? '无效' : `${value} mm`}`
        : `${DEPTH_NEAR_MILLIMETERS}-${DEPTH_FAR_MILLIMETERS} mm`}
    </span>
  )
}

// 一路画面及叠在上面的叠加层; 叠加层只在底图这一帧的时间戳上有数据时显示, 尺寸与底图不符则提示不叠
function StreamFigure({
  channel,
  payload,
  videoPlan,
  isActive,
  placeholder,
  frameIndex,
  frameTime,
  sampleDeviationOf,
  overlays,
}: {
  channel: ChannelInfo
  payload: ImagePayload | undefined
  // 视频: 从关键帧到所显示帧的样本; 非视频为null
  videoPlan: Sample<ImagePayload>[] | null
  isActive: boolean
  placeholder: string
  frameIndex: number
  frameTime: number | null
  // 采样轴上所显示帧的采样时刻, 标出与播放头的偏差; 接收轴上为null
  sampleDeviationOf: bigint | null
  overlays: OverlayOnStream[]
}) {
  const { colorRef, depthRef, painted, error } = useDecodedCanvas(payload, videoPlan, isActive)
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const isDepth = painted?.depth != null
  const mismatched = painted
    ? overlays.filter((overlay) => overlay.width !== painted.width || overlay.height !== painted.height)
    : []
  const drawn = painted && frameTime !== null ? overlays.filter((overlay) => !mismatched.includes(overlay)) : []
  const shown = payload && painted && !error
  return (
    <figure className="flex min-h-0 min-w-0 flex-col gap-1">
      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-md bg-surface-1">
        <canvas
          ref={colorRef}
          role="img"
          aria-label={channel.name}
          className="absolute inset-0 h-full w-full object-contain"
          hidden={!shown || isDepth}
        />
        <canvas
          ref={depthRef}
          role="img"
          aria-label={`${channel.name} 深度`}
          className="absolute inset-0 h-full w-full object-contain"
          hidden={!shown || !isDepth}
          onPointerMove={(event) => setHover(painted ? pixelAt(event, painted) : null)}
          onPointerLeave={() => setHover(null)}
        />
        {shown ? (
          <>
            {drawn.map((overlay) => (
              <OverlayLayer key={overlay.channel} overlay={overlay} frameTime={frameTime!} />
            ))}
            {isDepth && <DepthReadout painted={painted} hover={hover} />}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{error ? `解码失败: ${error}` : payload ? '解码中' : placeholder}</span>
        )}
        <OverlayNotices
          className="absolute inset-x-0 bottom-0 bg-surface-2/90 px-1.5 py-0.5"
          notices={mismatched.map(
            (overlay) =>
              `${overlay.name}尺寸${overlay.width}×${overlay.height}与底图${painted!.width}×${painted!.height}不符, 未叠加`,
          )}
        />
      </div>
      <figcaption className="flex items-baseline gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={channel.name}>
          {channel.name}
        </span>
        {channel.role && <span className="shrink-0">{ROLE_LABELS[channel.role] ?? channel.role}</span>}
        {sampleDeviationOf !== null && <SampleDeviation sampleTime={sampleDeviationOf} />}
        {frameIndex >= 0 && <span className="ml-auto shrink-0 font-mono">#{frameIndex}</span>}
      </figcaption>
    </figure>
  )
}

// 一路在该轴上不晚于播放头的最近一条的接收时刻, 拼成字符串作重渲依据; 没有为空
function latestKey(sample: Sample | null) {
  return sample ? String(sample.receiveTime) : ''
}

/**
 * 一组图像: 经数据源状态显示各路在所选时间轴上不晚于播放头的最近一帧, 渲染时才解码 (tab未显示时不解, 也不设需求窗口).
 * 离线: 帧号 (`#index`) 按通道的帧时刻表取; 需求窗口随所显示帧与播放与否更新, 暂停只要播放头处, 播放时向前预取.
 * 播放头处的段已到 (已覆盖) 才显示该帧; 未到时播放中停在已到的最近一帧 (降帧), 暂停显示"加载中". 采样轴上各路标出所显示帧与播放头的偏差.
 * 实时: 显示各路已收到的最新一帧, 需求窗口只说明要看哪些通道 (适配器据此订阅).
 */
function StreamGrid({ channels, overlays, isActive }: { channels: ChannelInfo[]; overlays: OverlayOnStream[]; isActive: boolean }) {
  const { playback } = useViewComposition()
  const { state, zero } = useDataSource()
  const axis = useAxis(state)
  const isLive = state.mode() === 'live'
  const panelId = useId()
  const ids = useMemo(() => channels.map((channel) => channel.id), [channels])
  // tab未显示时不订阅通道与时钟, 新样本不重渲
  useChannels(state, isActive ? ids : NO_CHANNELS)
  // 各路所显示的样本连成的字符串: 任一路换帧才重渲
  const shownKey = useClockSelector(playback.clock, (time) =>
    isActive ? ids.map((id) => latestKey(state.latestAtOrBefore(id, nanosecondsAt(zero, time)))).join(',') : '',
  )
  // 各路播放头所在的帧号 (按帧时刻表): 暂停时步进到还没取来的帧, 所显示的样本不变, 需求窗口也要随之移过去
  const frameKey = useClockSelector(playback.clock, (time) =>
    isActive && !isLive
      ? channels
          .map((channel) => (channel.frames ? latestIndexAtOrBefore(frameTimesOn(channel.frames, axis), nanosecondsAt(zero, time)) : ''))
          .join(',')
      : '',
  )

  useEffect(() => {
    if (!isActive) {
      state.setDemand(panelId, null)
      return
    }
    const time = nanosecondsAt(zero, playback.clock.getTime())
    const end = playback.isPlaying ? time + PREFETCH_NANOSECONDS : time
    // 视频要从关键帧解起, 起点前移到各视频通道播放头前最近的关键帧
    state.setDemand(panelId, { channels: ids, range: { start: isLive ? time : demandStartOf(channels, axis, time), end } })
    // 实时只说明要看哪些通道, 不随每帧更新窗口
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, zero, panelId, ids, channels, isActive, axis, playback.isPlaying, playback.clock, isLive ? null : shownKey, frameKey])
  useEffect(() => () => state.setDemand(panelId, null), [state, panelId])

  const time = isLive ? (state.latestReceiveTime() ?? 0n) : nanosecondsAt(zero, playback.clock.getTime())
  return (
    <>
      {channels.map((channel) => {
        const frameTimes = channel.frames ? frameTimesOn(channel.frames, axis) : null
        const index = frameTimes ? latestIndexAtOrBefore(frameTimes, time) : -1
        const isCovered = isLive || state.coveredRanges(channel.id).some((range) => range.start <= time && time <= range.end)
        const hasFrame = frameTimes ? index >= 0 : true
        const sample = hasFrame && (isCovered || playback.isPlaying) ? (state.latestAtOrBefore(channel.id, time) as Sample<ImagePayload> | null) : null
        // 视频要从关键帧解起: 关键帧那段未到时不画, 同未覆盖
        const isVideo = sample !== null && isVideoFormat(sample.payload.format)
        const videoPlan = isVideo ? samplesToDecode(state, channel.id, sample) : null
        const payload = isVideo && !videoPlan ? undefined : sample?.payload
        const error = state.errorOf(channel.id)
        const placeholder = error
          ? `取帧失败: ${error.message}`
          : !hasFrame
            ? '此刻之前无帧'
            : isLive
              ? isVideo ? '等待关键帧' : '等待数据'
              : '加载中'
        const sampleTime = sample?.sampleTime ?? null
        return (
          <StreamFigure
            key={channel.id}
            channel={channel}
            payload={payload}
            videoPlan={videoPlan}
            isActive={isActive}
            placeholder={placeholder}
            frameIndex={index}
            frameTime={axis === 'receive' && sampleTime !== null ? secondsAt(zero, sampleTime) : null}
            sampleDeviationOf={axis === 'sample' ? sampleTime : null}
            overlays={overlays.filter((overlay) => overlay.stream === channel.name)}
          />
        )
      })}
    </>
  )
}

// 叠加通道 -> 叠加层说明 (所基于的图像, 底图尺寸取自通道的`properties`); 内容无法识别的标为invalid
function overlayOf(channel: ChannelInfo): ImageOverlay & { channel: string } {
  const properties = (channel.properties ?? {}) as { stream?: string; width?: number; height?: number }
  const base = { channel: channel.id, name: channel.name, stream: properties.stream ?? '', width: properties.width ?? 0, height: properties.height ?? 0 }
  if (channel.issue || !isOverlayKind(channel.type) || !properties.stream)
    return { ...base, kind: 'invalid', issue: channel.issue ?? `未知的叠加种类${channel.type ?? ''}` }
  return { ...base, kind: channel.type, frames: [] } as ImageOverlay & { channel: string }
}

/**
 * 图像视图: 绑定到的各路图像排成网格 (列数按面板宽高比取使画面最大的), 分割与2D关键点叠在所基于的那路上.
 * 叠加层基于的图像不在本视图, 或内容无法识别时, 在面板底部提示未叠加. `isActive`为false (tab未显示) 时不解码.
 */
export function ImageView({ channels, isActive = true }: { channels: ChannelInfo[]; isActive?: boolean }) {
  const [gridRef, gridSize] = useElementSize()
  const streams = useMemo(() => channels.filter((channel) => channel.kind === 'image'), [channels])
  const overlays = useMemo(() => channels.filter((channel) => channel.kind === 'overlay').map(overlayOf), [channels])
  const streamNames = new Set(streams.map((stream) => stream.name))
  const placed = overlays.filter(
    (overlay): overlay is OverlayOnStream => overlay.kind !== 'invalid' && streamNames.has(overlay.stream),
  )
  const notices = overlays.flatMap((overlay) => {
    if (overlay.kind === 'invalid') return [`${overlay.name}的内容无法识别, 未叠加: ${overlay.issue}`]
    if (!streamNames.has(overlay.stream))
      return [`${overlay.name}基于图像${overlay.stream}, 与本视图的图像坐标系不符, 未叠加`]
    return []
  })

  if (streams.length === 0) return <p className="text-sm text-muted-foreground">没有图像通道</p>
  const columns = bestColumnCount(streams.length, gridSize)
  return (
    <div className="flex h-full min-h-0 flex-col gap-1">
      <div
        ref={gridRef}
        className="grid min-h-0 flex-1 gap-2"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.ceil(streams.length / columns)}, minmax(0, 1fr))`,
        }}
      >
        <StreamGrid channels={streams} overlays={placed} isActive={isActive} />
      </div>
      <OverlayNotices notices={notices} />
    </div>
  )
}
