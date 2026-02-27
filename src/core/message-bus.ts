/**
 * 消息总线
 * 
 * 解耦通道和代理的核心组件。
 * 入站消息（用户 -> 代理）和出站消息（代理 -> 通道）分别使用独立队列。
 */

import type { InboundMessage, OutboundMessage, ProgressMessage, ChannelName } from '../types/message.js';
import { AsyncQueue } from './async-queue.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('MessageBus');

/** 出站消息回调类型 */
export type OutboundHandler = (message: OutboundMessage) => Promise<void>;

/** 进度消息回调类型 */
export type ProgressHandler = (message: ProgressMessage) => void;

/**
 * 消息总线
 * 
 * - 入站队列: 通道 -> 代理
 * - 出站分发: 代理 -> 通道（通过注册的 handler 分发）
 * - 会话取消: 支持按 sessionId 取消正在执行的代理循环
 */
export class MessageBus {
  /** 入站消息队列 */
  private readonly inboundQueue = new AsyncQueue<InboundMessage>();

  /** 出站消息处理器，按通道注册 */
  private readonly outboundHandlers = new Map<ChannelName, OutboundHandler>();

  /** 进度消息处理器，按通道注册 */
  private readonly progressHandlers = new Map<ChannelName, ProgressHandler>();

  /** 会话级别的 AbortController，用于取消正在执行的代理循环 */
  private readonly sessionAbortControllers = new Map<string, AbortController>();

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
   * 注册进度消息处理器
   */
  registerProgressHandler(channel: ChannelName, handler: ProgressHandler): void {
    this.progressHandlers.set(channel, handler);
    log.debug({ channel }, '注册进度处理器');
  }

  /**
   * 移除进度消息处理器
   */
  removeProgressHandler(channel: ChannelName): void {
    this.progressHandlers.delete(channel);
    log.debug({ channel }, '移除进度处理器');
  }

  /**
   * 发布进度消息（代理调用）
   * 路由到对应通道的 handler（非阻塞，不 await）
   */
  publishProgress(message: ProgressMessage): void {
    const handler = this.progressHandlers.get(message.channel);
    if (handler) {
      try {
        handler(message);
      } catch (err) {
        log.error({ err, channel: message.channel }, '进度消息处理失败');
      }
    }
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

  // ─── 会话取消 ───

  /**
   * 为指定会话创建 AbortSignal。
   * AgentLoop 在处理消息前调用，用于后续检查取消状态。
   */
  createSessionAbort(sessionId: string): AbortSignal {
    // 如果之前的还在，先清理
    this.sessionAbortControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    this.sessionAbortControllers.set(sessionId, controller);
    return controller.signal;
  }

  /**
   * 取消指定会话的正在执行的代理循环。
   * 通道在客户端断开时调用。
   */
  cancelSession(sessionId: string): void {
    const controller = this.sessionAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionAbortControllers.delete(sessionId);
      log.info({ sessionId }, '会话已取消');
    }
  }

  /**
   * 清理指定会话的 AbortController（正常完成时调用）。
   */
  clearSessionAbort(sessionId: string): void {
    this.sessionAbortControllers.delete(sessionId);
  }

  /**
   * 关闭消息总线
   */
  close(): void {
    this.inboundQueue.close();
    this.outboundHandlers.clear();
    this.progressHandlers.clear();
    // 取消所有活跃会话
    for (const controller of this.sessionAbortControllers.values()) {
      controller.abort();
    }
    this.sessionAbortControllers.clear();
    log.info('消息总线已关闭');
  }
}
