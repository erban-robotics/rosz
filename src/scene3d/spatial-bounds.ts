// 取景用的包围盒 (依赖three, 只在3D场景分块里用). 只在取景时算一次, 样本与点都抽着算, 大点云也不全量遍历
import * as THREE from 'three'
import { type SceneLayer } from './scene-layers'
import type { FrameResolver } from './tf-tree'
import { type TcpTrack, trackBounds } from './trajectory'

// 每个图层最多看这么多条样本 (等间隔, 含最后一条), 每帧点最多看这么多点
const MAX_BOUND_SAMPLES = 64
const MAX_BOUND_POINTS = 2000

function spread<Item>(items: Item[], count: number) {
  if (items.length <= count) return items
  const step = (items.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => items[Math.round(index * step)])
}

/**
 * 轨迹与空间图层在基座标系里的包围盒: 各坐标系按取景时刻的TF树换算, 换算不了的不计. 位姿, 坐标变换与点按全部时刻的样本
 * (抽样) 计, 与回放时整段可见的范围相符
 */
export function sceneBounds(tracks: TcpTrack[], layers: SceneLayer[], frames: FrameResolver) {
  const bounds = new THREE.Box3()
  const vertex = new THREE.Vector3()
  const add = (x: number, y: number, z: number, matrix: THREE.Matrix4) => bounds.expandByPoint(vertex.set(x, y, z).applyMatrix4(matrix))
  for (const track of tracks) {
    const matrix = track.frame === null ? new THREE.Matrix4() : frames.matrixOf(track.frame)
    if (matrix) bounds.union(trackBounds([track]).applyMatrix4(matrix))
  }
  for (const layer of layers) {
    for (const sample of spread<SceneLayer['samples'][number]>(layer.samples, MAX_BOUND_SAMPLES)) {
      if ('transforms' in sample) {
        for (const { parent, translation } of sample.transforms) {
          const matrix = frames.matrixOf(parent)
          if (matrix) {
            add(0, 0, 0, matrix)
            add(...translation, matrix)
          }
        }
      } else if ('points' in sample) {
        const { frame, positions } = sample.points
        const matrix = frames.matrixOf(frame)
        if (!matrix) continue
        const step = Math.max(1, Math.ceil(positions.length / 3 / MAX_BOUND_POINTS)) * 3
        for (let at = 0; at + 2 < positions.length; at += step) add(positions[at], positions[at + 1], positions[at + 2], matrix)
      } else if (layer.kind === 'pose') {
        const matrix = frames.matrixOf(layer.frame)
        if (matrix) add(...sample.position, matrix)
      }
    }
  }
  return bounds
}
