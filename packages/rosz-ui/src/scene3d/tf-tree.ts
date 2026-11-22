/**
 * TF树的换算: 把各坐标系换算到基座标系 (依赖three, 只在3D场景分块里用). 每个子坐标系取播放时刻当时或之前最近的一条含它的变换
 * (不插值); 多个图层给同一子坐标系时取时刻较晚的. 基座标系可为树里任一坐标系 (不必是根), 不在同一棵树上的坐标系换算不了.
 */
import * as THREE from 'three'
import type { SceneTransformLayer } from './scene-layers'
import type { TransformEdge } from './spatial-layers'
import { edgeAt, MAX_CHAIN, transformIndex } from './tf-graph'

export type FrameResolver = {
  /** 坐标系在基座标系下的位姿 (矩阵为缓存, 勿改); 换算不了为null */
  matrixOf(frame: string): THREE.Matrix4 | null
}

function edgeMatrix({ translation, rotation }: TransformEdge) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...translation),
    new THREE.Quaternion(...rotation).normalize(),
    new THREE.Vector3(1, 1, 1),
  )
}

/**
 * `time`时刻的TF树换算到`base`. `base`为null (没有任何坐标系) 时一律不换算 (单位阵).
 * 结果只在该时刻有效, 场景每次摆放时重建; 各坐标系的位姿按需算, 算过的缓存
 */
export function resolveFrames(layers: SceneTransformLayer[], base: string | null, time: number): FrameResolver {
  const identity = new THREE.Matrix4()
  if (base === null) return { matrixOf: () => identity }
  const edges = new Map<string, { time: number; edge: TransformEdge }>()
  for (const layer of layers)
    for (const [child, track] of transformIndex(layer)) {
      const found = edgeAt(track, time)
      const known = edges.get(child)
      if (found && (!known || found.time > known.time)) edges.set(child, found)
    }
  // 坐标系 -> (树根, 在树根下的位姿); 成环的为null
  const inRoot = new Map<string, { root: string; matrix: THREE.Matrix4 } | null>()
  const poseInRoot = (frame: string, depth: number): { root: string; matrix: THREE.Matrix4 } | null => {
    const known = inRoot.get(frame)
    if (known !== undefined) return known
    const edge = edges.get(frame)?.edge
    let pose: { root: string; matrix: THREE.Matrix4 } | null
    if (!edge) pose = { root: frame, matrix: identity }
    else if (depth > MAX_CHAIN) pose = null
    else {
      const parent = poseInRoot(edge.parent, depth + 1)
      pose = parent && { root: parent.root, matrix: parent.matrix.clone().multiply(edgeMatrix(edge)) }
    }
    inRoot.set(frame, pose)
    return pose
  }
  const basePose = poseInRoot(base, 0)
  const inverse = basePose ? basePose.matrix.clone().invert() : identity
  const inBase = new Map<string, THREE.Matrix4 | null>()
  return {
    matrixOf(frame) {
      if (frame === base) return identity
      const known = inBase.get(frame)
      if (known !== undefined) return known
      const pose = poseInRoot(frame, 0)
      const matrix = pose && basePose && pose.root === basePose.root ? inverse.clone().multiply(pose.matrix) : null
      inBase.set(frame, matrix)
      return matrix
    },
  }
}
