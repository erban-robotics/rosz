import { expect, test } from 'vitest'
import type { ChannelInfo, Sample } from '../data-source/types'
import { buildSceneLayer, type SceneTransformLayer } from './scene-layers'
import type { TransformEdge } from './spatial-layers'

const IDENTITY: [number, number, number, number] = [0, 0, 0, 1]
const TF: ChannelInfo = { id: '/tf', kind: 'spatial', name: '/tf', type: 'transform' }

function edge(parent: string, child: string, x: number): TransformEdge {
  return { parent, child, translation: [x, 0, 0], rotation: IDENTITY }
}

function sample(time: number, transforms: TransformEdge[]): Sample {
  return { receiveTime: BigInt(time), payload: { time, transforms } }
}

const samples = [
  sample(1, [edge('world', 'base', 1), edge('base', 'hand', 1)]),
  sample(2, [edge('base', 'hand', 2)]),
  sample(3, [edge('base', 'hand', 3)]),
]

test('latestOnly时坐标变换只留各子坐标系最新的一条, 不随保留的样本数涨', () => {
  const { layer } = buildSceneLayer(TF, samples, { axis: 'receive', zero: 0n, rosz: null, latestOnly: true })
  const transforms = (layer as SceneTransformLayer).samples
  expect(transforms).toEqual([
    { time: 1, transforms: [edge('world', 'base', 1)] },
    { time: 3, transforms: [edge('base', 'hand', 3)] },
  ])
})

test('不给latestOnly时保留全部样本 (回放按播放头取当时的变换)', () => {
  const { layer } = buildSceneLayer(TF, samples, { axis: 'receive', zero: 0n, rosz: null })
  expect((layer as SceneTransformLayer).samples.map(({ time }) => time)).toEqual([1, 2, 3])
})
