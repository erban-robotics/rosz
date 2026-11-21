/**
 * 视图类型目录与布局描述的schema. 由开发者维护, agent只按它组合布局, 不新增类型.
 * 应用可导出JSON Schema (`layoutJsonSchema`) 入库, 给agent布局工具描述与校验参数 (如ADP的`frontend/schemas/view-layout.schema.json`).
 * 本文件只依赖zod, 生成脚本可用node直接加载.
 *
 * 绑定按通道目录选通道: `kind`为绑定种类 (由通道种类与类型得出, 见`layout-model.ts`的`bindingKindOf`), `role` `derivative` `name`
 * 分别对通道的`role` `source` `name`.
 */
import { z } from 'zod'

export const LAYOUT_DESCRIPTION_VERSION = 1

// 视图id: 小写字母开头, 字母数字与`-` `_`
const VIEW_ID_PATTERN = /^[a-z][a-z0-9_-]*$/

// 图层绑定的公共字段; `kind`由各视图类型限定可叠的图层种类
function layerBinding<const Kinds extends readonly [string, ...string[]]>(kinds: Kinds) {
  return z
    .object({
      kind: z.enum(kinds).describe('图层种类 (ADP即内核`GET /takes/{id}/layers`的`kind`; 实时话题的结构化消息为`message`)'),
      role: z
        .string()
        .min(1)
        .optional()
        .describe('图层角色, 可用`*`通配 (如`*joint_position`); 不写即该种类任意角色'),
      derivative: z.string().min(1).optional().describe('来源产物名 (如`low_dimensional_series`), 对通道的`source`; 不写即不限'),
      name: z.string().min(1).optional().describe('图像流名, 列组名或话题名 (如`head`); 不写即不限'),
      visible: z.boolean().optional().describe('是否显示, 缺省显示; 人在界面上的开关只存本地'),
    })
    .strict()
    .describe('按图层种类 + 角色 (可加产物名与名字) 选数据源的通道; ADP不写版本, 版本按图层接口的规则取 (采纳值优先)')
}

const viewCommon = {
  title: z.string().min(1).optional().describe('面板标题; 不写取视图类型名'),
}

export const Scene3dViewSchema = z
  .object({
    type: z.literal('scene3d'),
    ...viewCommon,
    frame: z
      .string()
      .min(1)
      .optional()
      .describe('基座标系名, 对应图层属性`frame` (序列声明的坐标系); 不在此坐标系的图层不画并标出. 不写取首个声明了坐标系的图层; 人的临时切换只存本地'),
    syncCamera: z.boolean().optional().describe('是否与其他开了同步的3D场景共用视角, 缺省不同步; 人的开关只存本地'),
    layers: z
      .array(layerBinding(['series', 'transform', 'pose', 'point_cloud', 'keypoints_3d']))
      .min(1)
      .describe(
        '叠放的图层: 末端位置序列画成轨迹, 坐标变换 (TF) 与位姿画成坐标轴, 点云与3D关键点画成点; 都按播放时刻取当时或之前最近的一条, 只画在基座标系里的',
      ),
  })
  .strict()
  .describe('3D场景')

export const ImageViewSchema = z
  .object({
    type: z.literal('image'),
    ...viewCommon,
    layers: z
      .array(layerBinding(['image_stream', 'segmentation', 'keypoints_2d']))
      .min(1)
      .describe(
        '图像流与叠在其上的分割, 2D关键点. 图像流匹配多路时并排, 用`name`可单放某一路相机; 叠加层叠到它所基于的那路图像上, 只在该帧时间戳上有数据时显示',
      ),
  })
  .strict()
  .describe('图像')

export const SeriesViewSchema = z
  .object({
    type: z.literal('series'),
    ...viewCommon,
    layers: z.array(layerBinding(['series'])).min(1).describe('序列: 末端位置画末端速度轨, 其余按列组分关节组'),
  })
  .strict()
  .describe('序列泳道')

export const EventsViewSchema = z
  .object({
    type: z.literal('events'),
    ...viewCommon,
    layers: z.array(layerBinding(['events'])).min(1).describe('事件: 质检结果 (角色`quality_check_events`) 按类别分质检事件与结构事件, 序列的阶段标记 (角色`task_phases`) 为任务事件'),
  })
  .strict()
  .describe('事件轨道')

export const MessageViewSchema = z
  .object({
    type: z.literal('message'),
    ...viewCommon,
    layers: z.array(layerBinding(['message'])).min(1).describe('结构化消息: 按播放时刻取不晚于它的最近一条, 解码后显示为消息树'),
  })
  .strict()
  .describe('消息树')

export const ViewSchema = z.discriminatedUnion('type', [
  Scene3dViewSchema,
  ImageViewSchema,
  SeriesViewSchema,
  EventsViewSchema,
  MessageViewSchema,
])

export type ViewSpec = z.infer<typeof ViewSchema>
export type ViewType = ViewSpec['type']
// 各视图类型的绑定只是`kind`范围不同, 跨类型处理时用这个公共形状
export type LayerBinding = {
  kind:
    | 'image_stream'
    | 'series'
    | 'events'
    | 'segmentation'
    | 'keypoints_2d'
    | 'transform'
    | 'pose'
    | 'point_cloud'
    | 'keypoints_3d'
    | 'message'
    | 'other'
  role?: string
  derivative?: string
  name?: string
  visible?: boolean
}

export const VIEW_TYPE_LABELS: Record<ViewType, string> = {
  scene3d: '3D场景',
  image: '图像',
  series: '序列泳道',
  events: '事件轨道',
  message: '消息树',
}

// 各视图类型可叠的图层种类, 与schema里的`kind`枚举一致
export const VIEW_LAYER_KINDS: Record<ViewType, readonly LayerBinding['kind'][]> = {
  scene3d: ['series', 'transform', 'pose', 'point_cloud', 'keypoints_3d'],
  image: ['image_stream', 'segmentation', 'keypoints_2d'],
  series: ['series'],
  events: ['events'],
  message: ['message'],
}

const nodeSize = z.number().positive().optional().describe('在上层分割里所占的相对份额, 缺省为1')

export const TabsNodeSchema = z
  .object({
    type: z.literal('tabs'),
    views: z.array(z.string()).min(1).describe('依次作为tab的视图id'),
    active: z.string().optional().describe('当前tab的视图id; 不写取第一个'),
    size: nodeSize,
  })
  .strict()
  .describe('一组tab')

export type TabsNode = z.infer<typeof TabsNodeSchema>
export type SplitNode = {
  type: 'split'
  direction: 'row' | 'column'
  children: LayoutNode[]
  size?: number
}
export type LayoutNode = TabsNode | SplitNode

export const SplitNodeSchema: z.ZodType<SplitNode> = z
  .object({
    type: z.literal('split'),
    direction: z.enum(['row', 'column']).describe('row: 子节点左右排; column: 上下排'),
    get children() {
      return z.array(LayoutNodeSchema).min(1)
    },
    size: nodeSize,
  })
  .strict()
  .describe('分割: 子节点按份额分占')

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.union([TabsNodeSchema, SplitNodeSchema])

// 布局树按出现顺序引用的视图id
export function referencedViews(node: LayoutNode): string[] {
  return node.type === 'tabs' ? node.views : node.children.flatMap(referencedViews)
}

function checkTabs(node: LayoutNode, issues: string[]) {
  if (node.type === 'split') node.children.forEach((child) => checkTabs(child, issues))
  else if (node.active !== undefined && !node.views.includes(node.active))
    issues.push(`tab组的active "${node.active}"不在其views里`)
}

export const LayoutDescriptionSchema = z
  .object({
    version: z.literal(LAYOUT_DESCRIPTION_VERSION),
    views: z
      .record(z.string().regex(VIEW_ID_PATTERN), ViewSchema)
      .describe('视图表: 视图id -> 视图; 加图层只改这里, 不动布局树'),
    layout: LayoutNodeSchema.describe('布局树: 只引用视图id, 每个视图至多出现一次'),
  })
  .strict()
  .superRefine((description, context) => {
    const issues: string[] = []
    const seen = new Set<string>()
    for (const id of referencedViews(description.layout)) {
      if (!(id in description.views)) issues.push(`布局树引用了视图表里没有的视图"${id}"`)
      if (seen.has(id)) issues.push(`视图"${id}"在布局树里出现了不止一次`)
      seen.add(id)
    }
    checkTabs(description.layout, issues)
    issues.forEach((message) => context.addIssue({ code: 'custom', message, path: ['layout'] }))
  })
  .describe('视图组装的布局描述: 视图表与布局树分开, 一份布局适用同一数据格式的所有录制')

export type LayoutDescription = z.infer<typeof LayoutDescriptionSchema>

export type LayoutParseResult = { success: true; description: LayoutDescription } | { success: false; issues: string[] }

// 校验一份布局描述; 不合schema的给出逐条问题 (路径: 说明), 调用方据此不渲染
export function parseLayoutDescription(input: unknown): LayoutParseResult {
  const result = LayoutDescriptionSchema.safeParse(input)
  if (result.success) return { success: true, description: result.data }
  return {
    success: false,
    issues: result.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)),
  }
}

// 入库给agent的JSON Schema; 布局树里引用须存在, 不重复这类跨字段约束JSON Schema表达不了, 以`parseLayoutDescription`为准
export function layoutJsonSchema() {
  return z.toJSONSchema(LayoutDescriptionSchema, { target: 'draft-2020-12' })
}
