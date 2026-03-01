/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 思考步骤（工具调用链） */
export interface ThinkingStep {
  type: 'tool_call' | 'tool_result' | 'thinking' | 'llm_response'
  toolName?: string
  toolArgs?: string
  toolCallId?: string
  content?: string
  isError?: boolean
}

/** 聊天消息 */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  thinkingSteps?: ThinkingStep[]
}

/** 实时进度步骤 */
export interface ProgressStep {
  id: string
  type: ThinkingStep['type']
  icon: string
  text: string
  toolName?: string
  toolArgs?: string
  toolCallId?: string
  content?: string
  isError?: boolean
  isActive: boolean
}

/** WebSocket 连接状态 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** 服务端消息类型 */
export type ServerMessage =
  | { type: 'connected'; sessionId: string; message: string; history?: HistoryMessage[] }
  | { type: 'progress'; step: string; toolName?: string; toolArgs?: Record<string, unknown>; toolCallId?: string; content?: string; isError?: boolean }
  | { type: 'response'; text: string }

/** 历史消息（从服务端返回） */
export interface HistoryMessage {
  role: MessageRole
  content: string
  thinkingSteps?: ThinkingStep[]
}
