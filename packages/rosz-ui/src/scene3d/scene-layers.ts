/**
 * 空间通道 (目录项 + 状态里的样本) -> 3D场景画的图层. 样本内容可为:
 * - 坐标变换: `PoseSample` (单个变换, 父子坐标系取目录的`frame` `childFrame`), `TransformsSample` (一条多个), `TFMessage`的CDR
 * - 位姿: `PoseSample` (坐标系取目录的`frame`)
 * - 点云: `PointCloudSample` (点为三元组数组), `PackedPointCloudSample` (Float32Array), `PointCloud2`的CDR; 坐标系取样本自带的,
 *   没有取目录的`frame`
 * - 3D关键点: `Keypoints3dSample`
 * 时刻取内容的`time` (会话时间轴秒数), 没有取样本在当前轴上的时刻. 每条内容只换算一次 (按内容对象缓存), 实时数据更新时
 * 不重算已有样本, 点云也不复制. 纯TS, 不依赖three.
 */
import { secondsAt } from '../data-source/clock'
import { onAxis } from '../data-source/time-axis'
import type { ChannelInfo, MessagePayload, Sample, TimeAxis } from '../data-source/types'
import type { Rosz } from '../message/rosz'
import { frameName, fromPointCloud2, fromTfMessage, rosSpatialKind } from './ros-spatial'
import {
  isSpatialKind,
  type PoseSample,
  type SpatialKind,
  type TransformEdge,
} from './spatial-layers'

// 一帧点 (点云或3D关键点), 换算后的同一对象在多次构建间复用, 场景按引用判断换没换帧
export type PointsFrame = { frame: string; positions: Float32Array; colors: Float32Array | null; total: number }

type LayerBase = { channel: string; name: string; label: string }
export type SceneTransformLayer = LayerBase & {
  kind: 'transform'
  samples: { time: number; transforms: TransformEdge[] }[]
}
export type ScenePoseLayer = LayerBase & { kind: 'pose'; frame: string; samples: PoseSample[] }
export type ScenePointsLayer = LayerBase & {
  kind: 'point_cloud' | 'keypoints_3d'
  samples: { time: number; points: PointsFrame }[]
}
/** 场景画的一个图层, 样本按时刻升序 */
export type SceneLayer = SceneTransformLayer | ScenePoseLayer | ScenePointsLayer

/** 通道的空间种类: 目录`type`为空间种类或能画的ROS类型 (`TFMessage` `PointCloud2`); 不是空间通道为null */
export function spatialKindOf(channel: ChannelInfo): SpatialKind | null {
  if (channel.kind !== 'spatial') return null
  return isSpatialKind(channel.type) ? channel.type : rosSpatialKind(channel.type)
}

type Content = { transforms: TransformEdge[] } | { points: PointsFrame } | { pose: PoseSample } | { issue: string }
type Properties = { frame?: string; childFrame?: string }

// 内容对象 -> 换算结果; 与通道的说明 (坐标系) 有关的部分按说明另记一层
const contentCache = new WeakMap<object, { key: string; content: Content }>()

function isCdr(payload: unknown): payload is MessagePayload {
  return typeof payload === 'object' && payload !== null && (payload as MessagePayload).encoding === 'cdr'
}

function packPoints(points: [number, number, number][]) {
  const positions = new Float32Array(points.length * 3)
  points.forEach((point, index) => positions.set(point, index * 3))
  return positions
}

function convert(kind: SpatialKind, channel: ChannelInfo, payload: Record<string, unknown>, rosz: Rosz): Content {
  const properties = (channel.properties ?? {}) as Properties
  const frame = properties.frame ? frameName(properties.frame) : null
  const noFrame = { issue: '没有给坐标系' }
  if (isCdr(payload)) {
    const { tree } = rosz.decoder.decode(channel.type ?? '', payload.data) as { tree: Record<string, unknown> }
    if (kind === 'transform') return { transforms: fromTfMessage(tree) }
    const cloud = fromPointCloud2(tree)
    return 'issue' in cloud ? cloud : { points: cloud }
  }
  if (kind === 'transform') {
    if (Array.isArray(payload.transforms)) {
      const transforms = (payload.transforms as TransformEdge[]).map((edge) => ({
        ...edge,
        parent: frameName(edge.parent),
        child: frameName(edge.child),
      }))
      return { transforms }
    }
    if (!frame) return noFrame
    const pose = payload as unknown as PoseSample
    const child = frameName(properties.childFrame || channel.name)
    return { transforms: [{ parent: frame, child, translation: pose.position, rotation: pose.orientation }] }
  }
  if (kind === 'pose') return frame ? { pose: payload as unknown as PoseSample } : noFrame
  const ownFrame = typeof payload.frame === 'string' && payload.frame ? frameName(payload.frame) : frame
  if (!ownFrame) return noFrame
  if (payload.positions instanceof Float32Array) {
    const positions = payload.positions
    const colors = payload.colors instanceof Float32Array ? payload.colors : null
    const total = typeof payload.total === 'number' ? payload.total : positions.length / 3
    return { points: { frame: ownFrame, positions, colors, total } }
  }
  const points = (payload.points as ([number, number, number] | { position: [number, number, number] })[]).map((point) =>
    Array.isArray(point) ? point : point.position,
  )
  return { points: { frame: ownFrame, positions: packPoints(points), colors: null, total: points.length } }
}

/**
 * 一个空间通道的样本 -> 场景图层. `rosz`为已加载的解码模块, 没加载完时CDR样本先跳过 (`isWaitingDecoder`为true).
 * 解不了或形状不对的样本跳过, 原因记入`issue`. 没有可画的样本时`layer`为null
 */
export function buildSceneLayer(
  channel: ChannelInfo,
  samples: Sample[],
  { axis, zero, rosz }: { axis: TimeAxis; zero: bigint; rosz: Rosz | null },
): { layer: SceneLayer | null; issue: string | null; isWaitingDecoder: boolean } {
  const kind = spatialKindOf(channel)
  if (!kind) return { layer: null, issue: `未知的空间种类${channel.type ?? ''}`, isWaitingDecoder: false }
  const properties = (channel.properties ?? {}) as Properties
  const key = `${channel.type}\n${properties.frame ?? ''}\n${properties.childFrame ?? ''}\n${channel.name}`
  let issue: string | null = null
  let isWaitingDecoder = false
  const converted: { time: number; content: Content }[] = []
  for (const sample of samples) {
    const payload = sample.payload as Record<string, unknown>
    if (typeof payload !== 'object' || payload === null) continue
    let cached = contentCache.get(payload)
    if (!cached || cached.key !== key) {
      if (isCdr(payload) && !rosz) {
        isWaitingDecoder = true
        continue
      }
      let content: Content
      try {
        content = convert(kind, channel, payload, rosz!)
      } catch (reason) {
        content = { issue: reason instanceof Error ? reason.message : String(reason) }
      }
      cached = { key, content }
      contentCache.set(payload, cached)
    }
    if ('issue' in cached.content) {
      issue = cached.content.issue
      continue
    }
    const ownTime = (sample.payload as { time?: unknown }).time
    const time =
      typeof ownTime === 'number'
        ? ownTime
        : secondsAt(zero, onAxis(axis, sample.receiveTime, sample.sampleTime) ?? sample.receiveTime)
    converted.push({ time, content: cached.content })
  }
  converted.sort((first, second) => first.time - second.time)
  if (converted.length === 0) return { layer: null, issue, isWaitingDecoder }
  const base = { channel: channel.id, name: channel.name }
  let layer: SceneLayer
  if (kind === 'transform') {
    const single = isSpatialKind(channel.type) && properties.frame && properties.childFrame
    const label = single ? `${properties.frame}->${properties.childFrame}` : channel.name
    layer = {
      ...base,
      label,
      kind,
      samples: converted.map(({ time, content }) => ({ time, transforms: (content as { transforms: TransformEdge[] }).transforms })),
    }
  } else if (kind === 'pose') {
    layer = {
      ...base,
      label: channel.name,
      kind,
      frame: frameName(properties.frame ?? ''),
      samples: converted.map(({ time, content }) => ({ ...(content as { pose: PoseSample }).pose, time })),
    }
  } else {
    layer = {
      ...base,
      label: channel.name,
      kind,
      samples: converted.map(({ time, content }) => ({ time, points: (content as { points: PointsFrame }).points })),
    }
  }
  return { layer, issue, isWaitingDecoder }
}

/** 图层里时刻不晚于`time`的最近一条的下标; 早于第一条为-1 (二分) */
export function indexAtOrBefore(samples: { time: number }[], time: number) {
  let low = 0
  let high = samples.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (samples[middle].time <= time) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** 图层画在哪个坐标系 (坐标变换为null, 各边各有父坐标系); 点云取最新一帧的 */
export function layerFrame(layer: SceneLayer): string | null {
  if (layer.kind === 'transform') return null
  if (layer.kind === 'pose') return layer.frame
  return layer.samples.at(-1)!.points.frame
}
