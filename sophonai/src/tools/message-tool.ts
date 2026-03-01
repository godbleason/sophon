/**
 * 消息发送工具
 *
 * 让 AI 能够向 Space 中的其他成员主动发送消息。
 *
 * 核心能力：
 * - 通过成员昵称或姓名自动解析目标用户
 * - 找到目标用户的活跃 session，通过 MessageBus 推送出站消息
 * - 支持跨通道发送（Telegram、Web、CLI 等）
 *
 * 使用场景：
 * - 用户说「提醒爷爷1小时后吃药」→ AI 创建定时任务 → 到时间后用此工具给爷爷发消息
 * - 用户说「告诉王总下午3点开会」→ AI 直接用此工具给王总发消息
 *
 * 并发安全：
 * - 通过 ToolContext.userId 获取发送者身份，不使用全局变量
 * - 多个消息并发处理时不会互相干扰
 */

import { randomUUID } from 'node:crypto';
import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import type { MessageBus } from '../core/message-bus.js';
import type { SessionManager } from '../core/session-manager.js';
import type { SpaceManager } from '../core/space-manager.js';
import type { UserStore } from '../core/user-store.js';
import { ToolExecutionError } from '../core/errors.js';

// ─── 模块级依赖引用 ───

interface MessageToolDeps {
  messageBus: MessageBus;
  sessionManager: SessionManager;
  spaceManager: SpaceManager;
  userStore: UserStore;
}

let deps: MessageToolDeps | null = null;

/**
 * 注入消息工具所需的依赖（在 App 初始化时调用）
 */
export function setMessageToolDeps(d: MessageToolDeps): void {
  deps = d;
}

function getDeps(): MessageToolDeps {
  if (!deps) {
    throw new Error('MessageTool 依赖未注入，请先调用 setMessageToolDeps()');
  }
  return deps;
}

/**
 * 发送消息工具 — 向 Space 中的成员发送消息
 *
 * 通过 ToolContext.userId 获取发送者身份，并发安全。
 */
export class SendMessageTool implements Tool {
  readonly name = 'send_message';
  readonly description =
    'Send a message to a member in one of the user\'s Spaces. ' +
    'Use this tool when the user wants to notify, remind, or communicate with another member. ' +
    'The recipient is identified by their nickname or name in a Space. ' +
    'Examples: send a reminder to "爷爷" (grandpa), notify "王总" (Boss Wang) about a meeting.';

  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description:
          'The nickname or name of the recipient in a Space. ' +
          'Must match a member in one of the sender\'s Spaces. ' +
          'Examples: "爷爷", "妈妈", "王总", "小李"',
      },
      message: {
        type: 'string',
        description:
          'The message content to send to the recipient. ' +
          'Write it as if speaking directly to the recipient.',
      },
    },
    required: ['recipient', 'message'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const recipient = params['recipient'] as string;
    const message = params['message'] as string;

    if (!recipient || recipient.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('收件人不能为空'));
    }

    if (!message || message.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('消息内容不能为空'));
    }

    // 从 ToolContext 获取发送者 userId（并发安全）
    const senderUserId = context.userId;
    if (!senderUserId) {
      throw new ToolExecutionError(
        this.name,
        params,
        new Error('无法确定当前发送者用户 ID'),
      );
    }

    const { messageBus, sessionManager, spaceManager, userStore } = getDeps();

    // 构建用户名映射
    const senderSpaces = spaceManager.listUserSpaces(senderUserId);
    const userNames = new Map<string, string>();
    for (const space of senderSpaces) {
      for (const member of space.members) {
        if (!userNames.has(member.userId)) {
          const user = userStore.getById(member.userId);
          if (user) {
            userNames.set(member.userId, user.name);
          }
        }
      }
    }

    // 解析收件人
    const resolved = spaceManager.resolveMemberByName(senderUserId, recipient, userNames);

    if (!resolved) {
      throw new ToolExecutionError(
        this.name,
        params,
        new Error(
          `未找到名为「${recipient}」的成员。请确认该成员的昵称或姓名，` +
          `以及你们是否在同一个 Space 中。`,
        ),
      );
    }

    // 查找目标用户的活跃 session
    const targetSessions = sessionManager.findSessionsByUser(resolved.userId);

    if (targetSessions.length === 0) {
      // 目标用户当前没有活跃 session（可能从未在线或 session 已过期）
      const targetUser = userStore.getById(resolved.userId);
      const displayName = resolved.nickname || targetUser?.name || resolved.userId;
      throw new ToolExecutionError(
        this.name,
        params,
        new Error(
          `「${displayName}」当前没有活跃的会话，无法发送消息。` +
          `该用户可能尚未在任何通道上连接过。`,
        ),
      );
    }

    // 获取发送者信息用于显示
    const sender = userStore.getById(senderUserId);
    const senderName = sender?.name || '未知用户';

    // 查找发送者在目标 Space 中的昵称
    const senderSpace = senderSpaces.find((s) => s.id === resolved.spaceId);
    const senderMember = senderSpace?.members.find((m) => m.userId === senderUserId);
    const senderNick = senderMember?.nickname || senderName;

    // 向目标用户的所有活跃 session 发送消息
    const formattedMessage = `💬 来自「${senderNick}」(${resolved.spaceName}):\n\n${message}`;

    let sentCount = 0;
    for (const session of targetSessions) {
      await messageBus.publishOutbound({
        id: randomUUID(),
        channel: session.channel,
        sessionId: session.id,
        text: formattedMessage,
        timestamp: Date.now(),
        metadata: {
          fromUserId: senderUserId,
          fromSpaceId: resolved.spaceId,
          type: 'space_message',
        },
      });
      sentCount++;
    }

    const targetUser = userStore.getById(resolved.userId);
    const displayName = resolved.nickname || targetUser?.name || resolved.userId;

    return [
      `✅ 消息已发送给「${displayName}」`,
      `📍 Space: ${resolved.spaceName}`,
      `📨 通道数: ${sentCount}`,
      `📝 内容: ${message}`,
    ].join('\n');
  }
}
