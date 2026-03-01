/**
 * DeepSeek LLM 提供商
 * 
 * DeepSeek 提供 OpenAI 兼容的 API 接口。
 * 支持 deepseek-chat (V3) 和 deepseek-reasoner (R1) 等模型。
 * 
 * 文档: https://api-docs.deepseek.com/
 */

import type { ProviderConfig } from '../types/config.js';
import { OpenAICompatibleProvider } from './openai-compatible-base.js';

/** DeepSeek 常用模型常量 */
export const DEEPSEEK_MODELS = {
  /** DeepSeek-V3 通用对话模型 */
  CHAT: 'deepseek-chat',
  /** DeepSeek-R1 推理模型 */
  REASONER: 'deepseek-reasoner',
} as const;

/**
 * DeepSeek 提供商
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  readonly name = 'deepseek';

  constructor(config: ProviderConfig) {
    super(config, {
      providerName: 'DeepSeekProvider',
      defaultApiBase: 'https://api.deepseek.com',
      apiKeyMissingMessage: 'API Key 未配置，请设置 DEEPSEEK_API_KEY 环境变量或在配置中指定',
    });
  }
}
