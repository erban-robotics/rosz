import { expect, test } from 'vitest'
import { createDataSourceState } from './state'
import type { Sample } from './types'

function sampleAt(receiveTime: bigint): Sample<string> {
  return { receiveTime, payload: `t${receiveTime}` }
}

test('取不晚于播放头的最近一条', () => {
  const state = createDataSourceState()
  state.write('head', { start: 0n, end: 100n }, [sampleAt(10n), sampleAt(20n), sampleAt(30n)])
  expect(state.latestAtOrBefore('head', 25n)?.payload).toBe('t20')
})

test('窗口内的样本连同窗口起点前最近一条', () => {
  const state = createDataSourceState()
  state.write('arm', { start: 0n, end: 100n }, [sampleAt(10n), sampleAt(20n), sampleAt(30n), sampleAt(40n)])
  expect(state.samplesIn('arm', { start: 25n, end: 30n }).map((sample) => sample.payload)).toEqual(['t20', 't30'])
})

test('需求窗口变了即淘汰远离各窗口的段', () => {
  const state = createDataSourceState()
  state.write('head', { start: 0n, end: 999_999_999n }, [sampleAt(0n)])
  state.write('head', { start: 10_000_000_000n, end: 10_999_999_999n }, [sampleAt(10_000_000_000n)])
  state.setDemand('panel', { channels: ['head'], range: { start: 10_500_000_000n, end: 10_500_000_000n } })
  expect(state.coveredRanges('head')).toEqual([{ start: 10_000_000_000n, end: 10_999_999_999n }])
})

test('已覆盖时间段把相接的写入合成一段', () => {
  const state = createDataSourceState()
  state.write('head', { start: 100n, end: 199n }, [sampleAt(150n)])
  state.write('head', { start: 0n, end: 99n }, [sampleAt(50n)])
  state.write('head', { start: 300n, end: 399n }, [])
  expect(state.coveredRanges('head')).toEqual([
    { start: 0n, end: 199n },
    { start: 300n, end: 399n },
  ])
})

test('切到采样时间轴后按采样时刻取不晚于播放头的最近一条, 无采样时刻的通道无数据', () => {
  const state = createDataSourceState()
  // 接收时刻与采样时刻次序相反: 先收到的是后采的
  state.writeStatic('head', [
    { receiveTime: 10n, sampleTime: 30n, payload: 'late' },
    { receiveTime: 20n, sampleTime: 5n, payload: 'early' },
  ])
  state.writeStatic('arm', [sampleAt(1n)])
  state.setAxis('sample')
  expect([state.latestAtOrBefore('head', 25n)?.payload, state.latestAtOrBefore('arm', 25n)]).toEqual(['early', null])
})

test('切轴是一次不连续', () => {
  const state = createDataSourceState()
  const before = state.discontinuity()
  state.setAxis('sample')
  expect(state.discontinuity()).toBe(before + 1)
})

test('淘汰后每通道至少留最新一条, 静态通道整个保留', () => {
  const state = createDataSourceState()
  state.write('head', { start: 0n, end: 99n }, [sampleAt(10n), sampleAt(20n)])
  state.writeStatic('arm', [sampleAt(10n), sampleAt(20n)])
  state.setDemand('panel', { channels: ['head', 'arm'], range: { start: 100_000_000_000n, end: 100_000_000_000n } })
  expect([
    state.samplesIn('head', { start: 0n, end: 99n }).map((sample) => sample.payload),
    state.samplesIn('arm', { start: 0n, end: 99n }).map((sample) => sample.payload),
  ]).toEqual([['t20'], ['t10', 't20']])
})

test('淘汰后只剩空段时仍留最新一条', () => {
  const state = createDataSourceState()
  state.write('head', { start: 0n, end: 99n }, [sampleAt(10n), sampleAt(20n)])
  state.write('head', { start: 100_000_000_000n, end: 100_000_000_099n }, [])
  state.setDemand('panel', { channels: ['head'], range: { start: 100_000_000_000n, end: 100_000_000_000n } })
  expect(state.latestAtOrBefore('head', 100_000_000_000n)?.payload).toBe('t20')
})

test('频率按样本的接收时刻统计', () => {
  const state = createDataSourceState({ mode: 'live' })
  // 15Hz: 间隔1/15秒, 共16条
  state.append('head', Array.from({ length: 16 }, (_, index) => sampleAt(BigInt(Math.round((index * 1e9) / 15)))))
  expect(state.stats('head').frequency).toBeCloseTo(15)
})

test('实时模式保留播放头前10秒, 静态通道与每通道最新一条不淘汰', () => {
  const state = createDataSourceState({ mode: 'live' })
  state.upsertChannels([{ id: '/tf_static', kind: 'spatial', name: '/tf_static', isStatic: true }])
  state.append('/tf_static', [sampleAt(0n)])
  state.append('/rare', [sampleAt(0n)])
  state.append('/head', [sampleAt(0n), sampleAt(5_000_000_000n)])
  state.append('/head', [sampleAt(20_000_000_000n)])
  expect([
    state.samplesIn('/tf_static', { start: 0n, end: 30_000_000_000n }).length,
    state.samplesIn('/rare', { start: 0n, end: 30_000_000_000n }).length,
    state.samplesIn('/head', { start: 0n, end: 30_000_000_000n }).map((sample) => sample.payload),
    state.latestReceiveTime(),
  ]).toEqual([1, 1, ['t20000000000'], 20_000_000_000n])
})

test('实时模式下标了keepLatest的通道只留最新一条, 频率照算', () => {
  const state = createDataSourceState({ mode: 'live' })
  state.upsertChannels([{ id: '/points', kind: 'spatial', name: '/points', keepLatest: true }])
  // 10Hz, 共11条, 一条一条到
  for (let index = 0; index <= 10; index += 1) state.append('/points', [sampleAt(BigInt(index * 100_000_000))])
  expect([state.samplesIn('/points', { start: 0n, end: 2_000_000_000n }).length, state.stats('/points').frequency]).toEqual([
    1,
    10,
  ])
})
