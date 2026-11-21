// 数据源的React侧: 上下文与面板用的钩子, 数据源里唯一依赖React处
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { DataSourceState } from './state'
import type { ChannelInfo, ChannelStats } from './types'
import { WHOLE_TIMELINE } from './time-axis'

// 面板读的数据源: 状态与会话零点 (绝对纳秒), 零点用于播放头秒数与样本时刻互换 (见`clock.ts`)
export type DataSource = { state: DataSourceState; zero: bigint }

// 由视图组装提供 (`<DataSourceContext.Provider>`), 面板经`useDataSource()`取
export const DataSourceContext = createContext<DataSource | null>(null)

export function useDataSource() {
  const value = useContext(DataSourceContext)
  if (!value) throw new Error('面板须在DataSourceContext内')
  return value
}

// 这些通道的数据 (样本段, 错误) 一变即重渲; 只订阅不取值, 取值在渲染里直接查状态
export function useChannels(state: DataSourceState, channels: string[]) {
  const key = channels.join('\n')
  const subscribe = useCallback(
    (listener: () => void) => {
      // 空列表即不订阅 (`''.split`会得到一个空名通道)
      const unsubscribes = key === '' ? [] : key.split('\n').map((channel) => state.subscribe(channel, listener))
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe())
    },
    [state, key],
  )
  useSyncExternalStore(subscribe, () =>
    key
      .split('\n')
      .map((channel) => state.version(channel))
      .join(','),
  )
}

// 当前时间轴; 切轴时重渲 (切轴必记一次不连续, 随不连续信号订阅)
export function useAxis(state: DataSourceState) {
  return useSyncExternalStore(state.subscribeDiscontinuity, () => state.axis())
}

// 不连续计数; 跳转, 步进, 循环回绕, 切轴时重渲, 按时间累积的结果据此重建
export function useDiscontinuity(state: DataSourceState) {
  return useSyncExternalStore(state.subscribeDiscontinuity, () => state.discontinuity())
}

/**
 * 这些通道在当前轴上的全部样本内容, 按通道顺序拼接, 各通道内按时刻升序. 给静态通道 (序列, 事件, 叠加, 空间) 用.
 * 通道数据不变 (版本号不变) 时返回同一数组, 样本内容也是写入时的同一对象, 下游按引用缓存的 (如uPlot) 不必重建.
 */
export function useChannelPayloads<Payload>(state: DataSourceState, channels: string[]): Payload[] {
  useChannels(state, channels)
  const versions = channels.map((channel) => state.version(channel)).join(',')
  const key = channels.join('\n')
  return useMemo(
    () =>
      key === ''
        ? []
        : key
            .split('\n')
            .flatMap((channel) => state.samplesIn(channel, WHOLE_TIMELINE).map((sample) => sample.payload as Payload)),
    // versions变即通道数据变了, 须重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, key, versions],
  )
}

// 通道目录; 目录一变即重渲
export function useCatalog(state: DataSourceState): ChannelInfo[] {
  return useSyncExternalStore(state.subscribeCatalog, () => state.catalog())
}

// 这些通道按样本统计的量 (样本数, 频率), 与`channels`同序; 通道数据一变即重渲
export function useChannelStats(state: DataSourceState, channels: string[]): ChannelStats[] {
  useChannels(state, channels)
  return channels.map((channel) => state.stats(channel))
}
