/**
 * 消息相关类型定义
 */

/** 消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 通道名称 */
export type ChannelName = 'cli' | 'telegram' | 'discord' | 'webhook' | string;

/** 工具调用请求（LLM 返回的） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具调用结果 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** 聊天消息（LLM 交互格式） */
export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  /** assistant 消息可能包含工具调用 */
  toolCalls?: ToolCall[];
  /** tool 消息需要关联的工具调用 ID */
  toolCallId?: string;
  /** tool 消息的工具名称 */
  name?: string;
}

/** 入站消息（从通道到代理） */
export interface InboundMessage {
  /** 消息唯一 ID */
  id: string;
  /** 来源通道 */
  channel: ChannelName;
  /** 会话 ID */
  sessionId: string;
  /** 用户输入文本 */
  text: string;
  /** 发送者标识 */
  sender: string;
  /** 时间戳 */
  timestamp: number;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 出站消息（从代理到通道） */
export interface OutboundMessage {
  /** 消息唯一 ID */
  id: string;
  /** 目标通道 */
  channel: ChannelName;
  /** 会话 ID */
  sessionId: string;
  /** 回复文本 */
  text: string;
  /** 时间戳 */
  timestamp: number;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}
