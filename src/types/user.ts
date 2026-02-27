/**
 * 用户相关类型定义
 *
 * 用户系统核心概念：
 * - 每个真实用户有一个统一的 User 实体
 * - 通过 channelBindings 将不同通道的原始身份（Telegram userId、CLI 用户名等）映射到同一个 User
 * - Session 通过 userId 字段关联到 User
 */

import type { ChannelName } from './message.js';

/** 通道绑定：记录用户在某个通道上的原始身份标识 */
export interface ChannelBinding {
  /** 通道名称 */
  channel: ChannelName;
  /** 该通道上的原始用户标识（如 Telegram userId、CLI 用户名等） */
  channelUserId: string;
  /** 绑定时间 */
  boundAt: number;
}

/**
 * 用户实体
 */
export interface User {
  /** 统一用户 ID（UUID） */
  id: string;
  /** 显示名称 */
  name: string;
  /** 通道绑定列表 */
  channelBindings: ChannelBinding[];
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 扩展元数据（可存储用户偏好等） */
  metadata?: Record<string, unknown>;
}

/** 用户存储配置 */
export interface UserStoreConfig {
  /** 用户数据存储目录 */
  storageDir: string;
}
