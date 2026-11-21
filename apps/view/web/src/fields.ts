/**
 * 消息的数值字段: 把解码出的值树摊平成 "字段路径 -> 数值", 画曲线用. 解码按样本缓存, 每条样本只解一次.
 * - 路径写法: 嵌套用 `.`, 数组下标用 `[i]` (如 `header.stamp.sec`, `position[3]`); 同层有等长的字符串数组 `name` 时
 *   下标换成名字 (JointState 的 `position[joint3]`)
 * - 64 位整数 (BigInt) 换成 number (曲线只要近似值); 布尔与字符串不算
 * - 超过 [`ARRAY_LIMIT`] 项的数组不摊 (点云, 图像字节), 免得字段多到没法选也拖慢解码
 */
import { loadedRosz, type Sample } from '@erban-robotics/rosz-ui'

const ARRAY_LIMIT = 64

export type Fields = Map<string, number>

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView))
}

function walk(value: unknown, path: string, out: Fields) {
  if (typeof value === 'number') out.set(path, value)
  else if (typeof value === 'bigint') out.set(path, Number(value))
  else if (isArrayLike(value)) {
    if (value.length > ARRAY_LIMIT) return
    for (let index = 0; index < value.length; index += 1) walk(value[index], `${path}[${index}]`, out)
  } else if (typeof value === 'object' && value !== null) walkRecord(value as Record<string, unknown>, path, out)
}

function walkRecord(record: Record<string, unknown>, prefix: string, out: Fields) {
  const names = Array.isArray(record.name) && record.name.every((item) => typeof item === 'string') ? (record.name as string[]) : null
  for (const [key, child] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (names && key !== 'name' && isArrayLike(child) && child.length === names.length && child.length <= ARRAY_LIMIT) {
      names.forEach((name, index) => walk(child[index], `${path}[${name}]`, out))
    } else walk(child, path, out)
  }
}

export function numericFields(tree: Record<string, unknown>): Fields {
  const out: Fields = new Map()
  walkRecord(tree, '', out)
  return out
}

// 样本 -> 摊平的字段; 解不了的记为空表, 不再重试. 样本淘汰后随之回收
const cache = new WeakMap<Sample, Fields>()
const EMPTY: Fields = new Map()

/** 一条结构化消息样本 (原始 CDR) 的数值字段; 解码模块还没加载时为 null */
export function fieldsOf(type: string, sample: Sample): Fields | null {
  const cached = cache.get(sample)
  if (cached) return cached
  const rosz = loadedRosz()
  if (!rosz) return null
  let fields = EMPTY
  try {
    const { tree } = rosz.decoder.decode(type, (sample.payload as { data: Uint8Array }).data) as { tree: Record<string, unknown> }
    fields = numericFields(tree)
  } catch {
    // 解码失败的原因由消息树显示, 曲线只是没有点
  }
  cache.set(sample, fields)
  return fields
}
