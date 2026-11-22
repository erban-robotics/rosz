import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { Component, type ComponentRef, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { type TcpTrack, TARGET_OPACITY, trackColor } from './trajectory'
import { sceneBounds } from './spatial-bounds'
import { type Placer, PlacementContext, placeObject, usePlacement } from './placement'
import type { SceneLayer, SceneTransformLayer } from './scene-layers'
import { SpatialLayer3d } from './SpatialLayer3d'
import { type FrameResolver, resolveFrames } from './tf-tree'
import { TrajectoryLayer } from './TrajectoryLayer'
import { type PlaybackClock, useClockListener } from '../playback/use-playback'
import { type SceneCamera, usePlaybackStore } from '../playback/store'

// 地面网格: 中线比面板底亮, 格线比面板底暗, 都零饱和 (面板底为surface-1)
const GRID_CENTER_LINE_COLOR = 0x696969
const GRID_LINE_COLOR = 0x292929
const AXIS_LENGTH_METERS = 0.1
const GRID_SIZE_METERS = 2
const GRID_DIVISIONS = 20
const CAMERA_FIELD_OF_VIEW_DEGREES = 45
const CAMERA_NEAR_METERS = 0.01
const CAMERA_FAR_METERS = 1000
// 取景: 从左后上方看向内容中心, 距离为包围球半径的倍数
const VIEW_DIRECTION = new THREE.Vector3(-1, -1, 0.8).normalize()
const VIEW_DISTANCE_FACTOR = 2.7
const MINIMUM_VIEW_RADIUS_METERS = 0.15
// 没给时的稳定空数组
const NO_LAYERS: SceneLayer[] = []
const NO_TRANSFORMS: SceneTransformLayer[] = []
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
 * 相机与环绕控制. 取景 (看向内容中心, 按包围球定距离) 只在`framing`变了 (换了图层或基座标系, 点了重新取景) 后内容首次非空时做一次,
 * 数据更新不复位视角; 包围盒也只在这时算 (`computeBounds`). 开了同步视角时, 拖动写入共享视角 (`usePlaybackStore`的`sceneCamera`),
 * 别的面板写入的视角照着摆; 刚打开同步时先跟上已有的共享视角.
 */
function CameraRig({
  framing,
  computeBounds,
  isActive,
  syncCamera,
}: {
  framing: string
  computeBounds: () => THREE.Box3
  isActive: boolean
  syncCamera: boolean
}) {
  const camera = useThree((state) => state.camera)
  const invalidate = useThree((state) => state.invalidate)
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const isApplyingRef = useRef(false)
  const framedRef = useRef<string | null>(null)
  const panelId = useId()

  const lookAt = useCallback(
    (center: THREE.Vector3, radius: number) => {
      const controls = controlsRef.current
      camera.position.copy(center).addScaledVector(VIEW_DIRECTION, radius * VIEW_DISTANCE_FACTOR)
      controls?.target.copy(center)
      controls?.update()
      invalidate()
    },
    [camera, invalidate],
  )

  // 还没有内容时先看着原点
  useEffect(() => {
    lookAt(new THREE.Vector3(), MINIMUM_VIEW_RADIUS_METERS)
  }, [lookAt])

  // 每次渲染只比一下取景键; 已按此键取过景即不再算包围盒
  useEffect(() => {
    if (framedRef.current === framing) return
    const bounds = computeBounds()
    if (bounds.isEmpty()) return
    framedRef.current = framing
    const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, MINIMUM_VIEW_RADIUS_METERS)
    lookAt(bounds.getCenter(new THREE.Vector3()), radius)
  })

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
 * 按播放时刻摆放: 每次解一次TF树 (换算到基座标系), 交给登记了的各图层, 再请求重画一帧, 不经React重渲.
 * `isActive`为false (面板被藏起) 时不摆不重画, 恢复后补摆一次. 场景内容 (图层, TF) 一变也补摆.
 */
function Placement({
  transforms,
  baseFrame,
  clock,
  isActive,
  onPlace,
  children,
}: {
  transforms: SceneTransformLayer[]
  baseFrame: string | null
  clock: PlaybackClock
  isActive: boolean
  // 每次摆放后报出该时刻的TF树 (取景用)
  onPlace: (frames: FrameResolver) => void
  children: ReactNode
}) {
  const invalidate = useThree((state) => state.invalidate)
  const placersRef = useRef(new Set<Placer>())
  const lastRef = useRef<{ time: number; frames: FrameResolver } | null>(null)
  const activeRef = useRef(isActive)
  useEffect(() => {
    activeRef.current = isActive
  })
  const place = useCallback(
    (time: number) => {
      const frames = resolveFrames(transforms, baseFrame, time)
      lastRef.current = { time, frames }
      onPlace(frames)
      for (const placer of placersRef.current) placer(time, frames)
      invalidate()
    },
    [transforms, baseFrame, invalidate, onPlace],
  )
  const context = useMemo(
    () => ({
      register(placer: Placer) {
        placersRef.current.add(placer)
        const last = lastRef.current
        if (last && activeRef.current) {
          placer(last.time, last.frames)
          invalidate()
        }
        return () => void placersRef.current.delete(placer)
      },
    }),
    [invalidate],
  )
  useEffect(() => {
    if (isActive) place(clock.getTime())
  }, [isActive, place, clock])
  useClockListener(clock, (time) => {
    if (isActive) place(time)
  })
  return <PlacementContext.Provider value={context}>{children}</PlacementContext.Provider>
}

// 轨迹按其坐标系经TF树摆放 (没声明坐标系的不换算), 换算不了的藏起
function TrackFrame({ frame, children }: { frame: string | null; children: ReactNode }) {
  const groupRef = useRef<THREE.Group>(null)
  const place = useCallback<Placer>(
    (_, frames) => placeObject(groupRef.current, frame === null ? new THREE.Matrix4() : frames.matrixOf(frame)),
    [frame],
  )
  usePlacement(place)
  return (
    <group ref={groupRef} matrixAutoUpdate={false}>
      {children}
    </group>
  )
}

// WebGL上下文建不起来等渲染出错只在3D视图内提示, 不波及整页; 换了图层后重试
class SceneBoundary extends Component<{ resetKey: string; children: ReactNode }, { error?: Error; resetKey: string }> {
  state: { error?: Error; resetKey: string } = { resetKey: this.props.resetKey }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { resetKey: string }) {
    return props.resetKey === state.resetKey ? null : { error: undefined, resetKey: props.resetKey }
  }
  render() {
    if (!this.state.error) return this.props.children
    return <p className="p-2 text-sm text-muted-foreground">3D视图无法显示: {this.state.error.message}</p>
  }
}

/**
 * 3D场景 (r3f): 地面网格与原点坐标轴, 叠末端轨迹图层与空间图层 (TF树, 位姿, 点云, 3D关键点); 可拖动旋转缩放,
 * 左下角列图例. 各图层按其坐标系经TF树 (`transforms`, 全部坐标变换图层, 不必都画) 换算到基座标系`baseFrame`, 换算不了的不画;
 * `baseFrame`为null时不换算. 取景只在换了图层或基座标系后做一次, 数据更新不复位视角, 右上角可重新取景.
 * 浏览器不支持WebGL或渲染出错时给出说明. 轨迹上自上次不连续 (跳转, 步进, 循环回绕, 切轴) 起走过的一段为尾迹, 实色描出.
 * 按需渲染 (`frameloop="demand"`): 播放, 拖动, 视角同步, 数据更新时才画一帧; `isActive`为false (所在面板被藏起) 时不随播放重画.
 * `syncCamera`为true时与其他开了同步的3D场景共用视角.
 */
export function Scene3d({
  tracks,
  layers = NO_LAYERS,
  transforms = NO_TRANSFORMS,
  baseFrame = null,
  clock,
  discontinuity = 0,
  isActive = true,
  syncCamera = false,
}: {
  tracks: TcpTrack[]
  layers?: SceneLayer[]
  transforms?: SceneTransformLayer[]
  baseFrame?: string | null
  clock: PlaybackClock
  // 数据源的不连续计数, 一变轨迹尾迹即从播放头重新累积
  discontinuity?: number
  isActive?: boolean
  syncCamera?: boolean
}) {
  const [isUnsupported] = useState(() => !isWebGLAvailable())
  const [reframes, setReframes] = useState(0)
  const lastFramesRef = useRef<FrameResolver | null>(null)
  const contentKey = [...tracks.map((track) => track.label), ...layers.map((layer) => layer.channel)].join('\n')
  const framing = `${baseFrame}\n${reframes}\n${contentKey}`
  const tracksRef = useRef(tracks)
  const layersRef = useRef(layers)
  useEffect(() => {
    tracksRef.current = tracks
    layersRef.current = layers
  })
  const onPlace = useCallback((frames: FrameResolver) => {
    lastFramesRef.current = frames
  }, [])
  // 取景时刻的TF树 (最近一次摆放的); 还没摆过按当前播放时刻解
  const computeBounds = useCallback(
    () =>
      sceneBounds(
        tracksRef.current,
        layersRef.current,
        lastFramesRef.current ?? resolveFrames(transforms, baseFrame, clock.getTime()),
      ),
    [transforms, baseFrame, clock],
  )

  if (tracks.length === 0 && layers.length === 0)
    return <p className="text-sm text-muted-foreground">没有可画的末端位置序列或空间图层</p>
  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden rounded-md border bg-surface-1">
      {isUnsupported ? (
        <p className="p-2 text-sm text-muted-foreground">浏览器不支持WebGL, 无法显示3D视图</p>
      ) : (
        <SceneBoundary resetKey={contentKey}>
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
            <Placement
              transforms={transforms}
              baseFrame={baseFrame}
              clock={clock}
              isActive={isActive}
              onPlace={onPlace}
            >
              {tracks.map((track, index) => (
                <TrackFrame key={track.label} frame={track.frame}>
                  <TrajectoryLayer
                    track={track}
                    color={trackColor(index)}
                    clock={clock}
                    discontinuity={discontinuity}
                    isActive={isActive}
                  />
                </TrackFrame>
              ))}
              {layers.map((layer, index) => (
                <SpatialLayer3d key={layer.channel} layer={layer} color={trackColor(tracks.length + index)} />
              ))}
            </Placement>
            <CameraRig framing={framing} computeBounds={computeBounds} isActive={isActive} syncCamera={syncCamera} />
          </Canvas>
        </SceneBoundary>
      )}
      {!isUnsupported && (
        <button
          type="button"
          className="press absolute top-1 left-2 rounded-sm border border-transparent px-1.5 py-0.5 text-xs text-foreground-tertiary hover:text-foreground"
          onClick={() => setReframes((count) => count + 1)}
        >
          重新取景
        </button>
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
        {layers.map((layer, index) => (
          <li key={layer.channel} className="flex items-center gap-1">
            <span className="inline-block size-1.5 rounded-full" style={{ background: trackColor(tracks.length + index) }} />
            <span className="font-mono">{layer.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
