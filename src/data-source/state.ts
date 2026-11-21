import { compareTimes, onAxis, WHOLE_TIMELINE } from './time-axis'
import type { ChannelInfo, ChannelStats, DemandWindow, Sample, SourceMode, TimeAxis, TimeRange } from './types'

// 淘汰时在各需求窗口之前保留的时长 (纳秒): 回退一点不必重取
const RETAIN_BEHIND_NANOSECONDS = 1_000_000_000n
// 淘汰时在各需求窗口之后保留的时长 (纳秒): 暂停时已预取的不丢, 接着播不必重取
const RETAIN_AHEAD_NANOSECONDS = 2_000_000_000n
// 实时模式保留播放头 (已收到的最大接收时刻) 之前的时长 (纳秒); 4路15Hz图像约60MB
const LIVE_RETAIN_NANOSECONDS = 10_000_000_000n
// 实时淘汰的余量: 最旧样本超出保留时长这么多才清一次, 不必每条都清
const LIVE_EVICT_SLACK_NANOSECONDS = 1_000_000_000n
// 频率按最近这段 (按接收时刻) 的样本统计
const FREQUENCY_WINDOW_NANOSECONDS = 2_000_000_000n

// 一次写入的一段: 段内样本已全部到齐, 按接收时刻升序. 实时模式下每通道一段, 随追加延长
type Chunk = { range: TimeRange; samples: Sample[] }

export type DataSourceOptions = { mode?: SourceMode; axis?: TimeAxis }

function overlaps(first: TimeRange, second: TimeRange) {
  return first.start <= second.end && second.start <= first.end
}

// 样本在该时间轴上的时刻; 采样轴上没有采样时刻的样本为undefined
function timeOn(sample: Sample, axis: TimeAxis) {
  return onAxis(axis, sample.receiveTime, sample.sampleTime)
}

function byReceiveTime(first: Sample, second: Sample) {
  return compareTimes(first.receiveTime, second.receiveTime)
}

/**
 * 数据源的前端状态: 按通道存适配器写入的样本段, 记已覆盖时间段, 汇总各面板的需求窗口, 持通道目录并按样本统计频率.
 * 纯TS对象, 不依赖React. 适配器写通道目录 (`setCatalog`) 与样本, 订阅需求窗口 (`onDemandChange`) 把缺的段写进来;
 * 面板读目录, 设需求窗口, 按通道订阅 (`subscribe`) 并查询.
 *
 * 模式由适配器声明: 离线按段写入 (`write` `writeStatic`); 实时持续追加 (`append`), 只有接收时刻轴,
 * 播放头为已收到的最大接收时刻 (`latestReceiveTime`), 保留其前10秒, 每通道至少留最新一条, 静态 (transient_local) 通道不淘汰,
 * 目录标了`keepLatest`的 (大消息如点云) 只留最新一条.
 *
 * 时间轴: 全局选接收时刻 (默认) 或采样时刻, 查询, 需求窗口与覆盖段都在所选轴上; 没有采样时刻的样本在采样轴上不存在.
 * 切轴清空窗口通道 (适配器按新轴重取), 静态通道保留.
 * 不连续信号: 计数, 跳转, 步进, 循环回绕, 切轴时加一; 按时间累积的结果 (如3D轨迹尾迹) 见它变即从播放头重建.
 * 淘汰按段: 需求窗口一变, 不挨着任何窗口 (前留1秒, 后留2秒) 的段即丢弃, 但每通道至少留最新一条;
 * 静态通道 (`writeStatic`一次写全, 如全程的序列, 事件, transient_local话题) 不淘汰.
 */
export function createDataSourceState({ mode = 'offline', axis: initialAxis = 'receive' }: DataSourceOptions = {}) {
  const catalog = new Map<string, ChannelInfo>()
  const catalogListeners = new Set<() => void>()
  let catalogVersion = 0
  let catalogSnapshot: ChannelInfo[] = []
  const statsCache = new Map<string, { version: number; stats: ChannelStats }>()
  let latestReceive: bigint | null = null
  // 只留最新一条的实时通道: 最近2秒收到的接收时刻, 频率按它算
  const recentReceives = new Map<string, bigint[]>()
  const chunksByChannel = new Map<string, Chunk[]>()
  const staticChannels = new Set<string>()
  const errorByChannel = new Map<string, Error>()
  const versionByChannel = new Map<string, number>()
  const channelListeners = new Map<string, Set<() => void>>()
  const demandByPanel = new Map<string, DemandWindow>()
  const demandListeners = new Set<() => void>()
  const discontinuityListeners = new Set<() => void>()
  let axis: TimeAxis = mode === 'live' ? 'receive' : initialAxis
  let discontinuityCount = 0

  function chunksOf(channel: string) {
    return chunksByChannel.get(channel) ?? []
  }

  function changed(channel: string) {
    versionByChannel.set(channel, (versionByChannel.get(channel) ?? 0) + 1)
    for (const listener of channelListeners.get(channel) ?? []) listener()
  }

  function retains(channel: string, range: TimeRange) {
    for (const window of demandByPanel.values()) {
      if (!window.channels.includes(channel)) continue
      const kept = {
        start: window.range.start - RETAIN_BEHIND_NANOSECONDS,
        end: window.range.end + RETAIN_AHEAD_NANOSECONDS,
      }
      if (overlaps(range, kept)) return true
    }
    return false
  }

  // 所选轴上时刻最晚的一条及其时刻
  function latestOf(channel: string) {
    let latest: { sample: Sample; time: bigint } | null = null
    for (const chunk of chunksOf(channel)) {
      for (const sample of chunk.samples) {
        const time = timeOn(sample, axis)
        if (time !== undefined && (!latest || time >= latest.time)) latest = { sample, time }
      }
    }
    return latest
  }

  function evict() {
    if (mode === 'live') return
    for (const [channel, chunks] of chunksByChannel) {
      if (isStaticChannel(channel)) continue
      const kept = chunks.filter((chunk) => retains(channel, chunk.range))
      if (kept.length === chunks.length) continue
      // 留下的段一条样本都没有 (全丢或只剩空段) 时, 另留最新一条作单点段
      const latest = kept.some((chunk) => chunk.samples.length > 0) ? null : latestOf(channel)
      if (latest) {
        kept.push({ range: { start: latest.time, end: latest.time }, samples: [latest.sample] })
        kept.sort((first, second) => compareTimes(first.range.start, second.range.start))
      }
      chunksByChannel.set(channel, kept)
      changed(channel)
    }
  }

  function latestAtOrBefore(channel: string, time: bigint, queryAxis: TimeAxis = axis): Sample | null {
    let latest: Sample | null = null
    let latestTime = 0n
    for (const chunk of chunksOf(channel)) {
      // 段的覆盖范围在当前轴上; 静态段覆盖整条轴, 两种轴都适用
      if (queryAxis === axis && chunk.range.start > time) break
      for (const sample of chunk.samples) {
        const sampleTime = timeOn(sample, queryAxis)
        if (sampleTime === undefined || sampleTime > time) continue
        if (!latest || sampleTime >= latestTime) {
          latest = sample
          latestTime = sampleTime
        }
      }
    }
    return latest
  }

  function catalogChanged() {
    catalogVersion += 1
    catalogSnapshot = [...catalog.values()]
    for (const listener of catalogListeners) listener()
  }

  function isStaticChannel(channel: string) {
    return staticChannels.has(channel) || catalog.get(channel)?.isStatic === true
  }

  function noteReceived(samples: Sample[]) {
    for (const sample of samples) {
      if (latestReceive === null || sample.receiveTime > latestReceive) latestReceive = sample.receiveTime
    }
  }

  // 实时淘汰: 丢掉播放头前保留时长之外的样本, 至少留最新一条; 最旧的超出余量才清
  function evictLive(channel: string, chunk: Chunk) {
    if (latestReceive === null || isStaticChannel(channel)) return
    const cutoff = latestReceive - LIVE_RETAIN_NANOSECONDS
    const oldest = chunk.samples[0]
    if (!oldest || oldest.receiveTime >= cutoff - LIVE_EVICT_SLACK_NANOSECONDS) return
    let index = chunk.samples.findIndex((sample) => sample.receiveTime >= cutoff)
    if (index < 0) index = chunk.samples.length - 1
    chunk.samples = chunk.samples.slice(index)
    chunk.range = { start: chunk.samples[0].receiveTime, end: chunk.range.end }
  }

  // 按接收时刻统计: 现存样本数, 最近2秒内的频率. 离线以该通道最近一条为准; 实时以播放头为准, 停发的话题随之归于无频率
  function computeStats(channel: string): ChannelStats {
    const samples = chunksOf(channel).flatMap((chunk) => chunk.samples)
    if (samples.length === 0) return { count: 0, frequency: null }
    const times = recentReceives.get(channel) ?? samples.map((sample) => sample.receiveTime)
    let last = times[0]
    for (const time of times) if (time > last) last = time
    const now = mode === 'live' && latestReceive !== null && latestReceive > last ? latestReceive : last
    const recent = times.filter((time) => time > now - FREQUENCY_WINDOW_NANOSECONDS)
    if (recent.length < 2) return { count: samples.length, frequency: null }
    let first = last
    for (const time of recent) if (time < first) first = time
    const span = Number(last - first) / 1e9
    return { count: samples.length, frequency: span > 0 ? (recent.length - 1) / span : null }
  }

  // 只留最新一条的实时通道: 记下接收时刻 (留最近2秒) 后只留最晚的一条
  function keepLatestOnly(channel: string, chunk: Chunk, samples: Sample[]) {
    const times = [...(recentReceives.get(channel) ?? []), ...samples.map((sample) => sample.receiveTime)]
    const latest = chunk.samples.at(-1)!
    recentReceives.set(
      channel,
      times.filter((time) => time > latest.receiveTime - FREQUENCY_WINDOW_NANOSECONDS),
    )
    chunk.samples = [latest]
    chunk.range = { start: latest.receiveTime, end: latest.receiveTime }
  }

  function notifyAll() {
    for (const channel of new Set([...chunksByChannel.keys(), ...channelListeners.keys()])) changed(channel)
  }

  function markDiscontinuity() {
    discontinuityCount += 1
    for (const listener of discontinuityListeners) listener()
  }

  return {
    mode(): SourceMode {
      return mode
    },

    // 替换整个通道目录 (离线打开数据时一次给全)
    setCatalog(channels: ChannelInfo[]) {
      catalog.clear()
      for (const channel of channels) catalog.set(channel.id, channel)
      catalogChanged()
    },

    // 增改目录项 (实时话题上线, 类型或QoS变了)
    upsertChannels(channels: ChannelInfo[]) {
      for (const channel of channels) catalog.set(channel.id, channel)
      catalogChanged()
    },

    // 删目录项 (实时话题下线); 样本照留, 不再出现在目录里
    removeChannels(ids: string[]) {
      for (const id of ids) catalog.delete(id)
      catalogChanged()
    },

    // 通道目录, 按加入次序; 目录不变时为同一数组
    catalog(): ChannelInfo[] {
      return catalogSnapshot
    },

    channelInfo(id: string): ChannelInfo | null {
      return catalog.get(id) ?? null
    },

    catalogVersion() {
      return catalogVersion
    },

    subscribeCatalog(listener: () => void) {
      catalogListeners.add(listener)
      return () => void catalogListeners.delete(listener)
    },

    // 按样本统计的通道量 (现存样本数, 频率); 离线时通道数据不变即为同一对象, 实时随播放头前移每次重算
    stats(channel: string): ChannelStats {
      if (mode === 'live') return computeStats(channel)
      const version = versionByChannel.get(channel) ?? 0
      const cached = statsCache.get(channel)
      if (cached && cached.version === version) return cached.stats
      const stats = computeStats(channel)
      statsCache.set(channel, { version, stats })
      return stats
    },

    // 已收到的最大接收时刻 (实时的播放头); 还没有样本为null
    latestReceiveTime() {
      return latestReceive
    },

    // 实时追加: 样本接到该通道之后 (乱序到达的按接收时刻插入), 随即按保留时长淘汰 (`keepLatest`的通道只留最新一条)
    append(channel: string, samples: Sample[]) {
      if (samples.length === 0) return
      noteReceived(samples)
      let chunk = chunksOf(channel)[0]
      if (!chunk) {
        chunk = { range: { start: samples[0].receiveTime, end: samples[0].receiveTime }, samples: [] }
        chunksByChannel.set(channel, [chunk])
      }
      for (const sample of samples) {
        const last = chunk.samples.at(-1)
        if (!last || sample.receiveTime >= last.receiveTime) chunk.samples.push(sample)
        else {
          const index = chunk.samples.findIndex((other) => other.receiveTime > sample.receiveTime)
          chunk.samples.splice(index, 0, sample)
        }
      }
      chunk.range = {
        start: chunk.samples[0].receiveTime,
        end: chunk.range.end > samples.at(-1)!.receiveTime ? chunk.range.end : chunk.samples.at(-1)!.receiveTime,
      }
      if (mode === 'live' && catalog.get(channel)?.keepLatest) keepLatestOnly(channel, chunk, samples)
      else evictLive(channel, chunk)
      errorByChannel.delete(channel)
      changed(channel)
    },

    // 写入一段: `range` (当前轴上) 内的样本即`samples` (按接收时刻升序), 此后该段算已覆盖, 清掉该通道的错误
    write(channel: string, range: TimeRange, samples: Sample[]) {
      const chunks = chunksOf(channel).filter((chunk) => !overlaps(chunk.range, range))
      chunks.push({ range, samples })
      chunks.sort((first, second) => compareTimes(first.range.start, second.range.start))
      chunksByChannel.set(channel, chunks)
      noteReceived(samples)
      errorByChannel.delete(channel)
      changed(channel)
    },

    // 一次写全一个静态通道 (覆盖整条时间轴, 替换已有), 不淘汰, 切轴不清
    writeStatic(channel: string, samples: Sample[]) {
      staticChannels.add(channel)
      chunksByChannel.set(channel, [{ range: WHOLE_TIMELINE, samples: [...samples].sort(byReceiveTime) }])
      noteReceived(samples)
      errorByChannel.delete(channel)
      changed(channel)
    },

    // 适配器取数失败时报给通道, 面板据此提示; 下次写入即清掉
    reportError(channel: string, error: Error) {
      errorByChannel.set(channel, error)
      changed(channel)
    },

    errorOf(channel: string): Error | null {
      return errorByChannel.get(channel) ?? null
    },

    // 所选轴 (默认当前轴) 上时刻不晚于`time`的最近一条; 没有为null
    latestAtOrBefore,

    // 当前轴上`range`内的样本, 前面加上起点前最近一条 (有的话), 按该轴时刻升序
    samplesIn(channel: string, range: TimeRange): Sample[] {
      const before = latestAtOrBefore(channel, range.start - 1n)
      const inside = chunksOf(channel)
        .flatMap((chunk) => chunk.samples)
        .flatMap((sample) => {
          const time = timeOn(sample, axis)
          return time !== undefined && time >= range.start && time <= range.end ? [{ sample, time }] : []
        })
        .sort((first, second) => compareTimes(first.time, second.time))
        .map(({ sample }) => sample)
      return before ? [before, ...inside] : inside
    },

    // 已覆盖时间段 (当前轴上): 写入过的段, 相接或重叠的合成一段, 按起点升序
    coveredRanges(channel: string): TimeRange[] {
      const merged: TimeRange[] = []
      for (const { range } of chunksOf(channel)) {
        const last = merged.at(-1)
        if (last && range.start <= last.end + 1n) last.end = range.end > last.end ? range.end : last.end
        else merged.push({ ...range })
      }
      return merged
    },

    // 该段是否仍在某个需求窗口附近; 适配器据此取消在途请求, 不写已被淘汰的段
    retains,

    axis() {
      return axis
    },

    // 切换时间轴: 清空窗口通道 (覆盖段在旧轴上), 记一次不连续, 通知各通道与适配器. 实时只有接收时刻轴, 不切
    setAxis(next: TimeAxis) {
      if (next === axis || mode === 'live') return
      axis = next
      for (const channel of [...chunksByChannel.keys()]) {
        if (!isStaticChannel(channel)) chunksByChannel.delete(channel)
      }
      errorByChannel.clear()
      markDiscontinuity()
      notifyAll()
      for (const listener of demandListeners) listener()
    },

    // 不连续计数: 跳转, 步进, 循环回绕 (由播放时钟一侧报来), 切轴, 实时重连或丢帧 (由适配器报来) 时加一
    discontinuity() {
      return discontinuityCount
    },

    markDiscontinuity,

    subscribeDiscontinuity(listener: () => void) {
      discontinuityListeners.add(listener)
      return () => void discontinuityListeners.delete(listener)
    },

    // 设或清 (`null`) 一个面板的需求窗口, 随即淘汰并通知适配器
    setDemand(panelId: string, window: DemandWindow | null) {
      if (window) demandByPanel.set(panelId, window)
      else demandByPanel.delete(panelId)
      evict()
      for (const listener of demandListeners) listener()
    },

    demandWindows(): DemandWindow[] {
      return [...demandByPanel.values()]
    },

    onDemandChange(listener: () => void) {
      demandListeners.add(listener)
      return () => void demandListeners.delete(listener)
    },

    // 通道的数据 (样本段, 错误) 每变一次版本号加一; 配合`subscribe`给React的useSyncExternalStore
    version(channel: string) {
      return versionByChannel.get(channel) ?? 0
    },

    subscribe(channel: string, listener: () => void) {
      const listeners = channelListeners.get(channel) ?? new Set()
      listeners.add(listener)
      channelListeners.set(channel, listeners)
      return () => void listeners.delete(listener)
    },
  }
}

export type DataSourceState = ReturnType<typeof createDataSourceState>
