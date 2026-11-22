// 播放时钟的读取口与时刻换算. 纯TS, 不依赖React

/**
 * 播放时钟: 会话时间轴上的当前时刻 (秒, 起点为会话零点). 时刻每变一次通知一次订阅者, 不经React状态.
 * 驱动与读取的React钩子见`use-playback.ts`.
 */
export type PlaybackClock = {
  getTime: () => number
  subscribe: (listener: () => void) => () => void
}

/**
 * 会话时间轴秒数 -> 绝对纳秒. 状态里的样本时刻与面板查询的播放头都经这一个换算,
 * 同一秒数总落在同一纳秒上, 步进到某帧的时刻再查不会因浮点误差落到前一帧.
 */
export function nanosecondsAt(zero: bigint, seconds: number) {
  return zero + BigInt(Math.round(seconds * 1e9))
}

// 绝对纳秒 -> 会话时间轴秒数
export function secondsAt(zero: bigint, time: bigint) {
  return Number(time - zero) / 1e9
}
