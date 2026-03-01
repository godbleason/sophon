/**
 * 定时任务调度器
 * 
 * 每个 session 可以创建定时任务，到达指定时间时自动向 MessageBus 推送
 * 入站消息，让 AgentLoop 执行。
 * 
 * 功能：
 * - 基于 cron 表达式的定时触发
 * - 任务持久化委托给 StorageProvider
 * - 应用重启后自动恢复活跃任务
 * - 每个 session 独立管理任务
 */

import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { SchedulerConfig } from '../types/config.js';
import type { ChannelName } from '../types/message.js';
import type { MessageBus } from './message-bus.js';
import type { StorageProvider, ScheduledTask } from '../storage/storage-provider.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('Scheduler');

// 重导出 ScheduledTask 类型，供外部使用
export type { ScheduledTask } from '../storage/storage-provider.js';

/**
 * 定时任务调度器
 */
export class Scheduler {
  private readonly config: SchedulerConfig;
  private readonly messageBus: MessageBus;
  private readonly storage: StorageProvider;
  /** 所有任务元数据 */
  private readonly tasks = new Map<string, ScheduledTask>();
  /** 活跃的 Cron 实例 */
  private readonly cronJobs = new Map<string, Cron>();

  constructor(config: SchedulerConfig, messageBus: MessageBus, storage: StorageProvider) {
    this.config = config;
    this.messageBus = messageBus;
    this.storage = storage;
  }

  /**
   * 启动调度器：从存储加载已持久化的任务并恢复 cron 调度
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      log.info('定时任务调度器已禁用');
      return;
    }

    await this.loadAllTasks();

    // 恢复所有启用的任务
    let restored = 0;
    for (const task of this.tasks.values()) {
      if (task.enabled) {
        this.scheduleCron(task);
        restored++;
      }
    }

    log.info({ total: this.tasks.size, restored }, '定时任务调度器已启动');
  }

  /**
   * 停止调度器：停止所有 cron 并保存
   */
  async stop(): Promise<void> {
    for (const job of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();
    await this.saveAllTasks();
    log.info('定时任务调度器已停止');
  }

  /**
   * 添加定时任务
   */
  async addTask(params: {
    sessionId: string;
    channel: ChannelName;
    cronExpression: string;
    description: string;
    taskPrompt: string;
    creatorUserId?: string;
  }): Promise<ScheduledTask> {
    // 校验 cron 表达式
    try {
      const test = new Cron(params.cronExpression, { paused: true });
      test.stop();
    } catch {
      throw new Error(`无效的 cron 表达式: "${params.cronExpression}"。格式: "秒(可选) 分 时 日 月 星期"，示例: "0 9 * * *"(每天 9:00), "*/30 * * * *"(每 30 分钟)`);
    }

    // 检查会话任务数量限制
    const sessionTasks = this.getTasksBySession(params.sessionId);
    if (sessionTasks.length >= this.config.maxTasksPerSession) {
      throw new Error(`已达到单个会话最大任务数限制 (${this.config.maxTasksPerSession})，请先删除不需要的任务`);
    }

    const task: ScheduledTask = {
      id: randomUUID().substring(0, 8),
      sessionId: params.sessionId,
      channel: params.channel,
      cronExpression: params.cronExpression,
      description: params.description,
      taskPrompt: params.taskPrompt,
      enabled: true,
      createdAt: Date.now(),
      runCount: 0,
      creatorUserId: params.creatorUserId,
    };

    this.tasks.set(task.id, task);
    this.scheduleCron(task);
    await this.saveSessionTasks(params.sessionId);

    const nextRun = this.cronJobs.get(task.id)?.nextRun();
    log.info({ taskId: task.id, sessionId: task.sessionId, cron: task.cronExpression, nextRun }, '定时任务已创建');

    return task;
  }

  /**
   * 删除定时任务
   */
  async removeTask(taskId: string, sessionId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId) {
      return false;
    }

    // 停止 cron
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }

    this.tasks.delete(taskId);
    await this.saveSessionTasks(sessionId);

    log.info({ taskId, sessionId }, '定时任务已删除');
    return true;
  }

  /**
   * 启用 / 禁用任务
   */
  async setTaskEnabled(taskId: string, sessionId: string, enabled: boolean): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.sessionId !== sessionId) {
      return false;
    }

    task.enabled = enabled;

    if (enabled) {
      this.scheduleCron(task);
    } else {
      const job = this.cronJobs.get(taskId);
      if (job) {
        job.stop();
        this.cronJobs.delete(taskId);
      }
    }

    await this.saveSessionTasks(sessionId);
    log.info({ taskId, enabled }, '定时任务状态已更新');
    return true;
  }

  /**
   * 获取指定会话的所有任务
   */
  getTasksBySession(sessionId: string): ScheduledTask[] {
    const result: ScheduledTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId) {
        result.push(task);
      }
    }
    return result;
  }

  /**
   * 获取任务详情（包含下次执行时间）
   */
  getTaskInfo(taskId: string): (ScheduledTask & { nextRunAt?: string }) | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const job = this.cronJobs.get(taskId);
    const nextRun = job?.nextRun();

    return {
      ...task,
      nextRunAt: nextRun?.toISOString(),
    };
  }

  // ─── 内部方法 ───

  /**
   * 为任务创建 Cron 调度
   */
  private scheduleCron(task: ScheduledTask): void {
    // 先停掉之前的（如果有）
    const existing = this.cronJobs.get(task.id);
    if (existing) {
      existing.stop();
    }

    const job = new Cron(task.cronExpression, () => {
      this.onTaskTrigger(task);
    });

    this.cronJobs.set(task.id, job);
  }

  /**
   * 任务触发时的回调：向 MessageBus 推送入站消息
   */
  private onTaskTrigger(task: ScheduledTask): void {
    log.info({ taskId: task.id, sessionId: task.sessionId, description: task.description }, '定时任务触发');

    // 更新运行统计
    task.lastRunAt = Date.now();
    task.runCount++;

    // 异步保存，不阻塞触发
    this.saveSessionTasks(task.sessionId).catch((err) => {
      log.error({ err, taskId: task.id }, '保存任务状态失败');
    });

    // 推送入站消息，让 AgentLoop 处理
    const prefix = `[定时任务: ${task.description}]\n`;
    this.messageBus.publishInbound({
      id: randomUUID(),
      channel: task.channel,
      sessionId: task.sessionId,
      text: prefix + task.taskPrompt,
      sender: 'scheduler',
      timestamp: Date.now(),
      metadata: {
        scheduledTaskId: task.id,
        creatorUserId: task.creatorUserId,
      },
    });
  }

  /**
   * 从存储加载所有任务
   */
  private async loadAllTasks(): Promise<void> {
    const allSchedules = await this.storage.loadAllSchedules();
    let totalLoaded = 0;

    for (const [_sessionId, tasks] of allSchedules) {
      for (const task of tasks) {
        this.tasks.set(task.id, task);
        totalLoaded++;
      }
    }

    if (totalLoaded > 0) {
      log.debug({ count: totalLoaded }, '已从存储加载定时任务');
    }
  }

  /**
   * 保存所有任务（按 session 分别写入）
   */
  private async saveAllTasks(): Promise<void> {
    // 按 sessionId 分组
    const bySession = new Map<string, ScheduledTask[]>();
    for (const task of this.tasks.values()) {
      const list = bySession.get(task.sessionId) || [];
      list.push(task);
      bySession.set(task.sessionId, list);
    }

    for (const [sessionId, tasks] of bySession) {
      await this.storage.saveSchedules(sessionId, tasks);
    }
  }

  /**
   * 保存指定 session 的任务
   */
  private async saveSessionTasks(sessionId: string): Promise<void> {
    const tasks = this.getTasksBySession(sessionId);
    await this.storage.saveSchedules(sessionId, tasks);
  }
}
