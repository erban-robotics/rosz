/**
 * 查看器的面板布局与 "点话题加进面板".
 *
 * 默认布局固定两个视图: 图像 (左) 与消息树 (右). 各视图的第一条绑定是关着的 "全部" (点它的图层开关即看该类全部话题),
 * 其后每条按话题名绑一路. 点话题树即在对应视图里增删这一路: 直接改 rosz-ui 的本地布局 (`useLayoutStore`, 与面板上的
 * 图层开关同一份, 存 localStorage, 下次打开仍在), 不动布局树, 人拖过的面板不复位. rosz-ui 没有 "往视图加绑定" 的对外入口,
 * 这里按它的约定 (本地布局叠在默认布局的序列化 `base` 上) 写; 包里有了入口后改用.
 *
 * 首次打开 (本地还没有布局) 时自动选一路彩色与一路深度, 不一下订阅全部图像.
 *
 * 面板的拖动, 缩放, 关 tab 由 rosz-ui 的视图组装存进同一份本地布局. 两处补它的缺:
 * - 人关掉了图像或消息树 tab 后再点话题: 视图表里还有它, 布局树里没了, 点了看不见. 此时把该视图放回布局树 (右侧新开一栏),
 *   并让视图组装重挂 ([`useLayoutEpoch`]) 读到新布局树
 * - "恢复默认布局" 清掉整份本地布局, 已加的话题一并没了: 清掉时把各视图按名加的话题放回默认布局 (只复位面板排布)
 */
import {
  type ChannelInfo,
  type LayerBinding,
  type LayoutNode,
  parseLayoutDescription,
  referencedViews,
  useLayoutStore,
  type ViewSpec,
} from '@erban-robotics/rosz-ui'
import { useSyncExternalStore } from 'react'
import { forgetCurves } from './curves-store'

export const LAYOUT_SCOPE = 'rosz-view'
const IMAGE_VIEW = 'image'
const MESSAGE_VIEW = 'message'

export const DEFAULT_LAYOUT = {
  version: 1,
  views: {
    [IMAGE_VIEW]: { type: 'image', title: '图像', layers: [{ kind: 'image_stream', visible: false }] },
    [MESSAGE_VIEW]: { type: 'message', title: '消息树', layers: [{ kind: 'message', visible: false }] },
  },
  layout: {
    type: 'split',
    direction: 'row',
    children: [
      { type: 'tabs', views: [IMAGE_VIEW], size: 3 },
      { type: 'tabs', views: [MESSAGE_VIEW], size: 2 },
    ],
  },
}

const parsed = parseLayoutDescription(DEFAULT_LAYOUT)
if (!parsed.success) throw new Error(`默认布局不合 schema: ${parsed.issues.join('; ')}`)
const base = parsed.description
// 与 ViewComposition 判断本地布局是否叠在同一默认布局上的写法一致
const BASE_KEY = JSON.stringify(base)

type Views = Record<string, ViewSpec>

function currentViews(): Views {
  const local = useLayoutStore.getState().localLayouts[LAYOUT_SCOPE]
  return local?.base === BASE_KEY ? local.views : base.views
}

function currentLayout(): LayoutNode | null {
  const local = useLayoutStore.getState().localLayouts[LAYOUT_SCOPE]
  return local?.base === BASE_KEY ? local.layout : null
}

function saveViews(views: Views, layout = currentLayout()) {
  useLayoutStore.getState().saveLocalLayout(LAYOUT_SCOPE, { base: BASE_KEY, views, layout })
}

// 布局树里 (null 为默认布局树) 有没有这个视图
function isShown(layout: LayoutNode | null, viewId: string) {
  return referencedViews(layout ?? base.layout).includes(viewId)
}

// 视图组装的重挂计数: 本模块改了布局树 (视图组装只在挂上时读它) 时加一
let epoch = 0
const epochListeners = new Set<() => void>()
function remount() {
  epoch += 1
  for (const listener of epochListeners) listener()
}

/** 作 ViewComposition 的 key: 布局树被这里改过即变 */
export function useLayoutEpoch() {
  return useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener)
      return () => void epochListeners.delete(listener)
    },
    () => epoch,
  )
}

function viewOf(channel: ChannelInfo) {
  if (channel.kind === 'image') return { id: IMAGE_VIEW, kind: 'image_stream' as const }
  if (channel.kind === 'message') return { id: MESSAGE_VIEW, kind: 'message' as const }
  return null
}

function boundNames(view: ViewSpec | undefined) {
  return (view?.layers ?? []).flatMap((binding: LayerBinding) => (binding.name ? [binding.name] : []))
}

/**
 * 话题在对应视图里有就去掉, 没有就加上; 图像与结构化消息之外的通道不处理.
 * 对应视图的 tab 已被关掉时, 重新打开它并确保话题在里面 (不去掉).
 */
export function toggleTopic(channel: ChannelInfo) {
  const target = viewOf(channel)
  if (!target) return
  const views = currentViews()
  const view = views[target.id] ?? base.views[target.id]
  const layout = currentLayout()
  const shown = isShown(layout, target.id)
  const isBound = view.layers.some((binding) => binding.name === channel.name)
  const layers =
    isBound && shown
      ? view.layers.filter((binding) => binding.name !== channel.name)
      : isBound
        ? view.layers
        : [...view.layers, { kind: target.kind, name: channel.name }]
  if (isBound && shown && target.id === MESSAGE_VIEW) forgetCurves(channel.name)
  const next = { ...views, [target.id]: { ...view, layers } as ViewSpec }
  if (shown) return saveViews(next)
  // 放回布局树: 原布局整体在左, 该视图在右一栏
  const tab: LayoutNode = { type: 'tabs', views: [target.id], size: 1 }
  saveViews(next, { type: 'split', direction: 'row', children: [{ ...(layout ?? base.layout), size: 3 }, tab] })
  remount()
}

/** 已按名字加进面板 (且该面板开着) 的话题: 图像与结构化消息分开 */
export function useBoundTopics() {
  const local = useLayoutStore((state) => state.localLayouts[LAYOUT_SCOPE])
  const isLocal = local?.base === BASE_KEY
  const views = isLocal ? local.views : base.views
  const layout = isLocal ? local.layout : null
  const names = (id: string) => (isShown(layout, id) ? boundNames(views[id]) : [])
  return { images: names(IMAGE_VIEW), messages: names(MESSAGE_VIEW) }
}

// "恢复默认布局" 清掉本地布局时, 把按名加的话题放回默认布局的各视图 (面板排布, 图层开关照样复位)
useLayoutStore.subscribe((state, previous) => {
  const before = previous.localLayouts[LAYOUT_SCOPE]
  if (state.localLayouts[LAYOUT_SCOPE] || before?.base !== BASE_KEY) return
  const views: Views = { ...base.views }
  for (const [id, view] of Object.entries(base.views)) {
    const named = (before.views[id]?.layers ?? []).filter((binding) => binding.name)
    if (named.length > 0) views[id] = { ...view, layers: [...view.layers, ...named] } as ViewSpec
  }
  saveViews(views, null)
})

// 越像 "对齐到彩色的深度 / 压缩彩色" 分越高; 不认识的插件格式 (theora, zstd_image_transport) 不加分
function colorScore(name: string) {
  if (!/color|rgb/i.test(name) || /depth/i.test(name)) return -1
  return name.endsWith('/compressed') ? 2 : 1
}

function depthScore(name: string) {
  if (!/depth/i.test(name)) return -1
  return (name.endsWith('/compressedDepth') ? 2 : 0) + (/aligned/i.test(name) ? 1 : 0) + (/\/zstd$/.test(name) ? 1 : 0)
}

function best(names: string[], score: (name: string) => number) {
  let chosen: string | null = null
  for (const name of [...names].sort()) if (score(name) >= 0 && (chosen === null || score(name) > score(chosen))) chosen = name
  return chosen
}

/** 本地还没有布局时按话题名挑一路彩色, 一路深度加进图像面板; 挑过 (或人改过布局) 即不再挑 */
export function pickDefaultImages(catalog: ChannelInfo[]) {
  if (useLayoutStore.getState().localLayouts[LAYOUT_SCOPE]?.base === BASE_KEY) return
  const names = catalog.filter((channel) => channel.kind === 'image' && !channel.undecodable).map((channel) => channel.name)
  const chosen = [best(names, colorScore), best(names, depthScore)].filter((name): name is string => name !== null)
  if (chosen.length === 0) return
  const view = base.views[IMAGE_VIEW]
  const layers = [...view.layers, ...chosen.map((name) => ({ kind: 'image_stream' as const, name }))]
  saveViews({ ...base.views, [IMAGE_VIEW]: { ...view, layers } as ViewSpec })
}
