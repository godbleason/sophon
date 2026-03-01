/**
 * OpenRouter LLM 提供商
 * 
 * OpenRouter 是一个统一的 AI 模型网关，支持访问多种模型（OpenAI, Anthropic, Google, Meta 等）。
 * API 兼容 OpenAI 格式，但有额外的 headers 和可选的路由参数。
 * 
 * 特点:
 * - 统一接口访问 200+ 模型
 * - 自动选择最优提供商（价格/速度/可用性）
 * - 支持 fallback 路由
 * 
 * 文档: https://openrouter.ai/docs
 */

import type { ProviderConfig } from '../types/config.js';
import type { LLMRequestOptions } from '../types/provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-base.js';

/** OpenRouter 常用模型常量 */
export const OPENROUTER_MODELS = {
  // OpenAI
  GPT4O: 'openai/gpt-4o',
  GPT4O_MINI: 'openai/gpt-4o-mini',
  O1: 'openai/o1',
  O1_MINI: 'openai/o1-mini',
  // Anthropic
  CLAUDE_3_5_SONNET: 'anthropic/claude-3.5-sonnet',
  CLAUDE_3_5_HAIKU: 'anthropic/claude-3.5-haiku',
  CLAUDE_3_OPUS: 'anthropic/claude-3-opus',
  // Google
  GEMINI_2_FLASH: 'google/gemini-2.0-flash-001',
  GEMINI_2_PRO: 'google/gemini-2.0-pro-exp-02-05',
  // DeepSeek
  DEEPSEEK_CHAT: 'deepseek/deepseek-chat',
  DEEPSEEK_R1: 'deepseek/deepseek-r1',
  // Meta
  LLAMA_3_3_70B: 'meta-llama/llama-3.3-70b-instruct',
  // Qwen
  QWEN_2_5_72B: 'qwen/qwen-2.5-72b-instruct',
  // 自动路由
  AUTO: 'openrouter/auto',
} as const;

/**
 * OpenRouter 提供商
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter';

  constructor(config: ProviderConfig) {
    super(config, {
      providerName: 'OpenRouterProvider',
      defaultApiBase: 'https://openrouter.ai/api/v1',
      apiKeyMissingMessage: 'API Key 未配置，请设置 OPENROUTER_API_KEY 环境变量或在配置中指定',
      extraHeaders: {
        'HTTP-Referer': 'https://github.com/sophon-ai',
        'X-Title': 'Sophon AI Assistant',
      },
    });
  }

  /**
   * 扩展请求体，添加 OpenRouter 特有字段
   */
  protected override extendRequestBody(
    body: Record<string, unknown>,
    _options: LLMRequestOptions,
  ): void {
    // OpenRouter 支持 transforms 让服务端自动处理 prompt 截断
    body['transforms'] = ['middle-out'];

    // 可选: 指定路由策略
    // body['route'] = 'fallback';

    // 可选: provider 偏好
    // body['provider'] = {
    //   order: ['Anthropic', 'OpenAI'],
    //   allow_fallbacks: true,
    // };
  }
}
