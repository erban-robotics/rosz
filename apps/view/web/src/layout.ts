/**
 * 查看器的面板布局与 "点话题加进面板".
 *
 * 默认布局固定两个视图: 图像 (左) 与消息树 (右). 各视图的第一条绑定是关着的 "全部" (点它的图层开关即看该类全部话题),
 * 其后每条按话题名绑一路. 点话题树即在对应视图里增删这一路: 直接改 rosz-ui 的本地布局 (`useLayoutStore`, 与面板上的
 * 图层开关同一份, 存 localStorage, 下次打开仍在), 不动布局树, 人拖过的面板不复位. rosz-ui 没有 "往视图加绑定" 的对外入口,
 * 这里按它的约定 (本地布局叠在默认布局的序列化 `base` 上) 写; 包里有了入口后改用.
 *
 * 首次打开 (本地还没有布局) 时自动选一路彩色与一路深度, 不一下订阅全部图像.
 */
import { type ChannelInfo, type LayerBinding, parseLayoutDescription, useLayoutStore, type ViewSpec } from '@erban-robotics/rosz-ui'

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

function saveViews(views: Views) {
  const { localLayouts, saveLocalLayout } = useLayoutStore.getState()
  const local = localLayouts[LAYOUT_SCOPE]
  saveLocalLayout(LAYOUT_SCOPE, { base: BASE_KEY, views, layout: local?.base === BASE_KEY ? local.layout : null })
}

function viewOf(channel: ChannelInfo) {
  if (channel.kind === 'image') return { id: IMAGE_VIEW, kind: 'image_stream' as const }
  if (channel.kind === 'message') return { id: MESSAGE_VIEW, kind: 'message' as const }
  return null
}

function boundNames(view: ViewSpec | undefined) {
  return (view?.layers ?? []).flatMap((binding: LayerBinding) => (binding.name ? [binding.name] : []))
}

/** 话题在对应视图里有就去掉, 没有就加上; 图像与结构化消息之外的通道不处理 */
export function toggleTopic(channel: ChannelInfo) {
  const target = viewOf(channel)
  if (!target) return
  const views = currentViews()
  const view = views[target.id] ?? base.views[target.id]
  const isBound = view.layers.some((binding) => binding.name === channel.name)
  const layers = isBound
    ? view.layers.filter((binding) => binding.name !== channel.name)
    : [...view.layers, { kind: target.kind, name: channel.name }]
  saveViews({ ...views, [target.id]: { ...view, layers } as ViewSpec })
}

/** 已按名字加进面板的话题: 图像与结构化消息分开 */
export function useBoundTopics() {
  const local = useLayoutStore((state) => state.localLayouts[LAYOUT_SCOPE])
  const views = local?.base === BASE_KEY ? local.views : base.views
  return { images: boundNames(views[IMAGE_VIEW]), messages: boundNames(views[MESSAGE_VIEW]) }
}

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
