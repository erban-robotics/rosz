/**
 * rosz 查看器: 左侧常驻话题树 (按命名空间折叠), 右侧面板区 (rosz-ui 视图组装, 实时模式) 与其下的曲线区.
 * 点话题树里的图像话题即加进 (再点即移出) 图像面板, 多路并排; 点其余话题加进消息树面板, 能解的另在曲线区列出数值字段.
 * 面板要看哪些话题, 适配器就订阅哪些 (见 layout.ts, adapter.ts). Ctrl+K 按名或类型搜话题 (见 search.tsx).
 * 面板排布与曲线所选字段本机记住. 后端发送队列丢了小消息时顶上提示累计条数 (见 drops.ts).
 */
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelList, HintProvider, type Playback, useCatalog, useLivePlayback, ViewComposition } from '@erban-robotics/rosz-ui'
import { connect, type ConnectionStatus, type Viewer } from './adapter'
import { Curves } from './curves'
import { useDrops } from './drops'
import { DEFAULT_LAYOUT, LAYOUT_SCOPE, pickDefaultImages, toggleTopic, useBoundTopics, useLayoutEpoch } from './layout'
import { TopicSearch } from './search'
import './style.css'

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: '连接后端中',
  open: '',
  closed: '与后端的连接已断开 (rosz view 已退出?), 重新运行后刷新页面',
}
// 首个图像话题出现后等这么久再挑默认的几路, 等目录到齐
const PICK_DELAY_MS = 1000

// 丢帧提示里最多列几路
const DROP_TOPICS_SHOWN = 3

function DropNotice({ viewer }: { viewer: Viewer }) {
  const drops = useDrops(viewer.drops)
  if (drops.size === 0) return null
  const entries = [...drops].sort((first, second) => second[1] - first[1])
  const listed = entries.slice(0, DROP_TOPICS_SHOWN).map(([topic, count]) => `${topic} ${count} 条`)
  if (entries.length > DROP_TOPICS_SHOWN) listed.push(`另 ${entries.length - DROP_TOPICS_SHOWN} 路`)
  return (
    <p className="bg-surface-2 px-2 py-1 text-xs text-status-warning">
      前端处理不过来, 后端已丢 (累计): {listed.join(', ')}
    </p>
  )
}

function Workspace({ viewer }: { viewer: Viewer }) {
  const { dataSource } = viewer
  const epoch = useLayoutEpoch()
  const playback: Playback = useLivePlayback(dataSource)
  const catalog = useCatalog(dataSource.state)
  const bound = useBoundTopics()
  const hasImage = catalog.some((channel) => channel.kind === 'image')
  useEffect(() => {
    if (!hasImage) return
    const timer = setTimeout(() => pickDefaultImages(dataSource.state.catalog()), PICK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hasImage, dataSource])
  const selected = useMemo(() => [...bound.images, ...bound.messages], [bound.images, bound.messages])
  const plotted = useMemo(
    () => catalog.filter((channel) => channel.kind === 'message' && !channel.undecodable && bound.messages.includes(channel.name)),
    [catalog, bound.messages],
  )
  return (
    <>
      <DropNotice viewer={viewer} />
      <TopicSearch catalog={catalog} selected={selected} onPick={toggleTopic} />
      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <div className="flex w-80 shrink-0 flex-col gap-1">
          <p className="text-xs text-muted-foreground">点话题加进面板, 再点移出 · Ctrl+K 搜索</p>
          <ChannelList state={dataSource.state} selected={selected} onSelect={toggleTopic} className="min-h-0 flex-1 overflow-auto" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-[3]">
            <ViewComposition
              key={epoch}
              dataSource={dataSource}
              playback={playback}
              scope={LAYOUT_SCOPE}
              layout={DEFAULT_LAYOUT}
            />
          </div>
          {plotted.length > 0 && (
            <div className="min-h-0 flex-[2] overflow-auto">
              <Curves dataSource={dataSource} channels={plotted} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function App() {
  const [viewer, setViewer] = useState<Viewer | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  useEffect(() => connect(setViewer, setStatus), [])
  return (
    <div className="flex h-full flex-col">
      {STATUS_TEXT[status] && (
        <p className={`bg-surface-2 px-2 py-1 text-xs ${status === 'closed' ? 'text-status-danger' : 'text-muted-foreground'}`}>
          {STATUS_TEXT[status]}
        </p>
      )}
      {viewer && <Workspace viewer={viewer} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HintProvider>
      <App />
    </HintProvider>
  </StrictMode>,
)
