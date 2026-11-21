import { ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { nanosecondsAt } from '../data-source/clock'
import { useDataSource } from '../data-source/react'
import type { ChannelInfo, MessagePayload, Sample } from '../data-source/types'
import { useClockSelector } from '../playback/use-playback'
import { useViewComposition } from '../views/view-context'
import { type DecodedMessage, loadRosz, loadedRosz } from './rosz'

// 数组只列前几项: 大数组 (点云, 图像字节) 全列既看不清也拖慢渲染
const ARRAY_PREVIEW_ITEMS = 8
// 播放时需求窗口向前预取的时长 (纳秒), 同图像视图; 暂停时窗口只是播放头
const PREFETCH_NANOSECONDS = 2_000_000_000n
// 默认展开的层数: 顶层字段直接可见, 更深的嵌套消息点开再看
const EXPANDED_DEPTH = 1

// 一路当前显示的内容: 还没有样本, 解码结果, 或解码失败的原因
type Shown =
  | { kind: 'none'; text: string }
  | { kind: 'decoded'; tree: Record<string, unknown> }
  | { kind: 'failed'; reason: string }

function isTypedArray(value: unknown): value is ArrayLike<number | bigint> {
  return ArrayBuffer.isView(value) && !(value instanceof DataView)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isTypedArray(value)
}

// 叶子值的文字: BigInt与数字一样直接写出, 字符串原样 (不加引号, 空串标出来免得像没值)
function formatScalar(value: unknown) {
  if (typeof value === 'string') return value === '' ? '(空)' : value
  return String(value)
}

function isComposite(value: unknown) {
  return isRecord(value) || ((Array.isArray(value) || isTypedArray(value)) && value.length > 0)
}

// 能折叠的一行: 字段名加摘要, 展开后显示子项; 展开状态随组件留着, 同一字段换新消息时不复位
function FoldRow({ label, summary, depth, children }: { label: ReactNode; summary: ReactNode; depth: number; children: ReactNode }) {
  const [isOpen, setOpen] = useState(depth < EXPANDED_DEPTH)
  return (
    <li>
      <button
        type="button"
        aria-expanded={isOpen}
        className="flex w-full items-baseline gap-1 rounded-sm text-left hover:bg-surface-hover"
        onClick={() => setOpen(!isOpen)}
      >
        <ChevronRight className={`size-3 shrink-0 self-center text-foreground-tertiary transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        <span className="text-foreground-secondary">{label}</span>
        <span className="truncate text-foreground-tertiary">{summary}</span>
      </button>
      {isOpen && <ul className="ml-1.5 border-l border-line pl-2">{children}</ul>}
    </li>
  )
}

function LeafRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  // 与可折叠行的箭头对齐
  return (
    <li className="flex items-baseline gap-1 pl-4">
      <span className="shrink-0 text-foreground-secondary">{label}</span>
      <span className="break-all whitespace-pre-wrap text-foreground">{value}</span>
    </li>
  )
}

// 一个字段: 嵌套消息与数组可折叠, 其余为叶子
function FieldNode({ label, value, depth }: { label: ReactNode; value: unknown; depth: number }) {
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return <LeafRow label={label} value="{}" />
    return (
      <FoldRow label={label} summary="{…}" depth={depth}>
        {entries.map(([name, child]) => (
          <FieldNode key={name} label={name} value={child} depth={depth + 1} />
        ))}
      </FoldRow>
    )
  }
  if (Array.isArray(value) || isTypedArray(value)) {
    const items = Array.from({ length: Math.min(value.length, ARRAY_PREVIEW_ITEMS) }, (_, index) => value[index])
    const rest = value.length - items.length
    if (value.length === 0) return <LeafRow label={label} value="[0]" />
    // 全是标量的数组 (含TypedArray) 一行写完前几项, 消息数组逐项可折叠
    if (!items.some(isComposite))
      return <LeafRow label={label} value={`[${value.length}] ${items.map(formatScalar).join(', ')}${rest > 0 ? ', …' : ''}`} />
    return (
      <FoldRow label={label} summary={`[${value.length}]`} depth={depth}>
        {items.map((item, index) => (
          <FieldNode key={index} label={index} value={item} depth={depth + 1} />
        ))}
        {rest > 0 && <li className="pl-4 text-foreground-tertiary">还有{rest}项未列出</li>}
      </FoldRow>
    )
  }
  return <LeafRow label={label} value={formatScalar(value)} />
}

function decode(rosz: NonNullable<ReturnType<typeof loadedRosz>>, type: string, payload: MessagePayload): Shown {
  try {
    const { tree } = rosz.decoder.decode(type, payload.data) as DecodedMessage
    return { kind: 'decoded', tree }
  } catch (reason) {
    return { kind: 'failed', reason: reason instanceof Error ? reason.message : String(reason) }
  }
}

/**
 * 一路在`time`处 (不晚于它的最近一条) 的解码结果, 解码按显示节奏节流: 样本与播放头的变化只记下, 每个动画帧至多解一次最新的,
 * 中间的 (如200Hz话题一帧内到的多条) 直接跳过; 样本没换就不重解. 首次用到时等WASM加载完再解.
 */
function useDecodedAt(channel: ChannelInfo, time: () => bigint, placeholder: () => string): Shown {
  const { state } = useDataSource()
  const [shown, setShown] = useState<Shown>({ kind: 'none', text: '' })
  const timeRef = useRef(time)
  const placeholderRef = useRef(placeholder)
  useEffect(() => {
    timeRef.current = time
    placeholderRef.current = placeholder
  })
  const { playback } = useViewComposition()

  useEffect(() => {
    const type = channel.type
    let frame: number | null = null
    let decodedSample: Sample | null = null
    let isDisposed = false
    const update = () => {
      frame = null
      const rosz = loadedRosz()
      if (!rosz) {
        void loadRosz().then(schedule, (reason: Error) => {
          if (!isDisposed) setShown({ kind: 'failed', reason: `解码模块加载失败: ${reason.message}` })
        })
        return
      }
      const sample = state.latestAtOrBefore(channel.id, timeRef.current())
      if (!sample) {
        // 无样本时的说明 (等待, 取数失败) 可能随通道错误变, 每次都重算
        decodedSample = null
        const text = placeholderRef.current()
        setShown((previous) => (previous.kind === 'none' && previous.text === text ? previous : { kind: 'none', text }))
        return
      }
      if (sample === decodedSample) return
      decodedSample = sample
      if (!type) setShown({ kind: 'failed', reason: '通道没有消息类型' })
      else setShown(decode(rosz, type, sample.payload as MessagePayload))
    }
    function schedule() {
      if (isDisposed || frame !== null) return
      frame = requestAnimationFrame(update)
    }
    const unsubscribeChannel = state.subscribe(channel.id, schedule)
    const unsubscribeClock = playback.clock.subscribe(schedule)
    schedule()
    return () => {
      isDisposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      unsubscribeChannel()
      unsubscribeClock()
    }
  }, [state, playback.clock, channel.id, channel.type])
  return shown
}

function ChannelHeader({ channel }: { channel: ChannelInfo }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-foreground">{channel.name}</span>
      {channel.type && <span className="truncate font-mono text-foreground-tertiary">{channel.type}</span>}
    </div>
  )
}

function MessageChannel({ channel, time, placeholder }: { channel: ChannelInfo; time: () => bigint; placeholder: () => string }) {
  const shown = useDecodedAt(channel, time, placeholder)
  return (
    <section aria-label={channel.name} className="flex flex-col gap-1 rounded-md bg-surface-2 p-2">
      <ChannelHeader channel={channel} />
      {shown.kind === 'decoded' ? (
        <ul className="font-mono">
          {Object.entries(shown.tree).map(([name, value]) => (
            <FieldNode key={name} label={name} value={value} depth={0} />
          ))}
        </ul>
      ) : shown.kind === 'failed' ? (
        <p role="alert" className="text-status-danger">解码失败: {shown.reason}</p>
      ) : (
        <p className="text-muted-foreground">{shown.text}</p>
      )}
    </section>
  )
}

// 解不了的通道: 只显示名称与类型及原因, 不取数也不解码
function UndecodableChannel({ channel }: { channel: ChannelInfo }) {
  return (
    <section aria-label={channel.name} aria-disabled className="flex flex-col gap-1 rounded-md bg-surface-2 p-2 opacity-50">
      <ChannelHeader channel={channel} />
      <p className="text-foreground-tertiary">无法解码: {channel.undecodable}</p>
    </section>
  )
}

/**
 * 结构化消息视图: 各路显示不晚于播放头的最近一条 (实时为已收到的最新一条), 渲染时按通道`type`用rosz WASM解码成可折叠的树.
 * 需求窗口: 离线为播放头处 (随所显示消息与播放与否更新, 同图像视图), 实时只说明要看哪些通道; 解不了的通道不进窗口.
 */
export function MessageView({ channels }: { channels: ChannelInfo[] }) {
  const { playback } = useViewComposition()
  const { state, zero } = useDataSource()
  const isLive = state.mode() === 'live'
  const panelId = useId()
  const messages = useMemo(() => channels.filter((channel) => channel.kind === 'message'), [channels])
  const ids = useMemo(() => messages.filter((channel) => !channel.undecodable).map((channel) => channel.id), [messages])
  // 离线时各路所显示的样本与播放头是否已覆盖拼成的字符串, 任一路换条或播放头走出已取的段才更新需求窗口
  // (只看样本的话, 播放到已取段之外时所显示的不再变, 窗口会停住); 实时不随消息更新, 免得高频话题每条都重渲
  const shownKey = useClockSelector(playback.clock, (time) => {
    if (isLive) return ''
    const now = nanosecondsAt(zero, time)
    return ids
      .map((id) => {
        const isCovered = state.coveredRanges(id).some((range) => range.start <= now && now <= range.end)
        return `${state.latestAtOrBefore(id, now)?.receiveTime ?? ''}${isCovered ? '' : '?'}`
      })
      .join(',')
  })

  useEffect(() => {
    const start = nanosecondsAt(zero, playback.clock.getTime())
    const end = playback.isPlaying ? start + PREFETCH_NANOSECONDS : start
    state.setDemand(panelId, { channels: ids, range: { start, end } })
    // shownKey只作重设窗口的时机
  }, [state, zero, panelId, ids, playback.clock, playback.isPlaying, shownKey])
  useEffect(() => () => state.setDemand(panelId, null), [state, panelId])

  // 在节流的解码回调里读, 取的是那一刻的播放头, 不是渲染时的
  const time = () => (isLive ? (state.latestReceiveTime() ?? 0n) : nanosecondsAt(zero, playback.clock.getTime()))
  const placeholderOf = (id: string) => () => {
    const error = state.errorOf(id)
    if (error) return `取数失败: ${error.message}`
    if (isLive) return '等待数据'
    const now = time()
    // 播放头处的段还没取到时是在加载, 取到了仍没有才是确实没有
    return state.coveredRanges(id).some((range) => range.start <= now && now <= range.end) ? '此刻之前无消息' : '加载中'
  }

  if (messages.length === 0) return <p className="text-sm text-muted-foreground">没有消息通道</p>
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto text-xs">
      {messages.map((channel) =>
        channel.undecodable ? (
          <UndecodableChannel key={channel.id} channel={channel} />
        ) : (
          <MessageChannel key={channel.id} channel={channel} time={time} placeholder={placeholderOf(channel.id)} />
        ),
      )}
    </div>
  )
}
