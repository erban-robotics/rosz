// 时间线各行共用的栅格: 左侧标签栏等宽, 右侧轨道区横向严格对齐, 一根播放头贯穿全部轨道
export const GUTTER_WIDTH = '13rem'
export const ROW_CLASS = 'grid grid-cols-[13rem_minmax(0,1fr)]'
export const GUTTER_CLASS = 'flex min-w-0 flex-col justify-center gap-0.5 border-r px-2 text-xs'

export function fractionOf(time: number, view: { start: number; end: number }) {
  return (time - view.start) / (view.end - view.start)
}

// 第index条曲线的类别色 (index.css的--series-N)
export function seriesColor(index: number) {
  return `var(--series-${index + 1})`
}

export function formatValue(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toPrecision(3)
}
