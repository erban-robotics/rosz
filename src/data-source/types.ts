// 数据源接口的领域类型: 状态按通道与时刻存样本, 适配器写入, 面板只读. 纯TS, 不依赖React

/**
 * 一条样本. 时刻为绝对纳秒 (BigInt, 超出JS安全整数), 显示时换算到会话零点秒数 (见`clock.ts`).
 * `receiveTime`为接收时刻, 必有; `sampleTime`为采样时刻 (消息头的时间戳), 数据源没有时不给.
 */
export type Sample<Payload = unknown> = {
  receiveTime: bigint
  sampleTime?: bigint
  payload: Payload
}

// 回放时间轴: 按接收时刻 (默认) 或采样时刻排样本与播放头; 实时只有接收时刻轴
export type TimeAxis = 'receive' | 'sample'

// 数据源模式, 由适配器声明: 离线 (回放, 按需求窗口取段写入) 或实时 (持续追加, 播放头为已收到的最大接收时刻)
export type SourceMode = 'offline' | 'live'

// 时间段 (绝对纳秒), 闭区间 [start, end]
export type TimeRange = { start: bigint; end: bigint }

/**
 * 需求窗口: 面板要看的通道与时间段, 隐含要窗口起点前最近一条. 适配器订阅它, 把缺的数据取来写进状态.
 * `resolution`为分辨率提示 (纳秒): 相邻样本间隔小于它的不必都给 (如缩小看的曲线); 不给即要全部样本.
 */
export type DemandWindow = {
  channels: string[]
  range: TimeRange
  resolution?: bigint
}

/**
 * 通道种类: 图像 (压缩字节 + 格式), 序列 (按列的数值), 事件, 空间 (3D), 叠加 (图像上的2D标注), 结构化消息 (原始CDR, 渲染时解码)
 */
export type ChannelKind = 'image' | 'series' | 'events' | 'spatial' | 'overlay' | 'message'

// 离线图像通道的帧时刻表 (绝对纳秒): 第k项即第k帧; 帧号, 步进与时间轴总长按它
export type ChannelFrames = {
  receiveTimes: bigint[]
  sampleTimes: bigint[]
  // 同一帧时间表的一组 (同帧号即同一采样时刻); 步进按有同步帧表的组, 没有则按帧最多的一路
  group?: string
  isSynchronized?: boolean
}

/**
 * 通道目录的一项, 由适配器从数据源解析 (实时为liveliness token, ADP为图层列表); 频率等统计由状态按样本算, 不在这里.
 *
 * `properties`为数据源给的附加说明, 面板按约定的键读:
 * - 序列: `columns` (列名, 按此顺序), `unit`, `side` (左右, 关节配对用), `trajectory` (`target`为目标轨迹), `frame` (坐标系)
 * - 叠加: `stream` (所基于的图像通道`name`), `width`, `height` (底图像素)
 * - 空间: `frame` (数据所在坐标系, 坐标变换为父坐标系), `childFrame` (坐标变换的子坐标系)
 */
export type ChannelInfo = {
  // 状态里的通道名, 写入与查询都用它
  id: string
  kind: ChannelKind
  // 显示名: 实时为话题名, ADP为图层名 (图像流名, 列组名)
  name: string
  // 数据类型: 实时为ROS类型名 (如`sensor_msgs/msg/CompressedImage`); 叠加与空间为细分种类 (`segmentation` `keypoints_2d`
  // `transform` `pose` `point_cloud` `keypoints_3d`); 事件为`quality` (质检结果) 或`task` (任务阶段)
  type?: string | null
  // 角色 (如`end_effector_position` `camera` `depth`), 布局绑定按它选
  role?: string | null
  // 来源 (如ADP的产物名), 布局绑定可按它选
  source?: string | null
  // transient_local话题: 当静态, 不淘汰, 通道列表标"静态"
  isStatic?: boolean
  // 解不了的原因 (无定义, hash不符); 有即面板与通道列表变灰, 只显示名称与类型
  undecodable?: string | null
  // 内容无法识别的原因 (叠加, 空间), 面板据此提示未画
  issue?: string | null
  // 离线通道在接收轴上的首末时刻, 时间轴总长按它
  range?: TimeRange
  frames?: ChannelFrames
  properties?: Record<string, unknown>
}

// 状态按样本统计的通道量: 现存样本数, 最近2秒 (按接收时刻) 的频率 (Hz), 不足两条为null
export type ChannelStats = { count: number; frequency: number | null }

/**
 * 图像通道的样本内容: 原样的压缩字节与格式, 渲染时才解.
 * `format`即`sensor_msgs/CompressedImage.format`的写法: `jpeg` `png` 彩色; `16UC1; zstd` `16UC1; compressedDepth` 深度
 */
export type ImagePayload = { format: string; data: Blob | Uint8Array }

// 结构化消息通道的样本内容: 原始CDR (含4字节封装头), 渲染时按通道的`type`解码
export type MessagePayload = { encoding: 'cdr'; data: Uint8Array }
