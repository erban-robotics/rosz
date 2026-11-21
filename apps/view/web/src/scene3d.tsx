/**
 * 查看器的 3D 面板 (r3f): TF 树里的坐标系画成坐标轴 + 名字 + 指向父坐标系的连线, 点云按它的坐标系经 TF 换算后画点.
 * 一切换算到 "固定坐标系" (默认为最大那棵 TF 树的根, 可选), 地面网格画在它的 xy 平面上. 不在同一棵树上的点云不画并标出.
 * TF 取各边最新的一条 (不按点云时间戳插值). 视角只在打开时摆一次, 之后随人拖动, 数据更新不复位.
 *
 * 话题: 选中的 TF 话题画它给的坐标系; 点云要换算坐标, 所以只要面板开着就订阅全部 TF 话题 (自设需求窗口).
 * rosz-ui 的 3D 场景缺什么见 scene.ts 开头.
 */
import { Html, OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import { type ChannelInfo, type DataSource } from '@erban-robotics/rosz-ui'
import { useEffect, useId, useMemo, useState } from 'react'
import * as THREE from 'three'
import { type Edge, POINT_CLOUD2, type Scene, TF_MESSAGE } from './scene'

const AXIS_LENGTH_METERS = 0.15
const GRID_SIZE_METERS = 10
const GRID_DIVISIONS = 20
const GRID_CENTER_LINE_COLOR = 0x696969
const GRID_LINE_COLOR = 0x292929
const LINK_COLOR = 0x8a8a8a
const POINT_SIZE_PIXELS = 2
// TF 链的最大深度: 超过即认为成环, 该坐标系不画
const MAX_CHAIN = 64
// 没有颜色字段的点云按序取色
const CLOUD_COLORS = ['#4fc3f7', '#ffb74d', '#81c784', '#e57373', '#ba68c8']

type Pose = { root: string; matrix: THREE.Matrix4 }

/** 各坐标系在其树根下的位姿; 成环的不在结果里 */
function resolvePoses(edges: ReadonlyMap<string, Edge>) {
  const poses = new Map<string, Pose>()
  const poseOf = (frame: string, depth: number): Pose | null => {
    const known = poses.get(frame)
    if (known) return known
    const edge = edges.get(frame)
    if (!edge) {
      const pose = { root: frame, matrix: new THREE.Matrix4() }
      poses.set(frame, pose)
      return pose
    }
    if (depth > MAX_CHAIN) return null
    const parent = poseOf(edge.parent, depth + 1)
    if (!parent) return null
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...edge.translation),
      new THREE.Quaternion(...edge.rotation).normalize(),
      new THREE.Vector3(1, 1, 1),
    )
    const pose = { root: parent.root, matrix: parent.matrix.clone().multiply(local) }
    poses.set(frame, pose)
    return pose
  }
  for (const frame of edges.keys()) poseOf(frame, 0)
  return poses
}

/** 默认固定坐标系: 坐标系最多的那棵树的根 (同样多取名字靠前的) */
function largestRoot(poses: Map<string, Pose>) {
  const sizes = new Map<string, number>()
  for (const { root } of poses.values()) sizes.set(root, (sizes.get(root) ?? 0) + 1)
  return [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
}

/** 数据一变就在下一动画帧重渲一次 */
function useSceneVersion(scene: Scene) {
  const [version, setVersion] = useState(scene.version())
  useEffect(() => {
    let handle = 0
    const stop = scene.subscribe(() => {
      if (!handle)
        handle = requestAnimationFrame(() => {
          handle = 0
          setVersion(scene.version())
        })
    })
    return () => {
      stop()
      cancelAnimationFrame(handle)
    }
  }, [scene])
  return version
}

function FrameAxes({ name, matrix }: { name: string; matrix: THREE.Matrix4 }) {
  return (
    <group matrix={matrix} matrixAutoUpdate={false}>
      <axesHelper args={[AXIS_LENGTH_METERS]} />
      <Html className="pointer-events-none font-mono text-[11px] whitespace-nowrap text-foreground-secondary" style={{ transform: 'translate(4px, -50%)' }}>
        {name}
      </Html>
    </group>
  )
}

function Links({ segments }: { segments: number[] }) {
  const key = segments.join(',')
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(key ? key.split(',').map(Number) : []), 3))
    return geometry
  }, [key])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={LINK_COLOR} />
    </lineSegments>
  )
}

function CloudPoints({ positions, colors, color, matrix }: { positions: Float32Array; colors: Float32Array | null; color: string; matrix: THREE.Matrix4 }) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    return geometry
  }, [positions, colors])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <points geometry={geometry} matrix={matrix} matrixAutoUpdate={false}>
      <pointsMaterial size={POINT_SIZE_PIXELS} sizeAttenuation={false} vertexColors={colors !== null} color={colors ? 0xffffff : color} />
    </points>
  )
}

export default function ScenePanel({
  dataSource,
  scene,
  topics,
  catalog,
}: {
  dataSource: DataSource
  scene: Scene
  // 面板里选的空间话题名
  topics: string[]
  catalog: ChannelInfo[]
}) {
  const { state } = dataSource
  const panelId = useId()
  const tfTopics = catalog.filter((channel) => channel.type === TF_MESSAGE && !channel.undecodable).map((channel) => channel.name)
  const cloudTopics = catalog
    .filter((channel) => channel.type === POINT_CLOUD2 && !channel.undecodable && topics.includes(channel.name))
    .map((channel) => channel.name)
  const key = [...new Set([...tfTopics, ...cloudTopics])].join('\n')
  useEffect(() => {
    state.setDemand(panelId, key ? { channels: key.split('\n'), range: { start: 0n, end: 0n } } : null)
  }, [state, panelId, key])
  useEffect(() => () => state.setDemand(panelId, null), [state, panelId])

  const version = useSceneVersion(scene)
  const [chosenFixed, setChosenFixed] = useState<string | null>(null)
  // version 一变即 TF 树变了, 须重算
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poses = useMemo(() => resolvePoses(scene.edges()), [scene, version])
  const frames = [...poses.keys()].sort()
  const fixed = chosenFixed !== null && poses.has(chosenFixed) ? chosenFixed : largestRoot(poses)
  const fixedPose = fixed === null ? null : poses.get(fixed)!
  const inverse = fixedPose ? fixedPose.matrix.clone().invert() : new THREE.Matrix4()
  const inFixed = (frame: string) => {
    const pose = poses.get(frame)
    return pose && fixedPose && pose.root === fixedPose.root ? inverse.clone().multiply(pose.matrix) : null
  }

  // 选中的 TF 话题给的坐标系, 及其父坐标系 (树根没有边, 跟着子坐标系画)
  const edges = scene.edges()
  const shown = new Set<string>()
  for (const [child, edge] of edges)
    if (topics.includes(edge.topic)) {
      shown.add(child)
      shown.add(edge.parent)
    }
  const drawnFrames = [...shown].sort().flatMap((frame) => {
    const matrix = inFixed(frame)
    return matrix ? [{ frame, matrix }] : []
  })
  const linkPoints: number[] = []
  for (const { frame, matrix } of drawnFrames) {
    const parent = edges.get(frame)?.parent
    const parentMatrix = parent && shown.has(parent) ? inFixed(parent) : null
    if (!parentMatrix) continue
    linkPoints.push(...new THREE.Vector3().setFromMatrixPosition(parentMatrix).toArray())
    linkPoints.push(...new THREE.Vector3().setFromMatrixPosition(matrix).toArray())
  }

  const notes: string[] = []
  const clouds = cloudTopics.flatMap((topic, index) => {
    const cloud = scene.cloud(topic)
    if (!cloud) {
      notes.push(`${topic} 等待数据`)
      return []
    }
    // 没有 TF 时按点云自身坐标系画
    const matrix = fixed === null ? new THREE.Matrix4() : inFixed(cloud.frame)
    if (!matrix) {
      notes.push(`${topic} 的坐标系 ${cloud.frame || '(空)'} 不在 ${fixed ?? '固定坐标系'} 的 TF 树上, 未画`)
      return []
    }
    if (cloud.positions.length / 3 < cloud.total) notes.push(`${topic} 抽取 ${cloud.positions.length / 3} / ${cloud.total} 点`)
    return [{ topic, cloud, matrix, color: CLOUD_COLORS[index % CLOUD_COLORS.length] }]
  })
  for (const topic of topics)
    if (tfTopics.includes(topic) && ![...edges.values()].some((edge) => edge.topic === topic)) notes.push(`${topic} 等待数据`)

  return (
    <section aria-label="3D" className="flex h-full min-h-0 flex-col gap-1 rounded-md border bg-surface-1 p-1 text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
        <span className="text-foreground">3D</span>
        {frames.length > 0 && (
          <label className="flex items-center gap-1 text-foreground-secondary">
            固定坐标系
            <select
              aria-label="固定坐标系"
              className="rounded-sm border bg-surface-2 px-1 font-mono text-foreground"
              value={fixed ?? ''}
              onChange={(event) => setChosenFixed(event.target.value)}
            >
              {frames.map((frame) => (
                <option key={frame} value={frame}>
                  {frame}
                </option>
              ))}
            </select>
          </label>
        )}
        {notes.length > 0 && (
          <p role="status" className="text-foreground-tertiary">
            {notes.join('; ')}
          </p>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm">
        <Canvas
          className="absolute inset-0"
          frameloop="demand"
          gl={{ antialias: true, alpha: true }}
          camera={{ fov: 45, near: 0.01, far: 1000, up: [0, 0, 1], position: [-3, -3, 2.5] }}
        >
          <gridHelper args={[GRID_SIZE_METERS, GRID_DIVISIONS, GRID_CENTER_LINE_COLOR, GRID_LINE_COLOR]} rotation-x={Math.PI / 2} />
          {drawnFrames.map(({ frame, matrix }) => (
            <FrameAxes key={frame} name={frame} matrix={matrix} />
          ))}
          {linkPoints.length > 0 && <Links segments={linkPoints} />}
          {clouds.map(({ topic, cloud, matrix, color }) => (
            <CloudPoints key={topic} positions={cloud.positions} colors={cloud.colors} color={color} matrix={matrix} />
          ))}
          <OrbitControls makeDefault />
        </Canvas>
      </div>
    </section>
  )
}
