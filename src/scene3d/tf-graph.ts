/**
 * TF树的结构 (不依赖three, 主分块里用): 坐标变换图层按子坐标系分开的变换序列, 与不看时刻的连通关系.
 * 每个子坐标系取播放时刻当时或之前最近的一条含它的变换 (不插值). 换算矩阵见`tf-tree.ts`.
 */
import { indexAtOrBefore, type SceneTransformLayer } from './scene-layers'
import type { TransformEdge } from './spatial-layers'

// TF链的最大深度: 超过即认为成环, 该坐标系换算不了
export const MAX_CHAIN = 64

type EdgeTrack = { time: number; edge: TransformEdge }[]
// 一个图层按子坐标系分开的变换序列 (时刻升序); 按图层样本数组缓存, 只在图层数据变了时重建
const indexCache = new WeakMap<SceneTransformLayer['samples'], Map<string, EdgeTrack>>()

/** 图层里各子坐标系的变换序列 */
export function transformIndex(layer: SceneTransformLayer) {
  let index = indexCache.get(layer.samples)
  if (index) return index
  index = new Map()
  for (const { time, transforms } of layer.samples)
    for (const edge of transforms) {
      const track = index.get(edge.child) ?? []
      track.push({ time, edge })
      index.set(edge.child, track)
    }
  indexCache.set(layer.samples, index)
  return index
}

/** 子坐标系在`time`时的变换 (当时或之前最近的一条); 还没有为null */
export function edgeAt(track: EdgeTrack, time: number) {
  const found = indexAtOrBefore(track, time)
  return found < 0 ? null : track[found]
}

/**
 * 不看时刻的坐标系连通关系 (各图层出现过的全部边; 同一子坐标系的父坐标系变过的取最后一条): 基座标系下拉的选项,
 * 默认基座标系, 与 "不连通, 未画" 的提示用. `declared`为其他图层声明的坐标系 (可不在TF树里), 按声明顺序
 */
export function frameGraph(layers: SceneTransformLayer[], declared: string[]) {
  const parents = new Map<string, string>()
  for (const layer of layers)
    for (const [child, track] of transformIndex(layer)) parents.set(child, track.at(-1)!.edge.parent)
  const frames = new Set<string>([...declared, ...parents.keys(), ...parents.values()])
  const rootOf = (frame: string) => {
    let current = frame
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      const parent = parents.get(current)
      if (parent === undefined) return current
      current = parent
    }
    return null
  }
  return {
    frames: [...frames].sort(),
    // 两个坐标系在同一棵树上 (同名即是)
    isConnected(first: string, second: string) {
      if (first === second) return true
      const root = rootOf(first)
      return root !== null && root === rootOf(second)
    },
    /**
     * 默认基座标系: 坐标系最多的那棵树的根; 同样多时取先声明的坐标系所在的树 (只有坐标变换图层时按名字).
     * 没有任何坐标系为null
     */
    defaultFrame(): string | null {
      const sizes = new Map<string, number>()
      for (const frame of frames) {
        const root = rootOf(frame)
        if (root !== null) sizes.set(root, (sizes.get(root) ?? 0) + 1)
      }
      const order = (root: string) => {
        const index = declared.findIndex((frame) => rootOf(frame) === root)
        return index < 0 ? declared.length : index
      }
      return [...sizes].sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    },
  }
}

