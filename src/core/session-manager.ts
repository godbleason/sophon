/**
 * 会话管理器
 * 
 * 负责会话的创建、加载、持久化。
 * 
 * 目录结构（以 session 为中心）：
 *   <storageDir>/<sessionId>/
 *     history.jsonl      - 对话历史（JSONL 格式）
 *     workspace/          - 工具执行产生的文件
 *     schedules.json      - 定时任务（由 Scheduler 管理）
 */

import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChatMessage } from '../types/message.js';
import type { SessionConfig } from '../types/config.js';
import { SessionError } from './errors.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('SessionManager');

/** 会话元数据 */
interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  channel: string;
  messageCount: number;
  /** 关联的用户 ID */
  userId?: string;
}

/** 会话数据 */
interface Session {
  meta: SessionMeta;
  messages: ChatMessage[];
}

/**
 * 会话管理器
 */
export class SessionManager {
  /** 内存缓存 */
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly config: SessionConfig) {}

  /**
   * 获取或创建会话
   */
  async getOrCreate(sessionId: string, channel: string = 'cli'): Promise<Session> {
    // 先从内存缓存获取
    const cached = this.sessions.get(sessionId);
    if (cached) {
      return cached;
    }

    // 尝试从文件加载
    const historyFile = this.getHistoryFilePath(sessionId);
    if (existsSync(historyFile)) {
      const session = await this.loadFromFile(sessionId, historyFile);
      this.sessions.set(sessionId, session);
      log.info({ sessionId, messageCount: session.messages.length }, '已加载会话');
      return session;
    }

    // 创建新会话（同时创建目录）
    const sessionDir = this.getSessionDir(sessionId);
    if (!existsSync(sessionDir)) {
      await mkdir(sessionDir, { recursive: true });
    }

    const session: Session = {
      meta: {
        id: sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        channel,
        messageCount: 0,
      },
      messages: [],
    };

    this.sessions.set(sessionId, session);
    log.info({ sessionId, sessionDir }, '已创建新会话');
    return session;
  }

  /**
   * 为会话关联用户
   */
  setSessionUser(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.meta.userId = userId;
    }
  }

  /**
   * 获取会话关联的用户 ID
   */
  getSessionUserId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.meta.userId;
  }


  /**
   * 将某个用户的所有 session 迁移到另一个用户
   * 用于用户合并场景
   *
   * @returns 被迁移的 session 数量
   */
  migrateSessionsUser(fromUserId: string, toUserId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.meta.userId === fromUserId) {
        session.meta.userId = toUserId;
        count++;
      }
    }
    if (count > 0) {
      log.info({ fromUserId, toUserId, count }, '已迁移 session 用户关联');
    }
    return count;
  }

  /**
   * 添加消息到会话
   */
  async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError(sessionId, '会话不存在，请先调用 getOrCreate');
    }

    session.messages.push(message);
    session.meta.messageCount = session.messages.length;
    session.meta.updatedAt = Date.now();

    // 追加到文件
    await this.appendToFile(sessionId, message);
  }

  /**
   * 批量添加消息
   */
  async addMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      await this.addMessage(sessionId, message);
    }
  }

  /**
   * 获取会话历史（受 memoryWindow 限制）
   */
  getHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    const { memoryWindow } = this.config;
    if (session.messages.length <= memoryWindow) {
      return [...session.messages];
    }

    // 只返回最近的 N 条消息
    return session.messages.slice(-memoryWindow);
  }

  /**
   * 获取完整会话历史（不受 window 限制）
   */
  getFullHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    return [...session.messages];
  }

  /**
   * 清除会话（清空历史，保留目录）
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.meta.messageCount = 0;
      session.meta.updatedAt = Date.now();

      // 重写文件（清空）
      const historyFile = this.getHistoryFilePath(sessionId);
      await this.ensureSessionDir(sessionId);
      await writeFile(historyFile, '', 'utf-8');
      log.info({ sessionId }, '会话已清除');
    }
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.info({ sessionId }, '会话已删除（仅内存）');
  }

  /**
   * 查找用户的所有活跃 session
   *
   * 遍历内存中的所有 session，返回关联到指定 userId 的 session 列表。
   * 一个用户可能在多个通道上有多个 session。
   */
  findSessionsByUser(userId: string): SessionMeta[] {
    const result: SessionMeta[] = [];
    for (const session of this.sessions.values()) {
      if (session.meta.userId === userId) {
        result.push({ ...session.meta });
      }
    }
    return result;
  }

  /**
   * 列出所有活跃会话
   */
  listSessions(): SessionMeta[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.meta }));
  }

  // ─── 路径相关方法（统一管理） ───

  /**
   * 获取 session 根目录
   *   <storageDir>/<sessionId>/
   */
  getSessionDir(sessionId: string): string {
    return resolve(join(this.config.storageDir, sessionId));
  }

  /**
   * 获取 session 的工作区目录
   *   <storageDir>/<sessionId>/workspace/
   */
  async getWorkspaceDir(sessionId: string): Promise<string> {
    const workspaceDir = join(this.getSessionDir(sessionId), 'workspace');

    if (!existsSync(workspaceDir)) {
      await mkdir(workspaceDir, { recursive: true });
      log.info({ sessionId, workspaceDir }, '已创建会话工作区');
    }

    return workspaceDir;
  }

  /**
   * 获取 session 的定时任务文件路径
   *   <storageDir>/<sessionId>/schedules.json
   */
  getScheduleFilePath(sessionId: string): string {
    return join(this.getSessionDir(sessionId), 'schedules.json');
  }

  /**
   * 列出所有已存在的 session 目录名（用于 Scheduler 恢复）
   */
  async listSessionDirs(): Promise<string[]> {
    const baseDir = resolve(this.config.storageDir);
    if (!existsSync(baseDir)) {
      return [];
    }

    try {
      const entries = await readdir(baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ─── 私有方法 ───

  /** 获取历史文件路径 */
  private getHistoryFilePath(sessionId: string): string {
    return join(this.getSessionDir(sessionId), 'history.jsonl');
  }

  /** 确保 session 目录存在 */
  private async ensureSessionDir(sessionId: string): Promise<void> {
    const dir = this.getSessionDir(sessionId);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /** 从 JSONL 文件加载会话 */
  private async loadFromFile(sessionId: string, filePath: string): Promise<Session> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim().length > 0);
      const messages: ChatMessage[] = [];

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as ChatMessage;
          messages.push(msg);
        } catch {
          log.warn({ sessionId, line }, '跳过无效的消息行');
        }
      }

      return {
        meta: {
          id: sessionId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          channel: 'unknown',
          messageCount: messages.length,
        },
        messages,
      };
    } catch (err) {
      throw new SessionError(
        sessionId,
        `加载会话文件失败: ${filePath}`,
        { cause: err as Error },
      );
    }
  }

  /** 追加消息到 JSONL 文件 */
  private async appendToFile(sessionId: string, message: ChatMessage): Promise<void> {
    const filePath = this.getHistoryFilePath(sessionId);
    await this.ensureSessionDir(sessionId);

    try {
      const line = JSON.stringify(message) + '\n';
      await appendFile(filePath, line, 'utf-8');
    } catch (err) {
      log.error({ err, sessionId }, '消息持久化失败');
      throw new SessionError(
        sessionId,
        '消息持久化失败',
        { cause: err as Error },
      );
    }
  }
}
