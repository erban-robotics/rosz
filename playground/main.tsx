/**
 * 回放 capture.py 录下的真实话题: 按原节奏追加进实时模式的状态 (循环播), 用包的面板显示.
 * 查询参数: `capture` 录制目录名 (默认head); `copies` 彩色图像复制成几路 (测多路CPU, 默认1)
 */
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  type ChannelInfo,
  createDataSourceState,
  decodeImage,
  type DataSource,
  HintProvider,
  loadRosz,
  type Sample,
  useLivePlayback,
  ViewComposition,
} from '../src'
import './style.css'

type Entry = { file: string; topic: string; type: string | null; format?: string }
type Record = { receive: bigint; sample: bigint | null; data: Uint8Array }

const params = new URLSearchParams(location.search)
const capture = params.get('capture') ?? 'head'
const copies = Number(params.get('copies') ?? '1')

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

type Track = { channels: ChannelInfo[]; records: Record[]; toPayload: (record: Record) => unknown }

async function loadCapture(): Promise<Track[]> {
  const base = `/captures/${capture}/`
  const manifest = (await (await fetch(base + 'manifest.json')).json()) as Entry[]
  const { decoder } = await loadRosz()
  return Promise.all(
    manifest.map(async (entry): Promise<Track> => {
      const records = parseRecords(await (await fetch(base + entry.file)).arrayBuffer())
      if (entry.format)
        return {
          channels: [{ id: entry.topic, kind: 'image', name: entry.topic, type: 'sensor_msgs/msg/CompressedImage', role: 'depth' }],
          records,
          toPayload: (record) => ({ format: entry.format, data: record.data }),
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

function Live({ dataSource }: { dataSource: DataSource }) {
  const playback = useLivePlayback(dataSource)
  return <ViewComposition dataSource={dataSource} playback={playback} scope={`playground/${capture}/${copies}`} />
}

function App() {
  const dataSource = useMemo<DataSource>(
    () => ({ state: createDataSourceState({ mode: 'live' }), zero: BigInt(Date.now()) * 1_000_000n }),
    [],
  )
  const [error, setError] = useState<string | null>(null)
  const [isReady, setReady] = useState(false)
  useEffect(() => {
    let stop = () => {}
    loadCapture()
      .then((tracks) => {
        dataSource.state.setCatalog(tracks.flatMap((track) => track.channels))
        Object.assign(window, { probeDepth: () => probeDepth(tracks), roszState: dataSource.state })
        stop = startReplay(dataSource, tracks)
        setReady(true)
      })
      .catch((reason: Error) => setError(reason.message))
    return () => stop()
  }, [dataSource])
  if (error) return <p className="p-4 text-status-danger">{error}</p>
  if (!isReady) return <p className="p-4">加载录制</p>
  return (
    <div className="flex h-full flex-col p-2">
      <Live dataSource={dataSource} />
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
