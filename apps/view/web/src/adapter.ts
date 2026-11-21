/**
 * 查看器适配器: 经 WebSocket (`foxglove.websocket.v1` 子集, 见 apps/view/src/protocol.rs) 接后端, 写 rosz-ui 的实时状态.
 * - 通道目录: 后端 `advertise` / `unadvertise` -> `upsertChannels` / `removeChannels`. `CompressedImage` 与 `Image` 为图像通道,
 *   `TFMessage` 与 `PointCloud2` 为空间通道 (rosz-ui 的 3D 场景画, `type` 为 ROS 类型, 点云标 `keepLatest` 只留最新一条),
 *   其余为结构化消息. 图像的角色 (相机 / 深度) 等首帧按 format 定
 * - 订阅: 跟着状态的需求窗口走, 窗口里出现的通道才订阅, 不再出现即退订; 解不了的不订阅
 * - 样本: 接收时刻取数据帧里后端 PC 时钟的接收时间 (不用浏览器时钟), 采样时刻由 rosz-wasm 解 Header; 图像换成面板吃的
 *   `format` + 压缩字节 (见 images.ts). 面板显示不了的图像 (不认识的格式, 空数据) 整路标为解不了并退订, 原因显示在话题树与面板上.
 *   空间话题与结构化消息一样写原始 CDR, 由 rosz-ui 的 3D 场景渲染时解
 */
import {
  type ChannelInfo,
  createDataSourceState,
  type DataSource,
  loadRosz,
  rosSpatialKind,
  type Rosz,
  type Sample,
} from '@erban-robotics/rosz-ui'
import { createDropTally, type DropTally } from './drops'
import { COMPRESSED_IMAGE, type Converted, fromCompressed, fromRaw, isImageType, roleOf } from './images'

const SUBPROTOCOL = 'foxglove.websocket.v1'
const MESSAGE_DATA_OPCODE = 0x01
// 数据帧头: opcode (1) + 订阅号 (4) + 接收时间纳秒 (8)
const MESSAGE_DATA_HEADER = 13
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

export type Viewer = { dataSource: DataSource; drops: DropTally }

/**
 * 通道目录的一项: id 用话题名 (同名话题换类型时后端给新通道号, 目录里覆盖同一项). `role` 为首帧定的图像角色,
 * `issue` 为前端发现的解不了的原因 (图像格式), 与后端给的同样变灰
 */
function channelInfo(channel: AdvertisedChannel, role: string | null, issue: string | null): ChannelInfo {
  const spatial = rosSpatialKind(channel.schemaName)
  return {
    id: channel.topic,
    kind: isImageType(channel.schemaName) ? 'image' : spatial ? 'spatial' : 'message',
    name: channel.topic,
    // 空间通道也写 ROS 类型 (话题树显示, 按类型搜索; 3D 场景按它解 CDR)
    type: channel.schemaName,
    role,
    isStatic: channel.transientLocal ?? false,
    // 点云一条可达数 MB, 状态里只留最新一条
    keepLatest: spatial === 'point_cloud',
    undecodable: channel.undecodable ?? issue,
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
  const drops = createDropTally()
  const channels = new Map<number, AdvertisedChannel>()
  const channelByTopic = new Map<string, number>()
  // 订阅号 -> 通道号; 通道号 -> 订阅号
  const subscriptionChannel = new Map<number, number>()
  const channelSubscription = new Map<number, number>()
  let nextSubscription = 1
  // 通道号 -> 首帧定的图像角色 / 前端发现的解不了的原因 / 正在编码的帧 (原始彩色每路同时只编一帧)
  const roles = new Map<number, string>()
  const issues = new Map<number, string>()
  const encoding = new Set<number>()
  const infoOf = (channel: AdvertisedChannel) => channelInfo(channel, roles.get(channel.id) ?? null, issues.get(channel.id) ?? null)
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
        if (id !== undefined && !channels.get(id)?.undecodable && !issues.has(id)) wanted.add(id)
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
        onReady({ dataSource: { state, zero: BigInt(metadata.startTime ?? '0') }, drops })
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
        state.upsertChannels(added.map(infoOf))
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
          roles.delete(id)
          issues.delete(id)
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
      case 'status': {
        // 后端发送队列丢了某路的帧: 记不连续 (按时间累积的结果从播放头重建) 并累计条数
        const channelId = subscriptionChannel.get(message.subscriptionId as number)
        const channel = channelId === undefined ? undefined : channels.get(channelId)
        if (typeof message.dropped === 'number' && channel) {
          state.markDiscontinuity()
          drops.add(channel.topic, message.dropped)
        } else console.warn(`后端: ${message.message as string}`)
        break
      }
    }
  }

  // 面板显示不了这一路: 标为解不了 (话题树变灰, 面板显示原因) 并退订
  const markIssue = (channel: AdvertisedChannel, issue: string) => {
    if (issues.has(channel.id)) return
    issues.set(channel.id, issue)
    state.upsertChannels([infoOf(channel)])
    state.reportError(channel.topic, new Error(issue))
    syncSubscriptions()
  }

  const appendImage = (channel: AdvertisedChannel, sample: Sample<{ format: string }>) => {
    // 后端已换了同名话题的新通道 (或下线) 时丢掉迟到的帧
    if (channels.get(channel.id) !== channel) return
    const role = roleOf(sample.payload.format)
    if (roles.get(channel.id) !== role) {
      roles.set(channel.id, role)
      state.upsertChannels([infoOf(channel)])
    }
    state.append(channel.topic, [sample])
  }

  const onImage = (channel: AdvertisedChannel, receiveTime: bigint, sampleTime: bigint | undefined, converted: Converted) => {
    if ('issue' in converted) return markIssue(channel, converted.issue)
    const { payload } = converted
    if (!(payload instanceof Promise)) return appendImage(channel, { receiveTime, sampleTime, payload })
    if (encoding.has(channel.id)) return
    encoding.add(channel.id)
    payload.then(
      (encoded) => appendImage(channel, { receiveTime, sampleTime, payload: encoded }),
      (reason: Error) => state.reportError(channel.topic, reason),
    ).finally(() => encoding.delete(channel.id))
  }

  const onData = (buffer: ArrayBuffer) => {
    const view = new DataView(buffer)
    // 解码模块加载完之前的数据帧丢掉 (实时流, 下一帧马上到)
    if (buffer.byteLength < MESSAGE_DATA_HEADER || view.getUint8(0) !== MESSAGE_DATA_OPCODE || !rosz) return
    const channelId = subscriptionChannel.get(view.getUint32(1, true))
    const channel = channelId === undefined ? undefined : channels.get(channelId)
    if (!channel || issues.has(channel.id)) return
    const receiveTime = view.getBigUint64(5, true)
    const data = new Uint8Array(buffer, MESSAGE_DATA_HEADER)
    const isDecodable = !channel.undecodable
    try {
      const sampleTime = isDecodable ? rosz.decoder.sampleTime(channel.schemaName, data) : undefined
      if (isImageType(channel.schemaName) && isDecodable) {
        const { tree } = rosz.decoder.decode(channel.schemaName, data) as { tree: Record<string, unknown> }
        const converted =
          channel.schemaName === COMPRESSED_IMAGE
            ? fromCompressed(tree.format as string, tree.data as Uint8Array)
            : fromRaw(tree as Parameters<typeof fromRaw>[0])
        onImage(channel, receiveTime, sampleTime, converted)
      } else {
        state.append(channel.topic, [{ receiveTime, sampleTime, payload: { encoding: 'cdr', data } }])
      }
    } catch (reason) {
      state.reportError(channel.topic, reason instanceof Error ? reason : new Error(String(reason)))
    }
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
