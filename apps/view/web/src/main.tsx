/**
 * rosz 查看器: 左侧常驻话题树 (按命名空间折叠), 右侧面板区 (rosz-ui 视图组装, 实时模式) 与其下的曲线区.
 * 点话题树里的图像话题即加进 (再点即移出) 图像面板, 多路并排; TF 与点云话题加进 3D 面板 (面板区右侧, 有选中的才显示);
 * 点其余话题加进消息树面板, 能解的另在曲线区列出数值字段.
 * 面板要看哪些话题, 适配器就订阅哪些 (见 layout.ts, adapter.ts).
 */
import { lazy, StrictMode, Suspense, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelList, HintProvider, type Playback, useCatalog, useLivePlayback, ViewComposition } from '@erban-robotics/rosz-ui'
import { connect, type ConnectionStatus, type Viewer } from './adapter'
import { Curves } from './curves'
import { DEFAULT_LAYOUT, LAYOUT_SCOPE, pickDefaultImages, toggleTopic, useBoundTopics } from './layout'
import { toggleSceneTopic, useSceneTopics } from './scene'
import './style.css'

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: '连接后端中',
  open: '',
  closed: '与后端的连接已断开 (rosz view 已退出?), 重新运行后刷新页面',
}
// 首个图像话题出现后等这么久再挑默认的几路, 等目录到齐
const PICK_DELAY_MS = 1000
// 3D 面板 (three) 单独一块, 选了空间话题才加载
const ScenePanel = lazy(() => import('./scene3d'))

function Workspace({ viewer }: { viewer: Viewer }) {
  const { dataSource, scene } = viewer
  const playback: Playback = useLivePlayback(dataSource)
  const catalog = useCatalog(dataSource.state)
  const bound = useBoundTopics()
  const hasImage = catalog.some((channel) => channel.kind === 'image')
  useEffect(() => {
    if (!hasImage) return
    const timer = setTimeout(() => pickDefaultImages(dataSource.state.catalog()), PICK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hasImage, dataSource])
  const sceneTopics = useSceneTopics(catalog)
  const selected = useMemo(() => [...bound.images, ...bound.messages, ...sceneTopics], [bound.images, bound.messages, sceneTopics])
  const plotted = useMemo(
    () => catalog.filter((channel) => channel.kind === 'message' && !channel.undecodable && bound.messages.includes(channel.name)),
    [catalog, bound.messages],
  )
  return (
    <div className="flex min-h-0 flex-1 gap-2 p-2">
      <div className="flex w-80 shrink-0 flex-col gap-1">
        <p className="text-xs text-muted-foreground">点话题加进面板, 再点移出</p>
        <ChannelList state={dataSource.state} selected={selected} onSelect={(channel) => (channel.kind === 'spatial' ? toggleSceneTopic(channel, sceneTopics) : toggleTopic(channel))} className="min-h-0 flex-1 overflow-auto" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-h-0 flex-[3] gap-2">
          <div className="min-w-0 flex-[3]">
            <ViewComposition dataSource={dataSource} playback={playback} scope={LAYOUT_SCOPE} layout={DEFAULT_LAYOUT} />
          </div>
          {sceneTopics.length > 0 && (
            <div className="min-w-0 flex-[2]">
              <Suspense fallback={<p className="text-xs text-muted-foreground">加载 3D 面板</p>}>
                <ScenePanel dataSource={dataSource} scene={scene} topics={sceneTopics} catalog={catalog} />
              </Suspense>
            </div>
          )}
        </div>
        {plotted.length > 0 && (
          <div className="min-h-0 flex-[2] overflow-auto">
            <Curves dataSource={dataSource} channels={plotted} />
          </div>
        )}
      </div>
    </div>
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
