/**
 * 计数信号量
 *
 * 用于控制并发度。acquire() 获取一个许可，release() 释放。
 * 当所有许可被占用时，acquire() 会阻塞直到有许可可用。
 */

import { createChildLogger } from './logger.js';

const log = createChildLogger('Semaphore');

export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxPermits: number) {
    if (maxPermits < 1) {
      throw new Error(`Semaphore maxPermits 必须 >= 1，收到: ${maxPermits}`);
    }
    this.permits = maxPermits;
  }

  /**
   * 获取一个许可。如果无可用许可，阻塞等待。
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    log.debug({ available: this.permits, waiting: this.waiters.length }, '等待并发许可');

    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.permits--;
        resolve();
      });
    });
  }

  /**
   * 释放一个许可。如果有等待者，唤醒队首（FIFO）。
   */
  release(): void {
    this.permits++;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  /** 当前可用许可数 */
  get available(): number {
    return this.permits;
  }

  /** 当前等待者数量 */
  get waiting(): number {
    return this.waiters.length;
  }

  /** 最大许可数 */
  get max(): number {
    return this.maxPermits;
  }
}
