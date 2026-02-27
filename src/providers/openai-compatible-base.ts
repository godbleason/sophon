/**
 * OpenAI 兼容 API 基类
 * 
 * 提供所有 OpenAI 兼容 API 的公共逻辑：
 * 消息格式化、请求发送、响应解析。
 * 
 * OpenAI、OpenRouter 等提供商均继承此基类。
 */

import type { LLMProvider, LLMRequestOptions, LLMResponse } from '../types/provider.js';
import type { ChatMessage, ToolCall } from '../types/message.js';
import type { ToolDefinition } from '../types/tool.js';
import type { ProviderConfig } from '../types/config.js';
import { ProviderError } from '../core/errors.js';
import { createChildLogger } from '../core/logger.js';

/** OpenAI API 消息格式 */
export interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** OpenAI API 响应格式 */
export interface OpenAIResponse {
  id: string;
  choices: Array<{
    index: number;
    message: OpenAIMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** 基类初始化选项 */
export interface OpenAICompatibleOptions {
  /** 提供商名称（用于日志和错误信息） */
  providerName: string;
  /** 默认 API Base URL */
  defaultApiBase: string;
  /** API Key 缺失时的错误提示 */
  apiKeyMissingMessage: string;
  /** 额外的请求头 */
  extraHeaders?: Record<string, string>;
}

/**
 * OpenAI 兼容 API 基类
 */
export abstract class OpenAICompatibleProvider implements LLMProvider {
  abstract readonly name: string;

  protected readonly apiKey: string;
  protected readonly apiBase: string;
  protected readonly extraHeaders: Record<string, string>;
  protected readonly providerName: string;
  protected readonly log: ReturnType<typeof createChildLogger>;

  constructor(config: ProviderConfig, options: OpenAICompatibleOptions) {
    this.providerName = options.providerName;
    this.log = createChildLogger(options.providerName);

    if (!config.apiKey) {
      throw new ProviderError(options.providerName, options.apiKeyMissingMessage);
    }

    this.apiKey = config.apiKey;
    this.apiBase = config.apiBase || options.defaultApiBase;
    this.extraHeaders = options.extraHeaders ?? {};
  }

  async chat(options: LLMRequestOptions): Promise<LLMResponse> {
    const { model, messages, tools, temperature = 0.7, maxTokens = 4096 } = options;

    // 构建请求体
    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages, options.systemPrompt),
      temperature,
      max_tokens: maxTokens,
    };

    if (tools && tools.length > 0) {
      body['tools'] = this.formatTools(tools);
      body['tool_choice'] = 'auto';
    }

    // 允许子类扩展请求体
    this.extendRequestBody(body, options);

    this.log.debug({ model, messageCount: messages.length, toolCount: tools?.length ?? 0 }, '发送 LLM 请求');

    const url = `${this.apiBase}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(
        this.providerName,
        `API 请求失败: ${(err as Error).message}`,
        { url },
        { cause: err as Error },
      );
    }

    if (!response.ok) {
      let errorBody: string;
      try {
        errorBody = await response.text();
      } catch {
        errorBody = '无法读取错误响应';
      }
      throw new ProviderError(
        this.providerName,
        `API 返回错误: ${response.status} ${response.statusText}`,
        { status: response.status, body: errorBody },
      );
    }

    let data: OpenAIResponse;
    try {
      data = (await response.json()) as OpenAIResponse;
    } catch (err) {
      throw new ProviderError(
        this.providerName,
        '响应解析失败',
        undefined,
        { cause: err as Error },
      );
    }

    const choice = data.choices[0];
    if (!choice) {
      throw new ProviderError(this.providerName, 'API 返回空的 choices');
    }

    // 解析工具调用
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch (err) {
        throw new ProviderError(
          this.providerName,
          `工具调用参数解析失败: toolCallId=${tc.id}, function=${tc.function.name}`,
          { toolCallId: tc.id, rawArgs: tc.function.arguments },
          { cause: err as Error },
        );
      }

      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
      };
    });

    // 映射 finish_reason
    const finishReasonMap: Record<string, LLMResponse['finishReason']> = {
      'stop': 'stop',
      'tool_calls': 'tool_calls',
      'length': 'length',
      'content_filter': 'content_filter',
    };

    const result: LLMResponse = {
      content: choice.message.content,
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: finishReasonMap[choice.finish_reason] ?? 'stop',
    };

    this.log.debug({
      finishReason: result.finishReason,
      toolCallCount: toolCalls.length,
      tokens: result.usage.totalTokens,
    }, 'LLM 响应');

    return result;
  }

  /**
   * 子类可重写此方法扩展请求体
   */
  protected extendRequestBody(
    _body: Record<string, unknown>,
    _options: LLMRequestOptions,
  ): void {
    // 默认不做任何操作
  }

  /** 格式化消息为 OpenAI 格式 */
  protected formatMessages(messages: ChatMessage[], systemPrompt?: string): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      const formatted: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }));
      }

      if (msg.toolCallId) {
        formatted.tool_call_id = msg.toolCallId;
      }

      if (msg.name) {
        formatted.name = msg.name;
      }

      result.push(formatted);
    }

    return result;
  }

  /** 格式化工具定义 */
  protected formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((tool) => ({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      },
    }));
  }
}
