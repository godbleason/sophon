import { Bot } from 'lucide-react'
import type { ConnectionStatus } from '@/types/chat'
import { cn } from '@/lib/utils'

interface ChatHeaderProps {
  status: ConnectionStatus
  disconnectReason: string
}

export function ChatHeader({ status, disconnectReason }: ChatHeaderProps) {
  const statusText =
    status === 'connected'
      ? disconnectReason || '已连接'
      : status === 'connecting'
        ? '连接中...'
        : status === 'error'
          ? '连接错误'
          : disconnectReason || '已断开'

  return (
    <header className="flex items-center gap-3 px-4 h-14 border-b border-border bg-background shrink-0">
      <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
        <Bot className="h-4 w-4 text-primary" />
      </div>
      <span className="font-semibold text-sm">Sophon</span>

      <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            'h-2 w-2 rounded-full transition-colors',
            status === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/50',
          )}
        />
        <span>{statusText}</span>
      </div>
    </header>
  )
}
