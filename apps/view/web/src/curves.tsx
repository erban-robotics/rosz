/**
 * 曲线: 消息树里的话题各列出数值字段, 点字段即画进该话题的曲线 (uPlot), 横轴为接收时刻 (会话秒数), 显示最近
 * [`WINDOW_SECONDS`] 秒 (实时状态只留这么久). 曲线按 [`REDRAW_MS`] 节奏重画, 每条样本只解一次 (见 fields.ts).
 * rosz-ui 的序列泳道按全程排, 不跟实时窗口, 消息树也没有 "点字段画曲线" 的入口, 先在查看器里画.
 */
import { type ChannelInfo, type DataSource, secondsAt, WHOLE_TIMELINE } from '@erban-robotics/rosz-ui'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { toggleCurveField, useChosenCurves } from './curves-store'
import { fieldsOf } from './fields'

const WINDOW_SECONDS = 10
const REDRAW_MS = 100
// 字段列表的刷新间隔: 字段随消息内容 (数组长度) 才变, 不必每帧看
const FIELD_REFRESH_MS = 1000
const CHART_HEIGHT = 160
const SERIES_COLORS = 8

/** 一路最新样本的数值字段名, 按消息里的次序 */
function useFieldNames({ state }: DataSource, channel: ChannelInfo) {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    const refresh = () => {
      const latest = state.latestAtOrBefore(channel.id, state.latestReceiveTime() ?? 0n)
      const fields = latest && channel.type ? fieldsOf(channel.type, latest) : null
      if (!fields) return
      const next = [...fields.keys()]
      setNames((previous) => (previous.join('\n') === next.join('\n') ? previous : next))
    }
    refresh()
    const timer = setInterval(refresh, FIELD_REFRESH_MS)
    return () => clearInterval(timer)
  }, [state, channel.id, channel.type])
  return names
}

function Chart({ dataSource, channel, fields }: { dataSource: DataSource; channel: ChannelInfo; fields: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = containerRef.current
    const type = channel.type
    if (!container || !type || fields.length === 0) return
    const { state, zero } = dataSource
    const style = getComputedStyle(container)
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    const foreground = color('--foreground-secondary', '#ccc')
    const grid = color('--line', '#444')
    let now = 0
    const axis = { stroke: foreground, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid, width: 1 } }
    const plot = new uPlot(
      {
        width: container.clientWidth,
        height: CHART_HEIGHT,
        scales: { x: { time: false, auto: false, range: () => [now - WINDOW_SECONDS, now] } },
        axes: [{ ...axis, values: (_plot, ticks) => ticks.map((tick) => `${tick.toFixed(1)}s`) }, { ...axis, size: 80 }],
        series: [
          { label: '时刻', value: (_plot, value) => (value == null ? '—' : `${value.toFixed(3)}s`) },
          ...fields.map((field, index) => ({
            label: field,
            stroke: color(`--series-${(index % SERIES_COLORS) + 1}`, foreground),
            width: 1.5,
            points: { show: false },
            value: (_plot: uPlot, value: number | null) => (value == null ? '—' : value.toPrecision(4)),
          })),
        ],
      },
      [[], ...fields.map(() => [])],
      container,
    )
    let drawnVersion = -1
    let drawnNow = Number.NaN
    const redraw = () => {
      const latest = state.latestReceiveTime()
      if (latest === null) return
      now = secondsAt(zero, latest)
      const version = state.version(channel.id)
      if (version === drawnVersion && now === drawnNow) return
      drawnVersion = version
      drawnNow = now
      const samples = state.samplesIn(channel.id, WHOLE_TIMELINE)
      const times: number[] = []
      const columns: (number | null)[][] = fields.map(() => [])
      for (const sample of samples) {
        const values = fieldsOf(type, sample)
        if (!values) continue
        times.push(secondsAt(zero, sample.receiveTime))
        fields.forEach((field, index) => columns[index].push(values.get(field) ?? null))
      }
      plot.setData([times, ...columns])
    }
    redraw()
    const timer = setInterval(redraw, REDRAW_MS)
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) plot.setSize({ width: entry.contentRect.width, height: CHART_HEIGHT })
    })
    observer.observe(container)
    return () => {
      clearInterval(timer)
      observer.disconnect()
      plot.destroy()
    }
  }, [dataSource, channel.id, channel.type, fields])
  return <div ref={containerRef} className="rosz-view-chart min-w-0" />
}

function TopicCurves({
  dataSource,
  channel,
  chosen,
  onToggle,
}: {
  dataSource: DataSource
  channel: ChannelInfo
  chosen: string[]
  onToggle: (field: string) => void
}) {
  const names = useFieldNames(dataSource, channel)
  // 记下的字段这次的消息里没有 (如数组变短) 时先不画, 记忆保留
  const shown = useMemo(() => chosen.filter((field) => names.includes(field)), [chosen, names])
  return (
    <section aria-label={`${channel.name} 的曲线`} className="flex flex-col gap-1 rounded-md bg-surface-2 p-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-foreground">{channel.name}</span>
        <span className="text-foreground-tertiary">{names.length === 0 ? '等待数据 (或没有数值字段)' : '点字段画曲线'}</span>
      </div>
      <ul aria-label="数值字段" className="flex max-h-20 flex-wrap gap-1 overflow-auto">
        {names.map((name) => {
          const isChosen = chosen.includes(name)
          return (
            <li key={name}>
              <button
                type="button"
                aria-pressed={isChosen}
                className={`rounded-sm border px-1.5 font-mono ${isChosen ? 'border-line-strong text-foreground' : 'border-transparent text-foreground-tertiary hover:text-foreground-secondary'}`}
                onClick={() => onToggle(name)}
              >
                {name}
              </button>
            </li>
          )
        })}
      </ul>
      {shown.length > 0 && <Chart dataSource={dataSource} channel={channel} fields={shown} />}
    </section>
  )
}

/**
 * 消息树面板里各话题 (能解的) 的曲线区. 所选字段本机记住 (见 curves-store.ts). 自设需求窗口: 消息树面板关掉时曲线照样有数据.
 */
export function Curves({ dataSource, channels }: { dataSource: DataSource; channels: ChannelInfo[] }) {
  const chosen = useChosenCurves()
  const panelId = useId()
  const { state } = dataSource
  const key = channels.map((channel) => channel.id).join('\n')
  useEffect(() => {
    state.setDemand(panelId, key ? { channels: key.split('\n'), range: { start: 0n, end: 0n } } : null)
  }, [state, panelId, key])
  useEffect(() => () => state.setDemand(panelId, null), [state, panelId])

  return (
    <div className="flex flex-col gap-2 text-xs">
      {channels.map((channel) => (
        <TopicCurves
          key={channel.id}
          dataSource={dataSource}
          channel={channel}
          chosen={chosen[channel.id] ?? []}
          onToggle={(field) => toggleCurveField(channel.id, field)}
        />
      ))}
    </div>
  )
}
