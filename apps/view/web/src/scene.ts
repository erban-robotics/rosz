/**
 * 3D 面板的数据: TF 树 (`/tf` `/tf_static` 等 `TFMessage` 话题合成) 与各点云话题的最新一帧, 以及面板里选了哪些话题.
 *
 * rosz-ui 的 3D 场景一个空间通道只画一个坐标变换, 不按 TF 换算坐标系, 且每来一条样本就重新取景 (实时下转不动视角),
 * 所以 TF 与点云不走它的空间通道: 适配器把解出的变换与点写进这里, 查看器自己的 3D 面板 (scene3d.tsx) 读. 话题照样在
 * rosz-ui 状态里记样本 (话题树的频率, 需求窗口驱动订阅), 只是点云样本不带点.
 */
import { useSyncExternalStore } from 'react'
import type { ChannelInfo } from '@erban-robotics/rosz-ui'

export const TF_MESSAGE = 'tf2_msgs/msg/TFMessage'
export const POINT_CLOUD2 = 'sensor_msgs/msg/PointCloud2'

export type Vector3 = [number, number, number]
// 四元数, 顺序 x, y, z, w
export type Quaternion = [number, number, number, number]

/** TF 树的一条边: 子坐标系在父坐标系里的位姿, 来自哪个话题 */
export type Edge = { parent: string; translation: Vector3; rotation: Quaternion; topic: string }

/** 点云一帧: 点在 `frame` 坐标系里; 点太多时等间隔抽取, `total` 为原有点数 */
export type Cloud = { frame: string; positions: Float32Array; colors: Float32Array | null; total: number }

/** 空间话题的种类; 不是空间话题为 null */
export function spatialTypeOf(schemaName: string) {
  if (schemaName === TF_MESSAGE) return 'transform' as const
  if (schemaName === POINT_CLOUD2) return 'point_cloud' as const
  return null
}

type Xyz = { x: number; y: number; z: number }
type TransformStamped = {
  header: { frame_id: string }
  child_frame_id: string
  transform: { translation: Xyz; rotation: Xyz & { w: number } }
}

// tf2 的坐标系名不带开头的 `/`, 老数据带的按同一个算
const frameName = (name: string) => name.replace(/^\/+/, '')

export type Scene = ReturnType<typeof createScene>

export function createScene() {
  // 子坐标系 -> 边; 同一子坐标系后到的覆盖先到的 (不按时间戳插值, 取最新)
  const edges = new Map<string, Edge>()
  const clouds = new Map<string, Cloud>()
  const listeners = new Set<() => void>()
  let version = 0
  const changed = () => {
    version += 1
    for (const listener of listeners) listener()
  }
  return {
    /** 一条 TFMessage 的各变换并进 TF 树 */
    applyTf(topic: string, transforms: TransformStamped[]) {
      for (const { header, child_frame_id, transform } of transforms) {
        const { translation: t, rotation: r } = transform
        const parent = frameName(header.frame_id)
        const child = frameName(child_frame_id)
        if (!parent || !child || parent === child) continue
        edges.set(child, { parent, translation: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w], topic })
      }
      changed()
    },
    setCloud(topic: string, cloud: Cloud) {
      clouds.set(topic, { ...cloud, frame: frameName(cloud.frame) })
      changed()
    },
    /** 话题下线: 去掉它的点云与它给的边 */
    removeTopic(topic: string) {
      let removed = clouds.delete(topic)
      for (const [child, edge] of edges)
        if (edge.topic === topic) {
          edges.delete(child)
          removed = true
        }
      if (removed) changed()
    },
    edges(): ReadonlyMap<string, Edge> {
      return edges
    },
    cloud(topic: string) {
      return clouds.get(topic) ?? null
    },
    version() {
      return version
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

// ---------------- 面板里选了哪些空间话题 ----------------

// 选的话题存浏览器本地; 还没存过 (null) 时默认全部 TF 话题, 晚开查看器也直接看到静态变换
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
  return catalog.filter((channel) => channel.type === TF_MESSAGE).map((channel) => channel.name)
}

/** 点话题树里的空间话题: 在 3D 面板里有就去掉, 没有就加上 */
export function toggleSceneTopic(channel: ChannelInfo, current: string[]) {
  stored = current.includes(channel.name) ? current.filter((name) => name !== channel.name) : [...current, channel.name]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  for (const listener of selectionListeners) listener()
}
