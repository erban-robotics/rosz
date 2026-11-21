import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  type DrawableSpatialLayer,
  type PoseSample,
  sampleAtOrBefore,
  samplePositions,
  type Vector3,
} from './spatial-layers'
import { type PlaybackClock, useClockListener } from '../playback/use-playback'

// 位姿与坐标变换的坐标轴长 (米), 比原点坐标轴短, 免得混淆
const POSE_AXIS_LENGTH_METERS = 0.06
// 点的屏幕尺寸 (像素), 不随远近缩放; 3D关键点画得大些
const POINT_SIZE_PIXELS = 3
const KEYPOINT_SIZE_PIXELS = 8

/**
 * 按播放时刻摆一个空间图层: 取当时或之前最近的一条交给`apply`, 再请求重画一帧, 不经React重渲.
 * `isActive`为false (面板被藏起) 时不重画, 恢复后补摆一次.
 */
function useSampleAtClock<Sample extends { time: number }>(
  samples: Sample[],
  clock: PlaybackClock,
  isActive: boolean,
  apply: (sample: Sample | null) => void,
) {
  const invalidate = useThree((state) => state.invalidate)
  const place = useCallback(
    (time: number) => {
      apply(sampleAtOrBefore(samples, time))
      invalidate()
    },
    [samples, apply, invalidate],
  )
  useEffect(() => {
    if (isActive) place(clock.getTime())
  }, [isActive, place, clock])
  useClockListener(clock, (time) => {
    if (isActive) place(time)
  })
}

// 坐标变换与位姿: 在该时刻的位置与朝向画一组短坐标轴
function AxesLayer({
  layer,
  clock,
  isActive,
}: {
  layer: Extract<DrawableSpatialLayer, { kind: 'transform' | 'pose' }>
  clock: PlaybackClock
  isActive: boolean
}) {
  const axesRef = useRef<THREE.AxesHelper>(null)
  const apply = useCallback((sample: PoseSample | null) => {
    const axes = axesRef.current
    if (!axes) return
    axes.visible = sample !== null
    if (!sample) return
    axes.position.set(...sample.position)
    axes.quaternion.set(...sample.orientation)
  }, [])
  useSampleAtClock(layer.samples, clock, isActive, apply)
  return <axesHelper ref={axesRef} args={[POSE_AXIS_LENGTH_METERS]} />
}

type PointsSample = { time: number; positions: Vector3[] }

// 点云与3D关键点: 该时刻的一帧点, 换帧时重写几何
function PointsLayer({
  samples,
  color,
  size,
  clock,
  isActive,
}: {
  samples: PointsSample[]
  color: string
  size: number
  clock: PlaybackClock
  isActive: boolean
}) {
  const pointsRef = useRef<THREE.Points>(null)
  const shownRef = useRef<PointsSample | null>(null)
  const apply = useCallback((sample: PointsSample | null) => {
    const points = pointsRef.current
    if (!points) return
    points.visible = sample !== null
    if (!sample || shownRef.current === sample) return
    shownRef.current = sample
    const positions = new Float32Array(sample.positions.length * 3)
    sample.positions.forEach((position, index) => positions.set(position, index * 3))
    points.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    points.geometry.computeBoundingSphere()
  }, [])
  useSampleAtClock(samples, clock, isActive, apply)
  return (
    <points ref={pointsRef}>
      <bufferGeometry />
      <pointsMaterial color={color} size={size} sizeAttenuation={false} />
    </points>
  )
}

/** 3D场景里的一个空间图层: 坐标变换与位姿画坐标轴, 点云画点, 3D关键点画大点. 都取播放时刻当时或之前最近的一条. */
export function SpatialLayer3d({
  layer,
  color,
  clock,
  isActive,
}: {
  layer: DrawableSpatialLayer
  color: string
  clock: PlaybackClock
  isActive: boolean
}) {
  const pointSamples = useMemo(
    () =>
      layer.kind === 'point_cloud' || layer.kind === 'keypoints_3d'
        ? layer.samples.map((sample) => ({ time: sample.time, positions: samplePositions(sample) }))
        : [],
    [layer],
  )
  if (layer.kind === 'transform' || layer.kind === 'pose')
    return <AxesLayer layer={layer} clock={clock} isActive={isActive} />
  return (
    <PointsLayer
      samples={pointSamples}
      color={color}
      size={layer.kind === 'keypoints_3d' ? KEYPOINT_SIZE_PIXELS : POINT_SIZE_PIXELS}
      clock={clock}
      isActive={isActive}
    />
  )
}
