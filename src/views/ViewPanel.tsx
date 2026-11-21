import { lazy, type ReactNode, Suspense, useMemo } from 'react'
import { useParentTabState } from 'react-resizable-panels'
import { useAxis, useCatalog, useChannelPayloads, useDataSource, useDiscontinuity } from '../data-source/react'
import { WHOLE_TIMELINE } from '../data-source/time-axis'
import type { ChannelInfo } from '../data-source/types'
import { MessageView } from '../message/MessageView'
import { type DrawableSpatialLayer, isSpatialKind, type SpatialLayer } from '../scene3d/spatial-layers'
import { isEndEffectorTrack, speedLanes, tcpTracks } from '../timeline/end-effector'
import type { QualityCheckEvent, TaskEvent } from '../timeline/events'
import { buildJointGroups } from '../timeline/joint-lanes'
import type { SeriesTrack } from '../timeline/series'
import { formatSeconds } from '../timeline/timeline'
import { TimelinePanel } from '../timeline/TimelinePanel'
import { OptionSelect } from '../ui/OptionSelect'
import { usePlaybackStore } from '../playback/store'
import type { ViewSpec } from './catalog'
import { ImageView } from '../image/ImageView'
import { describeBinding, resolveBindings, viewTitle, visibleChannels } from './layout-model'
import { useViewComposition } from './view-context'
import { Hint } from '../ui/Hint'

// three.js与r3f体积大, 3D场景单独分块按需加载
const Scene3d = lazy(() => import('../scene3d/Scene3d').then((module) => ({ default: module.Scene3d })))

function ofKind(channels: ChannelInfo[], kind: ChannelInfo['kind']) {
  return channels.filter((channel) => channel.kind === kind)
}

// 绑定的序列: 从状态的序列通道读, 每条样本一段列, 配上通道说明; 采样轴上为空 (序列只有接收时刻)
function useTracks(channels: ChannelInfo[]): SeriesTrack[] {
  const { state } = useDataSource()
  const series = useMemo(() => ofKind(channels, 'series'), [channels])
  // 只为订阅: 序列通道数据一变 (含切轴) 即换新数组, 下面据此重取
  const payloads = useChannelPayloads(
    state,
    series.map((channel) => channel.id),
  )
  return useMemo(
    () =>
      series.flatMap((channel) =>
        state
          .samplesIn(channel.id, WHOLE_TIMELINE)
          .map((sample) => ({ channel, ...(sample.payload as Omit<SeriesTrack, 'channel'>) })),
      ),
    // payloads变即序列通道数据变了, 须重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, state, payloads],
  )
}

/**
 * 采样时间轴上没有可画的数据时显示空状态, 否则画`children`.
 * 没有采样时刻的样本 (如ADP的序列, 事件, 空间) 在采样轴上不存在.
 */
function OnAxisOrEmpty({ hasData, children }: { hasData: boolean; children: ReactNode }) {
  const { state } = useDataSource()
  const axis = useAxis(state)
  if (axis !== 'sample' || hasData) return children
  return (
    <p role="status" className="grid h-full place-items-center p-4 text-sm text-muted-foreground">
      采样时间轴上无数据: 该视图的通道只有接收时刻
    </p>
  )
}

type Scene3dView = Extract<ViewSpec, { type: 'scene3d' }>

/**
 * 3D场景: 只画在基座标系里的轨迹与空间图层, 其余标出未画 (不按坐标变换换算). 基座标系取视图的`frame`, 没给取首个声明了坐标系的图层;
 * 没声明坐标系的轨迹照画, 内容无法识别的空间图层标出. 基座标系与同步视角的切换经`updateView`存本地.
 */
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
  const { state } = useDataSource()
  const discontinuity = useDiscontinuity(state)
  const tracks = useTracks(channels)
  const spatialChannels = useMemo(() => ofKind(channels, 'spatial'), [channels])
  // 只为订阅: 空间通道数据一变 (含切轴) 即换新数组, 下面据此重取
  const spatialSamples = useChannelPayloads(
    state,
    spatialChannels.map((channel) => channel.id),
  )
  // 空间图层的说明 (种类, 名字, 坐标系) 取自通道目录, 样本取自状态; 采样轴上没有样本的不画
  const spatialLayers = useMemo(
    () =>
      spatialChannels.flatMap((channel): SpatialLayer[] => {
        const base = { channel: channel.id, name: channel.name }
        const properties = (channel.properties ?? {}) as { frame?: string; childFrame?: string }
        if (channel.issue || !isSpatialKind(channel.type) || !properties.frame)
          return [{ ...base, kind: 'invalid', frame: '', issue: channel.issue ?? `未知的空间种类${channel.type ?? ''}` }]
        const samples = state.samplesIn(channel.id, WHOLE_TIMELINE).map((sample) => sample.payload)
        if (samples.length === 0) return []
        return [
          { ...base, kind: channel.type, frame: properties.frame, childFrame: properties.childFrame ?? '', samples } as SpatialLayer,
        ]
      }),
    // spatialSamples变即空间通道数据变了, 须重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spatialChannels, state, spatialSamples],
  )
  const sceneTracks = useMemo(() => tcpTracks(tracks.filter(isEndEffectorTrack)), [tracks])
  const frames = useMemo(
    () => {
      const spatialFrames = spatialLayers.flatMap((spatial) => (spatial.kind === 'invalid' ? [] : [spatial.frame]))
      const declared = [view.frame, ...sceneTracks.map((track) => track.frame), ...spatialFrames]
      return [...new Set(declared.filter((frame) => frame != null))]
    },
    [view.frame, sceneTracks, spatialLayers],
  )
  const baseFrame = view.frame ?? frames[0] ?? null
  const drawnTracks = useMemo(
    () => sceneTracks.filter((track) => track.frame === null || baseFrame === null || track.frame === baseFrame),
    [sceneTracks, baseFrame],
  )
  const skippedTracks = sceneTracks.filter((track) => !drawnTracks.includes(track))
  const drawnSpatialLayers = useMemo(
    () =>
      spatialLayers.filter(
        (spatial): spatial is DrawableSpatialLayer =>
          spatial.kind !== 'invalid' && (baseFrame === null || spatial.frame === baseFrame),
      ),
    [spatialLayers, baseFrame],
  )
  const skippedNotes = [
    ...skippedTracks.map((track) => `${track.label}在坐标系${track.frame}`),
    ...spatialLayers.flatMap((spatial) =>
      spatial.kind !== 'invalid' && !drawnSpatialLayers.includes(spatial) ? [`${spatial.name}在坐标系${spatial.frame}`] : [],
    ),
  ]
  const invalidSpatialLayers = spatialLayers.filter((spatial) => spatial.kind === 'invalid')
  const isSynced = view.syncCamera ?? false
  return (
    <OnAxisOrEmpty hasData={sceneTracks.length > 0 || drawnSpatialLayers.length > 0}>
      <div className="flex h-full min-h-0 flex-col gap-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-1 text-xs">
          {frames.length > 0 && (
            <div className="flex items-center gap-1 text-foreground-secondary">
              基座标系
              <OptionSelect
                aria-label="基座标系"
                size="sm"
                className="h-6! px-1.5 font-mono text-xs text-foreground"
                value={baseFrame ?? ''}
                onChange={(frame) => updateView(viewId, (current) => ({ ...current, frame }) as ViewSpec)}
                options={frames.map((frame) => ({ value: frame, label: frame }))}
              />
            </div>
          )}
          <Hint text="与其他开了同步的3D场景共用视角">
            <button
              type="button"
              aria-pressed={isSynced}
              className={`press rounded-sm border px-1.5 py-0.5 ${isSynced ? 'border-line-strong text-foreground' : 'border-transparent text-foreground-tertiary'}`}
              onClick={() => updateView(viewId, (current) => ({ ...current, syncCamera: !isSynced }) as ViewSpec)}
            >
              同步视角
            </button>
          </Hint>
          {skippedNotes.length > 0 && (
            <p role="status" className="text-foreground-tertiary">
              {skippedNotes.join(', ')}, 与基座标系不符, 未画
            </p>
          )}
          {invalidSpatialLayers.length > 0 && (
            <p role="status" className="text-foreground-tertiary">
              {invalidSpatialLayers.map((spatial) => spatial.name).join(', ')}的内容无法识别, 未画
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<p className="text-sm text-muted-foreground">3D视图加载中</p>}>
            <Scene3d
              tracks={drawnTracks}
              spatialLayers={drawnSpatialLayers}
              clock={playback.clock}
              discontinuity={discontinuity}
              isActive={isActive}
              syncCamera={isSynced}
            />
          </Suspense>
        </div>
      </div>
    </OnAxisOrEmpty>
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
