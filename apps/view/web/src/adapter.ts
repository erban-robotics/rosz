/**
 * 查看器适配器: 经 WebSocket (`foxglove.websocket.v1` 子集, 见 apps/view/src/protocol.rs) 接后端, 写 rosz-ui 的实时状态.
 * - 通道目录: 后端 `advertise` / `unadvertise` -> `upsertChannels` / `removeChannels`. `CompressedImage` 为图像通道, 其余为结构化消息
 * - 订阅: 跟着状态的需求窗口走, 窗口里出现的通道才订阅, 不再出现即退订
 * - 样本: 接收时刻取数据帧里后端 PC 时钟的接收时间 (不用浏览器时钟), 采样时刻由 rosz-wasm 解 Header; 图像解出 `format` 与压缩字节
 */
import { type ChannelInfo, createDataSourceState, type DataSource, loadRosz, type Rosz, type Sample } from '@erban-robotics/rosz-ui'

const SUBPROTOCOL = 'foxglove.websocket.v1'
const MESSAGE_DATA_OPCODE = 0x01
// 数据帧头: opcode (1) + 订阅号 (4) + 接收时间纳秒 (8)
const MESSAGE_DATA_HEADER = 13
const COMPRESSED_IMAGE = 'sensor_msgs/msg/CompressedImage'
// ros2msg schema 里分隔各定义的行
const SCHEMA_SEPARATOR = /^={10,}$/m

type AdvertisedChannel = {
  id: number
  topic: string
  schemaName: string
  schema: string
  typeHash?: string
  undecodable?: string | null
  transientLocal?: boolean
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed'

export type Viewer = { dataSource: DataSource }

/** 通道目录的一项: id 用话题名 (同名话题换类型时后端给新通道号, 目录里覆盖同一项) */
function channelInfo(channel: AdvertisedChannel): ChannelInfo {
  const isImage = channel.schemaName === COMPRESSED_IMAGE
  return {
    id: channel.topic,
    kind: isImage ? 'image' : 'message',
    name: channel.topic,
    type: channel.schemaName,
    role: isImage ? (/depth/i.test(channel.topic) ? 'depth' : 'camera') : null,
    isStatic: channel.transientLocal ?? false,
    undecodable: channel.undecodable ?? null,
  }
}

/** 后端给的 schema 里有内置之外的定义 (`--msg-dir` 追加的) 时补进解码器 */
function addSchema(rosz: Rosz, channel: AdvertisedChannel) {
  if (!channel.schema || !rosz.decoder.undecodableReason(channel.schemaName, channel.typeHash)) return
  const [root, ...nested] = channel.schema.split(SCHEMA_SEPARATOR)
  try {
    for (const block of nested) {
      const match = /^\s*MSG: (\S+)\n([\s\S]*)$/.exec(block)
      if (match) rosz.decoder.addDefinition(match[1], match[2])
    }
    rosz.decoder.addDefinition(channel.schemaName, root)
  } catch (reason) {
    console.warn(`追加 ${channel.schemaName} 的定义失败`, reason)
  }
}

/**
 * 连后端, 收到 serverInfo 后给出数据源 (会话零点取后端的 `startTime`). `onStatus` 报连接状态; 断开后不重连 (关窗即退出,
 * 刷新页面即重连).
 */
export function connect(onReady: (viewer: Viewer) => void, onStatus: (status: ConnectionStatus) => void): () => void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${protocol}://${location.host}/ws`, SUBPROTOCOL)
  socket.binaryType = 'arraybuffer'
  onStatus('connecting')

  const state = createDataSourceState({ mode: 'live' })
  const channels = new Map<number, AdvertisedChannel>()
  const channelByTopic = new Map<string, number>()
  // 订阅号 -> 通道号; 通道号 -> 订阅号
  const subscriptionChannel = new Map<number, number>()
  const channelSubscription = new Map<number, number>()
  let nextSubscription = 1
  let rosz: Rosz | null = null
  void loadRosz().then((loaded) => {
    rosz = loaded
    for (const channel of channels.values()) addSchema(loaded, channel)
  })

  const send = (message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  // 需求窗口里的通道 = 要订阅的通道
  const syncSubscriptions = () => {
    const wanted = new Set<number>()
    for (const window of state.demandWindows())
      for (const topic of window.channels) {
        const id = channelByTopic.get(topic)
        if (id !== undefined) wanted.add(id)
      }
    const subscribe = [...wanted].filter((id) => !channelSubscription.has(id)).map((channelId) => {
      const id = nextSubscription++
      subscriptionChannel.set(id, channelId)
      channelSubscription.set(channelId, id)
      return { id, channelId }
    })
    const unsubscribe = [...channelSubscription].filter(([channelId]) => !wanted.has(channelId)).map(([channelId, id]) => {
      channelSubscription.delete(channelId)
      subscriptionChannel.delete(id)
      return id
    })
    if (subscribe.length > 0) send({ op: 'subscribe', subscriptions: subscribe })
    if (unsubscribe.length > 0) send({ op: 'unsubscribe', subscriptionIds: unsubscribe })
  }
  const stopDemand = state.onDemandChange(syncSubscriptions)

  const onControl = (message: { op: string; [key: string]: unknown }) => {
    switch (message.op) {
      case 'serverInfo': {
        const metadata = (message.metadata ?? {}) as { startTime?: string }
        onReady({ dataSource: { state, zero: BigInt(metadata.startTime ?? '0') } })
        break
      }
      case 'advertise': {
        const added = message.channels as AdvertisedChannel[]
        for (const channel of added) {
          // 同名话题换了类型: 旧通道作废
          const previous = channelByTopic.get(channel.topic)
          if (previous !== undefined) channels.delete(previous)
          channels.set(channel.id, channel)
          channelByTopic.set(channel.topic, channel.id)
          if (rosz) addSchema(rosz, channel)
        }
        state.upsertChannels(added.map(channelInfo))
        syncSubscriptions()
        break
      }
      case 'unadvertise': {
        const removed: string[] = []
        for (const id of message.channelIds as number[]) {
          const channel = channels.get(id)
          if (!channel) continue
          channels.delete(id)
          channelByTopic.delete(channel.topic)
          const subscription = channelSubscription.get(id)
          if (subscription !== undefined) {
            channelSubscription.delete(id)
            subscriptionChannel.delete(subscription)
          }
          removed.push(channel.topic)
        }
        state.removeChannels(removed)
        break
      }
      case 'status':
        console.warn(`后端: ${message.message as string}`)
        break
    }
  }

  const onData = (buffer: ArrayBuffer) => {
    const view = new DataView(buffer)
    // 解码模块加载完之前的数据帧丢掉 (实时流, 下一帧马上到)
    if (buffer.byteLength < MESSAGE_DATA_HEADER || view.getUint8(0) !== MESSAGE_DATA_OPCODE || !rosz) return
    const channelId = subscriptionChannel.get(view.getUint32(1, true))
    const channel = channelId === undefined ? undefined : channels.get(channelId)
    if (!channel) return
    const receiveTime = view.getBigUint64(5, true)
    const data = new Uint8Array(buffer, MESSAGE_DATA_HEADER)
    const isDecodable = !channel.undecodable
    let sample: Sample
    try {
      const sampleTime = isDecodable ? rosz.decoder.sampleTime(channel.schemaName, data) : undefined
      if (channel.schemaName === COMPRESSED_IMAGE && isDecodable) {
        const { tree } = rosz.decoder.decode(COMPRESSED_IMAGE, data) as { tree: { format: string; data: Uint8Array } }
        sample = { receiveTime, sampleTime, payload: { format: tree.format, data: tree.data } }
      } else {
        sample = { receiveTime, sampleTime, payload: { encoding: 'cdr', data } }
      }
    } catch (reason) {
      state.reportError(channel.topic, reason instanceof Error ? reason : new Error(String(reason)))
      return
    }
    state.append(channel.topic, [sample])
  }

  socket.onopen = () => onStatus('open')
  socket.onclose = () => onStatus('closed')
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') onControl(JSON.parse(event.data))
    else onData(event.data as ArrayBuffer)
  }
  return () => {
    stopDemand()
    socket.close()
  }
}
