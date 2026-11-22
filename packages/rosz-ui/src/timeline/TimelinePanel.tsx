import { Scan, ZoomIn, ZoomOut } from 'lucide-react'
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ExpandChevron } from '../ui/affordance'
import { Button } from '../ui/button'
import type { JointGroup } from './joint-lanes'
import { EventTracks, OverviewEvents } from './EventTracks'
import { LaneRow, type TimelineLane, type TrackHandlers } from './LaneRow'
import { PlaybackControls } from '../playback/PlaybackControls'
import {
  clampView,
  formatSeconds,
  formatTick,
  panView,
  ticksIn,
  tickStep,
  type TimeView,
  zoomView,
} from './timeline'
import { fractionOf, GUTTER_CLASS, GUTTER_WIDTH, ROW_CLASS } from './timeline-layout'
import { type Playback, useClockListener } from '../playback/use-playback'
import type { QualityCheckEvent, TaskEvent } from './events'
import { usePlaybackStore } from '../playback/store'

const ZOOM_BUTTON_FACTOR = 2
const WHEEL_ZOOM_SENSITIVITY = 0.002
// 按下后移动超过该像素数算拖选放大, 否则算点击跳转
const DRAG_THRESHOLD_PIXELS = 4
const MINIMUM_TICK_SPACING_PIXELS = 80
// ResizeObserver首次回调前 (及jsdom里) 的轨道宽度
const DEFAULT_TRACK_WIDTH_PIXELS = 1000
const JOINT_LANE_HEIGHT_PIXELS = 48
const COLLAPSED_GROUPS_STORAGE_KEY = 'replay.collapsed-joint-groups'
const NO_TASK_EVENTS: TaskEvent[] = []

// 叠加层在轨道区内的横向位置
function trackLeft(fraction: number) {
  return `calc(${GUTTER_WIDTH} + (100% - ${GUTTER_WIDTH}) * ${fraction})`
}

function readCollapsedGroups(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function writeCollapsedGroups(keys: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...keys]))
  } catch {
    // 存不了只是下次不记得折叠状态
  }
}

/**
 * 镜次时间线, 仿剪辑软件: 左侧标签栏等宽, 右侧轨道区共用一个可见区间, 一根播放头贯穿标尺, 事件轨道 (质检, 结构, 任务事件) 与各曲线轨道.
 * 标尺点按或拖动即跳到任意时刻 (含事件中间), 点事件块循环播放该段, 点任务事件跳到该时刻; 轨道上点击跳转, 拖选放大.
 * Ctrl+滚轮 (触控板双指捏合) 以指针处为中心缩放, Shift+滚轮或横向滚动平移, 底部全程条 (钉在滚动区底部, 与轨道同宽) 拖动平移.
 */
export function TimelinePanel({
  playback,
  duration,
  stepTimes,
  qualityCheckEvents,
  taskEvents = NO_TASK_EVENTS,
  lanes,
  jointGroups,
  hasPlaybackControls = true,
}: {
  playback: Playback
  duration: number
  stepTimes: number[]
  // null即不显示事件轨
  qualityCheckEvents: QualityCheckEvent[] | null
  // 任务事件 (序列的阶段标记), 与qualityCheckEvents同在事件轨道
  taskEvents?: TaskEvent[]
  lanes: TimelineLane[]
  jointGroups: JointGroup[]
  // 播放控件放在别处 (如视图组装的工具栏) 时关掉
  hasPlaybackControls?: boolean
}) {
  const full = useMemo(() => ({ start: 0, end: duration }), [duration])
  // null即全程; 存的区间按当前时长夹紧后用
  const [storedView, setStoredView] = useState<TimeView | null>(null)
  const view = storedView ? clampView(storedView, duration) : full
  const hoverTime = usePlaybackStore((state) => state.hoverTime)
  const setHoverTime = usePlaybackStore((state) => state.setHoverTime)
  const [selection, setSelection] = useState<TimeView | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups)
  const [trackWidth, setTrackWidth] = useState(DEFAULT_TRACK_WIDTH_PIXELS)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rulerTrackRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; time: number; isSelecting: boolean } | null>(null)
  const isScrubbingRef = useRef(false)
  const overviewDragRef = useRef<number | null>(null)

  const playheadRef = useRef<HTMLDivElement>(null)
  const overviewPlayheadRef = useRef<HTMLDivElement>(null)

  // 播放头, 全程条位置随播放直接改DOM, 不重渲整个时间线; 播放中播放头出了可见区间即翻页跟随
  useClockListener(playback.clock, (time) => {
    if (playback.isPlaying && storedView && (time < view.start || time > view.end)) {
      const span = view.end - view.start
      setStoredView(clampView({ start: time, end: time + span }, duration))
    }
    // 每帧只改`transform` (只走合成, 不触发重排): 承载层与轨道等宽, 平移百分比按自身宽即轨道宽
    if (playheadRef.current) {
      const fraction = duration > 0 ? fractionOf(time, view) : -1
      playheadRef.current.hidden = fraction < 0 || fraction > 1
      playheadRef.current.style.transform = `translateX(${fraction * 100}%)`
    }
    if (overviewPlayheadRef.current && duration > 0) overviewPlayheadRef.current.style.transform = `translateX(${(time / duration) * 100}%)`
  })

  useEffect(() => {
    const track = rulerTrackRef.current
    if (!track) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setTrackWidth(entry.contentRect.width)
    })
    observer.observe(track)
    return () => observer.disconnect()
  }, [])

  // 滚轮须非被动监听才能拦下浏览器缩放与横向滚动
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onWheel = (event: WheelEvent) => {
      const box = rulerTrackRef.current?.getBoundingClientRect()
      if (!box || box.width === 0 || duration <= 0) return
      const isZoom = event.ctrlKey || event.metaKey
      const isPan = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      if (!isZoom && !isPan) return
      event.preventDefault()
      setStoredView((previous) => {
        const current = previous ? clampView(previous, duration) : { start: 0, end: duration }
        const span = current.end - current.start
        if (isZoom) {
          const anchor = current.start + ((event.clientX - box.left) / box.width) * span
          return zoomView(current, anchor, Math.exp(event.deltaY * WHEEL_ZOOM_SENSITIVITY), duration)
        }
        const delta = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
        return panView(current, (delta / box.width) * span, duration)
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [duration])

  function timeAt(clientX: number) {
    const box = rulerTrackRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return view.start
    return view.start + ((clientX - box.left) / box.width) * (view.end - view.start)
  }

  function zoomAroundPlayhead(factor: number) {
    const time = playback.clock.getTime()
    const anchor = time >= view.start && time <= view.end ? time : (view.start + view.end) / 2
    setStoredView(zoomView(view, anchor, factor, duration))
  }

  // 轨道上: 点击跳转, 拖选放大
  const trackHandlers: TrackHandlers = {
    onPointerDown: (event) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      dragRef.current = { x: event.clientX, time: timeAt(event.clientX), isSelecting: false }
    },
    onPointerMove: (event) => {
      const time = timeAt(event.clientX)
      setHoverTime(time)
      const drag = dragRef.current
      if (!drag) return
      if (Math.abs(event.clientX - drag.x) > DRAG_THRESHOLD_PIXELS) drag.isSelecting = true
      if (drag.isSelecting) setSelection({ start: Math.min(drag.time, time), end: Math.max(drag.time, time) })
    },
    onPointerUp: (event) => {
      const drag = dragRef.current
      dragRef.current = null
      if (!drag) return
      if (drag.isSelecting) {
        const time = timeAt(event.clientX)
        setStoredView(clampView({ start: Math.min(drag.time, time), end: Math.max(drag.time, time) }, duration))
        setSelection(null)
      } else {
        playback.seek(timeAt(event.clientX))
      }
    },
    onPointerLeave: () => setHoverTime(null),
  }

  // 标尺: 按下即跳, 拖动连续跳 (擦洗)
  const rulerHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      isScrubbingRef.current = true
      playback.seek(timeAt(event.clientX))
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      setHoverTime(timeAt(event.clientX))
      if (isScrubbingRef.current) playback.seek(timeAt(event.clientX))
    },
    onPointerUp: () => {
      isScrubbingRef.current = false
    },
    onPointerLeave: () => setHoverTime(null),
  }

  // 全程条: 拖可见窗平移; 点窗外即把窗口中心移过去
  function overviewTime(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 ? ((event.clientX - box.left) / box.width) * duration : 0
  }
  const overviewHandlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || duration <= 0) return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const time = overviewTime(event)
      const span = view.end - view.start
      const offset = time >= view.start && time <= view.end ? time - view.start : span / 2
      overviewDragRef.current = offset
      setStoredView(clampView({ start: time - offset, end: time - offset + span }, duration))
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const offset = overviewDragRef.current
      if (offset === null) return
      const time = overviewTime(event)
      const span = view.end - view.start
      setStoredView(clampView({ start: time - offset, end: time - offset + span }, duration))
    },
    onPointerUp: () => {
      overviewDragRef.current = null
    },
  }

  function toggleGroup(key: string) {
    const next = new Set(collapsedGroups)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCollapsedGroups(next)
    writeCollapsedGroups(next)
  }

  const span = view.end - view.start
  const step = tickStep(span, trackWidth, MINIMUM_TICK_SPACING_PIXELS)
  const ticks = duration > 0 ? ticksIn(view, step) : []
  const hoverFraction = hoverTime !== null && duration > 0 ? fractionOf(hoverTime, view) : null
  const isZoomed = span < duration - 1e-9

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {hasPlaybackControls && <PlaybackControls playback={playback} duration={duration} stepTimes={stepTimes} />}
        <span className="ml-auto hidden text-xs text-muted-foreground xl:inline">
          {hasPlaybackControls && '空格播放 · ←→逐帧 · '}标尺上点按跳转 · 轨道上拖选放大 · Ctrl+滚轮缩放 · Shift+滚轮平移
        </span>
        <div className="flex gap-1" role="group" aria-label="缩放">
          <Button variant="ghost" size="icon" aria-label="缩小" disabled={!isZoomed} onClick={() => zoomAroundPlayhead(ZOOM_BUTTON_FACTOR)}>
            <ZoomOut />
          </Button>
          <Button variant="ghost" size="icon" aria-label="放大" onClick={() => zoomAroundPlayhead(1 / ZOOM_BUTTON_FACTOR)}>
            <ZoomIn />
          </Button>
          <Button variant="ghost" size="icon" aria-label="显示全程" disabled={!isZoomed} onClick={() => setStoredView(null)}>
            <Scan />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-surface-1">
        <div className="relative">
          <div className="sticky top-0 z-10 border-b bg-surface-1">
            <div className={`${ROW_CLASS} h-6 border-b`}>
              <div className={`${GUTTER_CLASS} font-mono text-muted-foreground`}>
                {formatSeconds(view.start)} - {formatSeconds(view.end)}
              </div>
              <div
                ref={rulerTrackRef}
                aria-label="时间标尺"
                className="relative min-w-0 cursor-col-resize touch-none overflow-hidden bg-muted/50 select-none"
                {...rulerHandlers}
              >
                {ticks.map((tick) => (
                  <div
                    key={tick}
                    className="pointer-events-none absolute top-0 h-full border-l border-foreground/30 pl-1 font-mono text-xs leading-6 text-muted-foreground"
                    style={{ left: `${fractionOf(tick, view) * 100}%` }}
                  >
                    {formatTick(tick, step)}
                  </div>
                ))}
              </div>
            </div>
            {qualityCheckEvents && (
              <EventTracks
                qualityCheckEvents={qualityCheckEvents}
                taskEvents={taskEvents}
                view={view}
                duration={duration}
                handlers={trackHandlers}
                onPlayRange={playback.playRange}
                onSeek={playback.seek}
              />
            )}
          </div>
          {lanes.map((lane) => (
            <LaneRow
              key={lane.key}
              lane={lane}
              height={lane.height}
              duration={duration}
              view={view}
              clock={playback.clock}
              hoverTime={hoverTime}
              handlers={trackHandlers}
            />
          ))}
          {jointGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key)
            return (
              <div key={group.key} role="group" aria-label={`关节组${group.name}`}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  className="flex h-6 w-full items-center gap-1 border-b bg-muted/60 px-2 text-left text-xs font-medium hover:bg-muted"
                  onClick={() => toggleGroup(group.key)}
                >
                  <ExpandChevron open={!isCollapsed} className="size-3.5" />
                  关节 · {group.name}
                  <span className="font-normal text-muted-foreground">{group.lanes.length}个关节</span>
                </button>
                {!isCollapsed &&
                  group.lanes.map((lane) => (
                    <LaneRow
                      key={lane.key}
                      lane={{ ...lane, hasIndependentScales: true }}
                      height={JOINT_LANE_HEIGHT_PIXELS}
                      duration={duration}
                      view={view}
                      clock={playback.clock}
              hoverTime={hoverTime}
                      handlers={trackHandlers}
                    />
                  ))}
              </div>
            )
          })}
          <div className={`${ROW_CLASS} sticky bottom-0 z-30 h-5 border-t bg-surface-1`}>
            <div className={`${GUTTER_CLASS} text-muted-foreground`}>全程</div>
            <div
              aria-label="全程条"
              className="group relative mx-0 my-auto h-2.5 min-w-0 cursor-grab touch-none rounded-full bg-muted active:cursor-grabbing"
              {...overviewHandlers}
            >
              {qualityCheckEvents && <OverviewEvents qualityCheckEvents={qualityCheckEvents} taskEvents={taskEvents} duration={duration} />}
              {duration > 0 && (
                <>
                  <div
                    className="pointer-events-none absolute inset-y-0 rounded-full bg-foreground/20 group-hover:bg-foreground/30"
                    style={{ left: `${(view.start / duration) * 100}%`, width: `${(span / duration) * 100}%` }}
                  />
                  {/* 播放头承载层与全程条等宽, 外裹同宽裁切框免得平移出去的部分撑出横向滚动; 播放头在两端时只露出一半 */}
                  <div className="pointer-events-none absolute inset-x-0 -inset-y-0.5 overflow-hidden">
                    <div ref={overviewPlayheadRef} className="absolute inset-0">
                      <div className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground" />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
            {selection && (
              <div
                className="absolute inset-y-0 bg-primary/15"
                style={{
                  left: trackLeft(fractionOf(selection.start, view)),
                  width: `calc((100% - ${GUTTER_WIDTH}) * ${fractionOf(selection.end, view) - fractionOf(selection.start, view)})`,
                }}
              />
            )}
            {hoverFraction !== null && hoverFraction >= 0 && hoverFraction <= 1 && (
              <div className="absolute inset-y-0 border-l border-dashed border-muted-foreground" style={{ left: trackLeft(hoverFraction) }} />
            )}
            <div ref={playheadRef} className="absolute inset-y-0 right-0" style={{ left: GUTTER_WIDTH }}>
              <div className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-foreground" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
