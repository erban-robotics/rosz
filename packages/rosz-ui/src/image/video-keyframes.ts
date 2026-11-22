// 视频通道的关键帧选取: 需求窗口前移到关键帧, 从状态里取解到目标帧所需的样本. 纯TS, 不依赖React与WebCodecs
import type { DataSourceState } from '../data-source/state'
import { frameTimesOn, onAxis, WHOLE_TIMELINE } from '../data-source/time-axis'
import type { ChannelInfo, ImagePayload, Sample, TimeAxis } from '../data-source/types'
import { latestIndexAtOrBefore } from '../timeline/timeline'

// 走WebCodecs的视频格式 (`foxglove_msgs/CompressedVideo.format`); 其余图像格式逐样本独立解
const VIDEO_FORMATS = new Set(['h264', 'av1'])

export function isVideoFormat(format: string) {
  return VIDEO_FORMATS.has(format)
}

/**
 * 图像面板需求窗口的起点: 视频通道 (帧时刻表带`keyframeIndices`) 要从播放头所在帧之前最近的关键帧解起,
 * 起点取各视频通道这一关键帧时刻中最早的, 不晚于`time`; 没有视频通道即`time`.
 */
export function demandStartOf(channels: ChannelInfo[], axis: TimeAxis, time: bigint) {
  let start = time
  for (const { frames } of channels) {
    if (!frames?.keyframeIndices) continue
    const times = frameTimesOn(frames, axis)
    const index = latestIndexAtOrBefore(times, time)
    if (index < 0) continue
    const keyframe = latestIndexAtOrBefore(frames.keyframeIndices, index)
    if (keyframe < 0) continue
    const keyframeTime = times[frames.keyframeIndices[keyframe]]
    if (keyframeTime < start) start = keyframeTime
  }
  return start
}

/**
 * 解到`target`这一帧要按序喂的样本: 从不晚于它的最近关键帧到它本身, 按当前轴升序.
 * 关键帧不在状态里, 或关键帧之后到目标之间有未覆盖的空隙 (中间帧可能缺) 时为null, 面板显示加载中而不错画.
 */
export function samplesToDecode(
  state: DataSourceState,
  channel: string,
  target: Sample<ImagePayload>,
): Sample<ImagePayload>[] | null {
  const axis = state.axis()
  const timeOf = (sample: Sample) => onAxis(axis, sample.receiveTime, sample.sampleTime)
  const targetTime = timeOf(target)
  if (targetTime === undefined) return null
  const samples = state.samplesIn(channel, { start: WHOLE_TIMELINE.start, end: targetTime }) as Sample<ImagePayload>[]
  const targetIndex = samples.lastIndexOf(target)
  if (targetIndex < 0) return null
  let keyframe = targetIndex
  while (keyframe >= 0 && !samples[keyframe].payload.isKeyframe) keyframe -= 1
  if (keyframe < 0) return null
  if (keyframe === targetIndex) return [target]
  // 关键帧可能是某段起点前补的那一条 (在段的覆盖范围外); 它之后的一条到目标须在同一覆盖段内
  const afterKeyframe = timeOf(samples[keyframe + 1])!
  const isGapless = state.coveredRanges(channel).some((range) => range.start <= afterKeyframe && targetTime <= range.end)
  return isGapless ? samples.slice(keyframe, targetIndex + 1) : null
}
