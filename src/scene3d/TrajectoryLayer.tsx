import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { latestIndexAtOrBefore } from '../timeline/timeline'
import { type TcpTrack, TARGET_OPACITY } from './trajectory'
import { type PlaybackClock, useClockListener } from '../playback/use-playback'

const MARKER_RADIUS_METERS = 0.012
const MARKER_WIDTH_SEGMENTS = 16
const MARKER_HEIGHT_SEGMENTS = 12
// 整条轨迹的不透明度相对尾迹的比例: 整条淡显作背景, 尾迹实色
const FULL_TRACK_OPACITY_RATIO = 0.35

// 轨迹的有效点 (缺测点跳过) 与第k个采样点之前的有效点数; 直接写Float32Array, 不为每点建Vector3
function trackVertices(track: TcpTrack) {
  const positions = new Float32Array(track.points.length * 3)
  const countBefore = new Int32Array(track.points.length + 1)
  let count = 0
  track.points.forEach((point, index) => {
    countBefore[index] = count
    if (!point) return
    positions.set(point, count * 3)
    count += 1
  })
  countBefore[track.points.length] = count
  return { positions: positions.subarray(0, count * 3), countBefore }
}

function trackLine(positions: Float32Array, color: string, opacity: number) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity })
  return new THREE.Line(geometry, material)
}

/**
 * 3D场景里的轨迹图层: 整条轨迹淡显, 球标出当前时刻的位置 (取不晚于它的最近一点, 缺测处隐藏).
 * 尾迹: 自上次不连续起播放头走过的一段实色描出, 随播放增量延长; `discontinuity`一变即丢弃, 从当前播放头重新累积.
 * 播放时直接挪球, 改尾迹的绘制范围并请求重画一帧, 不经React重渲; `isActive`为false (面板被藏起) 时不重画, 恢复后补画一次.
 */
export function TrajectoryLayer({
  track,
  color,
  clock,
  discontinuity,
  isActive,
}: {
  track: TcpTrack
  color: string
  clock: PlaybackClock
  discontinuity: number
  isActive: boolean
}) {
  const invalidate = useThree((state) => state.invalidate)
  const { positions, countBefore } = useMemo(() => trackVertices(track), [track])
  const opacity = track.isTarget ? TARGET_OPACITY : 1
  const line = useMemo(
    () => trackLine(positions, color, opacity * FULL_TRACK_OPACITY_RATIO),
    [positions, color, opacity],
  )
  const trail = useMemo(() => trackLine(positions, color, opacity), [positions, color, opacity])
  const markerRef = useRef<THREE.Mesh>(null)
  // 尾迹起点: 最近一次不连续时播放头处的有效点序号; null即待从下一次摆放的播放头重新起
  const trailStartRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      for (const object of [line, trail]) {
        object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    },
    [line, trail],
  )

  const placeMarker = useCallback(
    (time: number) => {
      const marker = markerRef.current
      if (!marker) return
      const index = latestIndexAtOrBefore(track.times, time)
      const point = track.points[index]
      marker.visible = point !== null && point !== undefined
      if (point) marker.position.set(...point)
      const end = countBefore[index + 1]
      trailStartRef.current ??= Math.max(end - 1, 0)
      const start = Math.min(trailStartRef.current, end)
      trail.geometry.setDrawRange(start, Math.max(end - start, 0))
      invalidate()
    },
    [track, countBefore, trail, invalidate],
  )

  // 不连续或换了轨迹: 丢弃尾迹, 接着由下面的补摆从当前播放头重起
  useEffect(() => {
    trailStartRef.current = null
  }, [discontinuity, trail])

  useEffect(() => {
    if (isActive) placeMarker(clock.getTime())
  }, [discontinuity, isActive, placeMarker, clock])

  useClockListener(clock, (time) => {
    if (isActive) placeMarker(time)
  })

  return (
    <>
      <primitive object={line} />
      <primitive object={trail} />
      <mesh ref={markerRef}>
        <sphereGeometry args={[MARKER_RADIUS_METERS, MARKER_WIDTH_SEGMENTS, MARKER_HEIGHT_SEGMENTS]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </>
  )
}
