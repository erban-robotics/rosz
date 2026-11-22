/**
 * 图像叠加层: 分割与2D关键点. 叠加通道 (`kind: 'overlay'`, `type`为`segmentation`或`keypoints_2d`) 的样本内容为一帧
 * (`KeypointsFrame` `SegmentationFrame`, 时刻为会话时间轴秒数); 通道的`properties`给所基于的图像 (`stream`) 与底图尺寸.
 * 离线数据的JSON内容形状见下方schema, 适配器用`parseOverlayContent`解析, 产出方按此形状写.
 * 叠加层基于某一路图像的像素坐标 (`stream`), 由视频算出的逐帧结果沿用源帧时间戳 (`time_s`, 相对数据原点).
 */
import { z } from 'zod'
import { latestIndexAtOrBefore } from '../timeline/timeline'

export const OVERLAY_LAYER_KINDS = ['segmentation', 'keypoints_2d'] as const
export type OverlayKind = (typeof OVERLAY_LAYER_KINDS)[number]

// 叠加帧与底图帧的时间戳视为同一帧的容差 (秒): 吸收纳秒原点换成秒的浮点误差, 远小于帧间隔
const SAME_FRAME_TOLERANCE_SECONDS = 1e-4

const overlayCommon = {
  stream: z.string().min(1).describe('所基于的图像流名, 坐标为该流图像的像素'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}

const KeypointsContentSchema = z.object({
  ...overlayCommon,
  frames: z.array(
    z.object({
      time_s: z.number(),
      points: z.array(z.object({ label: z.string().optional(), x: z.number(), y: z.number() })),
    }),
  ),
})

const SegmentationContentSchema = z.object({
  ...overlayCommon,
  // mask为掩码图像地址 (带透明通道), 与底图同尺寸
  frames: z.array(z.object({ time_s: z.number(), mask: z.string().min(1) })),
})

export type KeypointsFrame = { time: number; points: { label?: string; x: number; y: number }[] }
export type SegmentationFrame = { time: number; mask: string }

type OverlayCommon = { channel: string; name: string; stream: string; width: number; height: number }
export type ImageOverlay =
  | (OverlayCommon & { kind: 'keypoints_2d'; frames: KeypointsFrame[] })
  | (OverlayCommon & { kind: 'segmentation'; frames: SegmentationFrame[] })
  | (OverlayCommon & { kind: 'invalid'; issue: string })

export function isOverlayKind(kind: string | null | undefined): kind is OverlayKind {
  return (OVERLAY_LAYER_KINDS as readonly string[]).includes(kind ?? '')
}

/**
 * 一份叠加内容JSON -> 对齐到会话时间轴的叠加层 (`offset`为数据原点在会话时间轴上的秒数); 不合形状的标为invalid, 面板据此提示.
 * 适配器把结果的说明 (所基于的图像, 尺寸) 写进通道目录, 帧写成叠加通道.
 */
export function parseOverlayContent(
  kind: OverlayKind,
  content: unknown,
  offset: number,
  base: { channel: string; name: string },
): ImageOverlay {
  const schema = kind === 'keypoints_2d' ? KeypointsContentSchema : SegmentationContentSchema
  const parsed = schema.safeParse(content)
  if (!parsed.success)
    return { ...base, kind: 'invalid', stream: '', width: 0, height: 0, issue: parsed.error.issues[0]?.message ?? '' }
  const { stream, width, height } = parsed.data
  const sorted = [...parsed.data.frames].sort((first, second) => first.time_s - second.time_s)
  if (kind === 'keypoints_2d')
    return {
      ...base,
      kind: 'keypoints_2d',
      stream,
      width,
      height,
      frames: (sorted as z.infer<typeof KeypointsContentSchema>['frames']).map((frame) => ({
        time: frame.time_s + offset,
        points: frame.points,
      })),
    }
  return {
    ...base,
    kind: 'segmentation',
    stream,
    width,
    height,
    frames: (sorted as z.infer<typeof SegmentationContentSchema>['frames']).map((frame) => ({
      time: frame.time_s + offset,
      mask: frame.mask,
    })),
  }
}

// 叠加层在底图这一帧时间戳上的数据; 没有即null (不取前后最近的帧)
export function overlayFrameAt<Frame extends { time: number }>(frames: Frame[], frameTime: number): Frame | null {
  const index = latestIndexAtOrBefore(
    frames.map((frame) => frame.time),
    frameTime + SAME_FRAME_TOLERANCE_SECONDS,
  )
  if (index < 0) return null
  return frameTime - frames[index].time <= SAME_FRAME_TOLERANCE_SECONDS ? frames[index] : null
}
