import { type PointerEvent, useRef } from 'react'
import { LaneChart } from './LaneChart'
import { type ChartLine, latestIndexAtOrBefore, type TimeView } from './timeline'
import { formatValue, GUTTER_CLASS, ROW_CLASS, seriesColor } from './timeline-layout'
import { type PlaybackClock, useClockListener } from '../playback/use-playback'
import { Hint } from '../ui/Hint'

// 时间线的一条曲线轨道: 左侧标签 (名字, 单位, 读数) + 右侧曲线

// 类别色槽位数 (index.css的--series-N); 一轨超出的列不画, 注明省略
const SERIES_COLOR_COUNT = 8

// 顶层的曲线轨道 (如末端速度), 关节组之外
// hasIndependentScales: 各线各自纵轴, 否则共用
export type TimelineLane = {
  key: string
  label: string
  title: string
  unit: string
  lines: ChartLine[]
  height: number
  hasIndependentScales: boolean
}

// 轨道标签: 名字, 单位, 各线在悬停时刻 (无悬停取播放头) 的值; 读数随播放直接改文字, 不重渲
function LaneLabel({
  label,
  title,
  unit,
  lines,
  clock,
  hoverTime,
}: {
  label: string
  title: string
  unit: string
  lines: ChartLine[]
  clock: PlaybackClock
  hoverTime: number | null
}) {
  const readoutRefs = useRef<(HTMLSpanElement | null)[]>([])
  useClockListener(clock, (time) => {
    const readoutTime = hoverTime ?? time
    lines.forEach((line, index) => {
      const readout = readoutRefs.current[index]
      if (readout) readout.textContent = formatValue(line.values[latestIndexAtOrBefore(line.times, readoutTime)])
    })
  })
  return (
    <Hint text={title} side="right">
      <div className={GUTTER_CLASS}>
        <div className="flex items-baseline gap-1">
          <span className="truncate font-medium">{label}</span>
          <span className="text-muted-foreground">{unit}</span>
        </div>
        <ul className="flex flex-wrap gap-x-2 font-mono text-xs">
          {lines.map((line, index) => (
            <li key={line.label} className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-2.5 rounded" style={{ background: seriesColor(index) }} />
              <span className="text-muted-foreground">{line.label}</span>
              <span
                ref={(element) => {
                  readoutRefs.current[index] = element
                }}
              />
            </li>
          ))}
        </ul>
      </div>
    </Hint>
  )
}

export type TrackHandlers = {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void
  onPointerMove: (event: PointerEvent<HTMLElement>) => void
  onPointerUp: (event: PointerEvent<HTMLElement>) => void
  onPointerLeave: () => void
}

export function LaneRow({
  lane,
  height,
  duration,
  view,
  clock,
  hoverTime,
  handlers,
}: {
  lane: Omit<TimelineLane, 'height'>
  height: number
  duration: number
  view: TimeView
  clock: PlaybackClock
  hoverTime: number | null
  handlers: TrackHandlers
}) {
  const shown = lane.lines.slice(0, SERIES_COLOR_COUNT)
  return (
    <section aria-label={lane.label} className={`${ROW_CLASS} border-b`} style={{ height }}>
      <LaneLabel
        label={lane.label}
        title={lane.lines.length > shown.length ? `${lane.title} (另有${lane.lines.length - shown.length}列未画)` : lane.title}
        unit={lane.unit}
        lines={shown}
        clock={clock}
        hoverTime={hoverTime}
      />
      <div className="relative min-w-0 cursor-crosshair touch-none" {...handlers}>
        <LaneChart
          lines={shown}
          hasIndependentScales={lane.hasIndependentScales}
          duration={duration}
          viewStart={view.start}
          viewEnd={view.end}
        />
      </div>
    </section>
  )
}
