import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, test } from 'vitest'
import { useClockSelector, usePlayback } from './use-playback'
import { usePlaybackStore } from './store'

// 总长平时由视图组装写入, 这里直接写进store
beforeEach(() => {
  usePlaybackStore.setState({ duration: 10 })
})

test('播放状态在store里共享, 新挂载的播放时钟从头开始', () => {
  const first = renderHook(() => usePlayback())
  act(() => first.result.current.playRange({ start: 2, end: 4 }))
  expect(usePlaybackStore.getState()).toMatchObject({ time: 2, isPlaying: true, loop: { start: 2, end: 4 } })

  // 不经usePlayback的返回值, 直接用store的操作, 持有者照样看到
  act(() => usePlaybackStore.getState().togglePlaying())
  expect(first.result.current.isPlaying).toBe(false)
  first.unmount()

  const second = renderHook(() => usePlayback())
  expect(second.result.current.clock.getTime()).toBe(0)
  expect(second.result.current.loop).toBeNull()
})

test('循环区间内跳转仍循环, 跳到区间外解除循环', () => {
  const { result } = renderHook(() => usePlayback())

  act(() => result.current.playRange({ start: 2, end: 4 }))
  act(() => result.current.seek(3))
  expect(result.current.clock.getTime()).toBe(3)
  expect(result.current.loop).toEqual({ start: 2, end: 4 })

  act(() => result.current.seek(6))
  expect(result.current.loop).toBeNull()
})

test('时刻变化不重渲持有时钟的组件, 派生量变了才重渲订阅者', () => {
  let ownerRenders = 0
  let selectorRenders = 0
  const { result } = renderHook(() => {
    ownerRenders += 1
    return usePlayback()
  })
  const selected = renderHook(() => {
    selectorRenders += 1
    return useClockSelector(result.current.clock, (time) => Math.floor(time))
  })
  const [ownerBefore, selectorBefore] = [ownerRenders, selectorRenders]

  act(() => result.current.seek(0.3))
  act(() => result.current.seek(0.6))
  expect(ownerRenders).toBe(ownerBefore)
  expect(selectorRenders).toBe(selectorBefore)

  act(() => result.current.seek(1.2))
  expect(ownerRenders).toBe(ownerBefore)
  expect(selected.result.current).toBe(1)
  expect(selectorRenders).toBe(selectorBefore + 1)
})
