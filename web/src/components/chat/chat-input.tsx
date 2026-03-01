import { useCallback, useRef, useState } from 'react'
import { SendHorizonal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectionStatus } from '@/types/chat'

interface ChatInputProps {
  onSend: (text: string) => void
  disabled: boolean
  status: ConnectionStatus
}

export function ChatInput({ onSend, disabled, status }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isComposing = useRef(false)

  const handleSend = useCallback(() => {
    const text = value.trim()
    if (!text || disabled || status !== 'connected') return
    onSend(text)
    setValue('')
    // 重置高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, disabled, status, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleInput = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 150)}px`
    }
  }, [])

  const canSend = value.trim().length > 0 && !disabled && status === 'connected'

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onCompositionStart={() => { isComposing.current = true }}
            onCompositionEnd={() => { isComposing.current = false }}
            placeholder={status === 'connected' ? '输入消息...' : '连接中...'}
            disabled={status !== 'connected'}
            rows={1}
            className="w-full resize-none rounded-xl border border-input bg-secondary px-4 py-2.5 text-sm outline-none ring-ring/50 focus:ring-2 transition-shadow placeholder:text-muted-foreground disabled:opacity-50"
          />
        </div>
        <Button
          size="icon"
          className="shrink-0 rounded-xl h-10 w-10"
          onClick={handleSend}
          disabled={!canSend}
        >
          <SendHorizonal className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
