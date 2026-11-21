/**
 * 后端发送队列丢帧的累计 (后端 `status` 帧的 `dropped`, 见 apps/view/src/outbox.rs): 话题 -> 本次打开以来丢的条数.
 * 只有小消息队列满了才算丢帧; 图像点云每路只留最新一条是常态降帧, 不在此列.
 */
import { useSyncExternalStore } from 'react'

export type DropTally = ReturnType<typeof createDropTally>

export function createDropTally() {
  let counts = new Map<string, number>()
  const listeners = new Set<() => void>()
  return {
    add(topic: string, dropped: number) {
      counts = new Map(counts).set(topic, (counts.get(topic) ?? 0) + dropped)
      for (const listener of listeners) listener()
    },
    snapshot: () => counts,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

export function useDrops(tally: DropTally) {
  return useSyncExternalStore(tally.subscribe, tally.snapshot)
}
