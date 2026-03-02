import { useCallback, useRef, useState, useEffect } from 'react'
import { ArrowUp, BookOpen, Star, Wrench, BarChart3, User, Menu } from 'lucide-react'
import type { ConnectionStatus } from '@/types/chat'

interface ChatInputProps {
  onSend: (text: string) => void
  disabled: boolean
  status: ConnectionStatus
}

const menuItems = [
  { icon: BookOpen, emoji: '📖', label: '帮助', command: '/help' },
  { icon: Star, emoji: '🌟', label: '关于平台', command: '/about' },
  { icon: Wrench, emoji: '🔧', label: '工具列表', command: '/tools' },
  { icon: BarChart3, emoji: '📊', label: '状态', command: '/status' },
  { icon: User, emoji: '👤', label: '我的身份', command: '/whoami' },
]

export function ChatInput({ onSend, disabled, status }: ChatInputProps) {
  const [value, setValue] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const isComposing = useRef(false)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

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
    <div className="border-t border-border bg-background px-4 py-3 shrink-0">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center rounded-full border border-input bg-secondary transition-colors focus-within:border-primary">
          {/* 菜单按钮 */}
          <div className="relative shrink-0 flex items-center pl-1.5" ref={menuRef}>
            <button
              type="button"
              className="h-[34px] w-[34px] rounded-full bg-muted flex items-center justify-center text-muted-foreground hover:text-primary hover:bg-primary/15 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(!menuOpen)
              }}
              title="菜单"
            >
              <Menu className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute bottom-[calc(100%+12px)] left-0 bg-popover border border-border rounded-xl shadow-lg py-1.5 min-w-[160px] z-50 animate-in fade-in slide-in-from-bottom-2 duration-150">
                {menuItems.map((item) => (
                  <button
                    key={item.command}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
                    onClick={() => {
                      setMenuOpen(false)
                      onSend(item.command)
                    }}
                  >
                    <span className="text-base">{item.emoji}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            onCompositionStart={() => { isComposing.current = true }}
            onCompositionEnd={() => { isComposing.current = false }}
            placeholder={
              status === 'connected'
                ? '输入消息... (Enter 发送, Shift+Enter 换行)'
                : status === 'connecting'
                  ? '连接中...'
                  : status === 'error'
                    ? '连接失败'
                    : '已断开连接'
            }
            disabled={status !== 'connected'}
            rows={1}
            className="flex-1 resize-none bg-transparent px-2 py-2.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50 min-h-[44px] max-h-[150px] leading-relaxed"
          />

          {/* 发送按钮 */}
          <div className="shrink-0 flex items-center pr-1.5">
            <button
              type="button"
              className="h-[34px] w-[34px] rounded-full bg-primary text-primary-foreground flex items-center justify-center transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
              onClick={handleSend}
              disabled={!canSend}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
