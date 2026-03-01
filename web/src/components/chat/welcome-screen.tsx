import { Bot, BookOpen, Wrench, BarChart3, Hand } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface WelcomeScreenProps {
  onQuickMessage: (text: string) => void
}

export function WelcomeScreen({ onQuickMessage }: WelcomeScreenProps) {
  const quickActions = [
    { icon: BookOpen, label: '帮助', message: '/help' },
    { icon: Wrench, label: '工具列表', message: '/tools' },
    { icon: BarChart3, label: '状态', message: '/status' },
    { icon: Hand, label: '打招呼', message: '你好，介绍一下你自己' },
  ]

  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-4 text-center px-4">
      <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Bot className="h-8 w-8 text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-semibold">Sophon AI 助手</h2>
        <p className="text-muted-foreground text-sm mt-1.5 max-w-sm">
          输入消息开始对话，我可以帮你回答问题、执行命令、读写文件等。
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        {quickActions.map((action) => (
          <Button
            key={action.message}
            variant="outline"
            size="sm"
            className="gap-1.5 rounded-full"
            onClick={() => onQuickMessage(action.message)}
          >
            <action.icon className="h-3.5 w-3.5" />
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
