/**
 * SQLite 存储提供者
 *
 * 使用 better-sqlite3（同步 API）实现 StorageProvider 接口。
 * 所有方法对外暴露为 async，保持接口一致性，方便未来切换到异步后端。
 *
 * 数据库表结构：
 *   session_metas  - 会话元数据
 *   messages       - 对话消息（按 session 分组，保序）
 *   summaries      - 对话摘要
 *   schedules      - 定时任务
 *   kv             - 通用键值存储（users / spaces / memory / history）
 */

import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import type { ChatMessage } from '../types/message.js';
import type { User } from '../types/user.js';
import type { Space } from '../types/space.js';
import type {
  StorageProvider,
  PersistedSessionMeta,
  SessionSummary,
  ScheduledTask,
} from './storage-provider.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('SqliteStorage');

/** SQLite 存储配置 */
export interface SqliteStorageConfig {
  /** 数据库文件路径 */
  dbPath: string;
}

/**
 * SQLite 存储提供者
 */
export class SqliteStorageProvider implements StorageProvider {
  private db!: Database.Database;
  private readonly dbPath: string;

  constructor(config: SqliteStorageConfig) {
    this.dbPath = config.dbPath;
  }

  // ─── 生命周期 ───

  async init(): Promise<void> {
    // 确保数据库目录存在
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);

    // 性能优化
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');

    // 建表
    this.createTables();

    log.info({ dbPath: this.dbPath }, 'SQLite 存储已初始化');
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      log.info('SQLite 连接已关闭');
    }
  }

  // ─── Session Meta ───

  async loadAllSessionMetas(): Promise<PersistedSessionMeta[]> {
    const rows = this.db.prepare(
      'SELECT id, channel, user_id, created_at, updated_at, channel_data FROM session_metas',
    ).all() as Array<{
      id: string;
      channel: string;
      user_id: string | null;
      created_at: number;
      updated_at: number;
      channel_data: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      userId: row.user_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      channelData: row.channel_data ? JSON.parse(row.channel_data) as Record<string, unknown> : undefined,
    }));
  }

  async saveSessionMeta(meta: PersistedSessionMeta): Promise<void> {
    this.db.prepare(`
      INSERT INTO session_metas (id, channel, user_id, created_at, updated_at, channel_data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel = excluded.channel,
        user_id = excluded.user_id,
        updated_at = excluded.updated_at,
        channel_data = excluded.channel_data
    `).run(
      meta.id,
      meta.channel,
      meta.userId ?? null,
      meta.createdAt,
      meta.updatedAt,
      meta.channelData ? JSON.stringify(meta.channelData) : null,
    );
  }

  // ─── Messages ───

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = this.db.prepare(
      'SELECT data FROM messages WHERE session_id = ? ORDER BY rowid ASC',
    ).all(sessionId) as Array<{ data: string }>;

    return rows.map((row) => JSON.parse(row.data) as ChatMessage);
  }

  async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
    this.db.prepare(
      'INSERT INTO messages (id, session_id, data) VALUES (?, ?, ?)',
    ).run(message.id!, sessionId, JSON.stringify(message));
  }

  async clearMessages(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  }

  // ─── Summaries ───

  async loadSummary(sessionId: string): Promise<SessionSummary | null> {
    const row = this.db.prepare(
      'SELECT content, compressed_count, last_updated FROM summaries WHERE session_id = ?',
    ).get(sessionId) as { content: string; compressed_count: number; last_updated: number } | undefined;

    if (!row) return null;

    return {
      content: row.content,
      compressedCount: row.compressed_count,
      lastUpdated: row.last_updated,
    };
  }

  async saveSummary(sessionId: string, summary: SessionSummary): Promise<void> {
    this.db.prepare(`
      INSERT INTO summaries (session_id, content, compressed_count, last_updated)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        content = excluded.content,
        compressed_count = excluded.compressed_count,
        last_updated = excluded.last_updated
    `).run(sessionId, summary.content, summary.compressedCount, summary.lastUpdated);
  }

  async clearSummary(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM summaries WHERE session_id = ?').run(sessionId);
  }

  // ─── Schedules ───

  async loadAllSchedules(): Promise<Map<string, ScheduledTask[]>> {
    const rows = this.db.prepare(
      'SELECT session_id, data FROM schedules',
    ).all() as Array<{ session_id: string; data: string }>;

    const result = new Map<string, ScheduledTask[]>();
    for (const row of rows) {
      const task = JSON.parse(row.data) as ScheduledTask;
      const list = result.get(row.session_id) ?? [];
      list.push(task);
      result.set(row.session_id, list);
    }

    return result;
  }

  async saveSchedules(sessionId: string, tasks: ScheduledTask[]): Promise<void> {
    const saveTransaction = this.db.transaction((sid: string, taskList: ScheduledTask[]) => {
      // 先删除该 session 的所有任务
      this.db.prepare('DELETE FROM schedules WHERE session_id = ?').run(sid);

      // 重新插入
      const insert = this.db.prepare(
        'INSERT INTO schedules (id, session_id, data) VALUES (?, ?, ?)',
      );
      for (const task of taskList) {
        insert.run(task.id, sid, JSON.stringify(task));
      }
    });

    saveTransaction(sessionId, tasks);
  }

  // ─── Users ───

  async loadUsers(): Promise<User[]> {
    const row = this.db.prepare(
      "SELECT value FROM kv WHERE key = 'users'",
    ).get() as { value: string } | undefined;

    if (!row) return [];

    const data = JSON.parse(row.value) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('用户数据格式无效：期望数组');
    }
    return data as User[];
  }

  async saveUsers(users: User[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO kv (key, value) VALUES ('users', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(users));
  }

  // ─── Spaces ───

  async loadSpaces(): Promise<Space[]> {
    const row = this.db.prepare(
      "SELECT value FROM kv WHERE key = 'spaces'",
    ).get() as { value: string } | undefined;

    if (!row) return [];

    const data = JSON.parse(row.value) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Space 数据格式无效：期望数组');
    }
    return data as Space[];
  }

  async saveSpaces(spaces: Space[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO kv (key, value) VALUES ('spaces', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(spaces));
  }

  // ─── Memory ───

  async loadMemoryContent(): Promise<string> {
    const row = this.db.prepare(
      "SELECT value FROM kv WHERE key = 'memory'",
    ).get() as { value: string } | undefined;

    return row?.value ?? '';
  }

  async saveMemoryContent(content: string): Promise<void> {
    this.db.prepare(`
      INSERT INTO kv (key, value) VALUES ('memory', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(content);
  }

  async loadHistoryContent(): Promise<string> {
    const row = this.db.prepare(
      "SELECT value FROM kv WHERE key = 'history'",
    ).get() as { value: string } | undefined;

    return row?.value ?? '';
  }

  async appendHistoryContent(line: string): Promise<void> {
    // 先读取现有内容，再追加
    const existing = await this.loadHistoryContent();
    const newContent = existing + line;

    this.db.prepare(`
      INSERT INTO kv (key, value) VALUES ('history', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(newContent);
  }

  // ─── 内部方法 ───

  /** 创建数据库表 */
  private createTables(): void {
    this.db.exec(`
      -- 会话元数据
      CREATE TABLE IF NOT EXISTS session_metas (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        user_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        channel_data TEXT
      );

      -- 对话消息（id 为消息唯一标识，rowid 隐式保证插入顺序）
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

      -- 对话摘要
      CREATE TABLE IF NOT EXISTS summaries (
        session_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        compressed_count INTEGER NOT NULL,
        last_updated INTEGER NOT NULL
      );

      -- 定时任务
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_session ON schedules(session_id);

      -- 通用键值存储（users / spaces / memory / history）
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }
}
