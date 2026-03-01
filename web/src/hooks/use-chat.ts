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

  const handleServerMessage = useCallback((data: ServerMessage) => {
    switch (data.type) {
      case 'connected': {
        setMessages([])
        setProgressSteps([])
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

      switch (data.step) {
        case 'thinking': {
          progressCountRef.current++
          return [
            ...updated,
            {
              id: crypto.randomUUID(),
              type: 'thinking' as const,
              icon: '⏳',
              text: '正在思考...',
              isActive: true,
            },
          ]
        }
        case 'tool_call': {
          progressCountRef.current++
          const argsStr = data.toolArgs ? JSON.stringify(data.toolArgs, null, 2) : ''
          return [
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
        }
        case 'tool_result': {
          // 找到对应的 tool_call 步骤并更新
          const resultUpdated = updated.map((s) => {
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
          return resultUpdated
        }
        case 'llm_response': {
          if (data.content) {
            progressCountRef.current++
            return [
              ...updated,
              {
                id: crypto.randomUUID(),
                type: 'llm_response' as const,
                icon: '💬',
                text: data.content,
                isActive: false,
              },
            ]
          }
          return updated
        }
        default:
          return updated
      }
    })
  }, [])

  const finalizeProgress = useCallback(() => {
    setProgressSteps((prev) => {
      if (prev.length === 0) return prev

      // 标记所有 active 为完成
      const finalized = prev.map((s) =>
        s.isActive ? { ...s, isActive: false, icon: s.icon === '⏳' ? '✅' : s.icon } : s,
      )

      // 检查是否有工具调用
      const hasToolCalls = finalized.some((s) => s.type === 'tool_call')
      if (!hasToolCalls) {
        // 没有工具调用（只有 thinking），不生成思考过程消息
        progressCountRef.current = 0
        return []
      }

      // 生成一条带思考步骤的占位消息插入到消息列表中
      const toolCalls = finalized.filter((s) => s.type === 'tool_call')
      const uniqueNames = [...new Set(toolCalls.map((s) => s.toolName).filter(Boolean))]
      const summaryText = `🧠 思考过程 · ${toolCalls.length} 次工具调用${uniqueNames.length > 0 ? ` (${uniqueNames.join(', ')})` : ''}`

      // 将 progress steps 转为 thinking steps 并附加到即将到来的 assistant 消息
      const thinkingSteps = finalized
        .filter((s) => s.type === 'tool_call' || s.type === 'tool_result')
        .map((s) => ({
          type: s.type,
          toolName: s.toolName,
          toolArgs: s.toolArgs,
          content: s.content,
          isError: s.isError,
        }))

      // 插入一条 progress 消息
      setMessages((msgs) => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system' as const,
          content: summaryText,
          thinkingSteps,
        },
      ])

      progressCountRef.current = 0
      return []
    })
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
