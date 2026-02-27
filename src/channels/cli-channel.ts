/**
 * CLI 通道
 * 
 * 提供命令行交互界面。
 * 使用 Node.js readline 模块实现。
 */

import { createInterface, type Interface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ChannelName, OutboundMessage } from '../types/message.js';
import type { MessageBus } from '../core/message-bus.js';
import type { Channel } from './base-channel.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('CLIChannel');

/** CLI 通道配置 */
interface CLIChannelConfig {
  messageBus: MessageBus;
  prompt?: string;
  sessionId?: string;
}

/**
 * CLI 通道实现
 */
export class CLIChannel implements Channel {
  readonly name: ChannelName = 'cli';

  private readonly messageBus: MessageBus;
  private readonly prompt: string;
  private readonly sessionId: string;
  private rl: Interface | null = null;

  constructor(config: CLIChannelConfig) {
    this.messageBus = config.messageBus;
    this.prompt = config.prompt || 'you> ';
    this.sessionId = config.sessionId || 'cli-default';
  }

  async start(): Promise<void> {
    log.info('CLI 通道已启动');

    // 注册出站消息处理器
    this.messageBus.registerOutboundHandler('cli', this.handleOutbound.bind(this));

    // 创建 readline 接口
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // 显示欢迎信息
    console.log('\n🤖 Sophon AI 助手');
    console.log('输入消息开始对话，使用 /help 查看命令，Ctrl+C 退出\n');

    // 监听用户输入
    this.rl.on('line', (line: string) => {
      const text = line.trim();
      if (!text) {
        this.showPrompt();
        return;
      }

      // 发布入站消息
      this.messageBus.publishInbound({
        id: randomUUID(),
        channel: 'cli',
        sessionId: this.sessionId,
        text,
        sender: 'cli-user',
        timestamp: Date.now(),
        metadata: {
          displayName: 'CLI User',
        },
      });
    });

    this.rl.on('close', () => {
      console.log('\n👋 再见！');
      process.exit(0);
    });

    // 显示初始提示符
    this.showPrompt();
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.messageBus.removeOutboundHandler('cli');
    log.info('CLI 通道已停止');
  }

  /**
   * 处理出站消息（显示 AI 回复）
   */
  private async handleOutbound(message: OutboundMessage): Promise<void> {
    // 清除当前行（prompt），打印回复
    process.stdout.write('\r\x1b[K'); // 清除当前行
    console.log(`\n🤖 ${message.text}\n`);
    this.showPrompt();
  }

  /** 显示提示符 */
  private showPrompt(): void {
    process.stdout.write(this.prompt);
  }
}
