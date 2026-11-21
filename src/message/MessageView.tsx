import type { ChannelInfo } from '../data-source/types'

// 占位: 消息树视图, 由后续提交实现
export function MessageView({ channels }: { channels: ChannelInfo[] }) {
  return <p className="text-sm text-muted-foreground">{channels.length}路消息</p>
}
