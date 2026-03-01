/**
 * 配置管理器
 * 
 * 加载 .env 文件、JSON 配置文件，应用环境变量覆盖，并使用 Zod 进行运行时验证。
 * 
 * 加载顺序（优先级从低到高）：
 * 1. JSON 配置文件（config/default.json）
 * 2. .env 文件中的环境变量
 * 3. 系统环境变量
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { ConfigSchema, type Config } from '../types/config.js';
import { ConfigError } from '../core/errors.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('ConfigManager');

/** 默认配置文件路径列表（按优先级从高到低） */
const DEFAULT_CONFIG_PATHS = [
  'config/config.json',
  'config/default.json',
  'sophon.config.json',
];

/** MCP 配置文件路径列表（兼容 Cursor / Claude Desktop 格式） */
const MCP_CONFIG_PATHS = [
  'mcp.json',
  '.cursor/mcp.json',
  'config/mcp.json',
];

/**
 * 从文件加载原始 JSON 配置
 */
async function loadConfigFile(configPath: string): Promise<Record<string, unknown>> {
  const absolutePath = resolve(configPath);

  if (!existsSync(absolutePath)) {
    throw new ConfigError(`配置文件不存在: ${absolutePath}`, { path: absolutePath });
  }

  try {
    const content = await readFile(absolutePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `配置文件解析失败: ${absolutePath}`,
      { path: absolutePath },
      { cause: err as Error },
    );
  }
}

/**
 * 加载 .env 文件并注入到 process.env
 * 
 * 使用 dotenv 库，默认不覆盖已有的环境变量。
 * 文件不存在时跳过（如 Railway 等云平台直接通过系统环境变量注入）。
 */
function loadEnvFile(): void {
  const envPath = resolve('.env');
  if (existsSync(envPath)) {
    const result = dotenvConfig({ path: envPath });
    if (result.parsed) {
      log.info({ count: Object.keys(result.parsed).length }, '已加载 .env');
    }
  } else {
    log.debug('未找到 .env 文件，跳过（使用系统环境变量）');
  }
}

/**
 * 从环境变量中提取配置覆盖
 * 
 * 支持以下环境变量:
 * - SOPHON_LOG_LEVEL: 日志级别
 * - SOPHON_MODEL: 默认模型
 * - SOPHON_TEMPERATURE: 温度
 * - OPENAI_API_KEY: OpenAI API Key
 * - OPENAI_API_BASE: OpenAI API Base URL
 * - OPENROUTER_API_KEY: OpenRouter API Key
 * - DEEPSEEK_API_KEY: DeepSeek API Key
 * - ANTHROPIC_API_KEY: Anthropic API Key
 * - TELEGRAM_BOT_TOKEN: Telegram Bot Token
 * - DISCORD_BOT_TOKEN: Discord Bot Token
 * - PORT: Web 通道端口（Railway 等云平台自动设置，同时自动绑定 0.0.0.0）
 * - SOPHON_WEB_HOST: Web 通道绑定地址（默认 localhost，有 PORT 时默认 0.0.0.0）
 */
function getEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};

  // 日志级别
  if (process.env['SOPHON_LOG_LEVEL']) {
    overrides['logLevel'] = process.env['SOPHON_LOG_LEVEL'];
  }

  // 代理配置
  const agent: Record<string, unknown> = {};
  if (process.env['SOPHON_MODEL']) {
    agent['model'] = process.env['SOPHON_MODEL'];
  }
  if (process.env['SOPHON_TEMPERATURE']) {
    agent['temperature'] = parseFloat(process.env['SOPHON_TEMPERATURE']);
  }
  if (Object.keys(agent).length > 0) {
    overrides['agent'] = agent;
  }

  // 提供商 API Key
  const providers: Record<string, Record<string, string>> = {};
  if (process.env['OPENAI_API_KEY']) {
    providers['openai'] = { ...providers['openai'], apiKey: process.env['OPENAI_API_KEY'] };
  }
  if (process.env['OPENAI_API_BASE']) {
    providers['openai'] = { ...providers['openai'], apiBase: process.env['OPENAI_API_BASE'] };
  }
  if (process.env['OPENROUTER_API_KEY']) {
    providers['openrouter'] = { apiKey: process.env['OPENROUTER_API_KEY'] };
  }
  if (process.env['DEEPSEEK_API_KEY']) {
    providers['deepseek'] = { apiKey: process.env['DEEPSEEK_API_KEY'] };
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    providers['anthropic'] = { apiKey: process.env['ANTHROPIC_API_KEY'] };
  }
  if (Object.keys(providers).length > 0) {
    overrides['providers'] = providers;
  }

  // 通道 Token
  const channels: Record<string, unknown> = {};
  if (process.env['TELEGRAM_BOT_TOKEN']) {
    channels['telegram'] = { enabled: true, token: process.env['TELEGRAM_BOT_TOKEN'] };
  }
  if (process.env['DISCORD_BOT_TOKEN']) {
    channels['discord'] = { enabled: true, token: process.env['DISCORD_BOT_TOKEN'] };
  }

  // Web 通道：支持 PORT 环境变量（Railway 等云平台自动设置）
  // 当 PORT 存在时，自动启用 web 通道并绑定 0.0.0.0（允许外部访问）
  if (process.env['PORT']) {
    const port = parseInt(process.env['PORT'], 10);
    if (!isNaN(port)) {
      channels['web'] = {
        enabled: true,
        port,
        host: process.env['SOPHON_WEB_HOST'] || '0.0.0.0',
      };
    }
  } else if (process.env['SOPHON_WEB_HOST']) {
    channels['web'] = {
      ...(channels['web'] as Record<string, unknown> | undefined),
      host: process.env['SOPHON_WEB_HOST'],
    };
  }

  if (Object.keys(channels).length > 0) {
    overrides['channels'] = channels;
  }

  return overrides;
}

/**
 * 深度合并两个对象
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}

/**
 * 加载独立的 MCP 配置文件
 * 
 * 支持 Cursor / Claude Desktop 格式的 mcp.json 文件：
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
 *     }
 *   }
 * }
 * 
 * 也向下兼容旧版 Sophon 格式 (mcp.servers):
 * {
 *   "mcp": {
 *     "servers": { ... }
 *   }
 * }
 */
async function loadMcpConfig(): Promise<Record<string, unknown> | null> {
  for (const mcpPath of MCP_CONFIG_PATHS) {
    const absolutePath = resolve(mcpPath);
    if (existsSync(absolutePath)) {
      try {
        const content = await readFile(absolutePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        log.info({ path: absolutePath }, '已加载 MCP 配置文件');

        // 兼容 Cursor 格式: { mcpServers: { ... } }
        if (parsed['mcpServers'] && typeof parsed['mcpServers'] === 'object') {
          return parsed['mcpServers'] as Record<string, unknown>;
        }

        // 兼容旧版 Sophon 格式: { mcp: { servers: { ... } } }
        const mcp = parsed['mcp'] as Record<string, unknown> | undefined;
        if (mcp?.['servers'] && typeof mcp['servers'] === 'object') {
          return mcp['servers'] as Record<string, unknown>;
        }

        // 如果文件本身就是 servers 字典 (顶层直接是服务器)
        // 如: { "filesystem": { "command": "..." }, "another": { "url": "..." } }
        const keys = Object.keys(parsed);
        if (keys.length > 0 && keys.every(k => typeof parsed[k] === 'object' && parsed[k] !== null)) {
          const firstServer = parsed[keys[0]!] as Record<string, unknown>;
          if (firstServer['command'] || firstServer['url']) {
            return parsed;
          }
        }

        log.warn({ path: absolutePath }, 'MCP 配置文件格式无法识别，跳过');
      } catch (err) {
        log.warn(
          { path: absolutePath, err },
          '加载 MCP 配置文件失败，跳过',
        );
      }
    }
  }
  return null;
}

/**
 * 加载并验证配置
 * 
 * 1. 尝试从指定路径或默认路径加载配置文件
 * 2. 加载独立的 mcp.json 文件（兼容 Cursor / Claude Desktop 格式）
 * 3. 应用环境变量覆盖
 * 4. 使用 Zod Schema 验证
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // 首先加载 .env 文件
  loadEnvFile();

  let rawConfig: Record<string, unknown> = {};

  if (configPath) {
    // 明确指定了配置文件路径
    rawConfig = await loadConfigFile(configPath);
    log.info({ path: configPath }, '已加载配置文件');
  } else {
    // 尝试从默认路径加载
    for (const defaultPath of DEFAULT_CONFIG_PATHS) {
      const absolutePath = resolve(defaultPath);
      if (existsSync(absolutePath)) {
        rawConfig = await loadConfigFile(absolutePath);
        log.info({ path: absolutePath }, '已加载配置文件');
        break;
      }
    }

    if (Object.keys(rawConfig).length === 0) {
      log.info('未找到配置文件，使用默认配置');
    }
  }

  // 兼容旧格式: mcp.servers → mcpServers
  const mcpLegacy = rawConfig['mcp'] as Record<string, unknown> | undefined;
  if (mcpLegacy?.['servers'] && !rawConfig['mcpServers']) {
    rawConfig['mcpServers'] = mcpLegacy['servers'];
    delete rawConfig['mcp'];
    log.debug('已将 mcp.servers 转换为 mcpServers 格式');
  }

  // 加载独立的 mcp.json 文件（仅在主配置中没有 mcpServers 或 mcpServers 为空时加载）
  const existingMcpServers = rawConfig['mcpServers'] as Record<string, unknown> | undefined;
  if (!existingMcpServers || Object.keys(existingMcpServers).length === 0) {
    const externalMcpServers = await loadMcpConfig();
    if (externalMcpServers) {
      rawConfig['mcpServers'] = externalMcpServers;
      log.debug(
        { serverCount: Object.keys(externalMcpServers).length },
        '已从外部 MCP 配置文件加载服务器',
      );
    }
  } else {
    // 主配置中已有 mcpServers，尝试合并外部配置
    const externalMcpServers = await loadMcpConfig();
    if (externalMcpServers) {
      rawConfig['mcpServers'] = { ...externalMcpServers, ...existingMcpServers };
      log.debug('已合并外部 MCP 配置文件（主配置优先）');
    }
  }

  // 应用环境变量覆盖
  const envOverrides = getEnvOverrides();
  if (Object.keys(envOverrides).length > 0) {
    rawConfig = deepMerge(rawConfig, envOverrides);
    log.debug({ overrides: Object.keys(envOverrides) }, '已应用环境变量覆盖');
  }

  // Zod 验证
  const parseResult = ConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError('配置验证失败', { errors });
  }

  return parseResult.data;
}
