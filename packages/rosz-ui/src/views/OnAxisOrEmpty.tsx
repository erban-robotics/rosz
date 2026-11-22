import type { ReactNode } from 'react'
import { useAxis, useDataSource } from '../data-source/react'

/**
 * 采样时间轴上没有可画的数据时显示空状态, 否则画`children`.
 * 没有采样时刻的样本 (如ADP的序列, 事件, 空间) 在采样轴上不存在.
 */
export function OnAxisOrEmpty({ hasData, children }: { hasData: boolean; children: ReactNode }) {
  const { state } = useDataSource()
  const axis = useAxis(state)
  if (axis !== 'sample' || hasData) return children
  return (
    <p role="status" className="grid h-full place-items-center p-4 text-sm text-muted-foreground">
      采样时间轴上无数据: 该视图的通道只有接收时刻
    </p>
  )
}
