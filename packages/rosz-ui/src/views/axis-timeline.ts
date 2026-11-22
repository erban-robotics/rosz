import { secondsAt } from '../data-source/clock'
import type { ChannelInfo, TimeAxis } from '../data-source/types'

type FrameGroup = { channels: ChannelInfo[]; isSynchronized: boolean }

// 有帧时刻表的图像通道按组归拢: 同`frames.group`的一组, 没给组的各自一组
function frameGroups(channels: ChannelInfo[]): FrameGroup[] {
  const groups = new Map<string, FrameGroup>()
  for (const channel of channels) {
    if (channel.kind !== 'image' || !channel.frames) continue
    const key = channel.frames.group ?? `channel/${channel.id}`
    const group = groups.get(key) ?? { channels: [], isSynchronized: channel.frames.isSynchronized === true }
    group.channels.push(channel)
    groups.set(key, group)
  }
  return [...groups.values()]
}

// 一组图像在该轴上的帧时刻 (秒): 采样轴取帧时刻, 接收轴取各帧各路都已收到 (各路接收时刻中最晚) 的时刻
function groupTimes(group: FrameGroup, axis: TimeAxis, zero: bigint): number[] {
  const first = group.channels[0].frames!
  if (axis === 'sample') return first.sampleTimes.map((time) => secondsAt(zero, time))
  return first.receiveTimes.map((_, index) => {
    let latest = first.receiveTimes[index]
    for (const channel of group.channels) {
      const time = channel.frames!.receiveTimes[index]
      if (time !== undefined && time > latest) latest = time
    }
    return secondsAt(zero, latest)
  })
}

/**
 * 离线时间轴的总长与步进时刻 (秒), 由通道目录算: 步进按有同步帧表的组, 没有则按帧最多的一组.
 * 接收轴上各通道的末尾时刻 (`range.end`) 也计入总长; 采样轴上只有图像帧有时刻.
 */
export function axisTimeline(channels: ChannelInfo[], axis: TimeAxis, zero: bigint) {
  const groups = frameGroups(channels)
  const timesByGroup = groups.map((group) => groupTimes(group, axis, zero))
  const synchronizedIndex = groups.findIndex((group) => group.isSynchronized)
  const stepTimes =
    synchronizedIndex >= 0
      ? timesByGroup[synchronizedIndex]
      : timesByGroup.reduce<number[]>((longest, times) => (times.length > longest.length ? times : longest), [])
  const frameEnds = timesByGroup.map((times) => times.at(-1) ?? 0)
  const channelEnds =
    axis === 'receive' ? channels.flatMap((channel) => (channel.range ? [secondsAt(zero, channel.range.end)] : [])) : []
  return { duration: Math.max(0, ...channelEnds, ...frameEnds), stepTimes }
}
