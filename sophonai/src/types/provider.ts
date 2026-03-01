/**
 * LLM 提供商类型定义
 */

import type { ChatMessage, ToolCall } from './message.js';
import type { ToolDefinition } from './tool.js';

/** LLM 请求选项 */
export interface LLMRequestOptions {
  /** 模型名称 */
  model: string;
  /** 消息历史 */
  messages: ChatMessage[];
  /** 可用工具定义 */
  tools?: ToolDefinition[];
  /** 温度参数 */
  temperature?: number;
  /** 最大 token 数 */
  maxTokens?: number;
  /** 系统提示 */
  systemPrompt?: string;
  /** 停止序列 */
  stopSequences?: string[];
}

/** LLM 响应 */
export interface LLMResponse {
  /** 文本内容 */
  content: string | null;
  /** 工具调用列表 */
  toolCalls: ToolCall[];
  /** 使用的 token 数 */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 完成原因 */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
}

/** LLM 提供商接口 */
export interface LLMProvider {
  /** 提供商名称 */
  name: string;
  /** 发送聊天请求 */
  chat(options: LLMRequestOptions): Promise<LLMResponse>;
}
