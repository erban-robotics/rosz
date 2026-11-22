// 时间线上的事件轨道: 质检事件, 结构事件, 任务事件各占一行, 颜色区分; 全程条上的事件缩略
import { type PointerEvent, type ReactNode, useState } from 'react'
import {
  formatSeconds,
  qualityCheckEventKind,
  qualityCheckEventLabel,
  TIMELINE_EVENT_KIND_LABELS,
  TIMELINE_EVENT_KINDS,
  type TimelineEventKind,
  type TimeView,
} from './timeline'
import { fractionOf, GUTTER_CLASS, ROW_CLASS } from './timeline-layout'
import type { QualityCheckEvent, TaskEvent } from './events'

// 同EventStrip: 质检事件琥珀, 结构事件淡灰蓝; 任务事件紫
const EVENT_BLOCK_STYLES: Record<TimelineEventKind, string> = {
  quality: 'bg-status-warning/70 hover:bg-status-warning',
  structural: 'bg-status-structure/35 hover:bg-status-structure/60',
  task: 'bg-status-violet',
}
const OVERVIEW_STYLES: Record<TimelineEventKind, string> = {
  quality: 'bg-status-warning/70',
  structural: 'bg-status-structure/35',
  task: 'bg-status-violet',
}
const KIND_HINTS: Record<TimelineEventKind, string> = {
  quality: '点块循环播放',
  structural: '不算质量问题',
  task: '阶段标记, 点击跳转',
}

type EventHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
}

function Tooltip({ left, children }: { left: number; children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="absolute top-full z-30 mt-1 w-72 rounded-md border bg-popover p-2 text-xs shadow-md"
      style={{ left: `min(${left * 100}%, calc(100% - 18rem))` }}
    >
      {children}
    </div>
  )
}

function useHover() {
  const [isHovered, setIsHovered] = useState(false)
  const show = () => setIsHovered(true)
  const hide = () => setIsHovered(false)
  return { isHovered, handlers: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide } }
}

// 质检结果的事件块: 悬停显示时长, 强度与类别定义, 点击循环播放该事件
function QualityCheckEventBlock({ qualityCheckEvent, view, onSelect }: { qualityCheckEvent: QualityCheckEvent; view: TimeView; onSelect: () => void }) {
  const { isHovered, handlers } = useHover()
  const left = Math.max(fractionOf(qualityCheckEvent.start, view), 0)
  const right = Math.min(fractionOf(qualityCheckEvent.end, view), 1)
  if (right <= 0 || left >= 1) return null
  const kind = qualityCheckEventKind(qualityCheckEvent)
  return (
    <>
      <button
        type="button"
        aria-label={qualityCheckEventLabel(qualityCheckEvent)}
        className={`absolute top-1 bottom-1 min-w-1 rounded-sm ${EVENT_BLOCK_STYLES[kind]}`}
        style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
        {...handlers}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onSelect}
      />
      {isHovered && (
        <Tooltip left={left}>
          <div className="font-medium">
            {qualityCheckEvent.definition?.name ?? qualityCheckEvent.category}{' '}
            <span className="font-normal text-muted-foreground"> · {TIMELINE_EVENT_KIND_LABELS[kind]}</span>
          </div>
          <div className="text-muted-foreground">
            <span className="font-mono">
              {formatSeconds(qualityCheckEvent.start)}-{formatSeconds(qualityCheckEvent.end)}
            </span>{' '}
            时长<span className="font-mono">{(qualityCheckEvent.end - qualityCheckEvent.start).toFixed(2)}</span>秒 · 强度
            <span className="font-mono">{qualityCheckEvent.strength.toFixed(2)}</span> · 点击循环播放
          </div>
          {qualityCheckEvent.definition ? (
            <>
              <p>{qualityCheckEvent.definition.definition}</p>
              <p className="text-muted-foreground">推测原因: {qualityCheckEvent.definition.presumed_causes}</p>
            </>
          ) : (
            <p className="text-muted-foreground">质检结果里没有该类别的定义</p>
          )}
        </Tooltip>
      )}
    </>
  )
}

// 任务事件是时刻不是区间: 一根竖线加名字, 点击跳到该时刻
function TaskMarker({ event, view, onSelect }: { event: TaskEvent; view: TimeView; onSelect: () => void }) {
  const { isHovered, handlers } = useHover()
  const fraction = fractionOf(event.time, view)
  if (fraction < 0 || fraction > 1) return null
  return (
    <>
      <button
        type="button"
        aria-label={`${event.name}${formatSeconds(event.time)}`}
        className="group absolute inset-y-0.5 flex -translate-x-px items-center gap-1 pr-1"
        style={{ left: `${fraction * 100}%` }}
        {...handlers}
        onPointerDown={(pointerEvent) => pointerEvent.stopPropagation()}
        onClick={onSelect}
      >
        <span className={`h-full w-0.5 rounded-full ${EVENT_BLOCK_STYLES.task}`} />
        <span className="max-w-32 truncate font-mono text-xs text-foreground-secondary group-hover:text-foreground">
          {event.name}
        </span>
      </button>
      {isHovered && (
        <Tooltip left={fraction}>
          <div className="font-medium">
            {event.name} <span className="font-normal text-muted-foreground"> · 任务事件</span>
          </div>
          <div className="text-muted-foreground">
            <span className="font-mono">{formatSeconds(event.time)}</span> · 序列的阶段标记 · 点击跳到该时刻
          </div>
        </Tooltip>
      )}
    </>
  )
}

function EventRow({ kind, handlers, children }: { kind: TimelineEventKind; handlers: EventHandlers; children: ReactNode }) {
  return (
    <section aria-label={TIMELINE_EVENT_KIND_LABELS[kind]} className={`${ROW_CLASS} h-7 border-b last:border-b-0`}>
      <div className={`${GUTTER_CLASS} flex-row! items-center justify-start! gap-2`}>
        <span className="flex shrink-0 items-center gap-1.5 font-medium">
          <span className={`inline-block size-2 rounded-sm ${OVERVIEW_STYLES[kind]}`} />
          {TIMELINE_EVENT_KIND_LABELS[kind]}
        </span>
        <span className="truncate text-muted-foreground">{KIND_HINTS[kind]}</span>
      </div>
      <div className="relative min-w-0 cursor-crosshair touch-none" {...handlers}>
        {children}
      </div>
    </section>
  )
}

/**
 * 事件轨道: 有事件的种类各一行, 依次质检, 结构, 任务; 一个事件都没有时一行说明.
 * 质检结果的事件点块循环播放, 任务事件点击跳转; 行内空白处同曲线轨道 (点击跳转, 拖选放大).
 */
export function EventTracks({
  qualityCheckEvents,
  taskEvents,
  view,
  duration,
  handlers,
  onPlayRange,
  onSeek,
}: {
  qualityCheckEvents: QualityCheckEvent[]
  taskEvents: TaskEvent[]
  view: TimeView
  duration: number
  handlers: EventHandlers
  onPlayRange: (range: TimeView) => void
  onSeek: (time: number) => void
}) {
  const kinds = TIMELINE_EVENT_KINDS.filter((kind) =>
    kind === 'task' ? taskEvents.length > 0 : qualityCheckEvents.some((qualityCheckEvent) => qualityCheckEventKind(qualityCheckEvent) === kind),
  )
  if (kinds.length === 0)
    return (
      <div className={`${ROW_CLASS} h-7`}>
        <div className={GUTTER_CLASS}>
          <span className="font-medium">事件</span>
        </div>
        <div className="flex items-center px-2 text-xs text-muted-foreground" {...handlers}>
          无事件
        </div>
      </div>
    )
  return (
    <>
      {kinds.map((kind) => (
        <EventRow key={kind} kind={kind} handlers={handlers}>
          {duration > 0 &&
            (kind === 'task'
              ? taskEvents.map((event) => (
                  <TaskMarker key={`${event.channel}-${event.name}-${event.time}`} event={event} view={view} onSelect={() => onSeek(event.time)} />
                ))
              : qualityCheckEvents
                  .filter((qualityCheckEvent) => qualityCheckEventKind(qualityCheckEvent) === kind)
                  .map((qualityCheckEvent) => (
                    <QualityCheckEventBlock
                      key={`${qualityCheckEvent.channel}-${qualityCheckEvent.category}-${qualityCheckEvent.start}`}
                      qualityCheckEvent={qualityCheckEvent}
                      view={view}
                      onSelect={() => onPlayRange({ start: qualityCheckEvent.start, end: qualityCheckEvent.end })}
                    />
                  )))}
        </EventRow>
      ))}
    </>
  )
}

// 全程条上的事件缩略: 质检结果的事件铺色, 任务事件一根细线
export function OverviewEvents({
  qualityCheckEvents,
  taskEvents,
  duration,
}: {
  qualityCheckEvents: QualityCheckEvent[]
  taskEvents: TaskEvent[]
  duration: number
}) {
  if (duration <= 0) return null
  return (
    <>
      {qualityCheckEvents.map((qualityCheckEvent) => (
        <div
          key={`${qualityCheckEvent.channel}-${qualityCheckEvent.category}-${qualityCheckEvent.start}`}
          className={`pointer-events-none absolute inset-y-0.5 rounded-full ${OVERVIEW_STYLES[qualityCheckEventKind(qualityCheckEvent)]}`}
          style={{ left: `${(qualityCheckEvent.start / duration) * 100}%`, width: `${((qualityCheckEvent.end - qualityCheckEvent.start) / duration) * 100}%` }}
        />
      ))}
      {taskEvents.map((event) => (
        <div
          key={`${event.channel}-${event.name}-${event.time}`}
          className={`pointer-events-none absolute inset-y-0 w-px ${OVERVIEW_STYLES.task}`}
          style={{ left: `${(event.time / duration) * 100}%` }}
        />
      ))}
    </>
  )
}
