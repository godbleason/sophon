/**
 * 会话管理器
 * 
 * 负责会话的创建、加载、持久化。
 * 使用 JSONL 格式存储会话历史（便于追加）。
 * 内存缓存 + 文件持久化。
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    const filePath = this.getSessionFilePath(sessionId);
    if (existsSync(filePath)) {
      const session = await this.loadFromFile(sessionId, filePath);
      this.sessions.set(sessionId, session);
      log.info({ sessionId, messageCount: session.messages.length }, '已加载会话');
      return session;
    }

    // 创建新会话
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
    log.info({ sessionId }, '已创建新会话');
    return session;
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
   * 清除会话
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.meta.messageCount = 0;
      session.meta.updatedAt = Date.now();

      // 重写文件（清空）
      const filePath = this.getSessionFilePath(sessionId);
      await this.ensureDir(filePath);
      await writeFile(filePath, '', 'utf-8');
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
   * 列出所有活跃会话
   */
  listSessions(): SessionMeta[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.meta }));
  }

  // === 私有方法 ===

  /** 获取会话文件路径 */
  private getSessionFilePath(sessionId: string): string {
    return join(this.config.storageDir, `${sessionId}.jsonl`);
  }

  /** 确保目录存在 */
  private async ensureDir(filePath: string): Promise<void> {
    const dir = dirname(filePath);
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
    const filePath = this.getSessionFilePath(sessionId);
    await this.ensureDir(filePath);

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
