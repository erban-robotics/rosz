import { Pin, Plus, RotateCcw, X } from 'lucide-react'
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import {
  type HiddenTabBehavior,
  type Orientation,
  Separator,
  type TabNode,
  type TabRenderProps,
  TabCloseButton,
  Workspace,
  type WorkspaceChangedMeta,
  type WorkspaceImperativeHandle,
  useWorkspaceRef,
} from 'react-resizable-panels'
import { FailureAlert } from '../ui/FailureAlert'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { OptionSelect } from '../ui/OptionSelect'
import { type DataSource, DataSourceContext, useAxis, useCatalog } from '../data-source/react'
import type { ChannelInfo, TimeAxis } from '../data-source/types'
import { PlaybackControls } from '../playback/PlaybackControls'
import type { Playback } from '../playback/use-playback'
import { usePlaybackShortcuts } from '../playback/use-playback-shortcuts'
import { type LocalLayout, useLayoutStore, usePlaybackStore } from '../playback/store'
import {
  type LayoutDescription,
  type LayoutNode,
  parseLayoutDescription,
  VIEW_TYPE_LABELS,
  type ViewSpec,
  type ViewType,
} from './catalog'
import {
  autoLayout,
  createView,
  fromWorkspaceModel,
  hiddenTabBehaviorFor,
  toWorkspaceModel,
  type ViewWorkspaceModel,
  viewTitle,
} from './layout-model'
import { axisTimeline } from './axis-timeline'
import { ViewCompositionContext } from './view-context'
import { ViewPanel } from './ViewPanel'

// 分割线, tab, 拖放提示的样式在index.css的"视图区"一段, 按Workspace的data属性写
function renderTab(tab: TabNode<null>, props: TabRenderProps) {
  return (
    <div {...props}>
      <span className="truncate">{tab.title}</span>
      <TabCloseButton aria-label={`关闭${tab.title}`} className="view-tab-close">
        <X aria-hidden className="size-3" />
      </TabCloseButton>
    </div>
  )
}

function renderSeparator(orientation: Orientation) {
  return <Separator className="view-separator" data-split-orientation={orientation} />
}

function renderTabContent(tab: TabNode<null>) {
  return <ViewPanel viewId={tab.id} />
}

function InvalidLayout({ issues }: { issues: string[] }) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md border border-status-danger/40 p-3 text-sm">
      <p className="font-medium text-status-danger">布局描述不合视图类型目录的schema, 未渲染</p>
      <ul className="list-disc pl-5 font-mono text-xs text-foreground-secondary">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  )
}

// 起始布局: 本地存的布局树 (叠在同一默认布局上, 且与视图表合得上) 优先, 存下的坏了就回到默认
function initialModel(base: LayoutDescription, stored: LocalLayout | undefined, baseKey: string): ViewWorkspaceModel {
  if (stored?.base === baseKey && stored.layout) {
    const parsed = parseLayoutDescription({ version: base.version, views: stored.views, layout: stored.layout })
    if (parsed.success) return toWorkspaceModel(parsed.description)
  }
  return toWorkspaceModel(base)
}

// Workspace只在挂上时读起始模型, 之后的变化经workspaceRef改; 换布局范围或默认布局时由key重挂
function ViewWorkspace({
  initialModel: readInitialModel,
  workspaceRef,
  onModelChanged,
  hiddenTabBehavior,
}: {
  initialModel: () => ViewWorkspaceModel
  workspaceRef: RefObject<WorkspaceImperativeHandle<null> | null>
  onModelChanged: (model: ViewWorkspaceModel, meta: WorkspaceChangedMeta) => void
  hiddenTabBehavior: (tab: TabNode<null>) => HiddenTabBehavior
}) {
  const [defaultModel] = useState(readInitialModel)
  return (
    <Workspace
      className="view-workspace"
      defaultModel={defaultModel}
      workspaceRef={workspaceRef}
      onModelChanged={onModelChanged}
      hiddenTabBehavior={hiddenTabBehavior}
      renderTab={renderTab}
      renderSeparator={renderSeparator}
      renderTabContent={renderTabContent}
      tabRemovalSelectionBehavior="recent"
    />
  )
}

const AXIS_OPTIONS: { value: TimeAxis; label: string }[] = [
  { value: 'receive', label: '接收时间' },
  { value: 'sample', label: '采样时间' },
]

function uniqueViewId(type: ViewType, views: Record<string, ViewSpec>) {
  let index = 1
  while (`${type}-${index}` in views) index += 1
  return `${type}-${index}`
}

const NO_STEPS: number[] = []

/**
 * 所选时间轴上的总长与步进时刻, 按通道目录算 (见`axisTimeline`). 两轴共用会话零点, 同一秒数即同一绝对时刻.
 * 离线时播放store的总长 (时钟按它停, 跳转按它夹紧) 只由这里写: 总长一变即写入并就地夹紧播放头.
 * 实时的总长由`useLivePlayback`随播放头写, 这里只读, 无步进.
 */
function useAxisTimeline(dataSource: DataSource, catalog: ChannelInfo[], axis: TimeAxis) {
  const isLive = dataSource.state.mode() === 'live'
  const offline = useMemo(
    () => (isLive ? null : axisTimeline(catalog, axis, dataSource.zero)),
    [isLive, catalog, axis, dataSource.zero],
  )
  // 实时总长每帧都变, 取整秒再订阅, 免得整个视图组装每帧重渲
  const liveDuration = usePlaybackStore((state) => (isLive ? Math.ceil(state.duration) : 0))
  const timeline = useMemo(() => offline ?? { duration: liveDuration, stepTimes: NO_STEPS }, [offline, liveDuration])
  useLayoutEffect(() => {
    if (isLive) return
    const store = usePlaybackStore.getState()
    if (store.duration === timeline.duration) return
    usePlaybackStore.setState({ duration: timeline.duration })
    if (store.time > timeline.duration) store.seek(timeline.duration)
  }, [isLive, timeline.duration])
  return timeline
}

// 播放时钟的每次不连续 (store的`jumpCount`: 跳转, 步进, 循环回绕) 转记到数据源状态
function useJumpsAsDiscontinuity(dataSource: DataSource) {
  useEffect(() => {
    return usePlaybackStore.subscribe((current, previous) => {
      if (current.jumpCount !== previous.jumpCount) dataSource.state.markDiscontinuity()
    })
  }, [dataSource])
}

/**
 * 视图组装: 一组可拖动, 分裂, 叠tab, 调大小的视图面板 (react-resizable-panels的`Workspace`), 顶上是播放控件.
 * 数据只经`dataSource` (状态与会话零点): 面板按通道目录与布局绑定选通道, 读状态与播放时钟; 适配器在外面写状态.
 * 离线有播放控件与时间轴切换 (接收/采样); 实时 (状态为`live`, `playback`来自`useLivePlayback`) 只有接收时间轴, 不显示播放控件.
 * 布局取`layout` (默认布局, 先过schema, 不合即不渲染); 没给则按目录已有通道自动排布.
 * 人的拖动, 缩放, 加面板, 图层开关, 视图参数修改存本地 (`useLayoutStore`的`localLayouts`, 按`scope`分; 存回译后的布局树与视图表), 叠在默认布局之上; 默认布局变了即作废.
 * 给了`onSetDefault`即显示"设为默认", 把当前布局 (默认布局叠上本地调整) 回译成布局描述交给调用方.
 * 撑满调用方给的高度. 快捷键空格播放/暂停, 左右方向键逐帧.
 */
export function ViewComposition({
  dataSource,
  playback,
  scope,
  layout,
  onSetDefault,
  isLoading = false,
  error = null,
}: {
  dataSource: DataSource
  playback: Playback
  // 本地调整的归属, 如ADP同一数据格式的录制共用`data-kind/3`
  scope: string
  // 默认布局 (未经校验的JSON); undefined即无默认布局
  layout?: unknown
  // 把当前布局设为默认布局; 不给即不显示该按钮
  onSetDefault?: (description: LayoutDescription) => void
  // 适配器在取通道目录时为true, 取失败时给error
  isLoading?: boolean
  error?: Error | null
}) {
  const isLive = dataSource.state.mode() === 'live'
  const catalog = useCatalog(dataSource.state)
  const axis = useAxis(dataSource.state)
  const timeline = useAxisTimeline(dataSource, catalog, axis)
  useJumpsAsDiscontinuity(dataSource)
  usePlaybackShortcuts(playback, timeline.stepTimes)
  const parsed = useMemo(() => (layout === undefined ? null : parseLayoutDescription(layout)), [layout])
  const automatic = useMemo(() => autoLayout(catalog), [catalog])
  const base: LayoutDescription | null = parsed ? (parsed.success ? parsed.description : null) : automatic
  const baseKey = useMemo(() => JSON.stringify(base), [base])
  const local = useLayoutStore((state) => state.localLayouts[scope])
  const saveLocalLayout = useLayoutStore((state) => state.saveLocalLayout)
  const clearLocalLayout = useLayoutStore((state) => state.clearLocalLayout)
  const workspaceRef = useWorkspaceRef<null>()

  // 本地调整只在默认布局没变时生效
  const views = useMemo(() => (local?.base === baseKey ? local.views : (base?.views ?? {})), [local, baseKey, base])

  // 读最新的本地视图表 (Workspace回调里用, 免得拿到旧闭包)
  const currentViews = useCallback(() => {
    const stored = useLayoutStore.getState().localLayouts[scope]
    return stored?.base === baseKey ? stored.views : (base?.views ?? {})
  }, [scope, baseKey, base])

  const save = useCallback(
    (nextViews: Record<string, ViewSpec>, layoutTree: LayoutNode | null) =>
      saveLocalLayout(scope, { base: baseKey, views: nextViews, layout: layoutTree }),
    [saveLocalLayout, scope, baseKey],
  )

  // 当前布局树: Workspace已挂上取它的模型回译, 否则取存下的
  const currentLayout = useCallback(() => {
    const model = workspaceRef.current?.getModel()
    if (model) return fromWorkspaceModel(model, currentViews())?.layout ?? null
    const stored = useLayoutStore.getState().localLayouts[scope]
    return stored?.base === baseKey ? (stored.layout ?? null) : null
  }, [workspaceRef, currentViews, scope, baseKey])

  const updateView = useCallback(
    (viewId: string, change: (view: ViewSpec) => ViewSpec) => {
      const previous = currentViews()
      const view = previous[viewId]
      if (!view) return
      save({ ...previous, [viewId]: change(view) }, currentLayout())
    },
    [currentViews, currentLayout, save],
  )

  const setBindingVisible = useCallback(
    (viewId: string, bindingIndex: number, isVisible: boolean) =>
      updateView(viewId, (view) => {
        const layers = view.layers.map((binding, index) => (index === bindingIndex ? { ...binding, visible: isVisible } : binding))
        return { ...view, layers } as ViewSpec
      }),
    [updateView],
  )

  // 人拖动, 缩放, 切tab, 加或关面板后存本地; "恢复默认布局"的整体替换 (set-model) 不存, 本地调整保持清空
  const onModelChanged = useCallback(
    (model: ViewWorkspaceModel, meta: WorkspaceChangedMeta) => {
      if (meta.reason === 'set-model') return
      save(currentViews(), fromWorkspaceModel(model, currentViews())?.layout ?? null)
    },
    [save, currentViews],
  )

  const hiddenTabBehavior = useCallback(
    (tab: TabNode<null>) => hiddenTabBehaviorFor(currentViews()[tab.id]?.type),
    [currentViews],
  )

  function addView(type: ViewType) {
    const workspace = workspaceRef.current
    if (!workspace) return
    const previous = currentViews()
    const id = uniqueViewId(type, previous)
    const view = createView(type, catalog)
    // 先存视图表, tab挂上时即能取到; 布局变化随后由onModelChanged存下
    save({ ...previous, [id]: view }, currentLayout())
    workspace.addTab({ id, title: viewTitle(view), data: null })
  }

  function setDefault() {
    const workspace = workspaceRef.current
    if (!workspace || !onSetDefault) return
    const description = fromWorkspaceModel(workspace.getModel(), currentViews())
    if (description) onSetDefault(description)
  }

  function restoreDefault() {
    clearLocalLayout(scope)
    if (base) workspaceRef.current?.setModel(toWorkspaceModel(base))
  }

  const context = useMemo(
    () => ({ timeline, playback, views, setBindingVisible, updateView }),
    [timeline, playback, views, setBindingVisible, updateView],
  )

  if (error) return <FailureAlert title="数据加载失败" error={error} />
  if (isLoading) return <p className="text-sm text-muted-foreground">数据加载中</p>
  if (parsed && !parsed.success) return <InvalidLayout issues={parsed.issues} />
  if (!base) return <p className="text-sm text-muted-foreground">没有可显示的通道</p>

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {!isLive && (
          <>
            <PlaybackControls playback={playback} duration={timeline.duration} stepTimes={timeline.stepTimes} />
            <OptionSelect
              aria-label="时间轴"
              size="sm"
              className="h-7! px-2 text-xs"
              value={axis}
              onChange={(next) => dataSource.state.setAxis(next as TimeAxis)}
              options={AXIS_OPTIONS}
            />
          </>
        )}
        <span className="ml-auto hidden text-xs text-muted-foreground xl:inline">
          {isLive ? '拖动面板tab重排 · 拖分界线调大小' : '空格播放 · ←→逐帧 · 拖动面板tab重排 · 拖分界线调大小'}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus />
              添加视图
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(VIEW_TYPE_LABELS) as ViewType[]).map((type) => (
              <DropdownMenuItem key={type} onSelect={() => addView(type)}>
                {VIEW_TYPE_LABELS[type]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="sm" onClick={restoreDefault}>
          <RotateCcw />
          恢复默认布局
        </Button>
        {onSetDefault && (
          <Button variant="ghost" size="sm" onClick={setDefault}>
            <Pin />
            设为默认
          </Button>
        )}
      </div>
      <ViewCompositionContext.Provider value={context}>
        <DataSourceContext.Provider value={dataSource}>
          <div className="min-h-0 flex-1">
            <ViewWorkspace
              key={`${scope}/${baseKey}`}
              initialModel={() => initialModel(base, useLayoutStore.getState().localLayouts[scope], baseKey)}
              workspaceRef={workspaceRef}
              onModelChanged={onModelChanged}
              hiddenTabBehavior={hiddenTabBehavior}
            />
          </div>
        </DataSourceContext.Provider>
      </ViewCompositionContext.Provider>
    </div>
  )
}
