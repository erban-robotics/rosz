import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { type ComponentRef, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { type TcpTrack, TARGET_OPACITY, trackBounds, trackColor } from './trajectory'
import { spatialBounds } from './spatial-bounds'
import { type DrawableSpatialLayer, spatialLabel } from './spatial-layers'
import { SpatialLayer3d } from './SpatialLayer3d'
import { TrajectoryLayer } from './TrajectoryLayer'
import type { PlaybackClock } from '../playback/use-playback'
import { type SceneCamera, usePlaybackStore } from '../playback/store'

// 地面网格: 中线比面板底亮, 格线比面板底暗, 都零饱和 (面板底为surface-1)
const GRID_CENTER_LINE_COLOR = 0x696969
const GRID_LINE_COLOR = 0x292929
const AXIS_LENGTH_METERS = 0.1
const GRID_SIZE_METERS = 2
const GRID_DIVISIONS = 20
const CAMERA_FIELD_OF_VIEW_DEGREES = 45
const CAMERA_NEAR_METERS = 0.01
const CAMERA_FAR_METERS = 100
// 取景: 从左后上方看向轨迹中心, 距离为包围球半径的倍数
const VIEW_DIRECTION = new THREE.Vector3(-1, -1, 0.8).normalize()
const VIEW_DISTANCE_FACTOR = 2.7
const MINIMUM_VIEW_RADIUS_METERS = 0.15
// 没给空间图层时的稳定空数组, 取景的useMemo不必每次重算
const NO_SPATIAL_LAYERS: DrawableSpatialLayer[] = []
// 场景z轴朝上
const SCENE_UP: [number, number, number] = [0, 0, 1]

function isWebGLAvailable() {
  const canvas = document.createElement('canvas')
  try {
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function toTuple(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z]
}

/**
 * 相机与环绕控制: 轨迹变了即重新取景. 开了同步视角时, 拖动写入共享视角 (`usePlaybackStore`的`sceneCamera`),
 * 别的面板写入的视角照着摆; 刚打开同步时先跟上已有的共享视角.
 */
function CameraRig({
  center,
  radius,
  isActive,
  syncCamera,
}: {
  center: THREE.Vector3
  radius: number
  isActive: boolean
  syncCamera: boolean
}) {
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const isApplyingRef = useRef(false)
  const panelId = useId()

  useEffect(() => {
    const controls = controlsRef.current
    camera.position.copy(center).addScaledVector(VIEW_DIRECTION, radius * VIEW_DISTANCE_FACTOR)
    controls?.target.copy(center)
    controls?.update()
    invalidate()
  }, [camera, center, radius, invalidate])

  useEffect(() => {
    if (!syncCamera) return
    const apply = (pose: SceneCamera | null) => {
      const controls = controlsRef.current
      if (!pose || pose.sourceId === panelId || !controls) return
      isApplyingRef.current = true
      camera.position.set(...pose.position)
      controls.target.set(...pose.target)
      controls.update()
      isApplyingRef.current = false
      if (isActive) invalidate()
    }
    apply(usePlaybackStore.getState().sceneCamera)
    return usePlaybackStore.subscribe((state, previous) => {
      if (state.sceneCamera !== previous.sceneCamera) apply(state.sceneCamera)
    })
  }, [syncCamera, camera, panelId, isActive, invalidate])

  const onChange = () => {
    const controls = controlsRef.current
    if (!syncCamera || isApplyingRef.current || !controls) return
    usePlaybackStore.getState().setSceneCamera({
      position: toTuple(camera.position),
      target: toTuple(controls.target),
      sourceId: panelId,
    })
  }

  return <OrbitControls ref={controlsRef} makeDefault onChange={onChange} />
}

/**
 * 3D场景 (r3f): 地面网格与原点坐标轴, 叠末端轨迹图层与空间图层 (坐标变换, 位姿, 点云, 3D关键点); 可拖动旋转缩放,
 * 左下角列图例. 浏览器不支持WebGL时给出说明. 轨迹上自上次不连续 (跳转, 步进, 循环回绕, 切轴) 起走过的一段为尾迹, 实色描出.
 * 按需渲染 (`frameloop="demand"`): 播放, 拖动, 视角同步时才画一帧; `isActive`为false (所在面板被藏起) 时不随播放重画.
 * `syncCamera`为true时与其他开了同步的3D场景共用视角.
 */
export function Scene3d({
  tracks,
  spatialLayers = NO_SPATIAL_LAYERS,
  clock,
  discontinuity = 0,
  isActive = true,
  syncCamera = false,
}: {
  tracks: TcpTrack[]
  spatialLayers?: DrawableSpatialLayer[]
  clock: PlaybackClock
  // 数据源的不连续计数, 一变轨迹尾迹即从播放头重新累积
  discontinuity?: number
  isActive?: boolean
  syncCamera?: boolean
}) {
  const [isUnsupported] = useState(() => !isWebGLAvailable())
  const { center, radius } = useMemo(() => {
    const bounds = spatialBounds(spatialLayers, trackBounds(tracks))
    if (bounds.isEmpty()) return { center: new THREE.Vector3(), radius: MINIMUM_VIEW_RADIUS_METERS }
    return {
      center: bounds.getCenter(new THREE.Vector3()),
      radius: Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, MINIMUM_VIEW_RADIUS_METERS),
    }
  }, [tracks, spatialLayers])

  if (tracks.length === 0 && spatialLayers.length === 0)
    return <p className="text-sm text-muted-foreground">没有可画的末端位置序列或空间图层</p>
  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden rounded-md border bg-surface-1">
      {isUnsupported ? (
        <p className="p-2 text-sm text-muted-foreground">浏览器不支持WebGL, 无法显示3D视图</p>
      ) : (
        <Canvas
          className="absolute inset-0"
          frameloop="demand"
          gl={{ antialias: true, alpha: true }}
          camera={{
            fov: CAMERA_FIELD_OF_VIEW_DEGREES,
            near: CAMERA_NEAR_METERS,
            far: CAMERA_FAR_METERS,
            up: SCENE_UP,
          }}
        >
          <gridHelper
            args={[GRID_SIZE_METERS, GRID_DIVISIONS, GRID_CENTER_LINE_COLOR, GRID_LINE_COLOR]}
            rotation-x={Math.PI / 2}
          />
          <axesHelper args={[AXIS_LENGTH_METERS]} />
          {tracks.map((track, index) => (
            <TrajectoryLayer
              key={track.label}
              track={track}
              color={trackColor(index)}
              clock={clock}
              discontinuity={discontinuity}
              isActive={isActive}
            />
          ))}
          {spatialLayers.map((layer, index) => (
            <SpatialLayer3d
              key={layer.channel}
              layer={layer}
              color={trackColor(tracks.length + index)}
              clock={clock}
              isActive={isActive}
            />
          ))}
          <CameraRig center={center} radius={radius} isActive={isActive} syncCamera={syncCamera} />
        </Canvas>
      )}
      <ul className="pointer-events-none absolute bottom-1 left-2 flex flex-wrap gap-x-3 text-xs">
        {tracks.map((track, index) => (
          <li key={track.label} className="flex items-center gap-1">
            <span
              className="inline-block h-0.5 w-3 rounded"
              style={{ background: trackColor(index), opacity: track.isTarget ? TARGET_OPACITY : 1 }}
            />
            <span className="font-mono">{track.label}</span>
          </li>
        ))}
        {spatialLayers.map((layer, index) => (
          <li key={layer.channel} className="flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full" style={{ background: trackColor(tracks.length + index) }} />
            <span className="font-mono">{spatialLabel(layer)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
