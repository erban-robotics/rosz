import { type ReactNode, useMemo } from 'react'
import { useParentTabState } from 'react-resizable-panels'
import { useCatalog, useChannelPayloads, useDataSource } from '../data-source/react'
import type { ChannelInfo } from '../data-source/types'
import { MessageView } from '../message/MessageView'
import { Scene3dView as Scene3dPanel } from '../scene3d/Scene3dView'
import { isEndEffectorTrack, speedLanes } from '../timeline/end-effector'
import type { QualityCheckEvent, TaskEvent } from '../timeline/events'
import { buildJointGroups } from '../timeline/joint-lanes'
import { formatSeconds } from '../timeline/timeline'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { useTracks } from '../timeline/use-tracks'
import { usePlaybackStore } from '../playback/store'
import type { ViewSpec } from './catalog'
import { ImageView } from '../image/ImageView'
import { describeBinding, resolveBindings, viewTitle, visibleChannels } from './layout-model'
import { useViewComposition } from './view-context'
import { Hint } from '../ui/Hint'
import { OnAxisOrEmpty } from './OnAxisOrEmpty'

function ofKind(channels: ChannelInfo[], kind: ChannelInfo['kind']) {
  return channels.filter((channel) => channel.kind === kind)
}

type Scene3dView = Extract<ViewSpec, { type: 'scene3d' }>

// 3D场景: 基座标系与同步视角的切换经`updateView`存本地
function Scene3dContent({
  viewId,
  view,
  channels,
  isActive,
}: {
  viewId: string
  view: Scene3dView
  channels: ChannelInfo[]
  isActive: boolean
}) {
  const { playback, updateView } = useViewComposition()
  return (
    <Scene3dPanel
      channels={channels}
      clock={playback.clock}
      isActive={isActive}
      frame={view.frame}
      onFrameChange={(frame) => updateView(viewId, (current) => ({ ...current, frame }) as ViewSpec)}
      syncCamera={view.syncCamera ?? false}
      onSyncCameraChange={(syncCamera) => updateView(viewId, (current) => ({ ...current, syncCamera }) as ViewSpec)}
    />
  )
}

function SeriesContent({ channels }: { channels: ChannelInfo[] }) {
  const { timeline, playback } = useViewComposition()
  const tracks = useTracks(channels)
  const lanes = useMemo(() => speedLanes(tracks.filter(isEndEffectorTrack)), [tracks])
  const jointGroups = useMemo(() => buildJointGroups(tracks.filter((track) => !isEndEffectorTrack(track))), [tracks])
  return (
    <OnAxisOrEmpty hasData={tracks.length > 0}>
      <TimelinePanel
        playback={playback}
        duration={timeline.duration}
        stepTimes={timeline.stepTimes}
        qualityCheckEvents={null}
        lanes={lanes}
        jointGroups={jointGroups}
        hasPlaybackControls={false}
      />
    </OnAxisOrEmpty>
  )
}

// 事件: 事件通道`type`为`task`的是任务事件, 其余为质检结果的事件
function EventsContent({ channels }: { channels: ChannelInfo[] }) {
  const { timeline, playback } = useViewComposition()
  const { state } = useDataSource()
  const events = ofKind(channels, 'events')
  const boundQualityCheckEvents = useChannelPayloads<QualityCheckEvent>(
    state,
    events.filter((channel) => channel.type !== 'task').map((channel) => channel.id),
  )
  const boundTaskEvents = useChannelPayloads<TaskEvent>(
    state,
    events.filter((channel) => channel.type === 'task').map((channel) => channel.id),
  )
  // 各通道按时刻排好, 跨通道再排一次
  const qualityCheckEvents = useMemo(
    () => [...boundQualityCheckEvents].sort((first, second) => first.start - second.start),
    [boundQualityCheckEvents],
  )
  const taskEvents = useMemo(
    () => [...boundTaskEvents].sort((first, second) => first.time - second.time),
    [boundTaskEvents],
  )
  return (
    <OnAxisOrEmpty hasData={qualityCheckEvents.length > 0 || taskEvents.length > 0}>
      <TimelinePanel
        playback={playback}
        duration={timeline.duration}
        stepTimes={timeline.stepTimes}
        qualityCheckEvents={qualityCheckEvents}
        taskEvents={taskEvents}
        lanes={[]}
        jointGroups={[]}
        hasPlaybackControls={false}
      />
    </OnAxisOrEmpty>
  )
}

// 悬停时刻读数: 图像与3D没有时间轴, 悬停在任一时间轴上时在角上标出该时刻
function HoverTimeBadge() {
  const hoverTime = usePlaybackStore((state) => state.hoverTime)
  if (hoverTime === null) return null
  return (
    <span className="pointer-events-none absolute top-1 right-2 z-10 rounded-sm bg-surface-2/90 px-1.5 font-mono text-xs text-foreground-secondary">
      悬停{formatSeconds(hoverTime)}
    </span>
  )
}

// 图层开关与缺层说明: 每条绑定一个开关, 镜次里没匹配到的标为缺
function LayerBar({ viewId, view, catalog }: { viewId: string; view: ViewSpec; catalog: ChannelInfo[] }) {
  const { setBindingVisible } = useViewComposition()
  const resolved = resolveBindings(view, catalog)
  return (
    <ul aria-label="图层" className="flex shrink-0 flex-wrap items-center gap-1 px-1 text-xs">
      {resolved.map(({ binding, isVisible, channels }, index) => (
        <li key={index}>
          {channels.length === 0 ? (
            <Hint text="数据源没有这一图层">
              <span className="rounded-sm px-1.5 py-0.5 text-foreground-tertiary line-through">缺{describeBinding(binding)}</span>
            </Hint>
          ) : (
            <button
              type="button"
              aria-pressed={isVisible}
              className={`press rounded-sm border px-1.5 py-0.5 ${isVisible ? 'border-line-strong text-foreground' : 'border-transparent text-foreground-tertiary'}`}
              onClick={() => setBindingVisible(viewId, index, !isVisible)}
            >
              {describeBinding(binding)}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}

function MissingLayers({ view }: { view: ViewSpec }) {
  return (
    <div role="status" className="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground">
      <div className="flex flex-col gap-1">
        <p>数据源缺少此视图所需的图层</p>
        <ul className="text-xs text-foreground-tertiary">
          {view.layers.map((binding, index) => (
            <li key={index}>{describeBinding(binding)}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * 一个视图面板 (Workspace的tab内容): 按视图类型画内容, 顶上一行图层开关. 视图要的图层镜次一个都没有时显示缺层空状态.
 * 面板自带`region`与视图标题作可访问名. tab未选中, 所在tabset折叠或被最大化的tabset盖住时, 3D场景暂停重画.
 * 新视图类型: 先在`catalog.ts`加schema, 再在这里的`switch`加一支内容组件.
 */
export function ViewPanel({ viewId }: { viewId: string }) {
  const { views } = useViewComposition()
  const { state } = useDataSource()
  const catalog = useCatalog(state)
  const isVisible = useParentTabState()?.isVisible ?? true
  const view = views[viewId] as ViewSpec | undefined
  // 通道随视图与目录不变时保持同一引用, 别的视图改动 (加面板, 开关别处图层) 不让3D场景重建
  const channels = useMemo(() => (view ? visibleChannels(view, catalog) : []), [view, catalog])
  if (!view)
    return (
      <section aria-label={viewId} className="absolute inset-0 p-2 text-sm text-muted-foreground">
        布局里没有视图"{viewId}"
      </section>
    )

  const hasAnyChannel = resolveBindings(view, catalog).some((resolved) => resolved.channels.length > 0)
  let content: ReactNode
  switch (view.type) {
    case 'image':
      content = <ImageView channels={channels} isActive={isVisible} />
      break
    case 'scene3d':
      content = <Scene3dContent viewId={viewId} view={view} channels={channels} isActive={isVisible} />
      break
    case 'series':
      content = <SeriesContent channels={channels} />
      break
    case 'events':
      content = <EventsContent channels={channels} />
      break
    case 'message':
      content = <MessageView channels={channels} />
      break
  }
  return (
    <section aria-label={viewTitle(view)} className="absolute inset-0 flex min-h-0 flex-col gap-1 bg-surface-1 p-1">
      <LayerBar viewId={viewId} view={view} catalog={catalog} />
      <div className="relative min-h-0 flex-1">
        {hasAnyChannel ? content : <MissingLayers view={view} />}
        {hasAnyChannel && (view.type === 'image' || view.type === 'scene3d') && <HoverTimeBadge />}
      </div>
    </section>
  )
}
