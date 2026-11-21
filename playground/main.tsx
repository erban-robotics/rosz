/**
 * 回放 capture.py 录下的真实话题: 按原节奏追加进实时模式的状态 (循环播), 用包的面板显示.
 * 查询参数: `capture` 录制目录名 (默认head); `copies` 彩色图像复制成几路 (测多路CPU, 默认1);
 * `depth` 只放哪种深度 (`zstd` 或 `png`, 默认都放); `messages=0` 不放结构化消息;
 * `mode=offline` 改按离线回放: 图像通道给帧时刻表, 按需求窗口以1秒为块写入 (同ADP适配器的做法), 有播放控件与时间轴切换.
 * 视频录制 (`capture=video`, 由encode-video.mjs造): 每路给关键帧, 页面上`await compareVideo(话题, 帧号)`把画面与ffmpeg解出的同帧PNG比对
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ChannelList,
  type ChannelInfo,
  createDataSourceState,
  decodeImage,
  type DataSource,
  HintProvider,
  loadRosz,
  type Sample,
  useLivePlayback,
  usePlayback,
  usePlaybackStore,
  ViewComposition,
} from '../src'
import './style.css'

// `keyframes`: 视频的关键帧样本序号
type Entry = { file: string; topic: string; type: string | null; format?: string; keyframes?: number[] }
type Record = { receive: bigint; sample: bigint | null; data: Uint8Array }

const params = new URLSearchParams(location.search)
const capture = params.get('capture') ?? 'head'
const copies = Number(params.get('copies') ?? '1')
const depthOnly = params.get('depth')
const withMessages = params.get('messages') !== '0'
const isOffline = params.get('mode') === 'offline'
const BLOCK_NANOSECONDS = 1_000_000_000n

function isWanted(entry: Entry) {
  const isDepth = entry.topic.includes('depth')
  if (isDepth && depthOnly) return depthOnly === 'zstd' ? entry.format === '16UC1; zstd' : entry.topic.includes('compressedDepth')
  return isDepth || entry.keyframes !== undefined || entry.type === 'sensor_msgs/msg/CompressedImage' || withMessages
}

function parseRecords(buffer: ArrayBuffer): Record[] {
  const view = new DataView(buffer)
  const records: Record[] = []
  for (let offset = 0; offset < buffer.byteLength; ) {
    const receive = view.getBigUint64(offset, true)
    const sample = view.getBigInt64(offset + 8, true)
    const length = view.getUint32(offset + 16, true)
    records.push({ receive, sample: sample < 0n ? null : sample, data: new Uint8Array(buffer, offset + 20, length) })
    offset += 20 + length
  }
  return records
}

type Track = { channels: ChannelInfo[]; records: Record[]; toPayload: (record: Record) => unknown; keyframes?: number[] }

async function loadCapture(): Promise<Track[]> {
  const base = `/captures/${capture}/`
  const manifest = ((await (await fetch(base + 'manifest.json')).json()) as Entry[]).filter(isWanted)
  const { decoder } = await loadRosz()
  return Promise.all(
    manifest.map(async (entry): Promise<Track> => {
      const records = parseRecords(await (await fetch(base + entry.file)).arrayBuffer())
      if (entry.format) {
        const keyframes = new Set(entry.keyframes?.map((index) => records[index]))
        return {
          channels: [{ id: entry.topic, kind: 'image', name: entry.topic, type: entry.type, role: entry.keyframes ? 'camera' : 'depth' }],
          records,
          toPayload: (record) => ({ format: entry.format, data: record.data, ...(entry.keyframes && { isKeyframe: keyframes.has(record) }) }),
          keyframes: entry.keyframes,
        }
      }
      if (entry.type === 'sensor_msgs/msg/CompressedImage') {
        const isDepth = entry.topic.includes('depth')
        const count = isDepth ? 1 : copies
        return {
          channels: Array.from({ length: count }, (_, index) => ({
            id: index === 0 ? entry.topic : `${entry.topic}#${index}`,
            kind: 'image',
            name: index === 0 ? entry.topic : `${entry.topic} (副本${index})`,
            type: entry.type,
            role: isDepth ? 'depth' : 'camera',
          })),
          records,
          // 同查看器前端: 收到CDR后解出format与data, 渲染时再解图像
          toPayload: (record) => {
            const { tree } = decoder.decode(entry.type!, record.data) as { tree: { format: string; data: Uint8Array } }
            return { format: tree.format, data: tree.data }
          },
        }
      }
      return {
        channels: [{ id: entry.topic, kind: 'message', name: entry.topic, type: entry.type }],
        records,
        toPayload: (record) => ({ encoding: 'cdr', data: record.data }),
      }
    }),
  )
}

// 按录制的接收时刻节奏循环追加; 接收时刻平移到本机当前时刻
function startReplay(dataSource: DataSource, tracks: Track[]) {
  const origin = tracks.flatMap((track) => track.records.map((record) => record.receive)).reduce((a, b) => (a < b ? a : b))
  const end = tracks.flatMap((track) => track.records.map((record) => record.receive)).reduce((a, b) => (a > b ? a : b))
  const span = end - origin + 1n
  const startedAt = performance.now()
  const cursors = tracks.map(() => ({ loop: 0n, index: 0 }))
  const timer = setInterval(() => {
    const elapsed = BigInt(Math.round((performance.now() - startedAt) * 1e6))
    tracks.forEach((track, trackIndex) => {
      const cursor = cursors[trackIndex]
      for (;;) {
        const record = track.records[cursor.index]
        const offset = cursor.loop * span + (record.receive - origin)
        if (offset > elapsed) break
        const receiveTime = dataSource.zero + offset
        const payload = track.toPayload(record)
        const sample: Sample = {
          receiveTime,
          sampleTime: record.sample === null ? undefined : record.sample - record.receive + receiveTime,
          payload,
        }
        for (const channel of track.channels) dataSource.state.append(channel.id, [sample])
        cursor.index += 1
        if (cursor.index >= track.records.length) {
          cursor.index = 0
          cursor.loop += 1n
        }
      }
    })
  }, 5)
  return () => clearInterval(timer)
}

// 离线: 帧时刻表进目录, 需求窗口一变就把窗口所在的1秒块 (含窗口起点前最近一条) 写成一段; 消息一次写全
function startOffline(dataSource: DataSource, tracks: Track[]) {
  const { state } = dataSource
  const toSample = (track: Track, record: Record): Sample => ({
    receiveTime: record.receive,
    sampleTime: record.sample ?? undefined,
    payload: track.toPayload(record),
  })
  const images = tracks.filter((track) => track.channels[0].kind === 'image')
  for (const track of tracks.filter((track) => track.channels[0].kind !== 'image'))
    for (const channel of track.channels) state.writeStatic(channel.id, track.records.map((record) => toSample(track, record)))
  const sync = () => {
    const axis = state.axis()
    for (const window of state.demandWindows()) {
      for (const track of images) {
        for (const channel of track.channels) {
          if (!window.channels.includes(channel.id)) continue
          const timeOf = (record: Record) => (axis === 'receive' ? record.receive : (record.sample ?? record.receive))
          const firstBlock = (window.range.start - dataSource.zero) / BLOCK_NANOSECONDS
          const lastBlock = (window.range.end - dataSource.zero) / BLOCK_NANOSECONDS
          for (let block = firstBlock - 1n; block <= lastBlock; block += 1n) {
            const range = { start: dataSource.zero + block * BLOCK_NANOSECONDS, end: dataSource.zero + (block + 1n) * BLOCK_NANOSECONDS - 1n }
            if (state.coveredRanges(channel.id).some((covered) => covered.start <= range.start && range.end <= covered.end)) continue
            const inside = track.records.filter((record) => timeOf(record) >= range.start && timeOf(record) <= range.end)
            state.write(channel.id, range, inside.map((record) => toSample(track, record)))
          }
        }
      }
    }
  }
  const unsubscribe = state.onDemandChange(sync)
  sync()
  return unsubscribe
}

function offlineCatalog(tracks: Track[]): ChannelInfo[] {
  return tracks.flatMap((track) => {
    const receiveTimes = track.records.map((record) => record.receive)
    const range = { start: receiveTimes[0], end: receiveTimes.at(-1)! }
    return track.channels.map((channel) =>
      channel.kind === 'image'
        ? {
            ...channel,
            range,
            frames: {
              receiveTimes,
              sampleTimes: track.records.map((record) => record.sample ?? record.receive),
              keyframeIndices: track.keyframes,
            },
          }
        : { ...channel, range },
    )
  })
}

// 验收: 解各深度通道首帧, 读expected.json里的像素, 与Python depth()对照
async function probeDepth(tracks: Track[]) {
  const expected = await (await fetch(`/captures/${capture}/expected.json`)).json()
  const results = []
  for (const track of tracks) {
    const topic = track.channels[0].id
    if (!expected[topic]) continue
    const frame = await decodeImage(track.toPayload(track.records[0]) as never)
    if (frame.kind !== 'depth') continue
    for (const probe of expected[topic].probes as { x: number; y: number; mm: number }[])
      results.push({ topic, ...probe, browser: frame.data[probe.y * frame.width + probe.x] })
  }
  return results
}

// 验收: 该话题画面canvas与reference/<format>/下ffmpeg解出的第`frame`帧 (帧号从0起) 逐像素比, 返回RGB平均绝对差, 另给前后帧作参照
async function compareVideo(topic: string, frame: number) {
  const canvas = document.querySelector<HTMLCanvasElement>(`canvas[aria-label="${topic}"]`)!
  const shown = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  const format = topic.split('/').at(-1)
  const differenceTo = async (index: number) => {
    const response = await fetch(`/captures/${capture}/reference/${format}/${String(index + 1).padStart(4, '0')}.png`)
    // 越界的帧号: 开发服务器回index.html
    if (!response.headers.get('content-type')?.startsWith('image/')) return null
    const bitmap = await createImageBitmap(await response.blob())
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const expected = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    let total = 0
    for (let offset = 0; offset < expected.length; offset += 4)
      for (let channel = 0; channel < 3; channel += 1) total += Math.abs(expected[offset + channel] - shown[offset + channel])
    return total / ((expected.length / 4) * 3)
  }
  return { frame: await differenceTo(frame), previous: await differenceTo(frame - 1), next: await differenceTo(frame + 1) }
}

function Live({ dataSource }: { dataSource: DataSource }) {
  const playback = useLivePlayback(dataSource)
  return <ViewComposition dataSource={dataSource} playback={playback} scope={`playground/${capture}/${copies}`} />
}

function Offline({ dataSource }: { dataSource: DataSource }) {
  const playback = usePlayback()
  return <ViewComposition dataSource={dataSource} playback={playback} scope={`playground-offline/${capture}/${copies}`} />
}

function App() {
  const [dataSource, setDataSource] = useState<DataSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stop = () => {}
    let isCancelled = false
    loadCapture()
      .then((tracks) => {
        if (isCancelled) return
        // 离线以录制首条的接收时刻为零点; 实时以本机当前时刻为零点, 回放时平移过来
        const origin = tracks.flatMap((track) => track.records.map((record) => record.receive)).reduce((a, b) => (a < b ? a : b))
        const next: DataSource = isOffline
          ? { state: createDataSourceState({ mode: 'offline' }), zero: origin }
          : { state: createDataSourceState({ mode: 'live' }), zero: BigInt(Date.now()) * 1_000_000n }
        next.state.setCatalog(isOffline ? offlineCatalog(tracks) : tracks.flatMap((track) => track.channels))
        Object.assign(window, { probeDepth: () => probeDepth(tracks), compareVideo, roszState: next.state, playbackStore: usePlaybackStore })
        stop = isOffline ? startOffline(next, tracks) : startReplay(next, tracks)
        setDataSource(next)
      })
      .catch((reason: Error) => setError(reason.message))
    return () => {
      isCancelled = true
      stop()
    }
  }, [])
  if (error) return <p className="p-4 text-status-danger">{error}</p>
  if (!dataSource) return <p className="p-4">加载录制</p>
  return (
    <div className="flex h-full gap-2 p-2">
      <ChannelList state={dataSource.state} className="w-80 shrink-0 overflow-auto" />
      <div className="flex min-w-0 flex-1 flex-col">
        {isOffline ? <Offline dataSource={dataSource} /> : <Live dataSource={dataSource} />}
      </div>
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
