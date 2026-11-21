/**
 * 布局描述与通道目录之间的换算: 绑定的匹配与说明, 无默认布局时的自动排布, 布局树与Workspace模型 (react-resizable-panels) 的互译.
 * agent不直写Workspace模型, 换布局库只改这里的翻译.
 */
import type { HiddenTabBehavior, WorkspaceModelInput, WorkspaceNodeInput } from 'react-resizable-panels'
import type { ChannelInfo } from '../data-source/types'
import { isOverlayKind } from '../image/image-overlay'
import { spatialKindOf } from '../scene3d/scene-layers'
import {
  LAYOUT_DESCRIPTION_VERSION,
  type LayerBinding,
  type LayoutDescription,
  type LayoutNode,
  referencedViews,
  VIEW_LAYER_KINDS,
  VIEW_TYPE_LABELS,
  type ViewSpec,
  type ViewType,
} from './catalog'

// 切到别的tab时: 3D场景 (WebGL context) 与图像 (已解码的画面) 保留DOM, 由面板按可见性暂停; 时间轴类视图卸载, 再选中时重建
export function hiddenTabBehaviorFor(type: ViewType | undefined): HiddenTabBehavior {
  return type === 'scene3d' || type === 'image' ? 'keep-mounted' : 'unmount'
}

// 通道的绑定种类: 由通道种类得出, 叠加与空间再按`type`细分 (同ADP图层种类; 空间也认ROS类型`TFMessage` `PointCloud2`); 认不出的细分为`other`
export function bindingKindOf(channel: ChannelInfo): LayerBinding['kind'] {
  switch (channel.kind) {
    case 'image':
      return 'image_stream'
    case 'overlay':
      return isOverlayKind(channel.type) ? channel.type : 'other'
    case 'spatial':
      return spatialKindOf(channel) ?? 'other'
    default:
      return channel.kind
  }
}

function isSpatialChannel(channel: ChannelInfo) {
  return spatialKindOf(channel) !== null
}

const END_EFFECTOR_POSITION_ROLE = 'end_effector_position'

const LAYER_KIND_LABELS: Record<LayerBinding['kind'], string> = {
  image_stream: '图像流',
  series: '序列',
  events: '事件',
  segmentation: '分割',
  keypoints_2d: '2D关键点',
  transform: '坐标变换',
  pose: '位姿',
  point_cloud: '点云',
  keypoints_3d: '3D关键点',
  message: '消息',
  other: '其他',
}

function wildcardMatches(pattern: string, value: string | null | undefined) {
  if (value === null || value === undefined) return false
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(value)
}

export function matchesBinding(binding: LayerBinding, channel: ChannelInfo) {
  return (
    bindingKindOf(channel) === binding.kind &&
    (binding.role === undefined || wildcardMatches(binding.role, channel.role)) &&
    (binding.derivative === undefined || channel.source === binding.derivative) &&
    (binding.name === undefined || channel.name === binding.name)
  )
}

// 给人看的绑定说明, 如"序列 · 角色end_effector_position"; 缺层空状态与图层开关用
export function describeBinding(binding: LayerBinding) {
  return [
    LAYER_KIND_LABELS[binding.kind],
    binding.role && `角色${binding.role}`,
    binding.derivative && `产物${binding.derivative}`,
    binding.name && `名为${binding.name}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

// 一个视图的各绑定在目录里匹配到的通道; 关掉的绑定也列出, 由调用方决定是否显示
export function resolveBindings(view: ViewSpec, channels: ChannelInfo[]) {
  return view.layers.map((binding) => ({
    binding,
    isVisible: binding.visible !== false,
    channels: channels.filter((channel) => matchesBinding(binding, channel)),
  }))
}

export function visibleChannels(view: ViewSpec, channels: ChannelInfo[]) {
  return resolveBindings(view, channels).flatMap((resolved) => (resolved.isVisible ? resolved.channels : []))
}

// 按目录已有的通道给某类视图配绑定: 可叠种类的每个角色一条; 没有可叠通道时给只限种类的一条 (面板显示缺层)
export function defaultBindings(type: ViewType, channels: ChannelInfo[]): LayerBinding[] {
  const kinds: readonly LayerBinding['kind'][] = VIEW_LAYER_KINDS[type]
  const candidates = channels.filter(
    (channel) =>
      kinds.includes(bindingKindOf(channel)) &&
      (type !== 'scene3d' || channel.kind !== 'series' || channel.role === END_EFFECTOR_POSITION_ROLE),
  )
  const seen = new Set<string>()
  const bindings: LayerBinding[] = []
  for (const channel of candidates) {
    const kind = bindingKindOf(channel)
    const key = `${kind}/${channel.role ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    bindings.push(channel.role == null ? { kind } : { kind, role: channel.role })
  }
  if (bindings.length > 0) return bindings
  return [type === 'scene3d' ? { kind: 'series', role: END_EFFECTOR_POSITION_ROLE } : { kind: kinds[0] }]
}

// 按已有通道建一个某类视图; 绑定的种类由`defaultBindings`保证在该类型可叠范围内
export function createView(type: ViewType, channels: ChannelInfo[]): ViewSpec {
  return { type, layers: defaultBindings(type, channels) } as ViewSpec
}

// 自动排布的份额: 上为图像与3D (图像多路并排, 占得宽些), 下为事件轨道与序列泳道
const MONITOR_SHARE = 40
const IMAGE_SHARE = 3
const SCENE_SHARE = 2
const EVENTS_SHARE = 24
const SERIES_SHARE = 36

/**
 * 无默认布局时按目录已有通道排: 有图像放图像, 有末端位置或空间通道 (坐标变换, 位姿, 点云, 3D关键点) 放3D场景,
 * 二者左右并排在上;
 * 有事件放事件轨道, 有序列放序列泳道, 有结构化消息放消息树, 上下叠在下. 一个通道都没有返回null.
 */
export function autoLayout(channels: ChannelInfo[]): LayoutDescription | null {
  const views: Record<string, ViewSpec> = {}
  const has = (predicate: (channel: ChannelInfo) => boolean) => channels.some(predicate)
  if (has((channel) => channel.kind === 'image')) views.image = createView('image', channels)
  if (has((channel) => (channel.kind === 'series' && channel.role === END_EFFECTOR_POSITION_ROLE) || isSpatialChannel(channel)))
    views.scene = createView('scene3d', channels)
  if (has((channel) => channel.kind === 'events')) views.events = createView('events', channels)
  if (has((channel) => channel.kind === 'series')) views.series = createView('series', channels)
  if (has((channel) => channel.kind === 'message')) views.message = createView('message', channels)

  const tabs = (ids: string[], size: number): LayoutNode[] =>
    ids.filter((id) => id in views).map((id) => ({ type: 'tabs', views: [id], size }))
  const monitor = [...tabs(['image'], IMAGE_SHARE), ...tabs(['scene'], SCENE_SHARE)]
  const timeline = [...tabs(['events'], EVENTS_SHARE), ...tabs(['series'], SERIES_SHARE), ...tabs(['message'], SERIES_SHARE)]
  const rows: LayoutNode[] = []
  if (monitor.length > 0) rows.push({ type: 'split', direction: 'row', children: monitor, size: MONITOR_SHARE })
  if (timeline.length > 0)
    rows.push({ type: 'split', direction: 'column', children: timeline, size: EVENTS_SHARE + SERIES_SHARE })
  if (rows.length === 0) return null
  return { version: LAYOUT_DESCRIPTION_VERSION, views, layout: { type: 'split', direction: 'column', children: rows } }
}

// 视图tab: tab id即视图id, 内容按id从视图表取, 不在Workspace模型里另存视图参数
export type ViewWorkspaceModel = WorkspaceModelInput<null>
type WorkspaceNode = WorkspaceNodeInput<null>

const ORIENTATION_OF = { row: 'horizontal', column: 'vertical' } as const
// 份额统一成上层分割内的百分比 (Workspace与回译都按此)
const PERCENT = 100

// 各子节点的相对份额换成百分比; 没写份额的按1份
function percentShares(sizes: (number | undefined)[]) {
  const shares = sizes.map((size) => size ?? 1)
  const total = shares.reduce((sum, share) => sum + share, 0)
  return shares.map((share) => (total > 0 ? (share / total) * PERCENT : PERCENT / shares.length))
}

/**
 * 布局描述 -> Workspace模型: 分割成split (row/column对应horizontal/vertical), tab组成tabset, 份额换成百分比.
 * 视图表里有而布局树没引用的视图不成tab.
 */
export function toWorkspaceModel(description: LayoutDescription): ViewWorkspaceModel {
  function build(node: LayoutNode, size?: number): WorkspaceNode {
    if (node.type === 'tabs')
      return {
        type: 'tabset',
        size,
        selectedId: node.active ?? node.views[0],
        tabs: node.views.map((id) => ({ id, title: viewTitle(description.views[id]), data: null })),
      }
    const shares = percentShares(node.children.map((child) => child.size))
    return {
      type: 'split',
      size,
      orientation: ORIENTATION_OF[node.direction],
      children: node.children.map((child, index) => build(child, shares[index])),
    }
  }
  return { version: 1, root: build(description.layout) }
}

// Workspace的尺寸: 数字为百分比; 带单位的字符串只在初始模型里出现, 不来自本翻译, 按未给处理
function percentOf(size: number | string | undefined) {
  return typeof size === 'number' ? size : undefined
}

/**
 * Workspace模型 -> 布局描述 ("设为默认"与本地布局用): split成分割, tabset成tab组, 尺寸取整成上层内的百分比份额.
 * 视图表里没有的tab, 空tabset略去; 只有一个子节点的分割即该子节点; 视图表只留布局树引用到的视图.
 */
export function fromWorkspaceModel(model: ViewWorkspaceModel, views: Record<string, ViewSpec>): LayoutDescription | null {
  function build(node: WorkspaceNode): LayoutNode | null {
    if (node.type === 'tabset') {
      const ids = node.tabs.map((tab) => tab.id).filter((id) => id in views)
      if (ids.length === 0) return null
      const active = node.selectedId && ids.includes(node.selectedId) ? node.selectedId : ids[0]
      return { type: 'tabs', views: ids, active }
    }
    const children = node.children
      .map((child) => ({ node: build(child), size: percentOf(child.size) }))
      .filter((child): child is { node: LayoutNode; size: number | undefined } => child.node !== null)
    if (children.length === 0) return null
    if (children.length === 1) return children[0].node
    // 没给尺寸的兄弟平分其余空间
    const given = children.reduce((sum, child) => sum + (child.size ?? 0), 0)
    const ungivenCount = children.filter((child) => child.size === undefined).length
    const fallback = ungivenCount > 0 ? Math.max(PERCENT - given, 0) / ungivenCount : 0
    const shares = percentShares(children.map((child) => child.size ?? fallback))
    return {
      type: 'split',
      direction: node.orientation === 'horizontal' ? 'row' : 'column',
      children: children.map((child, index) => ({ ...child.node, size: Math.max(1, Math.round(shares[index])) })),
    }
  }

  const layout = build(model.root)
  if (layout === null) return null
  const referenced = Object.fromEntries(referencedViews(layout).map((id) => [id, views[id]]))
  return { version: LAYOUT_DESCRIPTION_VERSION, views: referenced, layout }
}

export function viewTitle(view: ViewSpec) {
  return view.title ?? VIEW_TYPE_LABELS[view.type]
}
