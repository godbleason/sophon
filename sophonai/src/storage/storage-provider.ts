/**
 * 持久化抽象层
 *
 * 定义所有数据持久化操作的统一接口。
 * 各存储后端（SQLite、PostgreSQL、文件系统等）实现此接口即可无缝切换。
 *
 * 设计原则：
 * - 接口方法与业务语义对齐，而非通用 CRUD
 * - 所有方法均为 async，即使底层实现是同步的（如 better-sqlite3）
 * - 数据序列化/反序列化由实现层负责
 */

import type { ChatMessage } from '../types/message.js';
import type { User } from '../types/user.js';
import type { Space } from '../types/space.js';

// ─── 持久化数据类型（从各 Manager 内部类型提升为公共类型） ───

/** 持久化的会话元数据 */
export interface PersistedSessionMeta {
  id: string;
  channel: string;
  userId?: string;
  createdAt: number;
  updatedAt: number;
  /** 通道特定数据（如 Telegram 的 chatId） */
  channelData?: Record<string, unknown>;
}

/** 对话摘要 */
export interface SessionSummary {
  /** 摘要正文 */
  content: string;
  /** 已被压缩（摘要化）的消息数量 */
  compressedCount: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

/** 定时任务定义 */
export interface ScheduledTask {
  /** 任务唯一 ID */
  id: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 来源通道 */
  channel: string;
  /** Cron 表达式 */
  cronExpression: string;
  /** 任务描述 */
  description: string;
  /** 发送给 Agent 的提示词 */
  taskPrompt: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间戳 */
  createdAt: number;
  /** 上次执行时间戳 */
  lastRunAt?: number;
  /** 累计执行次数 */
  runCount: number;
  /** 创建者用户 ID */
  creatorUserId?: string;
}

/**
 * 持久化存储提供者接口
 *
 * 所有数据存储后端必须实现此接口。
 * 内存缓存、索引构建等逻辑不属于此层，由上层 Manager 负责。
 */
export interface StorageProvider {
  // ─── 生命周期 ───

  /** 初始化存储（建表、连接等） */
  init(): Promise<void>;

  /** 关闭存储（释放连接等） */
  close(): Promise<void>;

  // ─── Session Meta ───

  /** 加载所有会话元数据（启动时用于构建内存索引） */
  loadAllSessionMetas(): Promise<PersistedSessionMeta[]>;

  /** 保存/更新单个会话元数据 */
  saveSessionMeta(meta: PersistedSessionMeta): Promise<void>;

  // ─── Messages ───

  /** 加载指定会话的全部消息（按插入顺序） */
  loadMessages(sessionId: string): Promise<ChatMessage[]>;

  /** 追加一条消息到会话 */
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>;

  /** 清空指定会话的所有消息 */
  clearMessages(sessionId: string): Promise<void>;

  // ─── Summaries ───

  /** 加载会话摘要 */
  loadSummary(sessionId: string): Promise<SessionSummary | null>;

  /** 保存/更新会话摘要 */
  saveSummary(sessionId: string, summary: SessionSummary): Promise<void>;

  /** 清除会话摘要 */
  clearSummary(sessionId: string): Promise<void>;

  // ─── Schedules ───

  /** 加载所有定时任务（按 sessionId 分组） */
  loadAllSchedules(): Promise<Map<string, ScheduledTask[]>>;

  /** 保存指定会话的定时任务（覆盖写入） */
  saveSchedules(sessionId: string, tasks: ScheduledTask[]): Promise<void>;

  // ─── Users ───

  /** 加载所有用户 */
  loadUsers(): Promise<User[]>;

  /** 保存所有用户（覆盖写入） */
  saveUsers(users: User[]): Promise<void>;

  // ─── Spaces ───

  /** 加载所有 Space */
  loadSpaces(): Promise<Space[]>;

  /** 保存所有 Space（覆盖写入） */
  saveSpaces(spaces: Space[]): Promise<void>;

  // ─── Memory ───

  /** 加载长期记忆内容 */
  loadMemoryContent(): Promise<string>;

  /** 保存长期记忆内容（覆盖写入） */
  saveMemoryContent(content: string): Promise<void>;

  /** 加载历史日志内容 */
  loadHistoryContent(): Promise<string>;

  /** 追加历史日志 */
  appendHistoryContent(line: string): Promise<void>;
}
