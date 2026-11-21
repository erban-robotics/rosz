import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { secondsAt, type PlaybackClock } from '../data-source/clock'
import type { DataSource } from '../data-source/react'
import { type PlaybackState, usePlaybackStore } from './store'

export type { PlaybackClock } from '../data-source/clock'

/**
 * 播放时钟的实现: 时刻存在回放状态store (`usePlaybackStore`) 里, 每个动画帧推进, 不经React状态, 免得整棵回放树每帧重渲.
 * 高频消费者 (播放头, 读数, 3D标记) 用`useClockListener`直接改DOM/场景; 只关心派生量的 (如当前帧号) 用`useClockSelector`, 派生量变了才重渲.
 */
export const playbackClock: PlaybackClock = {
  getTime: () => usePlaybackStore.getState().time,
  subscribe: (listener) =>
    usePlaybackStore.subscribe((state, previous) => {
      if (state.time !== previous.time) listener()
    }),
}

export type Playback = Pick<
  PlaybackState,
  'isPlaying' | 'speed' | 'loop' | 'setSpeed' | 'togglePlaying' | 'seek' | 'step' | 'playRange' | 'clearLoop'
> & { clock: PlaybackClock }

// 当前驱动播放时钟的组件实例; 换了实例 (换页, 换一条录制) 才复位, StrictMode重跑副作用不复位
let currentOwner: object | null = null

/**
 * 驱动回放时间轴的播放时钟: 每个动画帧按倍速推进, 到末尾停; 有循环区间时到区间终点回起点.
 * 一页只挂一处 (回放页), 新挂载的实例从头开始. 实时查看改用`useLivePlayback`.
 * 状态与操作都在`usePlaybackStore`, 返回值是它们的快照, 方便按属性传给面板; 面板也可直接从store取.
 * 总长 (store的`duration`) 由视图组装按所选时间轴写入, 这里只读.
 */
export function usePlayback(): Playback {
  const [owner] = useState(() => ({}))
  const isPlaying = usePlaybackStore((state) => state.isPlaying)
  const speed = usePlaybackStore((state) => state.speed)
  const loop = usePlaybackStore((state) => state.loop)

  // 先于本组件的其余副作用复位
  useLayoutEffect(() => {
    if (currentOwner === owner) return
    currentOwner = owner
    usePlaybackStore.getState().resetPlayback()
  }, [owner])

  useEffect(() => {
    if (!isPlaying) return
    let previous = performance.now()
    let handle = 0
    const tick = (now: number) => {
      // 总长取store里的: 由视图组装按所选时间轴写入
      const { time, duration: end, markJump } = usePlaybackStore.getState()
      let next = time + ((now - previous) / 1000) * speed
      previous = now
      if (loop !== null) {
        if (next >= loop.end || next < loop.start) {
          next = loop.start
          markJump()
        }
      } else if (next >= end) {
        usePlaybackStore.setState({ time: end, isPlaying: false })
        return
      }
      usePlaybackStore.setState({ time: next })
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [isPlaying, speed, loop])

  const { setSpeed, togglePlaying, seek, step, playRange, clearLoop } = usePlaybackStore.getState()
  return { clock: playbackClock, isPlaying, speed, loop, setSpeed, togglePlaying, seek, step, playRange, clearLoop }
}

/**
 * 实时查看的播放时钟: 播放头为状态里已收到的最大接收时刻 (见`DataSourceState.latestReceiveTime`), 每个动画帧跟上, 无额外延迟;
 * 总长随之增长. 实时没有播放, 跳转与倍速, 返回值里的这些操作不改时刻. 与`usePlayback`二选一, 一页只挂一处.
 */
export function useLivePlayback({ state, zero }: DataSource): Playback {
  useLayoutEffect(() => {
    usePlaybackStore.getState().resetPlayback()
    let handle = 0
    const tick = () => {
      const latest = state.latestReceiveTime()
      if (latest !== null) {
        const time = secondsAt(zero, latest)
        if (time !== usePlaybackStore.getState().time) usePlaybackStore.setState({ time, duration: time })
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [state, zero])
  const noop = () => {}
  return {
    clock: playbackClock,
    isPlaying: false,
    speed: 1,
    loop: null,
    setSpeed: noop,
    togglePlaying: noop,
    seek: noop,
    step: noop,
    playRange: noop,
    clearLoop: noop,
  }
}

/**
 * 时刻每变一次调一次`onTime`, 不触发重渲; 组件自身重渲后也调一次, 让依赖别的状态 (如可见区间) 的写法跟上.
 * 回调里直接改DOM或three.js对象.
 */
export function useClockListener(clock: PlaybackClock, onTime: (time: number) => void) {
  const onTimeRef = useRef(onTime)
  useLayoutEffect(() => {
    onTimeRef.current = onTime
    onTime(clock.getTime())
  })
  useLayoutEffect(() => {
    return clock.subscribe(() => onTimeRef.current(clock.getTime()))
  }, [clock])
}

// 由时刻派生的值, 值变了才重渲; `select`须返回原始值 (按`Object.is`比较)
export function useClockSelector<T>(clock: PlaybackClock, select: (time: number) => T): T {
  return useSyncExternalStore(clock.subscribe, () => select(clock.getTime()))
}
