/**
 * 配置类型定义
 */

import { z } from 'zod';

/** 提供商配置 Schema */
const ProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
  apiBase: z.string().url().optional(),
  defaultModel: z.string().optional(),
});

/** 代理配置 Schema */
const AgentConfigSchema = z.object({
  model: z.string().default('gpt-4o-mini'),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().positive().default(4096),
  maxIterations: z.number().positive().default(10),
  systemPrompt: z.string().default('You are a helpful AI assistant.'),
});

/** 会话配置 Schema */
const SessionConfigSchema = z.object({
  /**
   * 会话数据根目录。每个 session 在此目录下拥有独立子目录：
   *   <storageDir>/<sessionId>/
   *     history.jsonl      - 对话历史
   *     workspace/          - 工具执行产生的文件
   *     schedules.json      - 定时任务
   */
  storageDir: z.string().default('data/sessions'),
  /** 记忆窗口大小（保留最近 N 条消息） */
  memoryWindow: z.number().positive().default(50),
});

/** 记忆配置 Schema */
const MemoryConfigSchema = z.object({
  /** 记忆存储目录 */
  storageDir: z.string().default('data/memory'),
  /** 是否启用记忆 */
  enabled: z.boolean().default(true),
});

/** 通道配置 Schema */
const ChannelConfigSchema = z.object({
  /** CLI 通道配置 */
  cli: z.object({
    enabled: z.boolean().default(true),
    prompt: z.string().default('you> '),
  }).default({}),
  /** Telegram 通道配置 */
  telegram: z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
    allowedUsers: z.array(z.string()).default([]),
  }).default({}),
  /** Discord 通道配置 */
  discord: z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
    allowedGuilds: z.array(z.string()).default([]),
  }).default({}),
  /** Web 通道配置 */
  web: z.object({
    enabled: z.boolean().default(false),
    port: z.number().positive().default(3000),
    host: z.string().default('localhost'),
  }).default({}),
});

/** 定时任务配置 Schema */
const SchedulerConfigSchema = z.object({
  /** 是否启用定时任务 */
  enabled: z.boolean().default(true),
  /** 单个会话最大任务数 */
  maxTasksPerSession: z.number().positive().default(20),
});

/** 顶层配置 Schema */
export const ConfigSchema = z.object({
  /** LLM 提供商配置 */
  providers: z.record(ProviderConfigSchema).default({}),
  /** 代理配置 */
  agent: AgentConfigSchema.default({}),
  /** 会话配置 */
  session: SessionConfigSchema.default({}),
  /** 记忆配置 */
  memory: MemoryConfigSchema.default({}),
  /** 通道配置 */
  channels: ChannelConfigSchema.default({}),
  /** 定时任务配置 */
  scheduler: SchedulerConfigSchema.default({}),
  /** 工作区目录 */
  workspaceDir: z.string().default('.'),
  /** 技能目录 */
  skillsDir: z.string().default('skills'),
  /** 日志级别 */
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

/** 配置类型（从 Schema 推断） */
export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;
