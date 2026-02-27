/**
 * 定时任务调度器
 * 
 * 每个 session 可以创建定时任务，到达指定时间时自动向 MessageBus 推送
 * 入站消息，让 AgentLoop 执行。
 * 
 * 功能：
 * - 基于 cron 表达式的定时触发
 * - 任务按 session 持久化（每个 session 目录下的 schedules.json）
 * - 应用重启后自动扫描并恢复活跃任务
 * - 每个 session 独立管理任务
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Cron } from 'croner';
import type { SchedulerConfig } from '../types/config.js';
import type { ChannelName } from '../types/message.js';
import type { MessageBus } from './message-bus.js';
import type { SessionManager } from './session-manager.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('Scheduler');

/** 定时任务定义 */
export interface ScheduledTask {
  /** 任务唯一 ID */
  id: string;
  /** 所属会话 ID */
  sessionId: string;
  /** 来源通道 */
  channel: ChannelName;
  /** Cron 表达式（如 "0 9 * * *" = 每天 9 点） */
  cronExpression: string;
  /** 任务描述（人类可读） */
  description: string;
  /** 发送给 Agent 的提示词 */
  taskPrompt: string;
  /** 是否启用 */
  enabled: boolean;
  /** 创建时间戳 */
  createdAt: number;
  /** 上次执行时间戳 */
  lastRunAt?: number;
  /** 累计执行次数 */
  runCount: number;
}

/** 持久化格式（每个 session 一个文件） */
interface ScheduleStore {
  tasks: ScheduledTask[];
}

/**
 * 定时任务调度器
 */
export class Scheduler {
  private readonly config: SchedulerConfig;
  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  /** 所有任务元数据 */
  private readonly tasks = new Map<string, ScheduledTask>();
  /** 活跃的 Cron 实例 */
  private readonly cronJobs = new Map<string, Cron>();

  constructor(config: SchedulerConfig, messageBus: MessageBus, sessionManager: SessionManager) {
    this.config = config;
    this.messageBus = messageBus;
    this.sessionManager = sessionManager;
  }

  /**
   * 启动调度器：扫描所有 session 目录，加载已持久化的任务并恢复 cron 调度
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
      metadata: { scheduledTaskId: task.id },
    });
  }

  /**
   * 扫描所有 session 目录，加载各自的 schedules.json
   */
  private async loadAllTasks(): Promise<void> {
    const sessionIds = await this.sessionManager.listSessionDirs();
    let totalLoaded = 0;

    for (const sessionId of sessionIds) {
      const filePath = this.sessionManager.getScheduleFilePath(sessionId);
      if (!existsSync(filePath)) continue;

      try {
        const raw = await readFile(filePath, 'utf-8');
        const store: ScheduleStore = JSON.parse(raw);

        for (const task of store.tasks) {
          this.tasks.set(task.id, task);
          totalLoaded++;
        }
      } catch (err) {
        log.error({ err, sessionId }, '加载 session 定时任务失败');
      }
    }

    if (totalLoaded > 0) {
      log.debug({ count: totalLoaded }, '已从各 session 目录加载定时任务');
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
      await this.writeSessionScheduleFile(sessionId, tasks);
    }
  }

  /**
   * 保存指定 session 的任务
   */
  private async saveSessionTasks(sessionId: string): Promise<void> {
    const tasks = this.getTasksBySession(sessionId);
    await this.writeSessionScheduleFile(sessionId, tasks);
  }

  /**
   * 写入 session 的 schedules.json 文件
   */
  private async writeSessionScheduleFile(sessionId: string, tasks: ScheduledTask[]): Promise<void> {
    const filePath = this.sessionManager.getScheduleFilePath(sessionId);

    // 确保目录存在
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    if (tasks.length === 0) {
      // 没有任务时，删除文件（或写空）
      if (existsSync(filePath)) {
        await writeFile(filePath, JSON.stringify({ tasks: [] }, null, 2), 'utf-8');
      }
      return;
    }

    const store: ScheduleStore = { tasks };
    await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  }
}
