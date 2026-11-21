import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

// 悬停多久后出提示 (ms): 鼠标路过不闪
const HINT_DELAY = 300

/**
 * 悬停提示的Provider: 页面骨架 (Layout) 挂一个, 全站共用; 单测单独渲染组件时自己包一层.
 * 同一Provider下沿工具栏扫过, 第一个提示等HINT_DELAY, 之后的即时出现且不做动画
 */
export function HintProvider({ children }: { children: ReactNode }) {
  return <TooltipProvider delayDuration={HINT_DELAY}>{children}</TooltipProvider>
}

/**
 * 悬停提示: 包住一个元素, 悬停或聚焦时显示text; text为空时原样返回子元素. 全站的补充说明都用它
 * (不用原生`title`, 其提示框由系统画, 不随主题). 须在HintProvider之内.
 * 禁用的按钮不发指针事件, 要给它提示就包在它外面的一层元素上
 */
export function Hint({
  text,
  side = 'top',
  children,
}: {
  text: ReactNode
  side?: ComponentProps<typeof TooltipContent>['side']
  children: ReactElement
}) {
  if (text === undefined || text === null || text === '') return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={4} className="max-w-sm [overflow-wrap:anywhere]">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
