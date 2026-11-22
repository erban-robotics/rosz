// 会话时间轴的纯计算: 按时刻找帧, 可见区间与刻度, 事件归类
import { type EventKind, eventKindOf, type QualityCheckEvent } from './events'

// 升序时刻 (秒或纳秒) 里不晚于time的最后一个下标; time早于首帧为-1
export function latestIndexAtOrBefore<Time extends number | bigint>(times: Time[], time: Time) {
  let low = 0
  let high = times.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (times[middle] <= time) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

// 时长显示为 分:秒.十分位
export function formatSeconds(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(1).padStart(4, '0')}`
}

// 事件的称呼: 类别中文名 (无定义时取类别id) 与会话时间轴上的起止
export function qualityCheckEventLabel(qualityCheckEvent: QualityCheckEvent) {
  const name = qualityCheckEvent.definition?.name ?? qualityCheckEvent.category
  return `${name}${formatSeconds(qualityCheckEvent.start)}-${formatSeconds(qualityCheckEvent.end)}`
}

// 一条曲线: 时刻与值等长, 缺测为null
export type ChartLine = { label: string; times: number[]; values: (number | null)[] }

// 时间线的可见区间 (秒), 各轨道共用
export type TimeView = { start: number; end: number }

// 可见区间最短0.05秒, 再放大已看不出200Hz采样间的差别
export const MINIMUM_VIEW_SECONDS = 0.05
// 标尺刻度间隔的候选 (秒), 取相邻刻度不小于最小像素间距的最小一档
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

// 区间长度夹在 [最短, 总长], 再整体平移进 [0, 总长]
export function clampView(view: TimeView, duration: number): TimeView {
  if (duration <= 0) return { start: 0, end: 0 }
  const span = Math.min(Math.max(view.end - view.start, Math.min(MINIMUM_VIEW_SECONDS, duration)), duration)
  const start = Math.min(Math.max(view.start, 0), duration - span)
  return { start, end: start + span }
}

// 以anchor为不动点缩放: factor<1放大, >1缩小
export function zoomView(view: TimeView, anchor: number, factor: number, duration: number): TimeView {
  return clampView(
    { start: anchor - (anchor - view.start) * factor, end: anchor + (view.end - anchor) * factor },
    duration,
  )
}

export function panView(view: TimeView, delta: number, duration: number): TimeView {
  return clampView({ start: view.start + delta, end: view.end + delta }, duration)
}

export function tickStep(span: number, widthPixels: number, minimumSpacingPixels: number) {
  const pixelsPerSecond = widthPixels / Math.max(span, Number.EPSILON)
  return TICK_STEPS.find((step) => step * pixelsPerSecond >= minimumSpacingPixels) ?? TICK_STEPS.at(-1)!
}

// 可见区间内的刻度时刻; 用整数倍免浮点累加误差
export function ticksIn(view: TimeView, step: number) {
  const ticks: number[] = []
  for (let index = Math.ceil(view.start / step - 1e-9); index * step <= view.end + 1e-9; index += 1) ticks.push(index * step)
  return ticks
}

// 刻度标签: 小数位随刻度间隔
export function formatTick(time: number, step: number) {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return `${time.toFixed(decimals)}s`
}

// 时间轴上的三种事件: 质检结果的事件按类别定义分质检事件与结构事件 (如待机, 结尾保持, 只标出录制结构), 序列的阶段标记为任务事件
export type TimelineEventKind = EventKind | 'task'

export const TIMELINE_EVENT_KINDS: readonly TimelineEventKind[] = ['quality', 'structural', 'task']

export const TIMELINE_EVENT_KIND_LABELS: Record<TimelineEventKind, string> = {
  quality: '质检事件',
  structural: '结构事件',
  task: '任务事件',
}

// 质检结果事件的种类: 按类别定义的`eventKindOf`, 无定义时按质检事件, 宁可多提醒
export function qualityCheckEventKind(qualityCheckEvent: QualityCheckEvent): EventKind {
  return qualityCheckEvent.definition === null ? 'quality' : eventKindOf(qualityCheckEvent.definition)
}

export function isQualityProblem(qualityCheckEvent: QualityCheckEvent) {
  return qualityCheckEventKind(qualityCheckEvent) === 'quality'
}
