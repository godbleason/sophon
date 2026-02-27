/**
 * 消息总线
 * 
 * 解耦通道和代理的核心组件。
 * 入站消息（用户 -> 代理）和出站消息（代理 -> 通道）分别使用独立队列。
 */

import type { InboundMessage, OutboundMessage, ChannelName } from '../types/message.js';
import { AsyncQueue } from './async-queue.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('MessageBus');

/** 出站消息回调类型 */
export type OutboundHandler = (message: OutboundMessage) => Promise<void>;

/**
 * 消息总线
 * 
 * - 入站队列: 通道 -> 代理
 * - 出站分发: 代理 -> 通道（通过注册的 handler 分发）
 */
export class MessageBus {
  /** 入站消息队列 */
  private readonly inboundQueue = new AsyncQueue<InboundMessage>();

  /** 出站消息处理器，按通道注册 */
  private readonly outboundHandlers = new Map<ChannelName, OutboundHandler>();

  /**
   * 发布入站消息（通道调用）
   */
  publishInbound(message: InboundMessage): void {
    log.debug({ messageId: message.id, channel: message.channel }, '入站消息');
    this.inboundQueue.enqueue(message);
  }

  /**
   * 消费入站消息（代理调用）
   * 阻塞等待直到有新消息
   */
  async consumeInbound(): Promise<InboundMessage> {
    return this.inboundQueue.dequeue();
  }

  /**
   * 入站消息异步迭代器
   */
  async *inboundMessages(): AsyncGenerator<InboundMessage> {
    yield* this.inboundQueue;
  }

  /**
   * 注册出站消息处理器
   */
  registerOutboundHandler(channel: ChannelName, handler: OutboundHandler): void {
    this.outboundHandlers.set(channel, handler);
    log.debug({ channel }, '注册出站处理器');
  }

  /**
   * 移除出站消息处理器
   */
  removeOutboundHandler(channel: ChannelName): void {
    this.outboundHandlers.delete(channel);
    log.debug({ channel }, '移除出站处理器');
  }

  /**
   * 发布出站消息（代理调用）
   * 自动路由到对应通道的 handler
   */
  async publishOutbound(message: OutboundMessage): Promise<void> {
    log.debug({ messageId: message.id, channel: message.channel }, '出站消息');

    const handler = this.outboundHandlers.get(message.channel);
    if (!handler) {
      log.warn({ channel: message.channel }, '未找到出站处理器，消息被丢弃');
      return;
    }

    try {
      await handler(message);
    } catch (err) {
      log.error({ err, channel: message.channel, messageId: message.id }, '出站消息处理失败');
      throw err;
    }
  }

  /**
   * 关闭消息总线
   */
  close(): void {
    this.inboundQueue.close();
    this.outboundHandlers.clear();
    log.info('消息总线已关闭');
  }
}
