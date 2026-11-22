import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { latestIndexAtOrBefore } from '../timeline/timeline'
import type { LayoutNode, ViewSpec } from '../views/catalog'

export type TimeRange = { start: number; end: number }

// 3D场景的视角: 相机位置与环绕中心 (米, 场景坐标); `sourceId`为发出这一视角的面板, 面板据此不回应自己
export type SceneCamera = {
  position: [number, number, number]
  target: [number, number, number]
  sourceId: string
}

/**
 * 回放与指针等高频界面状态, 全应用一份, 不存本地. 与`useLayoutStore`分开: 带`persist`的store每次`set`都同步写一遍localStorage,
 * 这里的时刻, 悬停, 3D视角每个动画帧或指针事件都变, 放进去会每帧序列化并写盘.
 * 播放时刻`time`每个动画帧都变, 不要用选择器订阅它: 高频消费者用`use-playback.ts`的`useClockListener`直接改DOM/场景, 只关心派生量的用`useClockSelector`.
 */
export type PlaybackState = {
  // 回放: 会话时间轴上的当前时刻 (秒), 由`usePlayback`驱动推进
  time: number
  duration: number
  isPlaying: boolean
  speed: number
  // 循环播放的区间; 跳到区间外即解除, 区间内跳转仍循环
  loop: TimeRange | null
  // 指针悬停处的时刻, 各面板同显指示线; 不在时间轴上为null
  hoverTime: number | null
  // 时刻不连续变化 (跳转, 步进, 区间播放, 回到开头, 循环回绕) 的次数, 回放的数据源状态据此记不连续
  jumpCount: number
  // 记一次不连续; 时钟推进中的循环回绕调它
  markJump: () => void

  setSpeed: (speed: number) => void
  togglePlaying: () => void
  seek: (time: number) => void
  // 按步进时刻前后各一帧, 并暂停
  step: (direction: 1 | -1, stepTimes: number[]) => void
  // 跳到区间起点并循环播放该区间
  playRange: (range: TimeRange) => void
  clearLoop: () => void
  setHoverTime: (time: number | null) => void
  // 回到初始状态 (时刻0, 暂停, 1倍速, 无循环, 无悬停), 时长保留
  resetPlayback: () => void

  // 3D视角同步: 开了同步视角的3D面板拖动时写入, 其余开了同步的面板跟随
  sceneCamera: SceneCamera | null
  setSceneCamera: (camera: SceneCamera) => void
}

/**
 * 跨面板界面状态, 全应用一份, 部分字段存localStorage. 按区块分组 (导航, 会话面板, 本地布局, 暂存裁决), 新区块照样并列加字段与操作;
 * 高频变化的状态不放这里, 放`usePlaybackStore`.
 * 组件按需用选择器订阅 (`useUiStore((state) => state.isSessionPanelOpen)`), 只在所选值变了才重渲.
 */
// 步进时把当前时刻略往后放, 免得浮点误差让正好停在帧上的时刻落到前一帧
const STEP_EPSILON_SECONDS = 1e-6

const INITIAL_PLAYBACK = { time: 0, isPlaying: false, speed: 1, loop: null, hoverTime: null }

export const usePlaybackStore = create<PlaybackState>()((set, get) => {
  const clamp = (value: number) => Math.min(Math.max(value, 0), get().duration)
  const jumped = () => ({ jumpCount: get().jumpCount + 1 })
  return {
    ...INITIAL_PLAYBACK,
    duration: 0,
    jumpCount: 0,
    markJump: () => set(jumped()),

    setSpeed: (speed) => set({ speed }),
    togglePlaying: () => {
      const { isPlaying, loop, time, duration } = get()
      // 停在末尾时从头播
      if (!isPlaying && loop === null && time >= duration) set({ time: 0, ...jumped() })
      set({ isPlaying: !isPlaying })
    },
    seek: (target) => {
      const next = clamp(target)
      const { loop } = get()
      if (loop !== null && (next < loop.start || next > loop.end)) set({ loop: null })
      set({ time: next, ...jumped() })
    },
    step: (direction, stepTimes) => {
      set({ isPlaying: false, loop: null })
      if (stepTimes.length === 0) return
      const index = latestIndexAtOrBefore(stepTimes, get().time + STEP_EPSILON_SECONDS)
      const target = Math.min(Math.max(index + direction, 0), stepTimes.length - 1)
      set({ time: stepTimes[target], ...jumped() })
    },
    // 以传入区间为准, 不按总长夹紧: 复核页在视图组装写入总长之前就会调它; 总长写入后超出的由视图组装夹紧
    playRange: (range) => set({ loop: range, time: Math.max(range.start, 0), isPlaying: true, ...jumped() }),
    clearLoop: () => set({ loop: null }),
    setHoverTime: (hoverTime) => set({ hoverTime }),
    resetPlayback: () => set({ ...INITIAL_PLAYBACK, ...jumped() }),

    sceneCamera: null,
    setSceneCamera: (sceneCamera) => set({ sceneCamera }),
  }
})

/**
 * 人在本浏览器对某布局范围的调整: 拖动, 缩放, 加面板, 图层开关. 叠在`base` (默认布局或自动排布的描述序列化) 之上;
 * 默认布局变了 (`base`不同) 即作废, 回到新的默认.
 */
export type LocalLayout = {
  base: string
  // 视图表: 起自默认布局, 含人加的视图与图层开关
  views: Record<string, ViewSpec>
  // 人调过的布局树 (拖动, 缩放, 加面板后的); null即按默认布局树排
  layout: LayoutNode | null
}

// 本地布局: 布局范围 (如ADP的`data-kind/3`, 查看器的`viewer`) -> 本浏览器的调整, 存localStorage
export type LayoutState = {
  localLayouts: Record<string, LocalLayout>
  saveLocalLayout: (scope: string, layout: LocalLayout) => void
  clearLocalLayout: (scope: string) => void
}

const LOCAL_LAYOUTS_STORAGE_KEY = 'rosz-ui.local-layouts'

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      localLayouts: {},
      saveLocalLayout: (scope, layout) => set({ localLayouts: { ...get().localLayouts, [scope]: layout } }),
      clearLocalLayout: (scope) => {
        const rest = { ...get().localLayouts }
        delete rest[scope]
        set({ localLayouts: rest })
      },
    }),
    { name: LOCAL_LAYOUTS_STORAGE_KEY, storage: createJSONStorage(() => localStorage) },
  ),
)
