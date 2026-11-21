/**
 * `sensor_msgs/PointCloud2` 解出的值树 -> 3D 面板画的点: 取 x y z (任意数值类型), 有 `rgb` / `rgba` 字段 (按 PCL 约定
 * 打包成 4 字节, 字节序 b g r a) 时带颜色. 跳过非有限值的点; 超过 [`MAX_POINTS`] 时等间隔抽取.
 */
import type { Cloud } from './scene'

const MAX_POINTS = 200_000
// PointField.datatype -> (字节数, DataView 读法)
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
// sRGB 字节 -> 线性 (three 的顶点色按线性算)
const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

type PointField = { name: string; offset: number; datatype: number; count: number }
export type PointCloud2 = {
  header: { frame_id: string }
  height: number
  width: number
  fields: PointField[]
  is_bigendian: boolean
  point_step: number
  row_step: number
  data: Uint8Array
}

export function fromPointCloud2(msg: PointCloud2): Cloud | { issue: string } {
  const field = (name: string) => msg.fields.find((candidate) => candidate.name === name)
  const axes = [field('x'), field('y'), field('z')]
  if (axes.some((axis) => !axis || !READERS[axis.datatype])) return { issue: '点云没有数值类型的 x y z 字段' }
  const [x, y, z] = axes as PointField[]
  const rgb = field('rgb') ?? field('rgba')
  const { width, height, point_step: pointStep, row_step: rowStep, data } = msg
  const little = !msg.is_bigendian
  const end = Math.max(...axes.map((axis) => axis!.offset + READERS[axis!.datatype][0]))
  if (end > pointStep || (height > 0 && (height - 1) * rowStep + width * pointStep > data.length))
    return { issue: '点云数据比 width / height / point_step 声明的短' }
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
    if (colors) {
      const at = base + rgb!.offset
      // 打包的 0x00RRGGBB 按点云字节序存
      const [r, g, b] = little ? [data[at + 2], data[at + 1], data[at]] : [data[at + 1], data[at + 2], data[at + 3]]
      colors[out] = SRGB_TO_LINEAR[r]
      colors[out + 1] = SRGB_TO_LINEAR[g]
      colors[out + 2] = SRGB_TO_LINEAR[b]
    }
    count += 1
  }
  return {
    frame: msg.header.frame_id,
    positions: positions.subarray(0, count * 3),
    colors: colors ? colors.subarray(0, count * 3) : null,
    total,
  }
}
