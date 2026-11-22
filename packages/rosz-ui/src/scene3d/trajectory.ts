// 3D场景轨迹图层的数据形状与取色, 场景与图层共用
import * as THREE from 'three'

// 一条末端轨迹: 位置为米, `frame`为序列声明的坐标系 (图层属性`frame`), 没声明为null
export type TcpTrack = {
  label: string
  isTarget: boolean
  frame: string | null
  times: number[]
  points: ([number, number, number] | null)[]
}

// three的材质色不能用CSS变量, 取index.css的--series-1到4; 目标轨迹同色半透明
const TRACK_COLORS = ['#63b1f9', '#e3550b', '#1c985a', '#fcbb2e']
export const TARGET_OPACITY = 0.4

export function trackColor(index: number) {
  return TRACK_COLORS[index % TRACK_COLORS.length]
}

// 各轨迹全部有效点的包围盒; 逐点扩展, 长序列也不经展开参数
export function trackBounds(tracks: TcpTrack[]) {
  const bounds = new THREE.Box3()
  const vertex = new THREE.Vector3()
  for (const track of tracks) {
    for (const point of track.points) if (point) bounds.expandByPoint(vertex.set(...point))
  }
  return bounds
}
