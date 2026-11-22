// 绑定的序列: 从状态的序列通道读, 每条样本一段列, 配上通道说明; 采样轴上为空 (序列只有接收时刻)
import { useMemo } from 'react'
import { useChannels, useDataSource } from '../data-source/react'
import { WHOLE_TIMELINE } from '../data-source/time-axis'
import type { ChannelInfo } from '../data-source/types'
import type { SeriesTrack } from './series'

export function useTracks(channels: ChannelInfo[]): SeriesTrack[] {
  const { state } = useDataSource()
  const series = useMemo(() => channels.filter((channel) => channel.kind === 'series'), [channels])
  const ids = useMemo(() => series.map((channel) => channel.id), [series])
  useChannels(state, ids)
  const versions = ids.map((id) => state.version(id)).join(',')
  return useMemo(
    () =>
      series.flatMap((channel) =>
        state
          .samplesIn(channel.id, WHOLE_TIMELINE)
          .map((sample) => ({ channel, ...(sample.payload as Omit<SeriesTrack, 'channel'>) })),
      ),
    // versions变即序列通道数据变了 (含切轴), 须重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, state, versions],
  )
}
