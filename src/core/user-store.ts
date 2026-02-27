/**
 * 用户存储
 *
 * 管理用户的创建、查找、绑定和持久化。
 *
 * 存储结构：
 *   <storageDir>/users.json - 所有用户数据
 *
 * 核心查找逻辑：
 *   通过 (channel, channelUserId) 唯一定位一个 User。
 *   同一个 User 可以绑定多个通道身份（跨通道关联）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ChannelName } from '../types/message.js';
import type { User, UserStoreConfig } from '../types/user.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('UserStore');

/** 链接码有效期（5 分钟） */
const LINK_CODE_TTL_MS = 5 * 60 * 1000;

/** 待使用的链接码 */
interface PendingLinkCode {
  /** 链接码 */
  code: string;
  /** 发起方用户 ID */
  userId: string;
  /** 过期时间 */
  expiresAt: number;
}

/** 用户合并结果 */
export interface MergeResult {
  /** 合并后的主用户 */
  primaryUser: User;
  /** 被合并的用户 ID */
  mergedUserId: string;
  /** 被迁移的通道绑定数量 */
  migratedBindings: number;
}

/**
 * 用户存储
 */
export class UserStore {
  /** 内存中的用户列表 */
  private users: User[] = [];

  /** 快速查找索引：`${channel}:${channelUserId}` -> userId */
  private readonly bindingIndex = new Map<string, string>();

  /** 用户 ID 索引：userId -> User */
  private readonly idIndex = new Map<string, User>();

  /** 持久化文件路径 */
  private readonly filePath: string;

  /** 是否有未保存的变更 */
  private dirty = false;

  /** 待使用的链接码：code -> PendingLinkCode */
  private readonly pendingLinks = new Map<string, PendingLinkCode>();

  constructor(config: UserStoreConfig) {
    this.filePath = join(config.storageDir, 'users.json');
  }

  /**
   * 初始化：从文件加载用户数据
   */
  async init(): Promise<void> {
    if (!existsSync(this.filePath)) {
      log.info('用户数据文件不存在，初始化为空');
      return;
    }

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content) as User[];

      if (!Array.isArray(data)) {
        throw new Error('用户数据格式无效：期望数组');
      }

      this.users = data;
      this.rebuildIndexes();
      log.info({ userCount: this.users.length }, '用户数据已加载');
    } catch (err) {
      log.error({ err }, '加载用户数据失败');
      throw new Error(`加载用户数据失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 通过通道身份获取或创建用户
   *
   * 核心方法：通道发送消息时调用此方法，自动完成：
   * 1. 查找已有绑定 → 返回已有用户
   * 2. 未找到 → 创建新用户并绑定
   *
   * @param channel 通道名称
   * @param channelUserId 通道原始用户标识
   * @param displayName 可选的显示名称（仅创建新用户时使用）
   * @returns 用户实体
   */
  async getOrCreateByChannel(
    channel: ChannelName,
    channelUserId: string,
    displayName?: string,
  ): Promise<User> {
    // 1. 尝试从索引查找
    const key = this.bindingKey(channel, channelUserId);
    const existingId = this.bindingIndex.get(key);

    if (existingId) {
      const user = this.idIndex.get(existingId);
      if (user) {
        // 更新最后活跃时间
        user.lastActiveAt = Date.now();
        this.dirty = true;
        return user;
      }
    }

    // 2. 创建新用户
    const now = Date.now();
    const user: User = {
      id: randomUUID(),
      name: displayName || `${channel}:${channelUserId}`,
      channelBindings: [
        {
          channel,
          channelUserId,
          boundAt: now,
        },
      ],
      createdAt: now,
      lastActiveAt: now,
    };

    this.users.push(user);
    this.indexUser(user);
    this.dirty = true;

    log.info(
      { userId: user.id, name: user.name, channel, channelUserId },
      '创建新用户',
    );

    // 持久化
    await this.save();

    return user;
  }

  /**
   * 通过用户 ID 获取用户
   */
  getById(userId: string): User | undefined {
    return this.idIndex.get(userId);
  }

  /**
   * 通过通道身份查找用户（不创建）
   */
  findByChannel(channel: ChannelName, channelUserId: string): User | undefined {
    const key = this.bindingKey(channel, channelUserId);
    const userId = this.bindingIndex.get(key);
    if (userId) {
      return this.idIndex.get(userId);
    }
    return undefined;
  }

  /**
   * 为已有用户绑定新的通道身份
   *
   * 用于跨通道关联：同一个人在 Telegram 和 CLI 上使用不同身份，
   * 可以通过此方法将它们关联到同一个 User。
   */
  async bindChannel(
    userId: string,
    channel: ChannelName,
    channelUserId: string,
  ): Promise<void> {
    const user = this.idIndex.get(userId);
    if (!user) {
      throw new Error(`用户不存在: ${userId}`);
    }

    // 检查是否已绑定到其他用户
    const key = this.bindingKey(channel, channelUserId);
    const existingUserId = this.bindingIndex.get(key);
    if (existingUserId && existingUserId !== userId) {
      throw new Error(
        `通道身份 ${channel}:${channelUserId} 已绑定到其他用户 ${existingUserId}`,
      );
    }

    // 检查是否已绑定到当前用户
    const alreadyBound = user.channelBindings.some(
      (b) => b.channel === channel && b.channelUserId === channelUserId,
    );
    if (alreadyBound) {
      return;
    }

    // 添加绑定
    user.channelBindings.push({
      channel,
      channelUserId,
      boundAt: Date.now(),
    });

    this.bindingIndex.set(key, userId);
    this.dirty = true;

    log.info({ userId, channel, channelUserId }, '用户绑定新通道');

    await this.save();
  }

  /**
   * 解绑用户的某个通道身份
   *
   * 约束：每个用户至少保留一个通道绑定，不允许解绑最后一个。
   *
   * @param userId 用户 ID
   * @param channel 要解绑的通道名称
   * @param channelUserId 要解绑的通道用户 ID
   */
  async unbindChannel(
    userId: string,
    channel: ChannelName,
    channelUserId: string,
  ): Promise<void> {
    const user = this.idIndex.get(userId);
    if (!user) {
      throw new Error(`用户不存在: ${userId}`);
    }

    // 不允许解绑最后一个通道
    if (user.channelBindings.length <= 1) {
      throw new Error('不能解绑最后一个通道，每个用户至少需要保留一个通道绑定');
    }

    const bindingIdx = user.channelBindings.findIndex(
      (b) => b.channel === channel && b.channelUserId === channelUserId,
    );

    if (bindingIdx === -1) {
      throw new Error(`未找到绑定: ${channel}:${channelUserId}`);
    }

    // 移除绑定
    user.channelBindings.splice(bindingIdx, 1);

    // 移除索引
    const key = this.bindingKey(channel, channelUserId);
    this.bindingIndex.delete(key);

    this.dirty = true;
    await this.save();

    log.info({ userId, channel, channelUserId }, '用户已解绑通道');
  }

  /**
   * 更新用户名称
   */
  async updateName(userId: string, name: string): Promise<void> {
    const user = this.idIndex.get(userId);
    if (!user) {
      throw new Error(`用户不存在: ${userId}`);
    }

    user.name = name;
    this.dirty = true;
    await this.save();
  }

  /**
   * 更新用户元数据
   */
  async updateMetadata(
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const user = this.idIndex.get(userId);
    if (!user) {
      throw new Error(`用户不存在: ${userId}`);
    }

    user.metadata = { ...user.metadata, ...metadata };
    this.dirty = true;
    await this.save();
  }

  /**
   * 列出所有用户
   */
  listUsers(): User[] {
    return this.users.map((u) => ({ ...u }));
  }

  // ─── 链接码与用户合并 ───

  /**
   * 生成链接码
   *
   * 用户在一个通道中发送 /link，系统生成一个短码，
   * 用户在另一个通道中发送 /link <code> 完成关联。
   *
   * @param userId 发起关联的用户 ID
   * @returns 6 位大写链接码
   */
  generateLinkCode(userId: string): string {
    const user = this.idIndex.get(userId);
    if (!user) {
      throw new Error(`用户不存在: ${userId}`);
    }

    // 清理该用户已有的未过期链接码（每人同时只能有一个）
    for (const [code, pending] of this.pendingLinks) {
      if (pending.userId === userId) {
        this.pendingLinks.delete(code);
      }
    }

    // 清理所有过期码
    this.cleanExpiredCodes();

    // 生成 6 位大写字母+数字链接码
    const code = randomBytes(3).toString('hex').toUpperCase();

    this.pendingLinks.set(code, {
      code,
      userId,
      expiresAt: Date.now() + LINK_CODE_TTL_MS,
    });

    log.info({ userId, code }, '已生成链接码');
    return code;
  }

  /**
   * 使用链接码合并用户
   *
   * 将当前用户（secondary）的所有通道绑定合并到链接码对应的用户（primary）。
   * secondary 用户会被删除。
   *
   * @param code 链接码
   * @param secondaryUserId 当前通道的用户 ID（将被合并到 primary）
   * @returns 合并结果，如果码无效则返回 undefined
   */
  async redeemLinkCode(
    code: string,
    secondaryUserId: string,
  ): Promise<MergeResult | undefined> {
    this.cleanExpiredCodes();

    const normalizedCode = code.trim().toUpperCase();
    const pending = this.pendingLinks.get(normalizedCode);

    if (!pending) {
      return undefined;
    }

    const primaryUserId = pending.userId;

    // 不能自己链接自己
    if (primaryUserId === secondaryUserId) {
      this.pendingLinks.delete(normalizedCode);
      return undefined;
    }

    const primary = this.idIndex.get(primaryUserId);
    const secondary = this.idIndex.get(secondaryUserId);

    if (!primary || !secondary) {
      this.pendingLinks.delete(normalizedCode);
      return undefined;
    }

    // 将 secondary 的所有通道绑定迁移到 primary
    let migratedBindings = 0;
    for (const binding of secondary.channelBindings) {
      const key = this.bindingKey(binding.channel, binding.channelUserId);

      // 检查是否已存在于 primary（避免重复绑定）
      const alreadyBound = primary.channelBindings.some(
        (b) => b.channel === binding.channel && b.channelUserId === binding.channelUserId,
      );

      if (!alreadyBound) {
        primary.channelBindings.push(binding);
        this.bindingIndex.set(key, primaryUserId);
        migratedBindings++;
      }
    }

    // 从用户列表中删除 secondary
    this.users = this.users.filter((u) => u.id !== secondaryUserId);
    this.idIndex.delete(secondaryUserId);

    // 使用链接码后立即删除
    this.pendingLinks.delete(normalizedCode);

    primary.lastActiveAt = Date.now();
    this.dirty = true;
    await this.save();

    log.info(
      { primaryUserId, secondaryUserId, migratedBindings },
      '用户合并完成',
    );

    return {
      primaryUser: primary,
      mergedUserId: secondaryUserId,
      migratedBindings,
    };
  }

  /** 清理过期链接码 */
  private cleanExpiredCodes(): void {
    const now = Date.now();
    for (const [code, pending] of this.pendingLinks) {
      if (pending.expiresAt <= now) {
        this.pendingLinks.delete(code);
      }
    }
  }

  /**
   * 获取用户总数
   */
  get size(): number {
    return this.users.length;
  }

  /**
   * 持久化到文件
   */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    try {
      const content = JSON.stringify(this.users, null, 2);
      await writeFile(this.filePath, content, 'utf-8');
      this.dirty = false;
      log.debug({ userCount: this.users.length }, '用户数据已保存');
    } catch (err) {
      log.error({ err }, '保存用户数据失败');
      throw new Error(`保存用户数据失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── 私有方法 ───

  /** 生成绑定索引的 key */
  private bindingKey(channel: ChannelName, channelUserId: string): string {
    return `${channel}:${channelUserId}`;
  }

  /** 重建所有索引 */
  private rebuildIndexes(): void {
    this.bindingIndex.clear();
    this.idIndex.clear();
    for (const user of this.users) {
      this.indexUser(user);
    }
  }

  /** 为单个用户建立索引 */
  private indexUser(user: User): void {
    this.idIndex.set(user.id, user);
    for (const binding of user.channelBindings) {
      const key = this.bindingKey(binding.channel, binding.channelUserId);
      this.bindingIndex.set(key, user.id);
    }
  }
}
