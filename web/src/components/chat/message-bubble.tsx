import { Bot, User } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import type { ChatMessage } from '@/types/chat'
import { cn } from '@/lib/utils'

interface MessageBubbleProps {
  message: ChatMessage
}

/** 简易 Markdown 渲染（代码块、行内代码、粗体、换行） */
function formatMarkdown(text: string): string {
  // 代码块
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-black/30 rounded-lg p-3 my-2 overflow-x-auto text-sm"><code>$2</code></pre>')
  // 行内代码
  result = result.replace(/`([^`]+)`/g, '<code class="bg-black/20 px-1.5 py-0.5 rounded text-sm">$1</code>')
  // 粗体
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 换行
  result = result.replace(/\n/g, '<br>')
  return result
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('flex gap-3 max-w-[85%]', isUser ? 'ml-auto flex-row-reverse' : '')}>
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={cn(
            'text-sm',
            isUser
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-secondary-foreground',
          )}
        >
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>

      <div
        className={cn(
          'rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words',
          isUser
            ? 'bg-primary text-primary-foreground rounded-tr-sm'
            : 'bg-secondary text-secondary-foreground rounded-tl-sm',
        )}
        dangerouslySetInnerHTML={{ __html: formatMarkdown(message.content) }}
      />
    </div>
  )
}
