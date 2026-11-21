/**
 * 曲线所选字段的本地记忆: 话题 -> 所选数值字段, 存 localStorage, 下次打开仍在.
 * 话题从消息树里移出时一并忘掉 (见 layout.ts 的 toggleTopic); 话题暂时不在线不动, 上线后照旧.
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'rosz-view.curves'

type Chosen = Record<string, string[]>

function load(): Chosen {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((field) => typeof field === 'string'),
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}

let chosen = load()
const listeners = new Set<() => void>()

function save(next: Chosen) {
  chosen = next
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}

/** 点字段: 选上或取消 */
export function toggleCurveField(topic: string, field: string) {
  const current = chosen[topic] ?? []
  const fields = current.includes(field) ? current.filter((item) => item !== field) : [...current, field]
  const next = { ...chosen }
  if (fields.length > 0) next[topic] = fields
  else delete next[topic]
  save(next)
}

export function forgetCurves(topic: string) {
  if (!(topic in chosen)) return
  const next = { ...chosen }
  delete next[topic]
  save(next)
}

export function useChosenCurves() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => chosen,
  )
}
