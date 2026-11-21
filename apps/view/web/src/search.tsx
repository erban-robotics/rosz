/**
 * Ctrl+K (macOS 为 Cmd+K) 话题搜索: 按话题名与类型查, 空格分开的几个词都要命中 (名或类型里含, 不分大小写).
 * 上下键选, Enter 即同点话题树 (加进面板或移出), Esc 关. rosz-ui 没有命令面板组件, 先在查看器里写.
 */
import type { ChannelInfo } from '@erban-robotics/rosz-ui'
import { useEffect, useMemo, useRef, useState } from 'react'

// 列出的结果上限: 话题再多也只渲染这么些, 再多就该多打几个字
const MAX_RESULTS = 50

function matches(channel: ChannelInfo, terms: string[]) {
  const haystack = `${channel.name}\n${channel.type ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function TopicSearch({
  catalog,
  selected,
  onPick,
}: {
  catalog: ChannelInfo[]
  selected: string[]
  onPick: (channel: ChannelInfo) => void
}) {
  const [isOpen, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return catalog
      .filter((channel) => matches(channel, terms))
      .sort((first, second) => first.name.localeCompare(second.name))
      .slice(0, MAX_RESULTS)
  }, [catalog, query])

  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!isOpen) return null
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const pick = (channel: ChannelInfo | undefined) => {
    if (!channel) return
    onPick(channel)
    close()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="搜索话题"
        className="flex max-h-[60vh] w-[36rem] flex-col overflow-hidden rounded-md border border-line-strong bg-surface-1 shadow-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="topic-search-results"
          placeholder="按话题名或类型搜索 (空格分开多个词)"
          className="border-b border-line bg-transparent px-3 py-2 text-sm text-foreground outline-none"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close()
            else if (event.key === 'ArrowDown') setActive((index) => Math.min(index + 1, results.length - 1))
            else if (event.key === 'ArrowUp') setActive((index) => Math.max(index - 1, 0))
            else if (event.key === 'Enter') pick(results[active])
            else return
            event.preventDefault()
          }}
        />
        <ul id="topic-search-results" role="listbox" ref={listRef} className="min-h-0 flex-1 overflow-auto py-1 text-xs">
          {results.length === 0 && <li className="px-3 py-2 text-muted-foreground">没有匹配的话题</li>}
          {results.map((channel, index) => (
            <li
              key={channel.id}
              role="option"
              aria-selected={index === active}
              aria-disabled={channel.undecodable ? true : undefined}
              className={`flex cursor-pointer items-baseline gap-2 px-3 py-1 ${index === active ? 'bg-surface-hover' : ''} ${channel.undecodable ? 'opacity-50' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(channel)}
            >
              <span className="font-mono text-foreground">{channel.name}</span>
              <span className="truncate text-foreground-tertiary">{channel.type}</span>
              {selected.includes(channel.name) && <span className="ml-auto shrink-0 text-foreground-secondary">已加, 回车移出</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
