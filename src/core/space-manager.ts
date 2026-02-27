/**
 * Space 管理器
 *
 * 管理 Space 的创建、查找、成员管理、邀请和持久化。
 *
 * 存储结构：
 *   <storageDir>/spaces.json - 所有 Space 数据
 *
 * 核心概念：
 * - 每个用户可以创建多个 Space
 * - 每个用户可以加入多个 Space
 * - Space 成员通过邀请码加入
 * - 成员有 owner / admin / member 三种角色
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Space, SpaceMember, SpaceInvite, SpaceManagerConfig, SpaceRole } from '../types/space.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('SpaceManager');

/** 邀请码有效期（24 小时） */
const INVITE_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Space 管理器
 */
export class SpaceManager {
  /** 内存中的 Space 列表 */
  private spaces: Space[] = [];

  /** Space ID 索引：spaceId -> Space */
  private readonly idIndex = new Map<string, Space>();

  /** 用户所属 Space 索引：userId -> Set<spaceId> */
  private readonly userSpacesIndex = new Map<string, Set<string>>();

  /** 待使用的邀请码：code -> SpaceInvite */
  private readonly pendingInvites = new Map<string, SpaceInvite>();

  /** 持久化文件路径 */
  private readonly filePath: string;

  /** 是否有未保存的变更 */
  private dirty = false;

  constructor(config: SpaceManagerConfig) {
    this.filePath = join(config.storageDir, 'spaces.json');
  }

  // ─── 初始化 ───

  /**
   * 初始化：从文件加载 Space 数据
   */
  async init(): Promise<void> {
    if (!existsSync(this.filePath)) {
      log.info('Space 数据文件不存在，初始化为空');
      return;
    }

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content) as Space[];

      if (!Array.isArray(data)) {
        throw new Error('Space 数据格式无效：期望数组');
      }

      this.spaces = data;
      this.rebuildIndexes();
      log.info({ spaceCount: this.spaces.length }, 'Space 数据已加载');
    } catch (err) {
      log.error({ err }, '加载 Space 数据失败');
      throw new Error(`加载 Space 数据失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Space CRUD ───

  /**
   * 创建 Space
   *
   * @param name Space 名称
   * @param ownerId 创建者用户 ID
   * @param description 可选描述
   * @param ownerNickname 创建者在 Space 中的昵称
   * @returns 新创建的 Space
   */
  async createSpace(
    name: string,
    ownerId: string,
    description?: string,
    ownerNickname?: string,
  ): Promise<Space> {
    const now = Date.now();

    const space: Space = {
      id: randomUUID(),
      name,
      description,
      ownerId,
      members: [
        {
          userId: ownerId,
          role: 'owner',
          nickname: ownerNickname,
          joinedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    this.spaces.push(space);
    this.indexSpace(space);
    this.dirty = true;

    log.info(
      { spaceId: space.id, name, ownerId },
      '已创建 Space',
    );

    await this.save();
    return space;
  }

  /**
   * 通过 ID 获取 Space
   */
  getById(spaceId: string): Space | undefined {
    return this.idIndex.get(spaceId);
  }

  /**
   * 通过名称模糊搜索 Space（在用户所属的 Space 中搜索）
   */
  findByName(userId: string, name: string): Space | undefined {
    const userSpaceIds = this.userSpacesIndex.get(userId);
    if (!userSpaceIds) return undefined;

    const lowerName = name.toLowerCase();
    for (const spaceId of userSpaceIds) {
      const space = this.idIndex.get(spaceId);
      if (space && space.name.toLowerCase().includes(lowerName)) {
        return space;
      }
    }
    return undefined;
  }

  /**
   * 列出用户所属的所有 Space
   */
  listUserSpaces(userId: string): Space[] {
    const userSpaceIds = this.userSpacesIndex.get(userId);
    if (!userSpaceIds) return [];

    const result: Space[] = [];
    for (const spaceId of userSpaceIds) {
      const space = this.idIndex.get(spaceId);
      if (space) {
        result.push(space);
      }
    }
    return result;
  }

  /**
   * 更新 Space 信息
   */
  async updateSpace(
    spaceId: string,
    userId: string,
    updates: { name?: string; description?: string },
  ): Promise<Space> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    // 仅 owner 和 admin 可修改
    const member = space.members.find((m) => m.userId === userId);
    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      throw new Error('权限不足：仅 owner 和 admin 可以修改 Space 信息');
    }

    if (updates.name) space.name = updates.name;
    if (updates.description !== undefined) space.description = updates.description;
    space.updatedAt = Date.now();

    this.dirty = true;
    await this.save();

    log.info({ spaceId, userId, updates }, 'Space 信息已更新');
    return space;
  }

  /**
   * 删除 Space（仅 owner 可操作）
   */
  async deleteSpace(spaceId: string, userId: string): Promise<void> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    if (space.ownerId !== userId) {
      throw new Error('权限不足：仅 owner 可以删除 Space');
    }

    // 清理索引
    for (const member of space.members) {
      const userSpaceIds = this.userSpacesIndex.get(member.userId);
      if (userSpaceIds) {
        userSpaceIds.delete(spaceId);
        if (userSpaceIds.size === 0) {
          this.userSpacesIndex.delete(member.userId);
        }
      }
    }
    this.idIndex.delete(spaceId);
    this.spaces = this.spaces.filter((s) => s.id !== spaceId);

    this.dirty = true;
    await this.save();

    log.info({ spaceId, userId }, 'Space 已删除');
  }

  // ─── 成员管理 ───

  /**
   * 获取用户在 Space 中的成员信息
   */
  getMember(spaceId: string, userId: string): SpaceMember | undefined {
    const space = this.idIndex.get(spaceId);
    if (!space) return undefined;
    return space.members.find((m) => m.userId === userId);
  }

  /**
   * 检查用户是否是 Space 成员
   */
  isMember(spaceId: string, userId: string): boolean {
    return this.getMember(spaceId, userId) !== undefined;
  }

  /**
   * 设置成员昵称
   */
  async setMemberNickname(
    spaceId: string,
    userId: string,
    nickname: string,
  ): Promise<void> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    const member = space.members.find((m) => m.userId === userId);
    if (!member) {
      throw new Error(`用户 ${userId} 不是 Space ${spaceId} 的成员`);
    }

    member.nickname = nickname;
    space.updatedAt = Date.now();
    this.dirty = true;
    await this.save();

    log.info({ spaceId, userId, nickname }, '成员昵称已更新');
  }

  /**
   * 设置成员角色（仅 owner 可操作）
   */
  async setMemberRole(
    spaceId: string,
    operatorId: string,
    targetUserId: string,
    role: SpaceRole,
  ): Promise<void> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    if (space.ownerId !== operatorId) {
      throw new Error('权限不足：仅 owner 可以修改成员角色');
    }

    if (targetUserId === operatorId) {
      throw new Error('不能修改自己的角色');
    }

    if (role === 'owner') {
      throw new Error('不能将其他成员设为 owner，请使用转让所有权功能');
    }

    const member = space.members.find((m) => m.userId === targetUserId);
    if (!member) {
      throw new Error(`用户 ${targetUserId} 不是 Space 的成员`);
    }

    member.role = role;
    space.updatedAt = Date.now();
    this.dirty = true;
    await this.save();

    log.info({ spaceId, operatorId, targetUserId, role }, '成员角色已更新');
  }

  /**
   * 移除成员（owner/admin 可操作，不能移除 owner）
   */
  async removeMember(
    spaceId: string,
    operatorId: string,
    targetUserId: string,
  ): Promise<void> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    // 权限检查
    const operator = space.members.find((m) => m.userId === operatorId);
    if (!operator || (operator.role !== 'owner' && operator.role !== 'admin')) {
      throw new Error('权限不足：仅 owner 和 admin 可以移除成员');
    }

    // 不能移除 owner
    if (targetUserId === space.ownerId) {
      throw new Error('不能移除 Space 的 owner');
    }

    // admin 不能移除其他 admin
    const target = space.members.find((m) => m.userId === targetUserId);
    if (!target) {
      throw new Error(`用户 ${targetUserId} 不是 Space 的成员`);
    }
    if (operator.role === 'admin' && target.role === 'admin') {
      throw new Error('admin 不能移除其他 admin');
    }

    // 移除成员
    space.members = space.members.filter((m) => m.userId !== targetUserId);
    space.updatedAt = Date.now();

    // 更新索引
    const userSpaceIds = this.userSpacesIndex.get(targetUserId);
    if (userSpaceIds) {
      userSpaceIds.delete(spaceId);
      if (userSpaceIds.size === 0) {
        this.userSpacesIndex.delete(targetUserId);
      }
    }

    this.dirty = true;
    await this.save();

    log.info({ spaceId, operatorId, targetUserId }, '成员已被移除');
  }

  /**
   * 主动离开 Space（owner 不能离开，须先转让所有权或删除 Space）
   */
  async leaveSpace(spaceId: string, userId: string): Promise<void> {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    if (space.ownerId === userId) {
      throw new Error('owner 不能直接离开 Space，请先转让所有权或删除 Space');
    }

    const memberIdx = space.members.findIndex((m) => m.userId === userId);
    if (memberIdx === -1) {
      throw new Error(`你不是 Space ${space.name} 的成员`);
    }

    space.members.splice(memberIdx, 1);
    space.updatedAt = Date.now();

    // 更新索引
    const userSpaceIds = this.userSpacesIndex.get(userId);
    if (userSpaceIds) {
      userSpaceIds.delete(spaceId);
      if (userSpaceIds.size === 0) {
        this.userSpacesIndex.delete(userId);
      }
    }

    this.dirty = true;
    await this.save();

    log.info({ spaceId, userId }, '用户已离开 Space');
  }

  // ─── 邀请码 ───

  /**
   * 生成邀请码
   *
   * @param spaceId 目标 Space ID
   * @param inviterId 邀请者用户 ID（需是 Space 成员）
   * @returns 8 位大写邀请码
   */
  generateInviteCode(spaceId: string, inviterId: string): string {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }

    // 检查邀请者是否是成员
    const member = space.members.find((m) => m.userId === inviterId);
    if (!member) {
      throw new Error(`你不是 Space ${space.name} 的成员，无法生成邀请码`);
    }

    // 仅 owner 和 admin 可以邀请
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new Error('权限不足：仅 owner 和 admin 可以邀请新成员');
    }

    // 清理过期邀请码
    this.cleanExpiredInvites();

    // 清理该 Space 由同一用户生成的旧邀请码
    for (const [code, invite] of this.pendingInvites) {
      if (invite.spaceId === spaceId && invite.inviterId === inviterId) {
        this.pendingInvites.delete(code);
      }
    }

    // 生成 8 位大写邀请码
    const code = randomBytes(4).toString('hex').toUpperCase();

    this.pendingInvites.set(code, {
      code,
      spaceId,
      inviterId,
      expiresAt: Date.now() + INVITE_CODE_TTL_MS,
    });

    log.info({ spaceId, inviterId, code }, '已生成 Space 邀请码');
    return code;
  }

  /**
   * 使用邀请码加入 Space
   *
   * @param code 邀请码
   * @param userId 加入者用户 ID
   * @param nickname 可选昵称
   * @returns 加入的 Space，如果码无效则返回 undefined
   */
  async joinByInviteCode(
    code: string,
    userId: string,
    nickname?: string,
  ): Promise<Space | undefined> {
    this.cleanExpiredInvites();

    const normalizedCode = code.trim().toUpperCase();
    const invite = this.pendingInvites.get(normalizedCode);

    if (!invite) {
      return undefined;
    }

    const space = this.idIndex.get(invite.spaceId);
    if (!space) {
      this.pendingInvites.delete(normalizedCode);
      return undefined;
    }

    // 检查是否已是成员
    if (space.members.some((m) => m.userId === userId)) {
      // 已经是成员了，删除邀请码并返回 Space
      this.pendingInvites.delete(normalizedCode);
      return space;
    }

    // 加入 Space
    const now = Date.now();
    const newMember: SpaceMember = {
      userId,
      role: 'member',
      nickname,
      joinedAt: now,
    };

    space.members.push(newMember);
    space.updatedAt = now;

    // 更新用户索引
    let userSpaceIds = this.userSpacesIndex.get(userId);
    if (!userSpaceIds) {
      userSpaceIds = new Set();
      this.userSpacesIndex.set(userId, userSpaceIds);
    }
    userSpaceIds.add(space.id);

    // 邀请码使用后删除
    this.pendingInvites.delete(normalizedCode);

    this.dirty = true;
    await this.save();

    log.info(
      { spaceId: space.id, userId, inviterId: invite.inviterId },
      '用户通过邀请码加入 Space',
    );

    return space;
  }

  // ─── 查询 ───

  /**
   * 获取 Space 成员列表
   */
  getMembers(spaceId: string): SpaceMember[] {
    const space = this.idIndex.get(spaceId);
    if (!space) {
      throw new Error(`Space 不存在: ${spaceId}`);
    }
    return [...space.members];
  }

  /**
   * 获取 Space 总数
   */
  get size(): number {
    return this.spaces.length;
  }

  /**
   * 为系统提示构建用户的全量 Space 上下文
   *
   * 将用户所属的所有 Space 及其成员信息注入系统提示，
   * 让 AI 自动根据对话内容识别涉及哪个 Space、哪些成员。
   *
   * 例如用户说「提醒爷爷1小时后吃药」，AI 通过 Space 成员昵称
   * 自动识别「爷爷」属于「家庭」Space。
   *
   * @param userId 当前对话用户 ID
   * @param userNames 用户名映射 userId -> name
   * @returns 可注入系统提示的 Space 上下文字符串，无 Space 时返回 undefined
   */
  buildAllSpacesContext(userId: string, userNames: Map<string, string>): string | undefined {
    const spaces = this.listUserSpaces(userId);
    if (spaces.length === 0) return undefined;

    const lines: string[] = [
      '',
      '\n## 用户的 Space（群组/空间）信息',
      '',
      '当前用户加入了以下 Space。当用户消息中提到某个成员的名字或昵称时，',
      '请自动识别该成员所属的 Space 上下文，并在此上下文中理解和执行用户的意图。',
      '',
    ];

    for (const space of spaces) {
      const currentMember = space.members.find((m) => m.userId === userId);
      const myNick = currentMember?.nickname ? ` (我的昵称: ${currentMember.nickname})` : '';

      lines.push(`### ${space.name}${myNick}`);
      if (space.description) {
        lines.push(`描述: ${space.description}`);
      }
      lines.push(`成员:`);

      for (const m of space.members) {
        const name = userNames.get(m.userId) || '未知用户';
        const nickname = m.nickname ? `「${m.nickname}」` : '';
        const isMe = m.userId === userId ? ' ← 当前用户' : '';
        lines.push(`  - ${name} ${nickname}${isMe}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── 持久化 ───

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
      const content = JSON.stringify(this.spaces, null, 2);
      await writeFile(this.filePath, content, 'utf-8');
      this.dirty = false;
      log.debug({ spaceCount: this.spaces.length }, 'Space 数据已保存');
    } catch (err) {
      log.error({ err }, '保存 Space 数据失败');
      throw new Error(`保存 Space 数据失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── 私有方法 ───

  /** 清理过期邀请码 */
  private cleanExpiredInvites(): void {
    const now = Date.now();
    for (const [code, invite] of this.pendingInvites) {
      if (invite.expiresAt <= now) {
        this.pendingInvites.delete(code);
      }
    }
  }

  /** 重建所有索引 */
  private rebuildIndexes(): void {
    this.idIndex.clear();
    this.userSpacesIndex.clear();
    for (const space of this.spaces) {
      this.indexSpace(space);
    }
  }

  /** 为单个 Space 建立索引 */
  private indexSpace(space: Space): void {
    this.idIndex.set(space.id, space);
    for (const member of space.members) {
      let userSpaceIds = this.userSpacesIndex.get(member.userId);
      if (!userSpaceIds) {
        userSpaceIds = new Set();
        this.userSpacesIndex.set(member.userId, userSpaceIds);
      }
      userSpaceIds.add(space.id);
    }
  }
}
