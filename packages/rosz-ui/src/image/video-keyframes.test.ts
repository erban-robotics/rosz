import { expect, test } from 'vitest'
import { createDataSourceState } from '../data-source/state'
import type { ChannelInfo, ImagePayload, Sample } from '../data-source/types'
import { demandStartOf, samplesToDecode } from './video-keyframes'

// 10帧H.264, 帧号0与5为关键帧, 接收时刻为帧号乘100
function videoSample(index: number): Sample<ImagePayload> {
  return { receiveTime: BigInt(index * 100), payload: { format: 'h264', data: new Uint8Array([index]), isKeyframe: index % 5 === 0 } }
}

test('视频通道的需求窗口起点前移到不晚于播放头的最近关键帧, 其余通道照旧', () => {
  const times = Array.from({ length: 10 }, (_, index) => BigInt(index * 100))
  const video: ChannelInfo = { id: 'head', kind: 'image', name: 'head', frames: { receiveTimes: times, sampleTimes: times, keyframeIndices: [0, 5] } }
  const jpeg: ChannelInfo = { id: 'wrist', kind: 'image', name: 'wrist', frames: { receiveTimes: times, sampleTimes: times } }
  expect(demandStartOf([jpeg, video], 'receive', 750n)).toBe(500n)
  expect(demandStartOf([jpeg], 'receive', 750n)).toBe(750n)
})

test('跳到非关键帧从前一关键帧解起; 关键帧那段未到则不解', () => {
  const state = createDataSourceState()
  const samples = Array.from({ length: 10 }, (_, index) => videoSample(index))
  // 只到了帧号6-9那段: 前一关键帧 (帧号5) 未缓冲
  state.write('head', { start: 600n, end: 999n }, samples.slice(6))
  expect(samplesToDecode(state, 'head', samples[7])).toBeNull()
  state.write('head', { start: 0n, end: 599n }, samples.slice(0, 6))
  expect(samplesToDecode(state, 'head', samples[7])?.map((sample) => sample.receiveTime)).toEqual([500n, 600n, 700n])
})
