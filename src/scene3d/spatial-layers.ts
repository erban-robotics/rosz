/**
 * 3D场景的空间图层: 坐标变换 (TF), 位姿, 点云, 3D关键点. 空间通道 (`kind: 'spatial'`, `type`为下列种类) 的样本内容为各种类的一条
 * (`PoseSample` `PointCloudSample` `Keypoints3dSample`, 时刻为会话时间轴秒数); 场景按播放时刻取当时或之前最近的一条, 第一条之前不画.
 *
 * 离线数据的JSON内容形状 (逐条带`time_s`, 相对数据原点) 也在这里约定, 适配器用`parseSpatialContent`解析, 产出方按此形状写.
 */
import { z } from 'zod'
import { latestIndexAtOrBefore } from '../timeline/timeline'

export const SPATIAL_LAYER_KINDS = ['transform', 'pose', 'point_cloud', 'keypoints_3d'] as const

export type Vector3 = [number, number, number]
// 四元数, 顺序为x, y, z, w
export type Quaternion = [number, number, number, number]

const vector3 = z.tuple([z.number(), z.number(), z.number()])
const quaternion = z.tuple([z.number(), z.number(), z.number(), z.number()])
const frameName = z.string().min(1)

const TransformContentSchema = z.object({
  parent_frame: frameName,
  child_frame: frameName,
  samples: z.array(z.object({ time_s: z.number(), translation: vector3, rotation: quaternion })),
})
const PoseContentSchema = z.object({
  frame: frameName,
  samples: z.array(z.object({ time_s: z.number(), position: vector3, orientation: quaternion })),
})
const PointCloudContentSchema = z.object({
  frame: frameName,
  frames: z.array(z.object({ time_s: z.number(), points: z.array(vector3) })),
})
const Keypoints3dContentSchema = z.object({
  frame: frameName,
  frames: z.array(
    z.object({
      time_s: z.number(),
      points: z.array(z.object({ label: z.string().optional(), position: vector3 })),
    }),
  ),
})

export type PoseSample = { time: number; position: Vector3; orientation: Quaternion }
export type PointCloudSample = { time: number; points: Vector3[] }
export type Keypoints3dSample = { time: number; points: { label?: string; position: Vector3 }[] }

// `frame`为数据所在的坐标系 (坐标变换取父坐标系), 场景只画与基座标系相符的
type SpatialCommon = { channel: string; name: string; frame: string }
export type SpatialLayer =
  | (SpatialCommon & { kind: 'transform'; childFrame: string; samples: PoseSample[] })
  | (SpatialCommon & { kind: 'pose'; samples: PoseSample[] })
  | (SpatialCommon & { kind: 'point_cloud'; samples: PointCloudSample[] })
  | (SpatialCommon & { kind: 'keypoints_3d'; samples: Keypoints3dSample[] })
  | (SpatialCommon & { kind: 'invalid'; issue: string })
export type DrawableSpatialLayer = Exclude<SpatialLayer, { kind: 'invalid' }>

export type SpatialKind = (typeof SPATIAL_LAYER_KINDS)[number]

export function isSpatialKind(kind: string | null | undefined): kind is SpatialKind {
  return (SPATIAL_LAYER_KINDS as readonly string[]).includes(kind ?? '')
}

function byTime<Sample extends { time: number }>(samples: Sample[]) {
  return [...samples].sort((first, second) => first.time - second.time)
}

/**
 * 一份空间内容JSON -> 对齐到会话时间轴的空间图层 (`offset`为数据原点在会话时间轴上的秒数); 不合形状的标为invalid, 面板据此提示.
 * 适配器把结果的说明 (种类, 坐标系) 写进通道目录, 样本写成空间通道.
 */
export function parseSpatialContent(
  kind: SpatialKind,
  content: unknown,
  offset: number,
  base: { channel: string; name: string },
): SpatialLayer {
  const invalid = (issues: z.core.$ZodIssue[]): SpatialLayer => ({
    ...base,
    kind: 'invalid',
    frame: '',
    issue: issues[0]?.message ?? '',
  })
  if (kind === 'transform') {
    const parsed = TransformContentSchema.safeParse(content)
    if (!parsed.success) return invalid(parsed.error.issues)
    const samples = parsed.data.samples.map((sample) => ({
      time: sample.time_s + offset,
      position: sample.translation,
      orientation: sample.rotation,
    }))
    const { parent_frame: frame, child_frame: childFrame } = parsed.data
    return { ...base, kind: 'transform', frame, childFrame, samples: byTime(samples) }
  }
  if (kind === 'pose') {
    const parsed = PoseContentSchema.safeParse(content)
    if (!parsed.success) return invalid(parsed.error.issues)
    const samples = parsed.data.samples.map((sample) => ({
      time: sample.time_s + offset,
      position: sample.position,
      orientation: sample.orientation,
    }))
    return { ...base, kind: 'pose', frame: parsed.data.frame, samples: byTime(samples) }
  }
  if (kind === 'point_cloud') {
    const parsed = PointCloudContentSchema.safeParse(content)
    if (!parsed.success) return invalid(parsed.error.issues)
    const samples = parsed.data.frames.map((frame) => ({ time: frame.time_s + offset, points: frame.points }))
    return { ...base, kind: 'point_cloud', frame: parsed.data.frame, samples: byTime(samples) }
  }
  const parsed = Keypoints3dContentSchema.safeParse(content)
  if (!parsed.success) return invalid(parsed.error.issues)
  const samples = parsed.data.frames.map((frame) => ({ time: frame.time_s + offset, points: frame.points }))
  return { ...base, kind: 'keypoints_3d', frame: parsed.data.frame, samples: byTime(samples) }
}

// 播放时刻当时或之前最近的一条; 早于第一条为null
export function sampleAtOrBefore<Sample extends { time: number }>(samples: Sample[], time: number): Sample | null {
  const index = latestIndexAtOrBefore(
    samples.map((sample) => sample.time),
    time,
  )
  return index < 0 ? null : samples[index]
}

// 一条里的全部点位置, 取景与画点用
export function samplePositions(sample: DrawableSpatialLayer['samples'][number]): Vector3[] {
  if ('position' in sample) return [sample.position]
  return sample.points.map((point) => (Array.isArray(point) ? point : point.position))
}

// 图例文字: 坐标变换写作父->子
export function spatialLabel(layer: DrawableSpatialLayer) {
  return layer.kind === 'transform' ? `${layer.frame}->${layer.childFrame}` : layer.name
}
