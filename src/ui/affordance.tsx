import { ChevronRightIcon } from 'lucide-react'
import { cn } from './utils'

// 可展开的箭头: 随`open`旋转 (样式见rosz-ui.css的`.expand-chevron`)
export function ExpandChevron({ open, className }: { open: boolean; className?: string }) {
  return <ChevronRightIcon aria-hidden data-open={open} className={cn('expand-chevron size-4 shrink-0', className)} />
}
