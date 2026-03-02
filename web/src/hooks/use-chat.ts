import { useCallback, useRef, useState } from 'react'
import type { ChatMessage, HistoryMessage, ProgressStep, ServerMessage } from '@/types/chat'
import { useWebSocket } from './use-websocket'

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.substring(0, max) + '...'
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([])
  const [isWaiting, setIsWaiting] = useState(false)
  const [showWelcome, setShowWelcome] = useState(true)
  const progressCountRef = useRef(0)
  // 用 ref 镜像 progressSteps，避免在 state updater 内产生副作用
  const progressStepsRef = useRef<ProgressStep[]>([])

  const handleServerMessage = useCallback((data: ServerMessage) => {
    switch (data.type) {
      case 'connected': {
        setMessages([])
        setProgressSteps([])
        progressStepsRef.current = []
        progressCountRef.current = 0

        if (data.history && data.history.length > 0) {
          setShowWelcome(false)
          const restored = restoreHistory(data.history)
          setMessages(restored)
        } else {
          setShowWelcome(true)
        }
        break
      }

      case 'progress': {
        setIsWaiting(true)
        handleProgress(data)
        break
      }

      case 'response': {
        // 完成进度并生成最终消息
        finalizeProgress()
        setIsWaiting(false)

        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.text,
        }
        setMessages((prev) => [...prev, assistantMsg])
        break
      }
    }
  }, [])

  const handleProgress = useCallback((data: ServerMessage & { type: 'progress' }) => {
    setProgressSteps((prev) => {
      // 将之前的 active 步骤标记为完成
      const updated = prev.map((s) =>
        s.isActive ? { ...s, isActive: false, icon: s.icon === '⏳' ? '✅' : s.icon } : s,
      )

      let next: ProgressStep[]

      switch (data.step) {
        case 'thinking': {
          progressCountRef.current++
          next = [
            ...updated,
            {
              id: crypto.randomUUID(),
              type: 'thinking' as const,
              icon: '⏳',
              text: '正在思考...',
              isActive: true,
            },
          ]
          break
        }
        case 'tool_call': {
          progressCountRef.current++
          const argsStr = data.toolArgs ? JSON.stringify(data.toolArgs, null, 2) : ''
          next = [
            ...updated,
            {
              id: crypto.randomUUID(),
              type: 'tool_call' as const,
              icon: '🔧',
              text: `调用工具 ${data.toolName || ''}`,
              toolName: data.toolName,
              toolArgs: argsStr ? truncate(argsStr, 200) : undefined,
              toolCallId: data.toolCallId,
              isActive: true,
            },
          ]
          break
        }
        case 'tool_result': {
          // 找到对应的 tool_call 步骤并更新
          next = updated.map((s) => {
            if (s.toolCallId === data.toolCallId) {
              return {
                ...s,
                isActive: false,
                icon: data.isError ? '❌' : '✅',
                content: data.content ? truncate(data.content, 500) : undefined,
                isError: data.isError,
              }
            }
            return s
          })
          break
        }
        case 'llm_response': {
          if (data.content) {
            progressCountRef.current++
            next = [
              ...updated,
              {
                id: crypto.randomUUID(),
                type: 'llm_response' as const,
                icon: '💬',
                text: data.content,
                isActive: false,
              },
            ]
          } else {
            next = updated
          }
          break
        }
        default:
          next = updated
      }

      // 同步更新 ref
      progressStepsRef.current = next
      return next
    })
  }, [])

  const finalizeProgress = useCallback(() => {
    // 从 ref 读取当前进度，避免在 state updater 内调用 setMessages（StrictMode 下会被调用两次）
    const prev = progressStepsRef.current
    if (prev.length === 0) return

    // 标记所有 active 为完成
    const finalized = prev.map((s) =>
      s.isActive ? { ...s, isActive: false, icon: s.icon === '⏳' ? '✅' : s.icon } : s,
    )

    // 检查是否有工具调用
    const hasToolCalls = finalized.some((s) => s.type === 'tool_call')
    if (hasToolCalls) {
      const toolCalls = finalized.filter((s) => s.type === 'tool_call')
      const uniqueNames = [...new Set(toolCalls.map((s) => s.toolName).filter(Boolean))]
      const summaryText = `🧠 思考过程 · ${toolCalls.length} 次工具调用${uniqueNames.length > 0 ? ` (${uniqueNames.join(', ')})` : ''}`

      const thinkingSteps = finalized
        .filter((s) => s.type === 'tool_call' || s.type === 'tool_result')
        .map((s) => ({
          type: s.type,
          toolName: s.toolName,
          toolArgs: s.toolArgs,
          content: s.content,
          isError: s.isError,
        }))

      // 在 state updater 外部调用 setMessages，避免 StrictMode 重复执行
      setMessages((msgs) => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system' as const,
          content: summaryText,
          thinkingSteps,
        },
      ])
    }

    // 清空进度
    progressStepsRef.current = []
    setProgressSteps([])
    progressCountRef.current = 0
  }, [])

  const { status, disconnectReason, send } = useWebSocket({
    onMessage: handleServerMessage,
  })

  const sendMessage = useCallback(
    (text: string) => {
      if (!text.trim() || isWaiting || status !== 'connected') return

      setShowWelcome(false)

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
      }
      setMessages((prev) => [...prev, userMsg])
      send(text)
      setIsWaiting(true)
    },
    [isWaiting, status, send],
  )

  return {
    messages,
    progressSteps,
    isWaiting,
    showWelcome,
    status,
    disconnectReason,
    sendMessage,
  }
}

/** 从历史数据恢复消息列表 */
function restoreHistory(history: HistoryMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []

  for (const msg of history) {
    // 如果有工具调用思考步骤，先插入进度消息
    if (msg.role === 'assistant' && msg.thinkingSteps && msg.thinkingSteps.length > 0) {
      const toolCalls = msg.thinkingSteps.filter((s) => s.type === 'tool_call')
      if (toolCalls.length > 0) {
        const uniqueNames = [...new Set(toolCalls.map((s) => s.toolName).filter(Boolean))]
        const summaryText = `🧠 思考过程 · ${toolCalls.length} 次工具调用${uniqueNames.length > 0 ? ` (${uniqueNames.join(', ')})` : ''}`

        result.push({
          id: crypto.randomUUID(),
          role: 'system',
          content: summaryText,
          thinkingSteps: msg.thinkingSteps,
        })
      }
    }

    result.push({
      id: crypto.randomUUID(),
      role: msg.role,
      content: msg.content,
    })
  }

  return result
}
