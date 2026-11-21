// 时刻的公用量: 时刻比较, 整条时间轴, 按时间轴取值. 纯TS, 不依赖React
import type { TimeAxis, TimeRange } from './types'

// 整条时间轴 (绝对纳秒, int64两端): 静态通道的覆盖段, 首块之前与末块之后的延伸, 取静态通道的全部样本
export const WHOLE_TIMELINE: TimeRange = { start: -(2n ** 63n), end: 2n ** 63n - 1n }

// 时刻升序的比较器, 给`sort`用; 相等为0, 排序稳定
export function compareTimes(first: bigint, second: bigint) {
  return first < second ? -1 : first > second ? 1 : 0
}

// 按时间轴取值: 接收轴取`receive`, 采样轴取`sample`
export function onAxis<Value>(axis: TimeAxis, receive: Value, sample: Value): Value {
  return axis === 'receive' ? receive : sample
}

// 一路图像帧的两种时刻 (秒或纳秒), 第k项即第k帧
export type FrameTimes<Time> = { receiveTimes: Time[]; sampleTimes: Time[] }

// 一路图像在该时间轴上的帧时刻: 接收轴取接收时刻, 采样轴取采样时刻
export function frameTimesOn<Time>(frames: FrameTimes<Time>, axis: TimeAxis): Time[] {
  return onAxis(axis, frames.receiveTimes, frames.sampleTimes)
}
