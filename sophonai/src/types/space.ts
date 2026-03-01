/**
 * Space（空间）相关类型定义
 *
 * Space 是多用户协作的核心概念：
 * - 用户可以创建多个 Space（如「家庭」「工作」）
 * - 用户可以加入多个 Space
 * - Space 内的成员共享对话上下文，AI 知道每个成员的角色和信息
 * - 通过邀请码机制邀请他人加入
 */

/** Space 成员角色 */
export type SpaceRole = 'owner' | 'admin' | 'member';

/** Space 成员 */
export interface SpaceMember {
  /** 用户 ID */
  userId: string;
  /** 在 Space 中的角色 */
  role: SpaceRole;
  /** 在 Space 中的昵称（如「爸爸」「妈妈」） */
  nickname?: string;
  /** 加入时间 */
  joinedAt: number;
}

/** Space 实体 */
export interface Space {
  /** Space 唯一 ID（UUID） */
  id: string;
  /** Space 名称 */
  name: string;
  /** Space 描述 */
  description?: string;
  /** 创建者用户 ID */
  ownerId: string;
  /** 成员列表 */
  members: SpaceMember[];
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** Space 邀请码 */
export interface SpaceInvite {
  /** 邀请码 */
  code: string;
  /** 目标 Space ID */
  spaceId: string;
  /** 邀请者用户 ID */
  inviterId: string;
  /** 过期时间 */
  expiresAt: number;
}

/** SpaceManager 配置 */
export interface SpaceManagerConfig {
  /** 数据存储目录 */
  storageDir: string;
}
