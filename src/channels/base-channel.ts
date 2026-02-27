/**
 * 通道基类
 * 
 * 定义通道的基本接口和生命周期。
 */

import type { ChannelName } from '../types/message.js';
import type { MessageBus } from '../core/message-bus.js';

/** 通道接口 */
export interface Channel {
  /** 通道名称 */
  readonly name: ChannelName;
  /** 启动通道 */
  start(): Promise<void>;
  /** 停止通道 */
  stop(): Promise<void>;
}

/** 通道基类配置 */
export interface BaseChannelConfig {
  messageBus: MessageBus;
}
