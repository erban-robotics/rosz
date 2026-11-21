/**
 * rosz 查看器: 左侧常驻话题树 (按命名空间折叠), 右侧面板区 (rosz-ui 视图组装, 实时模式).
 * 默认布局只有一个图像面板, 绑定全部图像话题; 其余视图由 "添加视图" 加 (面板要看哪些通道, 适配器就订阅哪些).
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChannelList, HintProvider, useLivePlayback, ViewComposition } from '@erban-robotics/rosz-ui'
import { connect, type ConnectionStatus, type Viewer } from './adapter'
import './style.css'

const DEFAULT_LAYOUT = {
  version: 1,
  views: { image: { type: 'image', layers: [{ kind: 'image_stream' }] } },
  layout: { type: 'tabs', views: ['image'] },
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: '连接后端中',
  open: '',
  closed: '与后端的连接已断开 (rosz view 已退出?), 重新运行后刷新页面',
}

function Workspace({ viewer }: { viewer: Viewer }) {
  const playback = useLivePlayback(viewer.dataSource)
  return <ViewComposition dataSource={viewer.dataSource} playback={playback} scope="rosz-view" layout={DEFAULT_LAYOUT} />
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
      {viewer && (
        <div className="flex min-h-0 flex-1 gap-2 p-2">
          <ChannelList state={viewer.dataSource.state} className="w-80 shrink-0 overflow-auto" />
          <div className="flex min-w-0 flex-1 flex-col">
            <Workspace viewer={viewer} />
          </div>
        </div>
      )}
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
