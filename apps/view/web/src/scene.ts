/**
 * 3D 面板里选了哪些空间话题 (TF 与点云). 面板本身是 rosz-ui 的 3D 场景视图 (`Scene3dView`): 画选中的话题, TF 树用目录里全部 TF 话题
 * 合成 (面板开着就都订阅), 点云按其 frame 经 TF 树放置.
 *
 * 选的话题存浏览器本地; 还没存过 (null) 时默认全部 TF 话题, 晚开查看器也直接看到静态变换.
 */
import { useSyncExternalStore } from 'react'
import { type ChannelInfo, spatialKindOf } from '@erban-robotics/rosz-ui'

const STORAGE_KEY = 'rosz-view.scene3d.topics'
const selectionListeners = new Set<() => void>()
let stored: string[] | null = load()

function load(): string[] | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
  } catch {
    return null
  }
}

function subscribeSelection(listener: () => void) {
  selectionListeners.add(listener)
  return () => void selectionListeners.delete(listener)
}

/** 3D 面板里的话题名; 还没选过时为目录里全部 TF 话题 */
export function useSceneTopics(catalog: ChannelInfo[]) {
  const chosen = useSyncExternalStore(subscribeSelection, () => stored)
  if (chosen) return chosen
  return catalog.filter((channel) => spatialKindOf(channel) === 'transform').map((channel) => channel.name)
}

/** 点话题树里的空间话题: 在 3D 面板里有就去掉, 没有就加上 */
export function toggleSceneTopic(channel: ChannelInfo, current: string[]) {
  stored = current.includes(channel.name) ? current.filter((name) => name !== channel.name) : [...current, channel.name]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  for (const listener of selectionListeners) listener()
}
