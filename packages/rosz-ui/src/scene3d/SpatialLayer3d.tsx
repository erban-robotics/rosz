import { Html } from '@react-three/drei'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { placeObject, type Placer, usePlacement } from './placement'
import {
  indexAtOrBefore,
  type PointsFrame,
  type SceneLayer,
  type ScenePointsLayer,
  type ScenePoseLayer,
  type SceneTransformLayer,
} from './scene-layers'
import { edgeAt, transformIndex } from './tf-graph'
import type { FrameResolver } from './tf-tree'

// 位姿与坐标变换的坐标轴长 (米), 比原点坐标轴短, 免得混淆
const POSE_AXIS_LENGTH_METERS = 0.06
// 坐标系到其父坐标系的连线
const LINK_COLOR = 0x8a8a8a
// 点的屏幕尺寸 (像素), 不随远近缩放; 3D关键点画得大些
const POINT_SIZE_PIXELS = 3
const KEYPOINT_SIZE_PIXELS = 8

function sameList(first: string[], second: string[]) {
  return first.length === second.length && first.every((item, index) => item === second[index])
}

// 换掉物体的几何并释放旧的 (旧几何的GPU缓冲随之删掉; 只换属性不释放会每帧漏一份)
function replaceGeometry(object: THREE.Points | THREE.LineSegments, geometry: THREE.BufferGeometry) {
  const previous = object.geometry
  object.geometry = geometry
  previous.dispose()
}

// 连线的端点: 缓冲够用就原地改写, 不够才换更大的
function setLinks(links: THREE.LineSegments, segments: number[]) {
  let attribute = links.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!attribute || attribute.array.length < segments.length) {
    attribute = new THREE.BufferAttribute(new Float32Array(Math.max(segments.length * 2, 6)), 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', attribute)
    replaceGeometry(links, geometry)
  }
  ;(attribute.array as Float32Array).set(segments)
  attribute.needsUpdate = true
  links.geometry.setDrawRange(0, segments.length / 3)
}

/**
 * 坐标变换: 该时刻有变换的各子坐标系与其父坐标系画一组短坐标轴并标名字, 子到父画连线. 坐标系集合变了才经React重渲,
 * 位姿直接写矩阵.
 */
function TransformLayer3d({ layer }: { layer: SceneTransformLayer }) {
  const index = useMemo(() => transformIndex(layer), [layer])
  const [shown, setShown] = useState<string[]>([])
  const groups = useRef(new Map<string, THREE.Group>())
  const lastFrames = useRef<FrameResolver | null>(null)
  const links = useMemo(() => {
    const segments = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: LINK_COLOR }))
    segments.frustumCulled = false
    return segments
  }, [])
  useEffect(
    () => () => {
      links.geometry.dispose()
      ;(links.material as THREE.Material).dispose()
    },
    [links],
  )

  const place = useCallback<Placer>(
    (time, frames) => {
      lastFrames.current = frames
      const visible = new Set<string>()
      const segments: number[] = []
      const origin = new THREE.Vector3()
      for (const [child, track] of index) {
        const found = edgeAt(track, time)
        const childMatrix = found && frames.matrixOf(child)
        if (!found || !childMatrix) continue
        visible.add(child)
        const parentMatrix = frames.matrixOf(found.edge.parent)
        if (!parentMatrix) continue
        visible.add(found.edge.parent)
        segments.push(...origin.setFromMatrixPosition(parentMatrix).toArray())
        segments.push(...origin.setFromMatrixPosition(childMatrix).toArray())
      }
      setLinks(links, segments)
      for (const [frame, group] of groups.current) placeObject(group, frames.matrixOf(frame))
      const next = [...visible].sort()
      setShown((previous) => (sameList(previous, next) ? previous : next))
    },
    [index, links],
  )
  usePlacement(place)

  // 新显示的坐标系挂上时按上次的TF树摆好, 不等下一次摆放
  const attach = useCallback((frame: string, group: THREE.Group | null) => {
    if (!group) {
      groups.current.delete(frame)
      return
    }
    groups.current.set(frame, group)
    if (lastFrames.current) placeObject(group, lastFrames.current.matrixOf(frame))
  }, [])

  return (
    <>
      <primitive object={links} />
      {shown.map((frame) => (
        <group key={frame} ref={(group) => attach(frame, group)} matrixAutoUpdate={false}>
          <axesHelper args={[POSE_AXIS_LENGTH_METERS]} />
          <Html
            className="pointer-events-none font-mono text-[11px] whitespace-nowrap text-foreground-secondary"
            style={{ transform: 'translate(4px, -50%)' }}
          >
            {frame}
          </Html>
        </group>
      ))}
    </>
  )
}

// 位姿: 在该时刻的位置与朝向画一组短坐标轴
function PoseLayer3d({ layer }: { layer: ScenePoseLayer }) {
  const axesRef = useRef<THREE.AxesHelper>(null)
  const place = useCallback<Placer>(
    (time, frames) => {
      const sample = layer.samples[indexAtOrBefore(layer.samples, time)]
      const base = sample ? frames.matrixOf(layer.frame) : null
      const pose =
        base &&
        new THREE.Matrix4()
          .compose(new THREE.Vector3(...sample.position), new THREE.Quaternion(...sample.orientation), new THREE.Vector3(1, 1, 1))
          .premultiply(base)
      placeObject(axesRef.current, pose)
    },
    [layer],
  )
  usePlacement(place)
  return <axesHelper ref={axesRef} args={[POSE_AXIS_LENGTH_METERS]} matrixAutoUpdate={false} />
}

// 点云与3D关键点: 该时刻的一帧点, 换帧时换几何的数据 (直接用换算好的Float32Array, 不复制)
function PointsLayer3d({ layer, color }: { layer: ScenePointsLayer; color: string }) {
  const pointsRef = useRef<THREE.Points>(null)
  const shownRef = useRef<PointsFrame | null>(null)
  const place = useCallback<Placer>(
    (time, frames) => {
      const object = pointsRef.current
      if (!object) return
      const sample = layer.samples[indexAtOrBefore(layer.samples, time)]
      placeObject(object, sample ? frames.matrixOf(sample.points.frame) : null)
      if (!sample || shownRef.current === sample.points) return
      shownRef.current = sample.points
      const { positions, colors } = sample.points
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      replaceGeometry(object, geometry)
      const material = object.material as THREE.PointsMaterial
      if (material.vertexColors !== (colors !== null)) {
        material.vertexColors = colors !== null
        material.color.set(colors ? 0xffffff : color)
        material.needsUpdate = true
      }
    },
    [layer, color],
  )
  usePlacement(place)
  return (
    <points ref={pointsRef} matrixAutoUpdate={false} frustumCulled={false}>
      <bufferGeometry />
      <pointsMaterial
        color={color}
        size={layer.kind === 'keypoints_3d' ? KEYPOINT_SIZE_PIXELS : POINT_SIZE_PIXELS}
        sizeAttenuation={false}
      />
    </points>
  )
}

/**
 * 3D场景里的一个空间图层: 坐标变换画TF树的坐标系, 位姿画坐标轴, 点云画点, 3D关键点画大点. 都取播放时刻当时或之前最近的一条,
 * 经TF树换算到基座标系, 换算不了的不画.
 */
export function SpatialLayer3d({ layer, color }: { layer: SceneLayer; color: string }) {
  if (layer.kind === 'transform') return <TransformLayer3d layer={layer} />
  if (layer.kind === 'pose') return <PoseLayer3d layer={layer} />
  return <PointsLayer3d layer={layer} color={color} />
}
