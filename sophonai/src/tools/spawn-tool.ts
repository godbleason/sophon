/**
 * 子代理生成工具 (Spawn Tool)
 *
 * 允许主代理创建子代理来处理后台任务。
 * 子代理在独立环境中异步执行，完成后自动通知。
 *
 * 使用场景：
 * - 耗时任务（代码分析、大量文件处理）
 * - 独立任务（不需要用户交互）
 * - 并发处理（多个独立任务同时执行）
 *
 * 并发安全：
 * - 通过 ToolContext.sessionId/channel 获取来源上下文，不使用全局变量
 */

import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import type { SubagentManager } from '../core/subagent-manager.js';
import { ToolExecutionError } from '../core/errors.js';

/**
 * 模块级别引用，在 App 启动时通过 setSubagentManager() 注入
 */
let subagentManager: SubagentManager | null = null;

/**
 * 注入 SubagentManager 实例
 */
export function setSubagentManager(manager: SubagentManager): void {
  subagentManager = manager;
}

/**
 * 获取 SubagentManager 实例
 */
function getManager(): SubagentManager {
  if (!subagentManager) {
    throw new Error('SubagentManager 未初始化，请先调用 setSubagentManager()');
  }
  return subagentManager;
}

/**
 * Spawn 工具 - 生成子代理
 *
 * 通过 ToolContext.sessionId/channel 获取来源上下文，并发安全。
 */
export class SpawnTool implements Tool {
  readonly name = 'spawn';
  readonly description =
    'Spawn a subagent to handle a task in the background. ' +
    'Use this for complex or time-consuming tasks that can run independently. ' +
    'The subagent will execute asynchronously and notify you when done.';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task for the subagent to complete. Be specific and detailed.',
      },
      label: {
        type: 'string',
        description: 'Optional short label for the task (for display purposes)',
      },
    },
    required: ['task'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const task = params['task'] as string;
    const label = params['label'] as string | undefined;

    if (!task || task.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('任务描述不能为空'));
    }

    const manager = getManager();

    // 从 ToolContext 构建来源上下文（并发安全）
    if (!context.sessionId || !context.channel) {
      throw new ToolExecutionError(
        this.name,
        params,
        new Error('无法确定来源上下文（sessionId / channel）'),
      );
    }

    const origin = {
      sessionId: context.sessionId,
      channel: context.channel,
    };

    try {
      const taskId = manager.spawn(task, origin, { label });
      const displayLabel = label || task.slice(0, 50);

      return [
        `✅ 子代理已启动`,
        `  任务 ID: ${taskId}`,
        `  标签: ${displayLabel}`,
        `  状态: 正在后台执行`,
        ``,
        `任务将在后台异步执行，完成后会自动通知您结果。`,
      ].join('\n');
    } catch (err) {
      throw new ToolExecutionError(this.name, params, err as Error);
    }
  }
}

/**
 * 子代理状态查询工具
 */
export class SubagentStatusTool implements Tool {
  readonly name = 'subagent_status';
  readonly description = 'List all subagent tasks and their current status.';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {},
  };

  async execute(_params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const manager = getManager();
    const tasks = manager.listTasks();

    if (tasks.length === 0) {
      return '当前没有子代理任务。';
    }

    const lines = ['📋 子代理任务列表:', ''];
    for (const task of tasks) {
      const statusEmoji =
        task.status === 'running' ? '🔄' :
        task.status === 'completed' ? '✅' :
        task.status === 'failed' ? '❌' :
        '⏹️';

      const elapsed = Math.round((Date.now() - task.createdAt) / 1000);
      lines.push(`  ${statusEmoji} [${task.id}] ${task.label} (${task.status}, ${elapsed}s)`);
    }

    lines.push('');
    lines.push(`运行中: ${manager.getRunningCount()}`);

    return lines.join('\n');
  }
}

/**
 * 取消子代理工具
 */
export class CancelSubagentTool implements Tool {
  readonly name = 'cancel_subagent';
  readonly description = 'Cancel a running subagent by its task ID.';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID of the subagent to cancel',
      },
    },
    required: ['taskId'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const taskId = params['taskId'] as string;

    if (!taskId || taskId.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('任务 ID 不能为空'));
    }

    const manager = getManager();
    const cancelled = manager.cancelById(taskId);

    if (cancelled) {
      return `✅ 子代理 ${taskId} 已取消`;
    }

    return `⚠️ 未找到运行中的子代理: ${taskId}`;
  }
}
