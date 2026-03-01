/**
 * 会话管理器
 * 
 * 负责会话的创建、加载、持久化。
 * 
 * 目录结构（以 session 为中心）：
 *   <storageDir>/<sessionId>/
 *     history.jsonl      - 对话历史（JSONL 格式）
 *     meta.json           - 会话元数据（userId、channel 等，用于重启恢复）
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

/** 持久化的会话元数据（存储到 meta.json） */
interface PersistedMeta {
  id: string;
  channel: string;
  userId?: string;
  createdAt: number;
  updatedAt: number;
  /** 通道特定数据（如 Telegram 的 chatId） */
  channelData?: Record<string, unknown>;
}

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

/** 持久化的对话摘要 */
interface SessionSummary {
  /** 摘要正文 */
  content: string;
  /** 已被压缩（摘要化）的消息数量（从 history.jsonl 开头起算） */
  compressedCount: number;
  /** 最后更新时间 */
  lastUpdated: number;
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

  constructor(private readonly config: SessionConfig) {}

  /**
   * 初始化：扫描所有 session 目录，加载元数据索引
   * 
   * 在应用启动时调用。只加载 meta.json（轻量），不加载 history.jsonl。
   * 这确保 findSessionsByUser 能在重启后立即找到所有用户的 session。
   */
  async init(): Promise<void> {
    const sessionIds = await this.listSessionDirs();
    let loadedCount = 0;

    for (const sessionId of sessionIds) {
      const metaFilePath = this.getMetaFilePath(sessionId);
      if (existsSync(metaFilePath)) {
        try {
          const content = await readFile(metaFilePath, 'utf-8');
          const persisted = JSON.parse(content) as PersistedMeta;
          this.metaIndex.set(sessionId, {
            id: persisted.id,
            channel: persisted.channel,
            userId: persisted.userId,
            createdAt: persisted.createdAt,
            updatedAt: persisted.updatedAt,
            messageCount: 0, // 实际数量在完整加载时更新
            channelData: persisted.channelData,
          });
          loadedCount++;
        } catch (err) {
          log.warn({ err, sessionId }, '加载 session 元数据失败，跳过');
        }
      }
    }

    log.info({ totalDirs: sessionIds.length, loadedMetas: loadedCount }, 'Session 元数据索引已加载');
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

    // 尝试从文件加载
    const historyFile = this.getHistoryFilePath(sessionId);
    if (existsSync(historyFile)) {
      const session = await this.loadFromFile(sessionId, historyFile);
      // 从 metaIndex 恢复 userId、channel 和 channelData
      const indexedMeta = this.metaIndex.get(sessionId);
      if (indexedMeta) {
        if (indexedMeta.userId) {
          session.meta.userId = indexedMeta.userId;
        }
        if (indexedMeta.channel && indexedMeta.channel !== 'unknown') {
          session.meta.channel = indexedMeta.channel;
        }
        if (indexedMeta.channelData) {
          session.meta.channelData = indexedMeta.channelData;
        }
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
    this.metaIndex.set(sessionId, { ...session.meta });
    // 持久化元数据
    await this.saveMetaFile(sessionId, session.meta);
    log.info({ sessionId, sessionDir }, '已创建新会话');
    return session;
  }

  /**
   * 为会话关联用户
   * 
   * 同时更新 metaIndex 并持久化到 meta.json，确保重启后可恢复。
   */
  setSessionUser(sessionId: string, userId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.meta.userId = userId;
      // 同步更新 metaIndex
      this.metaIndex.set(sessionId, { ...session.meta });
      // 异步持久化，不阻塞主流程
      this.saveMetaFile(sessionId, session.meta).catch((err) => {
        log.error({ err, sessionId }, '持久化 session 元数据失败');
      });
    } else {
      // session 未在内存中，但 metaIndex 可能有记录
      const meta = this.metaIndex.get(sessionId);
      if (meta) {
        meta.userId = userId;
        this.saveMetaFile(sessionId, meta).catch((err) => {
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
   * 同时更新内存和 metaIndex，并持久化到 meta.json。
   */
  setSessionChannelData(sessionId: string, data: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.meta.channelData = { ...session.meta.channelData, ...data };
      this.metaIndex.set(sessionId, { ...session.meta });
      this.saveMetaFile(sessionId, session.meta).catch((err) => {
        log.error({ err, sessionId }, '持久化 session channelData 失败');
      });
    } else {
      const meta = this.metaIndex.get(sessionId);
      if (meta) {
        meta.channelData = { ...meta.channelData, ...data };
        this.saveMetaFile(sessionId, meta).catch((err) => {
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
   * 清除会话（清空历史和摘要，保留目录）
   */
  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages = [];
      session.summary = undefined;
      session.meta.messageCount = 0;
      session.meta.updatedAt = Date.now();

      // 重写文件（清空）
      const historyFile = this.getHistoryFilePath(sessionId);
      await this.ensureSessionDir(sessionId);
      await writeFile(historyFile, '', 'utf-8');

      // 删除摘要文件
      const summaryFile = this.getSummaryFilePath(sessionId);
      if (existsSync(summaryFile)) {
        await writeFile(summaryFile, '', 'utf-8');
      }
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
    await this.saveSummary(sessionId, session.summary);

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
   * 首先搜索内存中的活跃 session，然后搜索 metaIndex（磁盘恢复的元数据）。
   * 这确保即使目标用户的 session 尚未被完整加载到内存中（如服务重启后），
   * 也能通过持久化的 meta.json 找到。
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

  /** 获取元数据文件路径 */
  private getMetaFilePath(sessionId: string): string {
    return join(this.getSessionDir(sessionId), 'meta.json');
  }

  /** 获取摘要文件路径 */
  private getSummaryFilePath(sessionId: string): string {
    return join(this.getSessionDir(sessionId), 'summary.json');
  }

  /** 加载对话摘要 */
  private async loadSummary(sessionId: string): Promise<SessionSummary | null> {
    const filePath = this.getSummaryFilePath(sessionId);
    if (!existsSync(filePath)) return null;

    try {
      const content = await readFile(filePath, 'utf-8');
      if (!content.trim()) return null;
      return JSON.parse(content) as SessionSummary;
    } catch (err) {
      log.warn({ err, sessionId }, '加载摘要文件失败');
      return null;
    }
  }

  /** 持久化对话摘要 */
  private async saveSummary(sessionId: string, summary: SessionSummary): Promise<void> {
    await this.ensureSessionDir(sessionId);
    const filePath = this.getSummaryFilePath(sessionId);
    try {
      await writeFile(filePath, JSON.stringify(summary, null, 2), 'utf-8');
    } catch (err) {
      log.error({ err, sessionId }, '保存摘要文件失败');
    }
  }

  /** 持久化 session 元数据到 meta.json */
  private async saveMetaFile(sessionId: string, meta: SessionMeta): Promise<void> {
    await this.ensureSessionDir(sessionId);
    const filePath = this.getMetaFilePath(sessionId);
    const persisted: PersistedMeta = {
      id: meta.id,
      channel: meta.channel,
      userId: meta.userId,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      channelData: meta.channelData,
    };
    try {
      await writeFile(filePath, JSON.stringify(persisted, null, 2), 'utf-8');
    } catch (err) {
      log.error({ err, sessionId }, '写入 meta.json 失败');
      throw new SessionError(sessionId, '写入 meta.json 失败', { cause: err as Error });
    }
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
      const allMessages: ChatMessage[] = [];

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as ChatMessage;
          allMessages.push(msg);
        } catch {
          log.warn({ sessionId, line }, '跳过无效的消息行');
        }
      }

      // 加载摘要（如果存在，跳过已被压缩的消息）
      const summary = await this.loadSummary(sessionId);
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
