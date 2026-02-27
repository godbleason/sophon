/**
 * Telegram 通道
 *
 * 通过 Telegram Bot API 实现消息交互。
 * 支持用户白名单、长文本分段发送和 Markdown 格式化。
 */

import TelegramBot from 'node-telegram-bot-api';
import { randomUUID } from 'node:crypto';
import type { ChannelName, OutboundMessage } from '../types/message.js';
import type { MessageBus } from '../core/message-bus.js';
import type { Channel } from './base-channel.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('TelegramChannel');

/** Telegram 通道配置 */
interface TelegramChannelConfig {
  messageBus: MessageBus;
  /** Bot Token（从 @BotFather 获取） */
  token: string;
  /** 允许交互的用户 ID 或用户名白名单，为空则允许所有人 */
  allowedUsers: string[];
}

/** Telegram 消息上下文：userId -> sessionId 映射 */
interface UserSession {
  sessionId: string;
  chatId: number;
  username?: string;
}

/** Telegram 单条消息最大字符数 */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Telegram 通道实现
 */
export class TelegramChannel implements Channel {
  readonly name: ChannelName = 'telegram';

  private readonly messageBus: MessageBus;
  private readonly token: string;
  private readonly allowedUsers: Set<string>;
  private bot: TelegramBot | null = null;
  /** 用户会话映射：Telegram userId -> UserSession */
  private readonly userSessions = new Map<string, UserSession>();

  constructor(config: TelegramChannelConfig) {
    this.messageBus = config.messageBus;
    this.token = config.token;
    this.allowedUsers = new Set(config.allowedUsers);
  }

  async start(): Promise<void> {
    // 注册出站消息处理器
    this.messageBus.registerOutboundHandler('telegram', this.handleOutbound.bind(this));

    // 创建 Telegram Bot 实例（使用 polling 模式）
    this.bot = new TelegramBot(this.token, { polling: true });

    // 监听文本消息
    this.bot.on('message', (msg) => {
      this.handleIncomingMessage(msg).catch((err) => {
        log.error({ err, chatId: msg.chat.id }, '处理入站消息时发生未捕获异常');
      });
    });

    // 监听 polling 错误
    this.bot.on('polling_error', (err) => {
      log.error({ err }, 'Telegram polling 错误');
    });

    // 获取 bot 信息用于日志
    try {
      const me = await this.bot.getMe();
      log.info({ botUsername: me.username, botId: me.id }, 'Telegram 通道已启动');
      console.log(`\n📱 Telegram Bot: @${me.username}\n`);
    } catch (err) {
      log.error({ err }, '获取 Bot 信息失败');
      throw new Error(`Telegram Bot 启动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }

    this.messageBus.removeOutboundHandler('telegram');
    this.userSessions.clear();
    log.info('Telegram 通道已停止');
  }

  /**
   * 处理收到的 Telegram 消息
   */
  private async handleIncomingMessage(msg: TelegramBot.Message): Promise<void> {
    // 忽略非文本消息
    if (!msg.text || !msg.from) return;

    const userId = String(msg.from.id);
    const username = msg.from.username;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    try {
      // 用户白名单检查
      if (this.allowedUsers.size > 0) {
        const isAllowed =
          this.allowedUsers.has(userId) ||
          (username !== undefined && this.allowedUsers.has(username));

        if (!isAllowed) {
          log.warn({ userId, username, chatId }, '未授权用户尝试发送消息');
          await this.sendMessage(chatId, '⛔ 您没有使用此 Bot 的权限。');
          return;
        }
      }

      // 处理 /start 命令
      if (text === '/start') {
        await this.sendMessage(chatId, '🤖 欢迎使用 Sophon AI 助手！\n\n直接发送消息即可开始对话。');
        return;
      }

      // 处理 /help 命令
      if (text === '/help') {
        await this.sendMessage(
          chatId,
          '🤖 Sophon AI 助手\n\n' +
            '直接发送消息即可与 AI 对话。\n\n' +
            '可用命令：\n' +
            '/start - 开始对话\n' +
            '/help - 显示帮助\n' +
            '/reset - 重置会话\n' +
            '/clear - 清除当前会话\n' +
            '/tools - 列出可用工具\n' +
            '/status - 显示状态信息\n' +
            '/stop - 停止当前任务\n' +
            '/whoami - 查看当前用户身份\n' +
            '/link - 生成跨通道关联码\n' +
            '/link <code> - 使用关联码绑定通道\n' +
            '/unlink - 解绑当前通道\n\n' +
            '🏠 Space 命令：\n' +
            '/space create <名称> - 创建一个新 Space\n' +
            '/space list - 查看我加入的所有 Space\n' +
            '/space info <名称或ID> - 查看 Space 详情\n' +
            '/space invite <名称或ID> - 生成邀请码\n' +
            '/space join <邀请码> - 通过邀请码加入 Space\n' +
            '/space leave <名称或ID> - 离开一个 Space\n' +
            '/space nick <名称或ID> <昵称> - 设置昵称\n' +
            '/space members <名称或ID> - 查看成员',
        );
        return;
      }

      // 处理 /reset 命令
      if (text === '/reset') {
        this.userSessions.delete(userId);
        await this.sendMessage(chatId, '🔄 会话已重置。发送新消息开始新的对话。');
        return;
      }

      // 其他斜杠命令（/link, /whoami, /clear 等）交给 AgentLoop 统一处理

      // 获取或创建用户会话
      let session = this.userSessions.get(userId);
      if (!session) {
        session = {
          sessionId: `tg-${userId}`,
          chatId,
          username,
        };
        this.userSessions.set(userId, session);
        log.info({ userId, username, sessionId: session.sessionId }, '新建 Telegram 用户会话');
      }

      // 更新 chatId（用户可能从不同的 chat 发消息）
      session.chatId = chatId;

      log.debug({ userId, text: text.substring(0, 100) }, '收到 Telegram 消息');

      // 发送"正在输入"提示
      await this.sendChatAction(chatId, 'typing');

      // 构建显示名称
      const displayName = [msg.from.first_name, msg.from.last_name]
        .filter(Boolean)
        .join(' ') || username || userId;

      // 发布入站消息到消息总线
      this.messageBus.publishInbound({
        id: randomUUID(),
        channel: 'telegram',
        sessionId: session.sessionId,
        text,
        sender: userId,
        timestamp: Date.now(),
        metadata: {
          chatId,
          username,
          displayName,
          messageId: msg.message_id,
        },
      });
    } catch (err) {
      // 捕获所有异常，防止单条消息处理失败导致进程崩溃
      log.error({ err, userId, chatId, text: text.substring(0, 50) }, '处理 Telegram 消息时发生异常');
      // 尽力通知用户
      await this.sendMessage(chatId, '⚠️ 处理消息时发生内部错误，请稍后再试。');
    }
  }

  /**
   * 处理出站消息（发送 AI 回复到 Telegram）
   */
  private async handleOutbound(message: OutboundMessage): Promise<void> {
    try {
      const { sessionId, text } = message;

      // 找到对应 session 的用户
      let targetSession: UserSession | undefined;
      for (const session of this.userSessions.values()) {
        if (session.sessionId === sessionId) {
          targetSession = session;
          break;
        }
      }

      if (!targetSession) {
        log.warn({ sessionId }, '未找到对应的 Telegram 用户会话');
        return;
      }

      // 发送回复（自动分段处理长文本）
      await this.sendLongMessage(targetSession.chatId, text);
    } catch (err) {
      // 捕获所有异常，防止出站消息处理失败导致进程崩溃
      log.error({ err, sessionId: message.sessionId }, '处理 Telegram 出站消息时发生异常');
    }
  }

  /**
   * 发送消息（支持长文本自动分段）
   */
  private async sendLongMessage(chatId: number, text: string): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.sendMessage(chatId, text);
      return;
    }

    // 按段落分割长文本
    const segments = this.splitMessage(text);
    for (const segment of segments) {
      await this.sendMessage(chatId, segment);
    }
  }

  /**
   * 将长文本分割为多个不超过限制的段落
   */
  private splitMessage(text: string): string[] {
    const segments: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        segments.push(remaining);
        break;
      }

      // 尝试在换行符处分割
      let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitIdx === -1 || splitIdx < MAX_MESSAGE_LENGTH / 2) {
        // 如果没有合适的换行符，在空格处分割
        splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      }
      if (splitIdx === -1 || splitIdx < MAX_MESSAGE_LENGTH / 2) {
        // 最后手段：硬截断
        splitIdx = MAX_MESSAGE_LENGTH;
      }

      segments.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trimStart();
    }

    return segments;
  }

  /**
   * 发送 Telegram 消息
   * 
   * 注意：此方法内部捕获所有异常，不会向外抛出，
   * 避免因单条消息发送失败导致整个进程崩溃。
   */
  private async sendMessage(
    chatId: number,
    text: string,
    parseMode?: TelegramBot.ParseMode,
  ): Promise<boolean> {
    if (!this.bot) {
      log.warn('Bot 未初始化，无法发送消息');
      return false;
    }

    try {
      await this.bot.sendMessage(chatId, text, {
        parse_mode: parseMode,
      });
      return true;
    } catch (err) {
      log.error({ err, chatId }, 'Telegram 消息发送失败');

      return false;
    }
  }

  /**
   * 发送聊天动作（如"正在输入"）
   */
  private async sendChatAction(
    chatId: number,
    action: TelegramBot.ChatAction,
  ): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.sendChatAction(chatId, action);
    } catch {
      // 忽略 chat action 失败，不影响主流程
    }
  }
}
