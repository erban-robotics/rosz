// rosz-ui 的对外接口. 纯TS部分 (状态, 时钟, 时刻换算) 不依赖React; React侧为Provider, 钩子与面板

// 数据源: 领域类型, 状态, 时钟与时刻换算
export type {
  ChannelFrames,
  ChannelInfo,
  ChannelKind,
  ChannelStats,
  DemandWindow,
  ImagePayload,
  MessagePayload,
  Sample,
  SourceMode,
  TimeAxis,
  TimeRange,
} from './data-source/types'
export { createDataSourceState, type DataSourceOptions, type DataSourceState } from './data-source/state'
export { nanosecondsAt, type PlaybackClock, secondsAt } from './data-source/clock'
export { compareTimes, type FrameTimes, frameTimesOn, onAxis, WHOLE_TIMELINE } from './data-source/time-axis'
export {
  type DataSource,
  DataSourceContext,
  useAxis,
  useCatalog,
  useChannelPayloads,
  useChannels,
  useChannelStats,
  useDataSource,
  useDiscontinuity,
} from './data-source/react'

// 播放: 时钟的驱动 (回放与实时), 控件, 快捷键, 界面状态
export { type Playback, useClockListener, useClockSelector, useLivePlayback, usePlayback } from './playback/use-playback'
export { PlaybackControls } from './playback/PlaybackControls'
export { usePlaybackShortcuts } from './playback/use-playback-shortcuts'
export {
  type LayoutState,
  type LocalLayout,
  type PlaybackState,
  type SceneCamera,
  useLayoutStore,
  usePlaybackStore,
} from './playback/store'

// 视图组装与布局描述
export { ViewComposition } from './views/ViewComposition'
export { ViewPanel } from './views/ViewPanel'
export { ViewCompositionContext, type ViewCompositionContextValue, useViewComposition } from './views/view-context'
export {
  type LayerBinding,
  type LayoutDescription,
  type LayoutNode,
  type LayoutParseResult,
  layoutJsonSchema,
  parseLayoutDescription,
  referencedViews,
  type ViewSpec,
  type ViewType,
  VIEW_LAYER_KINDS,
  VIEW_TYPE_LABELS,
} from './views/catalog'
export { autoLayout, bindingKindOf, describeBinding, matchesBinding, resolveBindings, visibleChannels } from './views/layout-model'
export { axisTimeline } from './views/axis-timeline'

// 面板与其数据形状
export { ImageView } from './image/ImageView'
export { decodeImage, type DecodedFrame, isDepthFormat } from './image/decode'
export { isVideoFormat } from './image/video-keyframes'
export {
  type ImageOverlay,
  isOverlayKind,
  type KeypointsFrame,
  OVERLAY_LAYER_KINDS,
  type OverlayKind,
  parseOverlayContent,
  type SegmentationFrame,
} from './image/image-overlay'
export {
  type DrawableSpatialLayer,
  isSpatialKind,
  type Keypoints3dSample,
  parseSpatialContent,
  type PackedPointCloudSample,
  type PointCloudSample,
  type PoseSample,
  SPATIAL_LAYER_KINDS,
  type SpatialKind,
  type SpatialLayer,
  type TransformEdge,
  type TransformsSample,
} from './scene3d/spatial-layers'
export { POINT_CLOUD2, rosSpatialKind, TF_MESSAGE } from './scene3d/ros-spatial'
export { spatialKindOf } from './scene3d/scene-layers'
export { Scene3dView } from './scene3d/Scene3dView'
export { TimelinePanel } from './timeline/TimelinePanel'
export {
  type EventCategoryDefinition,
  type EventKind,
  eventKindOf,
  type QualityCheckEvent,
  type TaskEvent,
} from './timeline/events'
export { columnsOf, type SeriesTrack } from './timeline/series'
export { formatSeconds, latestIndexAtOrBefore } from './timeline/timeline'
export { MessageView } from './message/MessageView'
export { ChannelList } from './channels/ChannelList'
export { type DecodedMessage, loadedRosz, loadRosz, type Rosz } from './message/rosz'

// 悬停提示的Provider: 应用骨架挂一个 (面板里的提示须在其内)
export { HintProvider } from './ui/Hint'
