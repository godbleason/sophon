/**
 * 会话管理器
 * 
 * 负责会话的创建、加载、持久化。
 * 
 * 持久化委托给 StorageProvider，本模块只管内存缓存与业务逻辑。
 * workspace 目录仍使用文件系统（工具产生的文件需要磁盘路径）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChatMessage } from '../types/message.js';
import type { SessionConfig } from '../types/config.js';
import type {
  StorageProvider,
  PersistedSessionMeta,
  SessionSummary,
} from '../storage/storage-provider.js';
import { SessionError } from './errors.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('SessionManager');

/** 会话元数据（运行时） */
interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  channel: string;
  messageCount: number;
  /** 关联的用户 ID */
  userId?: string;
  /** 通道特定数据（如 Telegram 的 chatId） */
  channelData?: Record<string, unknown>;
}

/** 会话数据 */
interface Session {
  meta: SessionMeta;
  messages: ChatMessage[];
  /** 对话摘要（压缩后的旧对话） */
  summary?: SessionSummary;
}

/**
 * 会话管理器
 */
export class SessionManager {
  /** 内存缓存（包含完整消息历史的 session） */
  private readonly sessions = new Map<string, Session>();
  /** 元数据索引（仅元数据，不含消息历史，启动时预加载） */
  private readonly metaIndex = new Map<string, SessionMeta>();

  constructor(
    private readonly config: SessionConfig,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * 初始化：从存储加载所有 session 元数据索引
   * 
   * 在应用启动时调用。只加载元数据（轻量），不加载消息历史。
   * 这确保 findSessionsByUser 能在重启后立即找到所有用户的 session。
   */
  async init(): Promise<void> {
    const metas = await this.storage.loadAllSessionMetas();

    for (const persisted of metas) {
      this.metaIndex.set(persisted.id, {
        id: persisted.id,
        channel: persisted.channel,
        userId: persisted.userId,
        createdAt: persisted.createdAt,
        updatedAt: persisted.updatedAt,
        messageCount: 0, // 实际数量在完整加载时更新
        channelData: persisted.channelData,
      });
    }

    log.info({ loadedMetas: metas.length }, 'Session 元数据索引已加载');
  }

  /**
   * 获取或创建会话
   */
  async getOrCreate(sessionId: string, channel: string = 'cli'): Promise<Session> {
    // 先从内存缓存获取
    const cached = this.sessions.get(sessionId);
    if (cached) {
      // 如果传入的 channel 更具体（非 'unknown'），更新一下
      if (channel !== 'cli' && cached.meta.channel === 'unknown') {
        cached.meta.channel = channel;
      }
      return cached;
    }

    // 尝试从存储加载
    const indexedMeta = this.metaIndex.get(sessionId);
    if (indexedMeta) {
      const session = await this.loadFromStorage(sessionId);
      // 从 metaIndex 恢复 userId、channel 和 channelData
      if (indexedMeta.userId) {
        session.meta.userId = indexedMeta.userId;
      }
      if (indexedMeta.channel && indexedMeta.channel !== 'unknown') {
        session.meta.channel = indexedMeta.channel;
      }
      if (indexedMeta.channelData) {
        session.meta.channelData = indexedMeta.channelData;
      }
      // 传入的 channel 参数优先（它来自实际的通道连接）
      if (channel !== 'cli') {
        session.meta.channel = channel;
      }
      this.sessions.set(sessionId, session);
      this.metaIndex.set(sessionId, { ...session.meta });
      log.info({ sessionId, messageCount: session.messages.length, userId: session.meta.userId }, '已加载会话');
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
    this.metaIndex.set(sessionId, { ...session.meta });
    // 持久化元数据
    await this.saveMetaToStorage(sessionId, session.meta);
    log.info({ sessionId }, '已创建新会话');
    return session;
  }

  /**
   * 为会话关联用户
   * 
   * 同时更新 metaIndex 并持久化，确保重启后可恢复。
   */
  setSessionUser(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.meta.userId = userId;
      // 同步更新 metaIndex
      this.metaIndex.set(sessionId, { ...session.meta });
      // 异步持久化，不阻塞主流程
      this.saveMetaToStorage(sessionId, session.meta).catch((err) => {
        log.error({ err, sessionId }, '持久化 session 元数据失败');
      });
    } else {
      // session 未在内存中，但 metaIndex 可能有记录
      const meta = this.metaIndex.get(sessionId);
      if (meta) {
        meta.userId = userId;
        this.saveMetaToStorage(sessionId, meta).catch((err) => {
          log.error({ err, sessionId }, '持久化 session 元数据失败');
        });
      }
    }
  }

  /**
   * 获取会话关联的用户 ID
   */
  getSessionUserId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.meta.userId
      ?? this.metaIndex.get(sessionId)?.userId;
  }

  /**
   * 设置通道特定数据（如 Telegram 的 chatId）
   * 
   * 同时更新内存和 metaIndex，并持久化。
   */
  setSessionChannelData(sessionId: string, data: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.meta.channelData = { ...session.meta.channelData, ...data };
      this.metaIndex.set(sessionId, { ...session.meta });
      this.saveMetaToStorage(sessionId, session.meta).catch((err) => {
        log.error({ err, sessionId }, '持久化 session channelData 失败');
      });
    } else {
      const meta = this.metaIndex.get(sessionId);
      if (meta) {
        meta.channelData = { ...meta.channelData, ...data };
        this.saveMetaToStorage(sessionId, meta).catch((err) => {
          log.error({ err, sessionId }, '持久化 session channelData 失败');
        });
      }
    }
  }

  /**
   * 获取通道特定数据
   */
  getSessionChannelData(sessionId: string): Record<string, unknown> | undefined {
    return this.sessions.get(sessionId)?.meta.channelData
      ?? this.metaIndex.get(sessionId)?.channelData;
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
   *
   * 如果消息没有 id，会自动生成一个 UUID。
   */
  async addMessage(sessionId: string, message: ChatMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionError(sessionId, '会话不存在，请先调用 getOrCreate');
    }

    // 自动补全消息 ID
    if (!message.id) {
      message.id = randomUUID();
    }

    session.messages.push(message);
    session.meta.messageCount = session.messages.length;
    session.meta.updatedAt = Date.now();

    // 持久化消息
    await this.storage.appendMessage(sessionId, message);
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
   * 获取会话历史（受 memoryWindow 限制，包含摘要上下文）
   *
   * 如果存在对话摘要，会在返回的消息列表开头注入一条 system 消息，
   * 告知 LLM 之前的对话概要。这确保 LLM 在有限的上下文窗口内
   * 仍能理解早期对话中建立的关键信息。
   *
   * 重要：截取时保证不在工具调用链中间截断，避免产生孤立的 tool 消息。
   */
  getHistory(sessionId: string): ChatMessage[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    const { memoryWindow } = this.config;
    const result: ChatMessage[] = [];

    // 如果有摘要，注入为开头的 system 消息
    if (session.summary?.content) {
      result.push({
        role: 'system',
        content: `[Conversation Summary]\nThe following is a summary of the earlier conversation that is no longer in the context window:\n\n${session.summary.content}`,
      });
    }

    // 计算剩余可用的消息槽位（预留 1 给摘要消息）
    const availableSlots = session.summary?.content
      ? memoryWindow - 1
      : memoryWindow;

    let messages: ChatMessage[];
    if (session.messages.length <= availableSlots) {
      messages = [...session.messages];
    } else {
      messages = session.messages.slice(-availableSlots);
    }

    // 清理开头的孤立消息：移除没有对应 assistant(toolCalls) 的 tool 消息，
    // 以及开头的 assistant(toolCalls) 消息（其 tool 结果可能已被截断）
    messages = this.sanitizeMessageStart(messages);

    result.push(...messages);
    return result;
  }

  /**
   * 清理消息列表开头的孤立消息
   *
   * 确保发送给 LLM 的消息不会以孤立的 tool 消息或
   * 不完整的 assistant(toolCalls) 消息开头。
   *
   * 孤立消息场景：
   * - 截取窗口恰好从 tool 消息开始（缺少前面的 assistant）
   * - 截取窗口从 assistant(toolCalls) 开始，但后续的 tool 结果被截断
   */
  private sanitizeMessageStart(messages: ChatMessage[]): ChatMessage[] {
    let startIdx = 0;

    // 跳过开头的孤立 tool 消息
    while (startIdx < messages.length && messages[startIdx]!.role === 'tool') {
      startIdx++;
    }

    // 如果开头是 assistant(toolCalls)，检查其 tool 结果是否完整
    if (startIdx < messages.length) {
      const first = messages[startIdx]!;
      if (first.role === 'assistant' && first.toolCalls?.length) {
        // 检查紧随其后的 tool 消息数量是否与 toolCalls 数量匹配
        const expectedToolCount = first.toolCalls.length;
        let actualToolCount = 0;
        for (let i = startIdx + 1; i < messages.length && messages[i]!.role === 'tool'; i++) {
          actualToolCount++;
        }
        if (actualToolCount < expectedToolCount) {
          // tool 结果不完整，跳过整个工具调用链
          startIdx += 1 + actualToolCount;
        }
      }
    }

    return startIdx > 0 ? messages.slice(startIdx) : messages;
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
   * 清除会话（清空历史和摘要，保留 workspace 目录）
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.summary = undefined;
      session.meta.messageCount = 0;
      session.meta.updatedAt = Date.now();

      // 清空存储
      await this.storage.clearMessages(sessionId);
      await this.storage.clearSummary(sessionId);

      log.info({ sessionId }, '会话已清除');
    }
  }

  /**
   * 获取会话摘要
   */
  getSummary(sessionId: string): SessionSummary | undefined {
    return this.sessions.get(sessionId)?.summary;
  }

  /**
   * 获取当前工作消息数（用于判断是否需要压缩）
   */
  getMessageCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.messages.length ?? 0;
  }

  /**
   * 获取需要被压缩的消息
   *
   * 返回超出保留窗口的旧消息，确保不会在工具调用链中间截断。
   * 保留最近的 keepRecent 条消息不被压缩。
   *
   * @returns 要被压缩的消息列表，如果不需要压缩则返回 null
   */
  getMessagesToCompress(sessionId: string, keepRecent: number): ChatMessage[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const total = session.messages.length;
    if (total <= keepRecent) return null;

    // 从后往前找到安全分割点（不要截断工具调用链）
    let splitIndex = total - keepRecent;
    splitIndex = this.findSafeSplitPoint(session.messages, splitIndex);

    if (splitIndex <= 0) return null;

    return session.messages.slice(0, splitIndex);
  }

  /**
   * 执行压缩：用摘要替换旧消息
   *
   * @param sessionId 会话 ID
   * @param summaryContent 新的摘要内容
   * @param compressedMessageCount 本次被压缩的消息数量
   */
  async applyCompression(
    sessionId: string,
    summaryContent: string,
    compressedMessageCount: number,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 更新摘要
    const prevCompressed = session.summary?.compressedCount ?? 0;
    session.summary = {
      content: summaryContent,
      compressedCount: prevCompressed + compressedMessageCount,
      lastUpdated: Date.now(),
    };

    // 从内存中移除已压缩的消息
    session.messages = session.messages.slice(compressedMessageCount);
    session.meta.messageCount = session.messages.length;
    session.meta.updatedAt = Date.now();

    // 持久化摘要
    await this.storage.saveSummary(sessionId, session.summary);

    log.info(
      {
        sessionId,
        compressedThisTime: compressedMessageCount,
        totalCompressed: session.summary.compressedCount,
        remainingMessages: session.messages.length,
      },
      '对话已压缩',
    );
  }

  /**
   * 找到安全的分割点，避免在工具调用链中间截断
   *
   * 工具调用链：assistant(toolCalls) + tool(result) + ... + tool(result)
   * 这些消息必须保持在一起，不能拆分。
   */
  private findSafeSplitPoint(messages: ChatMessage[], targetIndex: number): number {
    // 从 targetIndex 向前搜索安全分割点
    let idx = targetIndex;

    // 如果当前位置是 tool 消息，说明在工具调用链中间，需要向前找到链的开始
    while (idx > 0 && messages[idx]?.role === 'tool') {
      idx--;
    }

    // 如果当前位置是带 toolCalls 的 assistant 消息，整个链都应该保留
    if (idx > 0 && messages[idx]?.role === 'assistant' && messages[idx]?.toolCalls?.length) {
      idx--;
    }

    // 确保不会得到负数
    return Math.max(0, idx);
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.info({ sessionId }, '会话已删除（仅内存）');
  }

  /**
   * 查找用户的所有 session
   *
   * 首先搜索内存中的活跃 session，然后搜索 metaIndex（存储恢复的元数据）。
   * 这确保即使目标用户的 session 尚未被完整加载到内存中（如服务重启后），
   * 也能通过持久化的元数据找到。
   *
   * 一个用户可能在多个通道上有多个 session。
   */
  findSessionsByUser(userId: string): SessionMeta[] {
    const found = new Map<string, SessionMeta>();

    // 优先从内存 session 中查找（数据最新）
    for (const session of this.sessions.values()) {
      if (session.meta.userId === userId) {
        found.set(session.meta.id, { ...session.meta });
      }
    }

    // 补充从 metaIndex 中查找（覆盖未被完整加载的 session）
    for (const meta of this.metaIndex.values()) {
      if (meta.userId === userId && !found.has(meta.id)) {
        found.set(meta.id, { ...meta });
      }
    }

    return Array.from(found.values());
  }

  /**
   * 获取记忆窗口大小
   */
  getMemoryWindow(): number {
    return this.config.memoryWindow;
  }

  /**
   * 列出所有活跃会话
   */
  listSessions(): SessionMeta[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.meta }));
  }

  // ─── Workspace 相关方法（仍使用文件系统） ───

  /**
   * 获取 session 根目录（用于 workspace）
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

  // ─── 私有方法 ───

  /** 持久化 session 元数据到存储 */
  private async saveMetaToStorage(sessionId: string, meta: SessionMeta): Promise<void> {
    const persisted: PersistedSessionMeta = {
      id: meta.id,
      channel: meta.channel,
      userId: meta.userId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      channelData: meta.channelData,
    };

    try {
      await this.storage.saveSessionMeta(persisted);
    } catch (err) {
      log.error({ err, sessionId }, '保存 session 元数据失败');
      throw new SessionError(sessionId, '保存 session 元数据失败', { cause: err as Error });
    }
  }

  /** 从存储加载会话 */
  private async loadFromStorage(sessionId: string): Promise<Session> {
    try {
      const allMessages = await this.storage.loadMessages(sessionId);

      // 加载摘要（如果存在，跳过已被压缩的消息）
      const summary = await this.storage.loadSummary(sessionId);
      let messages: ChatMessage[];
      if (summary && summary.compressedCount > 0 && summary.compressedCount <= allMessages.length) {
        messages = allMessages.slice(summary.compressedCount);
        // 安全清理：确保恢复后的消息不以孤立的 tool 消息开头
        messages = this.sanitizeMessageStart(messages);
        log.info(
          { sessionId, total: allMessages.length, compressed: summary.compressedCount, remaining: messages.length },
          '已加载摘要，跳过已压缩的消息',
        );
      } else {
        messages = allMessages;
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
        summary: summary ?? undefined,
      };
    } catch (err) {
      throw new SessionError(
        sessionId,
        `加载会话失败: ${sessionId}`,
        { cause: err as Error },
      );
    }
  }
}
