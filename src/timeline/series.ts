import type { ChannelInfo } from '../data-source/types'

/**
 * 序列通道的样本内容: 一段按列的数值 (常为离线一次取全的降采样列), 时刻为会话时间轴秒数.
 * 列的次序按通道的`properties.columns`, 没给按`columns`的键序.
 */
export type SeriesTrack = {
  channel: ChannelInfo
  times: number[]
  columns: Record<string, (number | null)[]>
}

// 序列的列名, 按通道声明的次序
export function columnsOf(track: SeriesTrack): string[] {
  const declared = track.channel.properties?.columns
  return Array.isArray(declared) ? (declared as string[]) : Object.keys(track.columns)
}

// 序列通道的附加说明 (见`ChannelInfo.properties`)
export function seriesProperties(track: SeriesTrack) {
  return (track.channel.properties ?? {}) as { side?: string; unit?: string; trajectory?: string; frame?: unknown }
}
