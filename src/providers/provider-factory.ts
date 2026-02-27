/**
 * LLM Provider 工厂
 * 
 * 根据配置创建对应的 LLM Provider 实例。
 */

import type { LLMProvider } from '../types/provider.js';
import type { ProviderConfig } from '../types/config.js';
import { OpenAIProvider } from './openai-provider.js';
import { OpenRouterProvider } from './openrouter-provider.js';
import { DeepSeekProvider } from './deepseek-provider.js';
import { ProviderError } from '../core/errors.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('ProviderFactory');

/** 已注册的 Provider 构造器 */
const providerConstructors: Record<string, new (config: ProviderConfig) => LLMProvider> = {
  openai: OpenAIProvider,
  openrouter: OpenRouterProvider,
  deepseek: DeepSeekProvider,
};

/**
 * 创建 LLM Provider 实例
 */
export function createProvider(name: string, config: ProviderConfig): LLMProvider {
  const Constructor = providerConstructors[name];
  if (!Constructor) {
    throw new ProviderError(name, `不支持的 LLM 提供商: ${name}`);
  }

  log.info({ provider: name }, '创建 LLM 提供商');
  return new Constructor(config);
}

/**
 * 注册自定义 Provider
 */
export function registerProvider(
  name: string,
  constructor: new (config: ProviderConfig) => LLMProvider,
): void {
  providerConstructors[name] = constructor;
  log.info({ provider: name }, '注册自定义 LLM 提供商');
}
