import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useCatalog } from '../data-source/react'
import type { DataSourceState } from '../data-source/state'
import type { ChannelInfo } from '../data-source/types'
import { Hint } from '../ui/Hint'

// 频率刷新间隔 (ms): 频率按最近2秒统计, 每秒看一次足够, 不随每条消息重渲
const FREQUENCY_REFRESH_MS = 1000
// 每层缩进 (px)
const INDENT_PIXELS = 12

// 命名空间树的一个节点: `path`为从根起的命名空间 (如`/camera/color`), 一个名字可以既是通道又是命名空间 (如`/tf`与`/tf/x`)
type TreeNode = { segment: string; path: string; channel: ChannelInfo | null; children: TreeNode[] }

// 按名字的`/`分层; 开头的`/`与连续的`/`不算一层. 同层按名字排, 不按目录到达顺序, 话题上下线时列表不跳
function buildTree(channels: ChannelInfo[]): TreeNode[] {
  const root: TreeNode = { segment: '', path: '', channel: null, children: [] }
  for (const channel of channels) {
    let node = root
    for (const segment of channel.name.split('/').filter(Boolean)) {
      const path = `${node.path}/${segment}`
      let child = node.children.find((candidate) => candidate.segment === segment)
      if (!child) {
        child = { segment, path, channel: null, children: [] }
        node.children.push(child)
      }
      node = child
    }
    // 名字为空或只有`/`时挂在根下, 以原名显示
    if (node === root) root.children.push({ segment: channel.name, path: channel.id, channel, children: [] })
    else node.channel = channel
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((first, second) => first.segment.localeCompare(second.segment))
    nodes.forEach((node) => sort(node.children))
  }
  sort(root.children)
  return root.children
}

function formatFrequency(frequency: number | null) {
  return frequency === null ? null : `${frequency.toFixed(1)} Hz`
}

function ChannelRow({
  node,
  depth,
  frequency,
  isSelected,
  hasChildren,
  isOpen,
  onToggle,
  onSelect,
}: {
  node: TreeNode & { channel: ChannelInfo }
  depth: number
  frequency: number | null
  isSelected: boolean
  hasChildren: boolean
  isOpen: boolean
  onToggle: () => void
  onSelect?: (channel: ChannelInfo) => void
}) {
  const { channel } = node
  const row = (
    <div
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={hasChildren ? isOpen : undefined}
      aria-disabled={channel.undecodable ? true : undefined}
      tabIndex={0}
      className={`flex cursor-pointer items-baseline gap-1.5 rounded-sm py-0.5 pr-1.5 hover:bg-surface-hover ${isSelected ? 'bg-primary-soft text-foreground' : ''} ${channel.undecodable ? 'opacity-50' : ''}`}
      style={{ paddingLeft: depth * INDENT_PIXELS }}
      onClick={() => onSelect?.(channel)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.(channel)
        }
      }}
    >
      <Toggle isVisible={hasChildren} isOpen={isOpen} onToggle={onToggle} />
      <span className="shrink-0 text-foreground">{node.segment}</span>
      {channel.type && <span className="min-w-0 truncate font-mono text-[11px] text-foreground-tertiary">{channel.type}</span>}
      <span className="ml-auto flex shrink-0 items-baseline gap-1.5 text-foreground-tertiary">
        {channel.isStatic && <span className="rounded-sm border border-line px-1 text-[11px]">静态</span>}
        {frequency !== null && <span className="font-mono text-[11px] tabular-nums">{formatFrequency(frequency)}</span>}
      </span>
    </div>
  )
  return channel.undecodable ? <Hint text={`无法解码: ${channel.undecodable}`}>{row}</Hint> : row
}

// 折叠箭头; 没有子项时占位, 让同层的名字对齐
function Toggle({ isVisible, isOpen, onToggle }: { isVisible: boolean; isOpen: boolean; onToggle: () => void }) {
  if (!isVisible) return <span className="size-3 shrink-0" />
  return (
    <button
      type="button"
      aria-label={isOpen ? '折叠' : '展开'}
      className="shrink-0 self-center text-foreground-tertiary"
      onClick={(event) => {
        // 点箭头只折叠, 不选中所在行
        event.stopPropagation()
        onToggle()
      }}
    >
      <ChevronRight className={`size-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
    </button>
  )
}

/**
 * 通道列表: 查看器的话题列表与ADP的图层列表共用. 通道目录按名字的`/`折叠成命名空间树 (默认全展开, 名字不含`/`即平铺),
 * 每项显示名称, 类型, 频率 (有样本统计时), 静态标记; 解不了的整行变灰, 悬停给原因. `selected`为通道`id`.
 */
export function ChannelList({
  state,
  selected,
  onSelect,
  className = '',
}: {
  state: DataSourceState
  selected?: string[]
  onSelect?: (channel: ChannelInfo) => void
  className?: string
}) {
  const catalog = useCatalog(state)
  const tree = useMemo(() => buildTree(catalog), [catalog])
  // 记折叠的而非展开的: 新上线的命名空间默认展开
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), FREQUENCY_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  const selectedIds = new Set(selected)

  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const renderNodes = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const hasChildren = node.children.length > 0
      const isOpen = !collapsed.has(node.path)
      const children = hasChildren && isOpen && (
        <div role="group">{renderNodes(node.children, depth + 1)}</div>
      )
      if (node.channel)
        return (
          <div key={node.path}>
            <ChannelRow
              node={node as TreeNode & { channel: ChannelInfo }}
              depth={depth}
              frequency={state.stats(node.channel.id).frequency}
              isSelected={selectedIds.has(node.channel.id)}
              hasChildren={hasChildren}
              isOpen={isOpen}
              onToggle={() => toggle(node.path)}
              onSelect={onSelect}
            />
            {children}
          </div>
        )
      return (
        <div key={node.path}>
          <div
            role="treeitem"
            aria-selected={false}
            aria-expanded={isOpen}
            className="flex cursor-pointer items-baseline gap-1.5 rounded-sm py-0.5 pr-1.5 text-foreground-secondary hover:bg-surface-hover"
            style={{ paddingLeft: depth * INDENT_PIXELS }}
            onClick={() => toggle(node.path)}
          >
            <Toggle isVisible isOpen={isOpen} onToggle={() => toggle(node.path)} />
            <span>{node.segment}</span>
          </div>
          {children}
        </div>
      )
    })

  if (catalog.length === 0) return <p className={`text-xs text-muted-foreground ${className}`}>没有通道</p>
  return (
    <div role="tree" aria-label="通道" className={`flex flex-col text-xs ${className}`}>
      {renderNodes(tree, 0)}
    </div>
  )
}
