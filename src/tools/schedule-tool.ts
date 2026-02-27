/**
 * 定时任务管理工具
 * 
 * 提供给 LLM 的工具集，用于创建、查看、删除定时任务。
 * 这些工具依赖 Scheduler 实例，通过 setScheduler() 注入。
 */

import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import type { Scheduler } from '../core/scheduler.js';

// ─── 模块级 Scheduler 引用 ───

let schedulerInstance: Scheduler | null = null;

/**
 * 设置 Scheduler 实例（在 App 初始化时调用）
 */
export function setScheduler(scheduler: Scheduler): void {
  schedulerInstance = scheduler;
}

function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    throw new Error('定时任务调度器未初始化');
  }
  return schedulerInstance;
}

// ─── 创建定时任务工具 ───

export class CreateScheduleTool implements Tool {
  readonly name = 'create_schedule';
  readonly description = '创建一个定时任务，让 AI 在指定时间自动执行。支持 cron 表达式。常见示例："0 9 * * *" (每天 9:00)、"*/30 * * * *" (每 30 分钟)、"0 9 * * 1" (每周一 9:00)、"0 0 1 * *" (每月 1 日 0:00)。';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      cron_expression: {
        type: 'string',
        description: 'Cron 表达式，格式: "分 时 日 月 星期"。示例: "0 9 * * *" (每天 9:00), "*/30 * * * *" (每 30 分钟), "0 9 * * 1-5" (工作日 9:00)',
      },
      description: {
        type: 'string',
        description: '任务描述（简短说明任务目的）',
      },
      task_prompt: {
        type: 'string',
        description: '到达指定时间时要执行的完整提示词/指令',
      },
    },
    required: ['cron_expression', 'description', 'task_prompt'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const scheduler = getScheduler();
    const cronExpression = params['cron_expression'] as string;
    const description = params['description'] as string;
    const taskPrompt = params['task_prompt'] as string;

    // 从 sessionId 推断 channel
    const channel = context.sessionId.startsWith('web-') ? 'web'
      : context.sessionId.startsWith('cli-') ? 'cli'
      : 'cli';

    try {
      const task = await scheduler.addTask({
        sessionId: context.sessionId,
        channel,
        cronExpression,
        description,
        taskPrompt,
      });

      const info = scheduler.getTaskInfo(task.id);
      return JSON.stringify({
        success: true,
        taskId: task.id,
        description: task.description,
        cronExpression: task.cronExpression,
        nextRunAt: info?.nextRunAt || '未知',
        message: `定时任务已创建，ID: ${task.id}`,
      }, null, 2);
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: (err as Error).message,
      });
    }
  }
}

// ─── 查看定时任务工具 ───

export class ListSchedulesTool implements Tool {
  readonly name = 'list_schedules';
  readonly description = '查看当前会话的所有定时任务';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {},
  };

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const scheduler = getScheduler();
    const tasks = scheduler.getTasksBySession(context.sessionId);

    if (tasks.length === 0) {
      return JSON.stringify({ tasks: [], message: '当前会话没有定时任务' });
    }

    const result = tasks.map((t) => {
      const info = scheduler.getTaskInfo(t.id);
      return {
        id: t.id,
        description: t.description,
        cronExpression: t.cronExpression,
        enabled: t.enabled,
        runCount: t.runCount,
        lastRunAt: t.lastRunAt ? new Date(t.lastRunAt).toISOString() : null,
        nextRunAt: info?.nextRunAt || null,
        createdAt: new Date(t.createdAt).toISOString(),
      };
    });

    return JSON.stringify({ tasks: result, total: result.length }, null, 2);
  }
}

// ─── 删除定时任务工具 ───

export class RemoveScheduleTool implements Tool {
  readonly name = 'remove_schedule';
  readonly description = '删除一个定时任务';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: '要删除的任务 ID',
      },
    },
    required: ['task_id'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const scheduler = getScheduler();
    const taskId = params['task_id'] as string;

    const removed = await scheduler.removeTask(taskId, context.sessionId);
    if (removed) {
      return JSON.stringify({ success: true, message: `任务 ${taskId} 已删除` });
    }
    return JSON.stringify({ success: false, error: `未找到任务 ${taskId}，或该任务不属于当前会话` });
  }
}

// ─── 启用/禁用定时任务工具 ───

export class ToggleScheduleTool implements Tool {
  readonly name = 'toggle_schedule';
  readonly description = '启用或禁用一个定时任务';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: '任务 ID',
      },
      enabled: {
        type: 'string',
        description: '"true" 启用，"false" 禁用',
        enum: ['true', 'false'],
      },
    },
    required: ['task_id', 'enabled'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const scheduler = getScheduler();
    const taskId = params['task_id'] as string;
    const enabled = params['enabled'] === 'true' || params['enabled'] === true;

    const updated = await scheduler.setTaskEnabled(taskId, context.sessionId, enabled);
    if (updated) {
      return JSON.stringify({
        success: true,
        message: `任务 ${taskId} 已${enabled ? '启用' : '禁用'}`,
      });
    }
    return JSON.stringify({ success: false, error: `未找到任务 ${taskId}，或该任务不属于当前会话` });
  }
}
