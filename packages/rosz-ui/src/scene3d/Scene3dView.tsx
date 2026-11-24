import { lazy, Suspense, useEffect, useId, useMemo, useState } from 'react'
import { useAxis, useCatalog, useChannels, useDataSource, useDiscontinuity } from '../data-source/react'
import { WHOLE_TIMELINE } from '../data-source/time-axis'
import type { DataSourceState } from '../data-source/state'
import type { ChannelInfo } from '../data-source/types'
import { loadedRosz, loadRosz, type Rosz } from '../message/rosz'
import type { PlaybackClock } from '../playback/use-playback'
import { isEndEffectorTrack, tcpTracks } from '../timeline/end-effector'
import { useTracks } from '../timeline/use-tracks'
import { Hint } from '../ui/Hint'
import { OptionSelect } from '../ui/OptionSelect'
import { OnAxisOrEmpty } from '../views/OnAxisOrEmpty'
import { rosSpatialKind } from './ros-spatial'
import { buildSceneLayer, layerFrame, type SceneLayer, type SceneTransformLayer, spatialKindOf } from './scene-layers'
import { frameGraph, transformIndex } from './tf-graph'

// three.js与r3f体积大, 3D场景单独分块按需加载
const Scene3d = lazy(() => import('./Scene3d').then((module) => ({ default: module.Scene3d })))

type Build = ReturnType<typeof buildSceneLayer>
// 按数据源, 通道缓存换算结果
const buildCache = new WeakMap<DataSourceState, Map<string, { stamp: string; info: ChannelInfo; build: Build }>>()

function buildsOf(state: DataSourceState) {
  let builds = buildCache.get(state)
  if (!builds) {
    builds = new Map()
    buildCache.set(state, builds)
  }
  return builds
}

// ROS类型的空间通道 (CDR) 要用解码模块: 用到时加载, 加载完重渲
function useRoszWhen(isNeeded: boolean): Rosz | null {
  const [rosz, setRosz] = useState(loadedRosz)
  useEffect(() => {
    if (!isNeeded || rosz) return
    let isDisposed = false
    void loadRosz().then(
      (loaded) => {
        if (!isDisposed) setRosz(loaded)
      },
      (reason: Error) => console.warn('解码模块加载失败', reason),
    )
    return () => {
      isDisposed = true
    }
  }, [isNeeded, rosz])
  return rosz
}

/**
 * 3D场景视图: 把末端位置序列与空间通道画进3D场景, 顶上一行基座标系选择, 同步视角开关 (给了`onSyncCameraChange`才有) 与提示.
 * 读`DataSourceContext`的数据源, 视图组装里的3D场景与查看器的3D面板都用它.
 *
 * - TF树由目录里全部坐标变换通道合成 (不必在`channels`里, 只画`channels`里的); 位姿, 点云, 3D关键点与轨迹按其坐标系经TF树
 *   换算到基座标系, 不在同一棵树上的不画并标出
 * - 基座标系: 给了`frame`即用它, 否则为人在下拉里选的 (仍在树里时), 再否则取坐标系最多的那棵树的根
 * - 实时数据源下为这些通道 (含全部坐标变换通道) 设需求窗口, 适配器据此订阅; 面板藏起时清掉. 离线由适配器照常写入
 * - 数据更新只重算变了的通道, 视角不复位; 换了图层或基座标系才重新取景
 * - 实时数据源下一帧至多重算一次 (TF可达几百Hz), 坐标变换只留各子坐标系最新的一条 (播放头总在最新处, 旧的画不到)
 */
export function Scene3dView({
  channels,
  clock,
  isActive = true,
  frame,
  onFrameChange,
  syncCamera = false,
  onSyncCameraChange,
}: {
  // 要画的通道: 末端位置序列与空间通道, 其余忽略
  channels: ChannelInfo[]
  clock: PlaybackClock
  isActive?: boolean
  frame?: string
  onFrameChange?: (frame: string) => void
  syncCamera?: boolean
  onSyncCameraChange?: (syncCamera: boolean) => void
}) {
  const { state, zero } = useDataSource()
  const axis = useAxis(state)
  const discontinuity = useDiscontinuity(state)
  const catalog = useCatalog(state)
  const isLive = state.mode() === 'live'
  const tracks = useTracks(channels)
  const sceneTracks = useMemo(() => tcpTracks(tracks.filter(isEndEffectorTrack)), [tracks])

  const spatialChannels = useMemo(() => channels.filter((channel) => channel.kind === 'spatial'), [channels])
  const transformChannels = useMemo(
    () => catalog.filter((channel) => spatialKindOf(channel) === 'transform' && !channel.undecodable),
    [catalog],
  )
  const usedChannels = useMemo(() => {
    const byId = new Map([...spatialChannels, ...transformChannels].map((channel) => [channel.id, channel]))
    return [...byId.values()].filter((channel) => !channel.undecodable)
  }, [spatialChannels, transformChannels])
  const ids = useMemo(() => usedChannels.map((channel) => channel.id), [usedChannels])

  // 实时: 要这些通道 (适配器订阅); 面板藏起时不要
  const panelId = useId()
  const demandKey = isLive && isActive ? ids.join('\n') : ''
  useEffect(() => {
    if (!isLive) return
    state.setDemand(panelId, demandKey ? { channels: demandKey.split('\n'), range: WHOLE_TIMELINE } : null)
  }, [state, panelId, demandKey, isLive])
  useEffect(() => () => state.setDemand(panelId, null), [state, panelId])

  const rosz = useRoszWhen(usedChannels.some((channel) => rosSpatialKind(channel.type) !== null))
  // 实时TF可达几百Hz, 每条都重渲 (每次重算都扫一遍保留的样本) 主线程跟不上: 一帧至多重算一次
  useChannels(state, ids, { perFrame: isLive })
  const versions = ids.map((id) => state.version(id)).join(',')
  // 按通道缓存换算结果: 只有数据 (版本号), 目录项, 时间轴或解码模块变了的通道重算
  const builds = useMemo(() => {
    const cache = buildsOf(state)
    return new Map(
        usedChannels.map((channel) => {
          const stamp = `${state.version(channel.id)}\n${axis}\n${rosz !== null}`
          const cached = cache.get(channel.id)
          if (cached && cached.stamp === stamp && cached.info === channel) return [channel.id, cached.build]
          const samples = state.samplesIn(channel.id, WHOLE_TIMELINE)
          const build = buildSceneLayer(channel, samples, { axis, zero, rosz, latestOnly: isLive })
          cache.set(channel.id, { stamp, info: channel, build })
          return [channel.id, build]
        }),
    )
    // versions变即通道数据变了, 须重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedChannels, state, zero, axis, rosz, isLive, versions])

  const layers = useMemo(
    () => spatialChannels.flatMap((channel) => builds.get(channel.id)?.layer ?? []),
    [spatialChannels, builds],
  )
  const transforms = useMemo(
    () =>
      transformChannels.flatMap((channel) => {
        const layer = builds.get(channel.id)?.layer
        return layer?.kind === 'transform' ? [layer] : []
      }),
    [transformChannels, builds],
  )
  const declared = useMemo(
    () => [
      ...(frame ? [frame] : []),
      ...sceneTracks.flatMap((track) => (track.frame ? [track.frame] : [])),
      ...layers.flatMap((layer) => layerFrame(layer) ?? []),
    ],
    [frame, sceneTracks, layers],
  )
  const graph = useMemo(() => frameGraph(transforms, declared), [transforms, declared])
  const [chosenFrame, setChosenFrame] = useState<string | null>(null)
  const baseFrame =
    frame ?? (chosenFrame !== null && graph.frames.includes(chosenFrame) ? chosenFrame : graph.defaultFrame())
  const isDrawn = (layerFrameName: string | null) =>
    layerFrameName === null || baseFrame === null || graph.isConnected(layerFrameName, baseFrame)

  const drawnTracks = useMemo(
    () => sceneTracks.filter((track) => track.frame === null || baseFrame === null || graph.isConnected(track.frame, baseFrame)),
    [sceneTracks, baseFrame, graph],
  )
  const drawnLayers = useMemo(
    () =>
      layers.filter((layer) => {
        if (layer.kind !== 'transform') return isDrawn(layerFrame(layer))
        if (baseFrame === null) return true
        return [...transformIndex(layer)].some(([child]) => graph.isConnected(child, baseFrame))
      }),
    // isDrawn只依赖baseFrame与graph
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, baseFrame, graph],
  )

  const notes: string[] = []
  const skipped = [
    ...sceneTracks.filter((track) => !drawnTracks.includes(track)).map((track) => `${track.label}在坐标系${track.frame}`),
    ...layers
      .filter((layer) => !drawnLayers.includes(layer))
      .map((layer) => (layer.kind === 'transform' ? layer.name : `${layer.name}在坐标系${layerFrame(layer)}`)),
  ]
  if (skipped.length > 0) notes.push(`${skipped.join(', ')}, 与基座标系不连通, 未画`)
  const invalid: string[] = []
  for (const channel of spatialChannels) {
    const build = builds.get(channel.id)
    if (channel.undecodable) notes.push(`${channel.name}解不了: ${channel.undecodable}`)
    else if (channel.issue || (build && !build.layer && build.issue)) invalid.push(channel.name)
    else if (build?.isWaitingDecoder && !build.layer) notes.push(`${channel.name}等待解码模块`)
    else if (isLive && !build?.layer) notes.push(`${channel.name}等待数据`)
  }
  if (invalid.length > 0) notes.push(`${invalid.join(', ')}的内容无法识别, 未画`)
  for (const layer of drawnLayers)
    if (layer.kind === 'point_cloud') {
      const { positions, total } = layer.samples.at(-1)!.points
      if (positions.length / 3 < total) notes.push(`${layer.name}抽取${positions.length / 3}/${total}点`)
    }

  const options = [...new Set([...(frame ? [frame] : []), ...graph.frames])].sort()
  const chooseFrame = (next: string) => (onFrameChange ? onFrameChange(next) : setChosenFrame(next))
  return (
    <OnAxisOrEmpty hasData={sceneTracks.length > 0 || drawnLayers.length > 0}>
      <div className="flex h-full min-h-0 flex-col gap-1">
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-1 text-xs">
          {options.length > 0 && (
            <div className="flex items-center gap-1 text-foreground-secondary">
              基座标系
              <OptionSelect
                aria-label="基座标系"
                size="sm"
                className="h-6! px-1.5 font-mono text-xs text-foreground"
                value={baseFrame ?? ''}
                onChange={chooseFrame}
                options={options.map((option) => ({ value: option, label: option }))}
              />
            </div>
          )}
          {onSyncCameraChange && (
            <Hint text="与其他开了同步的3D场景共用视角">
              <button
                type="button"
                aria-pressed={syncCamera}
                className={`press rounded-sm border px-1.5 py-0.5 ${syncCamera ? 'border-line-strong text-foreground' : 'border-transparent text-foreground-tertiary'}`}
                onClick={() => onSyncCameraChange(!syncCamera)}
              >
                同步视角
              </button>
            </Hint>
          )}
          {notes.length > 0 && (
            <p role="status" className="text-foreground-tertiary">
              {notes.join('; ')}
            </p>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<p className="text-sm text-muted-foreground">3D视图加载中</p>}>
            <Scene3d
              tracks={drawnTracks}
              layers={drawnLayers as SceneLayer[]}
              transforms={transforms as SceneTransformLayer[]}
              baseFrame={baseFrame}
              clock={clock}
              discontinuity={discontinuity}
              isActive={isActive}
              syncCamera={syncCamera}
            />
          </Suspense>
        </div>
      </div>
    </OnAxisOrEmpty>
  )
}
