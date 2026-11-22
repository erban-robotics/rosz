// 关节曲线按组分轨: 同角色且分左右的列组配对成一组, 同序号的列左右同轨对照; 其余列组各成一组
import type { ChartLine } from './timeline'
import { columnsOf, type SeriesTrack, seriesProperties } from './series'

export type JointLane = {
  key: string
  // 轨道名: 去掉命名空间与左右后缀的关节名
  label: string
  // 悬停提示: 各线的完整列名
  title: string
  unit: string
  lines: ChartLine[]
}

export type JointGroup = { key: string; name: string; lanes: JointLane[] }

// 名字末尾的分隔符在取公共前缀后去掉
const TRAILING_SEPARATORS = /[._\-\s]+$/

export function commonPrefix(names: string[]) {
  if (names.length === 0) return ''
  let prefix = names[0]
  for (const name of names.slice(1)) {
    let length = 0
    while (length < prefix.length && length < name.length && prefix[length] === name[length]) length += 1
    prefix = prefix.slice(0, length)
  }
  return prefix.replace(TRAILING_SEPARATORS, '')
}

// 列名去掉首个`.`前的命名空间, 如joint.Elbow_L -> Elbow_L
function withoutNamespace(column: string) {
  const dot = column.indexOf('.')
  return dot < 0 ? column : column.slice(dot + 1)
}

function propertiesOf(track: SeriesTrack) {
  return seriesProperties(track)
}

function canPair(tracks: SeriesTrack[]) {
  const sides = tracks.map((track) => propertiesOf(track).side)
  return (
    tracks.length > 1 &&
    sides.every(Boolean) &&
    new Set(sides).size === tracks.length &&
    tracks.every((track) => columnsOf(track).length === columnsOf(tracks[0]).length)
  )
}

function lineOf(track: SeriesTrack, column: string, label: string): ChartLine {
  return { label, times: track.times, values: track.columns[column] ?? [] }
}

function pairedGroup(tracks: SeriesTrack[]): JointGroup {
  const names = tracks.map((track) => track.channel.name)
  return {
    key: tracks.map((track) => track.channel.id).join('+'),
    name: commonPrefix(names) || names.join(' / '),
    lanes: columnsOf(tracks[0]).map((_, index) => {
      const columns = tracks.map((track) => columnsOf(track)[index])
      return {
        key: columns.join('+'),
        label: withoutNamespace(commonPrefix(columns)) || columns.map(withoutNamespace).join(' / '),
        title: columns.join(' / '),
        unit: propertiesOf(tracks[0]).unit ?? '',
        lines: tracks.map((track, trackIndex) => lineOf(track, columns[trackIndex], propertiesOf(track).side!)),
      }
    }),
  }
}

function singleGroup(track: SeriesTrack): JointGroup {
  return {
    key: track.channel.id,
    name: track.channel.name,
    lanes: columnsOf(track).map((column) => ({
      key: column,
      label: withoutNamespace(column),
      title: column,
      unit: propertiesOf(track).unit ?? '',
      lines: [lineOf(track, column, withoutNamespace(column))],
    })),
  }
}

export function buildJointGroups(tracks: SeriesTrack[]): JointGroup[] {
  const byRole = new Map<string, SeriesTrack[]>()
  for (const track of tracks) {
    const role = track.channel.role ?? ''
    byRole.set(role, [...(byRole.get(role) ?? []), track])
  }
  return [...byRole.values()].flatMap((sameRole) => (canPair(sameRole) ? [pairedGroup(sameRole)] : sameRole.map(singleGroup)))
}
