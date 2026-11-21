import { createContext, useContext } from 'react'
import type { Playback } from '../playback/use-playback'
import type { ViewSpec } from './catalog'

/**
 * 面板共享的上下文: 时间轴, 播放时钟, 当前视图表, 图层开关与视图参数的本地修改. Workspace经React portal渲染tab内容, 上下文照常穿透.
 * 数据 (通道目录与样本) 不在这里, 面板经`useDataSource()`读状态; 播放时刻经`playback.clock`读 (见`use-playback.ts`),
 * 悬停时刻从`usePlaybackStore`的`hoverTime`读.
 */
export type ViewCompositionContextValue = {
  // 所选时间轴 (见数据源状态的`axis`) 上的总长与步进时刻; 实时为已收到的时长, 无步进
  timeline: { duration: number; stepTimes: number[] }
  playback: Playback
  views: Record<string, ViewSpec>
  setBindingVisible: (viewId: string, bindingIndex: number, isVisible: boolean) => void
  // 人改视图参数 (如3D场景的基座标系与同步视角), 同图层开关一样只存本地
  updateView: (viewId: string, change: (view: ViewSpec) => ViewSpec) => void
}

export const ViewCompositionContext = createContext<ViewCompositionContextValue | null>(null)

export function useViewComposition() {
  const value = useContext(ViewCompositionContext)
  if (!value) throw new Error('ViewPanel须在ViewCompositionContext内')
  return value
}
