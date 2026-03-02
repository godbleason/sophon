import { useEffect, useRef } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { ChatMessage, ProgressStep } from '@/types/chat'
import { MessageBubble } from './message-bubble'
import { HistoryProgressGroup, LiveProgressGroup } from './progress-group'
import { TypingIndicator } from './typing-indicator'
import { WelcomeScreen } from './welcome-screen'

interface MessageListProps {
  messages: ChatMessage[]
  progressSteps: ProgressStep[]
  isWaiting: boolean
  showWelcome: boolean
  onQuickMessage: (text: string) => void
}

export function MessageList({
  messages,
  progressSteps,
  isWaiting,
  showWelcome,
  onQuickMessage,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const isInitialLoad = useRef(true)

  useEffect(() => {
    if (messages.length === 0) {
      isInitialLoad.current = true
      return
    }

    // 滚动到底部
    const behavior = isInitialLoad.current ? 'instant' : 'smooth'
    bottomRef.current?.scrollIntoView({ behavior })
    isInitialLoad.current = false
  }, [messages, progressSteps, isWaiting])

  if (showWelcome && messages.length === 0) {
    return (
      <div className="flex-1 flex">
        <WelcomeScreen onQuickMessage={onQuickMessage} />
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {messages.map((msg) => {
          // system 消息带 thinkingSteps = 折叠的思考过程
          if (msg.role === 'system' && msg.thinkingSteps) {
            return <HistoryProgressGroup key={msg.id} message={msg} />
          }

          // 普通 system 消息（如断连提示）
          if (msg.role === 'system') {
            return (
              <div
                key={msg.id}
                className="text-center text-xs text-muted-foreground bg-muted/50 rounded-lg py-2 px-4"
              >
                {msg.content}
              </div>
            )
          }

          return <MessageBubble key={msg.id} message={msg} />
        })}

        {/* 实时进度组 */}
        {progressSteps.length > 0 && <LiveProgressGroup steps={progressSteps} />}

        {/* 打字指示器 */}
        {isWaiting && progressSteps.length === 0 && <TypingIndicator />}

        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
