// 事件轨的数据形状: 质检结果的事件 (按类别定义分质检事件与结构事件) 与任务事件 (阶段标记). 时刻为会话时间轴秒数

// 事件类别的定义, 随质检结果给出 (ADP内核的`EventCategoryDefinition`同形)
export type EventCategoryDefinition = {
  name: string
  definition: string
  presumed_causes: string
  is_quality_problem: boolean
  // 质检事件或结构事件 (待机, 结尾保持等), 与is_quality_problem一一对应; 较早的质检结果没有此字段
  event_kind?: 'quality' | 'structural'
  default_threshold_rule: string
}

export type EventKind = NonNullable<EventCategoryDefinition['event_kind']>

// 类别属质检事件还是结构事件; 缺event_kind的较早定义按is_quality_problem归类
export function eventKindOf(definition: EventCategoryDefinition): EventKind {
  return definition.event_kind ?? (definition.is_quality_problem ? 'quality' : 'structural')
}

// 质检结果的一个事件: 事件通道 (`type`为`quality`) 的一条样本内容
export type QualityCheckEvent = {
  // 来源通道id, 事件轨道按绑定筛, 也作列表key
  channel: string
  start: number
  end: number
  category: string
  strength: number
  definition: EventCategoryDefinition | null
}

// 任务事件: 序列的阶段标记, 事件通道 (`type`为`task`) 的一条样本内容
export type TaskEvent = {
  channel: string
  time: number
  name: string
}
