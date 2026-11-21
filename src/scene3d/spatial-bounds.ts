// 空间图层的包围盒 (依赖three, 只在3D场景分块里用)
import * as THREE from 'three'
import { type DrawableSpatialLayer, samplePositions } from './spatial-layers'

// 把空间图层全部位置并进`bounds`, 取景用
export function spatialBounds(layers: DrawableSpatialLayer[], bounds: THREE.Box3) {
  const vertex = new THREE.Vector3()
  for (const layer of layers) {
    for (const sample of layer.samples) {
      for (const position of samplePositions(sample)) bounds.expandByPoint(vertex.set(...position))
    }
  }
  return bounds
}
