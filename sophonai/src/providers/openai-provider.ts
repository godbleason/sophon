/**
 * OpenAI LLM 提供商
 * 
 * 支持 OpenAI API 及所有兼容 API（如 DeepSeek, 通义千问等）。
 */

import type { ProviderConfig } from '../types/config.js';
import { OpenAICompatibleProvider } from './openai-compatible-base.js';

/**
 * OpenAI 提供商
 */
export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly name = 'openai';

  constructor(config: ProviderConfig) {
    super(config, {
      providerName: 'OpenAIProvider',
      defaultApiBase: 'https://api.openai.com/v1',
      apiKeyMissingMessage: 'API Key 未配置，请设置 OPENAI_API_KEY 环境变量或在配置中指定',
    });
  }
}
