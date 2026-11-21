import { expect, test } from 'vitest'
import * as THREE from 'three'
import type { SceneTransformLayer } from './scene-layers'
import { resolveFrames } from './tf-tree'

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1]

test('一条多个变换的TF消息合成TF树, 每个子坐标系取当时或之前最近的一条, 换算到非根的基座标系', () => {
  const tf: SceneTransformLayer = {
    kind: 'transform',
    channel: '/tf',
    name: '/tf',
    label: '/tf',
    samples: [
      {
        time: 0,
        transforms: [
          { parent: 'world', child: 'base', translation: [1, 0, 0], rotation: IDENTITY },
          { parent: 'base', child: 'camera', translation: [0, 0, 1], rotation: IDENTITY },
        ],
      },
      // 只更新base, camera沿用上一条
      { time: 1, transforms: [{ parent: 'world', child: 'base', translation: [2, 0, 0], rotation: IDENTITY }] },
    ],
  }
  const origin = (time: number, frame: string, base: string) => {
    const matrix = resolveFrames([tf], base, time).matrixOf(frame)
    return matrix && new THREE.Vector3().setFromMatrixPosition(matrix).toArray()
  }
  expect([origin(0.5, 'camera', 'world'), origin(1, 'camera', 'world'), origin(1, 'world', 'camera'), origin(1, 'map', 'world')]).toEqual([
    [1, 0, 1],
    [2, 0, 1],
    [-2, 0, -1],
    null,
  ])
})
