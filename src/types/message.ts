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
  /** 消息唯一 ID（持久化时自动生成，LLM 交互时可省略） */
  id?: string;
  role: MessageRole;
  content: string | null;
  /** assistant 消息可能包含工具调用 */
  toolCalls?: ToolCall[];
  /** tool 消息需要关联的工具调用 ID */
  toolCallId?: string;
  /** tool 消息的工具名称 */
  name?: string;
  /** 附加元数据（不影响 LLM 交互，仅用于内部标记，如消息来源） */
  metadata?: Record<string, unknown>;
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

/** 进度消息步骤类型 */
export type ProgressStep =
  | 'thinking'       // LLM 正在思考
  | 'tool_call'      // 开始执行工具
  | 'tool_result'    // 工具执行完成
  | 'llm_response';  // LLM 中间响应（有 toolCalls 时的文本）

/** 进度消息（实时推送到通道，展示 Agent 每一步过程） */
export interface ProgressMessage {
  /** 消息唯一 ID */
  id: string;
  /** 目标通道 */
  channel: ChannelName;
  /** 会话 ID */
  sessionId: string;
  /** 进度步骤类型 */
  step: ProgressStep;
  /** 时间戳 */
  timestamp: number;
  /** 当前迭代轮次 */
  iteration?: number;
  /** 工具名称 */
  toolName?: string;
  /** 工具调用参数 */
  toolArgs?: Record<string, unknown>;
  /** 工具调用 ID */
  toolCallId?: string;
  /** 文本内容（工具结果 / LLM 中间文本） */
  content?: string;
  /** 是否出错 */
  isError?: boolean;
}
