/**
 * ROS空间消息 (rosz-wasm解出的值树) -> 3D场景的通用形状: `tf2_msgs/TFMessage` -> 一组坐标变换, `sensor_msgs/PointCloud2` -> 打包点云.
 * 适配器把这两种话题原样 (CDR) 写进空间通道, 场景渲染时才解, 与结构化消息同一约定. 纯TS, 不依赖three.
 */
import type { PackedPointCloudSample, SpatialKind, TransformEdge } from './spatial-layers'

export const TF_MESSAGE = 'tf2_msgs/msg/TFMessage'
export const POINT_CLOUD2 = 'sensor_msgs/msg/PointCloud2'

// 点云超过这么多点时等间隔抽取; three画20万点仍流畅
const MAX_POINTS = 200_000
// PointField.datatype -> (字节数, DataView读法)
const READERS: Record<number, [number, (view: DataView, offset: number, little: boolean) => number]> = {
  1: [1, (view, offset) => view.getInt8(offset)],
  2: [1, (view, offset) => view.getUint8(offset)],
  3: [2, (view, offset, little) => view.getInt16(offset, little)],
  4: [2, (view, offset, little) => view.getUint16(offset, little)],
  5: [4, (view, offset, little) => view.getInt32(offset, little)],
  6: [4, (view, offset, little) => view.getUint32(offset, little)],
  7: [4, (view, offset, little) => view.getFloat32(offset, little)],
  8: [8, (view, offset, little) => view.getFloat64(offset, little)],
}
// sRGB字节 -> 线性 (three的顶点色按线性算)
const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

// 能当空间通道画的ROS类型 -> 空间种类
const ROS_SPATIAL_KINDS: Record<string, SpatialKind> = { [TF_MESSAGE]: 'transform', [POINT_CLOUD2]: 'point_cloud' }

/** ROS类型名对应的空间种类; 不是能画的空间类型为null. 实时适配器据此把话题标为空间通道 */
export function rosSpatialKind(type: string | null | undefined): SpatialKind | null {
  return ROS_SPATIAL_KINDS[type ?? ''] ?? null
}

// tf2的坐标系名不带开头的`/`, 老数据带的按同一个算
export function frameName(name: string) {
  return name.replace(/^\/+/, '')
}

type Xyz = { x: number; y: number; z: number }
type TransformStamped = {
  header: { frame_id: string }
  child_frame_id: string
  transform: { translation: Xyz; rotation: Xyz & { w: number } }
}

/** 一条`TFMessage`的各坐标变换; 父子同名或为空的跳过 */
export function fromTfMessage(tree: Record<string, unknown>): TransformEdge[] {
  return (tree.transforms as TransformStamped[]).flatMap(({ header, child_frame_id, transform }) => {
    const parent = frameName(header.frame_id)
    const child = frameName(child_frame_id)
    if (!parent || !child || parent === child) return []
    const { translation: t, rotation: r } = transform
    return [{ parent, child, translation: [t.x, t.y, t.z], rotation: [r.x, r.y, r.z, r.w] }]
  })
}

type PointField = { name: string; offset: number; datatype: number; count: number }
type PointCloud2 = {
  header: { frame_id: string }
  height: number
  width: number
  fields: PointField[]
  is_bigendian: boolean
  point_step: number
  row_step: number
  data: Uint8Array
}

/**
 * 一条`PointCloud2` -> 打包点云: 取x y z (任意数值类型), 有`rgb` / `rgba`字段 (按PCL约定打包成4字节) 时带颜色.
 * 跳过非有限值的点; 超过20万点时等间隔抽取. 形状不对的给出原因
 */
export function fromPointCloud2(tree: Record<string, unknown>): Required<Omit<PackedPointCloudSample, 'time'>> | { issue: string } {
  const msg = tree as unknown as PointCloud2
  const field = (name: string) => msg.fields.find((candidate) => candidate.name === name)
  const axes = [field('x'), field('y'), field('z')]
  if (axes.some((axis) => !axis || !READERS[axis.datatype])) return { issue: '点云没有数值类型的x y z字段' }
  const [x, y, z] = axes as PointField[]
  const rgb = field('rgb') ?? field('rgba')
  const { width, height, point_step: pointStep, row_step: rowStep, data } = msg
  const little = !msg.is_bigendian
  const end = Math.max(...[x, y, z].map((axis) => axis.offset + READERS[axis.datatype][0]))
  if (end > pointStep || (height > 0 && (height - 1) * rowStep + width * pointStep > data.length))
    return { issue: '点云数据比width / height / point_step声明的短' }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const total = width * height
  const stride = Math.max(1, Math.ceil(total / MAX_POINTS))
  const positions = new Float32Array(Math.ceil(total / stride) * 3)
  const colors = rgb && rgb.offset + 4 <= pointStep ? new Float32Array(positions.length) : null
  const [readX, readY, readZ] = [x, y, z].map((axis) => READERS[axis.datatype][1])
  let count = 0
  for (let index = 0; index < total; index += stride) {
    const base = Math.floor(index / width) * rowStep + (index % width) * pointStep
    const px = readX(view, base + x.offset, little)
    const py = readY(view, base + y.offset, little)
    const pz = readZ(view, base + z.offset, little)
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue
    const out = count * 3
    positions[out] = px
    positions[out + 1] = py
    positions[out + 2] = pz
    if (colors && rgb) {
      const at = base + rgb.offset
      // 打包的0x00RRGGBB按点云字节序存
      const [r, g, b] = little ? [data[at + 2], data[at + 1], data[at]] : [data[at + 1], data[at + 2], data[at + 3]]
      colors[out] = SRGB_TO_LINEAR[r]
      colors[out + 1] = SRGB_TO_LINEAR[g]
      colors[out + 2] = SRGB_TO_LINEAR[b]
    }
    count += 1
  }
  return {
    frame: frameName(msg.header.frame_id),
    positions: positions.subarray(0, count * 3),
    colors: colors ? colors.subarray(0, count * 3) : null,
    total,
  }
}
