import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ChatMessage, ThinkingStep, ProgressStep } from '@/types/chat'
import { cn } from '@/lib/utils'

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.substring(0, max) + '...'
}

/** 从历史数据中的 thinkingSteps 渲染已折叠的思维链 */
export function HistoryProgressGroup({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const steps = message.thinkingSteps ?? []

  if (steps.length === 0) return null

  return (
    <div className="max-w-[85%] group">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex items-center gap-2 px-3.5 py-2 bg-secondary border border-border rounded-xl text-xs text-muted-foreground cursor-pointer select-none transition-colors group-hover:text-secondary-foreground group-hover:border-ring w-full data-[state=open]:rounded-b-none data-[state=open]:border-b-0">
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform duration-200',
              open && 'rotate-90',
            )}
          />
          <span>{message.content}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="bg-secondary border border-border border-t-0 rounded-b-xl px-3.5 py-3 space-y-2 text-xs text-muted-foreground transition-colors group-hover:border-ring">
          {steps.map((step, i) => (
            <StepItem key={i} step={step} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** 实时进度组（正在思考时显示） */
export function LiveProgressGroup({ steps }: { steps: ProgressStep[] }) {
  const [open, setOpen] = useState(true)

  if (steps.length === 0) return null

  const toolCalls = steps.filter((s) => s.type === 'tool_call')
  const uniqueNames = [...new Set(toolCalls.map((s) => s.toolName).filter(Boolean))]

  let summary = '🧠 思考中...'
  if (toolCalls.length > 0) {
    summary = `🧠 思考中 · ${toolCalls.length} 次工具调用${uniqueNames.length > 0 ? ` (${uniqueNames.join(', ')})` : ''}`
  }

  return (
    <div className="max-w-[85%] group">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex items-center gap-2 px-3.5 py-2 bg-secondary border border-border rounded-xl text-xs text-muted-foreground cursor-pointer select-none transition-colors group-hover:text-secondary-foreground group-hover:border-ring w-full data-[state=open]:rounded-b-none data-[state=open]:border-b-0">
          <ChevronRight
            className={cn(
              'h-3 w-3 transition-transform duration-200',
              open && 'rotate-90',
            )}
          />
          <span>{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="bg-secondary border border-border border-t-0 rounded-b-xl px-3.5 py-3 space-y-2 text-xs text-muted-foreground max-h-[300px] overflow-y-auto transition-colors group-hover:border-ring">
          {steps.map((step) => (
            <LiveStepItem key={step.id} step={step} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

/** 历史步骤项 */
function StepItem({ step }: { step: ThinkingStep }) {
  if (step.type === 'tool_call') {
    return (
      <div className="flex items-start gap-2">
        <span className="shrink-0">🔧</span>
        <div className="min-w-0">
          <span>调用工具 </span>
          <span className="font-semibold text-foreground">{step.toolName}</span>
          {step.toolArgs && (
            <div className="mt-1 text-[11px] text-muted-foreground/70 font-mono bg-black/10 rounded px-2 py-1 break-all">
              {truncate(step.toolArgs, 200)}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (step.type === 'tool_result') {
    const icon = step.isError ? '❌' : '✅'
    return (
      <div className="flex items-start gap-2">
        <span className="shrink-0">{icon}</span>
        <div className="min-w-0">
          <span className="font-semibold text-foreground">{step.toolName || '工具结果'}</span>
          {step.content && (
            <div
              className={cn(
                'mt-1 text-[11px] font-mono bg-black/10 rounded px-2 py-1 break-all max-h-[200px] overflow-y-auto',
                step.isError && 'text-destructive',
              )}
            >
              {truncate(step.content, 500)}
            </div>
          )}
        </div>
      </div>
    )
  }

  return null
}

/** 实时步骤项 */
function LiveStepItem({ step }: { step: ProgressStep }) {
  return (
    <div className={cn('flex items-start gap-2', step.isActive && 'animate-pulse')}>
      <span className="shrink-0">{step.icon}</span>
      <div className="min-w-0">
        {step.type === 'tool_call' ? (
          <>
            <span>调用工具 </span>
            <span className="font-semibold text-foreground">{step.toolName}</span>
            {step.toolArgs && (
              <div className="mt-1 text-[11px] text-muted-foreground/70 font-mono bg-black/10 rounded px-2 py-1 break-all">
                {step.toolArgs}
              </div>
            )}
          </>
        ) : step.type === 'tool_result' ? (
          <>
            <span className="font-semibold text-foreground">{step.toolName || '工具结果'}</span>
            {step.content && (
              <div
                className={cn(
                  'mt-1 text-[11px] font-mono bg-black/10 rounded px-2 py-1 break-all max-h-[200px] overflow-y-auto',
                  step.isError && 'text-destructive',
                )}
              >
                {step.content}
              </div>
            )}
          </>
        ) : (
          <span>{step.text}</span>
        )}
      </div>
    </div>
  )
}
