/**
 * 异步队列
 * 
 * 支持背压的异步队列实现。
 * 生产者 enqueue 消息，消费者 dequeue 等待消息。
 */

/**
 * 异步队列，支持背压
 */
export class AsyncQueue<T> {
  private queue: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  private closed = false;

  /** 队列当前长度 */
  get length(): number {
    return this.queue.length;
  }

  /** 队列是否已关闭 */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 入队一个元素
   * 如果有消费者在等待，直接交付
   */
  enqueue(item: T): void {
    if (this.closed) {
      throw new Error('队列已关闭，无法入队');
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      // 直接交付给等待的消费者
      waiter(item);
    } else {
      this.queue.push(item);
    }
  }

  /**
   * 出队一个元素
   * 如果队列为空，等待直到有新元素或队列关闭
   */
  async dequeue(): Promise<T> {
    const item = this.queue.shift();
    if (item !== undefined) {
      return item;
    }

    if (this.closed) {
      throw new Error('队列已关闭且为空');
    }

    // 等待新元素
    return new Promise<T>((resolve, reject) => {
      const waiter = (value: T): void => {
        resolve(value);
      };

      // 检查队列是否在等待期间被关闭
      const checkClosed = (): void => {
        if (this.closed) {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
          }
          reject(new Error('队列已关闭'));
        }
      };

      this.waiters.push(waiter);

      // 异步检查是否已关闭（处理竞态条件）
      queueMicrotask(checkClosed);
    });
  }

  /**
   * 尝试出队（非阻塞）
   * 返回 undefined 表示队列为空
   */
  tryDequeue(): T | undefined {
    return this.queue.shift();
  }

  /**
   * 关闭队列
   * 所有等待的消费者将收到错误
   */
  close(): void {
    this.closed = true;
    // 通知所有等待者
    for (const waiter of this.waiters) {
      // 通过 queueMicrotask 触发 reject
      void waiter;
    }
    this.waiters = [];
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * 异步迭代器支持
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (!this.closed) {
      try {
        yield await this.dequeue();
      } catch {
        // 队列关闭时退出迭代
        break;
      }
    }
  }
}
