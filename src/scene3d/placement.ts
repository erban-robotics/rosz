// 3D场景的摆放: 场景每次按播放时刻解一次TF树, 交给各图层摆放 (不经React重渲). 图层经`usePlacement`登记
import { createContext, useContext, useEffect } from 'react'
import type * as THREE from 'three'
import type { FrameResolver } from './tf-tree'

/** 图层的摆放: `time`为播放时刻 (秒), `frames`为该时刻换算到基座标系的TF树 */
export type Placer = (time: number, frames: FrameResolver) => void

export const PlacementContext = createContext<{ register: (placer: Placer) => () => void } | null>(null)

/** 登记图层的摆放; 登记时若场景已摆过一次, 随即按上次的时刻与TF树摆一次 */
export function usePlacement(placer: Placer) {
  const context = useContext(PlacementContext)
  if (!context) throw new Error('图层须在3D场景内')
  useEffect(() => {
    return context.register(placer)
  }, [context, placer])
}

// 直接设物体的位姿矩阵 (物体须`matrixAutoUpdate={false}`); 换算不了的藏起
export function placeObject(object: THREE.Object3D | null, matrix: THREE.Matrix4 | null) {
  if (!object) return
  object.visible = matrix !== null
  if (!matrix) return
  object.matrix.copy(matrix)
  object.matrixWorldNeedsUpdate = true
}
