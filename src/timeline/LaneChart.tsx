// 一轨曲线的绘制: 曲线层交给uPlot (Canvas), 播放头, 悬停线与刻度仍由时间线自绘
import { memo, useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { type ChartLine, latestIndexAtOrBefore, type TimeView } from './timeline'
import { formatValue, seriesColor } from './timeline-layout'

const Y_PADDING_RATIO = 0.08
// 各自纵轴时, 每条线的纵轴跨度不小于本轨全部线全程跨度的这一比例, 免得把静止关节的量化噪声放大成大幅抖动
const MINIMUM_INDEPENDENT_SPAN_RATIO = 0.25
const LINE_WIDTH_PIXELS = 1.5

// 可见区间内各线的极值; 读数与纵轴范围都按它
function visibleExtent(lines: ChartLine[], view: TimeView) {
  let low = Infinity
  let high = -Infinity
  for (const line of lines) {
    const first = Math.max(0, latestIndexAtOrBefore(line.times, view.start))
    const last = Math.min(line.values.length - 1, latestIndexAtOrBefore(line.times, view.end) + 1)
    for (let index = first; index <= last; index += 1) {
      const value = line.values[index]
      if (value === null || value === undefined || !Number.isFinite(value)) continue
      low = Math.min(low, value)
      high = Math.max(high, value)
    }
  }
  return Number.isFinite(low) ? { low, high } : null
}

// 纵轴范围: 跨度不小于minimumSpan, 上下各留一点边
function paddedRange(low: number | null, high: number | null, minimumSpan: number): uPlot.Range.MinMax {
  if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high)) return [0, 1]
  const middle = (low + high) / 2
  const halfSpan = Math.max(high - low, minimumSpan) / 2
  const padding = Math.max(halfSpan * 2, 1e-6) * Y_PADDING_RATIO
  return [middle - halfSpan - padding, middle + halfSpan + padding]
}

// jsdom等无canvas绘图上下文的环境只留读数不画线
let canvasSupport: boolean | undefined
function canDrawCanvas() {
  canvasSupport ??= document.createElement('canvas').getContext('2d') !== null
  return canvasSupport
}

// 各线时刻相同直接并列, 否则按时刻合并 (缺的点为undefined, uPlot连过去; 原有的null仍断开)
function alignedData(lines: ChartLine[]): uPlot.AlignedData {
  const [first] = lines
  const isShared = lines.every(
    (line) => line.times === first.times || (line.times.length === first.times.length && line.times.every((time, index) => time === first.times[index])),
  )
  if (isShared) return [first.times, ...lines.map((line) => line.values)]
  return uPlot.join(lines.map((line) => [line.times, line.values]))
}

/**
 * 一轨的曲线, 每轨一个uPlot实例. 数据或纵轴方式变了才重建, 缩放平移只改x范围, 播放时不重绘.
 * 共用纵轴便于比大小 (如末端速度); 各自纵轴时每条线撑满轨高, 看各自形状 (如左右同名关节, 取值可差很远).
 * 纵轴随可见区间自适应 (uPlot只按可见区间内的点算范围).
 */
export const LaneChart = memo(function LaneChart({
  lines,
  hasIndependentScales,
  duration,
  viewStart,
  viewEnd,
}: {
  lines: ChartLine[]
  hasIndependentScales: boolean
  duration: number
  viewStart: number
  viewEnd: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<uPlot | null>(null)
  // 建图时读当前可见区间, 不让区间变化触发重建
  const viewRef = useRef({ start: viewStart, end: viewEnd })
  useEffect(() => {
    viewRef.current = { start: viewStart, end: viewEnd }
  }, [viewStart, viewEnd])

  const groups = useMemo(() => (hasIndependentScales ? lines.map((line) => [line]) : [lines]), [lines, hasIndependentScales])
  const extents = useMemo(
    () => groups.map((group) => visibleExtent(group, { start: viewStart, end: viewEnd })),
    [groups, viewStart, viewEnd],
  )
  const minimumSpan = useMemo(() => {
    if (!hasIndependentScales) return 0
    const overall = visibleExtent(lines, { start: -Infinity, end: Infinity })
    return overall ? (overall.high - overall.low) * MINIMUM_INDEPENDENT_SPAN_RATIO : 0
  }, [lines, hasIndependentScales])

  useEffect(() => {
    const container = containerRef.current
    if (!container || lines.length === 0 || duration <= 0 || !canDrawCanvas()) return
    const style = getComputedStyle(container)
    const scaleOf = (index: number) => (hasIndependentScales ? `y${index}` : 'y')
    const scales: uPlot.Scales = {
      x: { time: false, auto: false, range: () => [viewRef.current.start, viewRef.current.end] },
    }
    for (const index of hasIndependentScales ? lines.keys() : [0]) {
      scales[scaleOf(index)] = { range: (_plot, low, high) => paddedRange(low, high, minimumSpan) }
    }
    const plot = new uPlot(
      {
        width: container.clientWidth,
        height: container.clientHeight,
        padding: [0, 0, 0, 0],
        legend: { show: false },
        cursor: { show: false },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        axes: [{ show: false }, { show: false, scale: scaleOf(0) }],
        scales,
        series: [
          {},
          ...lines.map((line, index) => ({
            label: line.label,
            scale: scaleOf(index),
            stroke: style.getPropertyValue(`--series-${index + 1}`).trim() || 'currentColor',
            width: LINE_WIDTH_PIXELS,
            points: { show: false },
          })),
        ],
      },
      alignedData(lines),
      container,
    )
    // 点击, 拖选与悬停由外层轨道处理
    plot.root.style.pointerEvents = 'none'
    plotRef.current = plot
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) plot.setSize({ width, height })
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      plot.destroy()
      plotRef.current = null
    }
  }, [lines, hasIndependentScales, minimumSpan, duration])

  useEffect(() => {
    plotRef.current?.setScale('x', { min: viewStart, max: viewEnd })
  }, [viewStart, viewEnd])

  if (duration <= 0) return null
  return (
    <>
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
      <span className="pointer-events-none absolute top-0.5 right-1 flex gap-2 font-mono text-xs text-muted-foreground">
        {extents.map((extent, index) => (
          <span key={index} style={hasIndependentScales ? { color: seriesColor(index) } : undefined}>
            {extent ? `${formatValue(extent.low)} ~ ${formatValue(extent.high)}` : '—'}
          </span>
        ))}
      </span>
    </>
  )
})
