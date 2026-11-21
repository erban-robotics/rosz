// 末端位置序列派生的显示量: 3D轨迹与末端速度轨, 视图组装的面板用
import type { TcpTrack } from '../scene3d/trajectory'
import type { ChartLine } from './timeline'
import type { TimelineLane } from './LaneRow'
import { columnsOf, type SeriesTrack, seriesProperties } from './series'

// 按角色选面板: 末端位置 -> 3D轨迹与末端速度轨道
export const END_EFFECTOR_POSITION_ROLE = 'end_effector_position'
const MILLIMETERS_PER_METER = 1000
const SPEED_LANE_HEIGHT_PIXELS = 120

export function isEndEffectorTrack(track: SeriesTrack) {
  return track.channel.role === END_EFFECTOR_POSITION_ROLE
}

function trackLabel(track: SeriesTrack) {
  const { side, trajectory } = seriesProperties(track)
  return side ? [side, trajectory].filter(Boolean).join(' ') : track.channel.name
}

function positionsOf(track: SeriesTrack) {
  const [x, y, z] = columnsOf(track).map((column) => track.columns[column])
  return track.times.map((_, index) => {
    const point = [x?.[index], y?.[index], z?.[index]]
    return point.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? (point as [number, number, number])
      : null
  })
}

// 末端线速度 (mm/s): 相邻两点的位移除以时间差; 任一端缺测为null
function speedLine(track: SeriesTrack): ChartLine {
  const points = positionsOf(track)
  const values = points.map((point, index) => {
    const previous = points[index - 1]
    const elapsed = track.times[index] - track.times[index - 1]
    if (index === 0 || !point || !previous || !(elapsed > 0)) return null
    return (Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]) / elapsed) * MILLIMETERS_PER_METER
  })
  return { label: trackLabel(track), times: track.times, values }
}

// 各末端轨迹共一条速度轨; 没有末端轨迹即无此轨
export function speedLanes(endEffectorTracks: SeriesTrack[]): TimelineLane[] {
  if (endEffectorTracks.length === 0) return []
  return [
    {
      key: 'end-effector-speed',
      label: '末端速度',
      title: '末端线速度: 相邻两点位移除以时间差',
      unit: 'mm/s',
      lines: endEffectorTracks.map(speedLine),
      height: SPEED_LANE_HEIGHT_PIXELS,
      hasIndependentScales: false,
    },
  ]
}

// 3D轨迹; 坐标系取列组声明的`frame` (图层属性), 没声明为null
export function tcpTracks(endEffectorTracks: SeriesTrack[]): TcpTrack[] {
  return endEffectorTracks.map((track) => {
    const { trajectory, frame } = seriesProperties(track)
    return {
      label: trackLabel(track),
      isTarget: trajectory === 'target',
      frame: typeof frame === 'string' ? frame : null,
      times: track.times,
      points: positionsOf(track),
    }
  })
}
