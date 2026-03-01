import { Bot, BookOpen, Wrench, BarChart3, User, Star, Menu } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConnectionStatus } from '@/types/chat'
import { cn } from '@/lib/utils'
import { useState, useRef, useEffect } from 'react'

interface ChatHeaderProps {
  status: ConnectionStatus
  disconnectReason: string
  onCommand: (cmd: string) => void
}

export function ChatHeader({ status, disconnectReason, onCommand }: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  const statusText =
    status === 'connected'
      ? disconnectReason || '已连接'
      : status === 'connecting'
        ? '连接中...'
        : status === 'error'
          ? '连接错误'
          : disconnectReason || '已断开'

  const menuItems = [
    { icon: BookOpen, label: '帮助', command: '/help' },
    { icon: Star, label: '关于平台', command: '/about' },
    { icon: Wrench, label: '工具列表', command: '/tools' },
    { icon: BarChart3, label: '状态', command: '/status' },
    { icon: User, label: '我的身份', command: '/whoami' },
  ]

  return (
    <header className="flex items-center gap-3 px-4 h-14 border-b border-border bg-background shrink-0">
      <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
        <Bot className="h-4 w-4 text-primary" />
      </div>
      <span className="font-semibold text-sm">Sophon</span>

      <div className="ml-auto flex items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              'h-2 w-2 rounded-full transition-colors',
              status === 'connected' ? 'bg-emerald-500' : 'bg-muted-foreground/50',
            )}
          />
          <span>{statusText}</span>
        </div>

        <div className="relative" ref={menuRef}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(!menuOpen)
            }}
          >
            <Menu className="h-4 w-4" />
          </Button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-40 bg-popover border border-border rounded-xl shadow-lg py-1 z-50">
              {menuItems.map((item) => (
                <button
                  key={item.command}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-popover-foreground hover:bg-accent transition-colors"
                  onClick={() => {
                    setMenuOpen(false)
                    onCommand(item.command)
                  }}
                >
                  <item.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
