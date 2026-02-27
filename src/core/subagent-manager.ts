/**
 * 子代理管理器 (Subagent Manager)
 *
 * 管理子代理的生命周期：创建、执行、完成、取消。
 * 子代理在后台异步执行，完成后通过 MessageBus 通知主代理。
 *
 * 设计要点：
 * - 每个子代理有独立执行环境，不共享主代理会话历史
 * - 使用受限工具集（不可发消息、不可嵌套子代理）
 * - 严格的迭代次数限制和超时控制
 * - 完成后自动通知原始会话
 */

import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../types/provider.js';
import type { ChatMessage, ChannelName } from '../types/message.js';
import type { SubagentConfig } from '../types/config.js';
import type { ToolContext } from '../types/tool.js';
import { MessageBus } from './message-bus.js';
import { ToolRegistry } from './tool-registry.js';
import { SubagentError } from './errors.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('SubagentManager');

/** 子代理生成选项 */
export interface SpawnOptions {
  /** 任务标签（简短描述，用于显示） */
  label?: string;
}

/** 子代理来源上下文（记录谁创建了子代理，完成后通知谁） */
export interface OriginContext {
  /** 来源会话 ID */
  sessionId: string;
  /** 来源通道 */
  channel: ChannelName;
}

/** 子代理任务状态 */
type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 子代理任务信息 */
interface SubagentTask {
  /** 任务唯一 ID */
  id: string;
  /** 任务描述 */
  task: string;
  /** 短标签 */
  label: string;
  /** 来源上下文 */
  origin: OriginContext;
  /** 当前状态 */
  status: SubagentStatus;
  /** 创建时间 */
  createdAt: number;
  /** 完成时间 */
  completedAt?: number;
  /** AbortController 用于取消 */
  abortController: AbortController;
  /** 执行 Promise */
  promise: Promise<void>;
}

/**
 * 子代理系统提示
 */
const SUBAGENT_SYSTEM_PROMPT = `# Subagent

You are a subagent spawned by the main agent to complete a specific task.

## Rules
1. Stay focused - complete only the assigned task, nothing else
2. Your final response will be reported back to the main agent
3. Do not initiate conversations or take on side tasks
4. Be concise but informative in your findings

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Complete the task thoroughly

## What You Cannot Do
- Send messages directly to users (no message tool available)
- Spawn other subagents
- Access the main agent's conversation history

When you have completed the task, provide a clear summary of your findings or actions.`;

/**
 * 子代理管理器
 */
export class SubagentManager {
  /** 运行中的任务映射：taskId -> SubagentTask */
  private readonly runningTasks = new Map<string, SubagentTask>();

  /** 会话到任务的映射：sessionId -> Set<taskId> */
  private readonly sessionTasks = new Map<string, Set<string>>();

  constructor(
    private readonly config: SubagentConfig,
    private readonly messageBus: MessageBus,
    private readonly provider: LLMProvider,
    private readonly mainToolRegistry: ToolRegistry,
    private readonly model: string,
  ) {}

  /**
   * 生成一个子代理，在后台异步执行任务
   *
   * @returns 子代理任务 ID
   */
  spawn(
    task: string,
    origin: OriginContext,
    options: SpawnOptions = {},
  ): string {
    if (!this.config.enabled) {
      throw new SubagentError('N/A', '子代理系统未启用');
    }

    // 检查并发限制
    const runningCount = this.getRunningCount();
    if (runningCount >= this.config.maxConcurrent) {
      throw new SubagentError(
        'N/A',
        `已达到最大并发子代理数量 (${this.config.maxConcurrent})`,
        { currentRunning: runningCount },
      );
    }

    const taskId = randomUUID().slice(0, 8);
    const label = options.label || task.slice(0, 50);
    const abortController = new AbortController();

    log.info({ taskId, label, sessionId: origin.sessionId }, '生成子代理');

    // 创建异步执行的 Promise
    const promise = this.runSubagent(taskId, task, label, origin, abortController.signal);

    const subagentTask: SubagentTask = {
      id: taskId,
      task,
      label,
      origin,
      status: 'running',
      createdAt: Date.now(),
      abortController,
      promise,
    };

    // 注册任务
    this.runningTasks.set(taskId, subagentTask);

    // 关联到会话
    let sessionTaskSet = this.sessionTasks.get(origin.sessionId);
    if (!sessionTaskSet) {
      sessionTaskSet = new Set();
      this.sessionTasks.set(origin.sessionId, sessionTaskSet);
    }
    sessionTaskSet.add(taskId);

    // Promise 完成后自动清理
    promise.finally(() => {
      this.cleanup(taskId);
    });

    return taskId;
  }

  /**
   * 取消指定会话的所有子代理
   *
   * @returns 取消的子代理数量
   */
  cancelBySession(sessionId: string): number {
    const taskIds = this.sessionTasks.get(sessionId);
    if (!taskIds || taskIds.size === 0) {
      return 0;
    }

    let cancelledCount = 0;
    for (const taskId of taskIds) {
      const task = this.runningTasks.get(taskId);
      if (task && task.status === 'running') {
        task.abortController.abort();
        task.status = 'cancelled';
        cancelledCount++;
        log.info({ taskId, sessionId }, '子代理已取消');
      }
    }

    return cancelledCount;
  }

  /**
   * 取消指定的子代理
   */
  cancelById(taskId: string): boolean {
    const task = this.runningTasks.get(taskId);
    if (!task || task.status !== 'running') {
      return false;
    }

    task.abortController.abort();
    task.status = 'cancelled';
    log.info({ taskId }, '子代理已取消');
    return true;
  }

  /**
   * 获取运行中的子代理数量
   */
  getRunningCount(): number {
    let count = 0;
    for (const task of this.runningTasks.values()) {
      if (task.status === 'running') {
        count++;
      }
    }
    return count;
  }

  /**
   * 列出所有子代理状态（用于调试/状态查询）
   */
  listTasks(): Array<{
    id: string;
    label: string;
    status: SubagentStatus;
    sessionId: string;
    createdAt: number;
  }> {
    return Array.from(this.runningTasks.values()).map((t) => ({
      id: t.id,
      label: t.label,
      status: t.status,
      sessionId: t.origin.sessionId,
      createdAt: t.createdAt,
    }));
  }

  /**
   * 停止所有子代理（优雅关闭时调用）
   */
  async stopAll(): Promise<void> {
    log.info({ count: this.runningTasks.size }, '停止所有子代理');

    const promises: Promise<void>[] = [];
    for (const task of this.runningTasks.values()) {
      if (task.status === 'running') {
        task.abortController.abort();
        task.status = 'cancelled';
        promises.push(task.promise);
      }
    }

    // 等待所有任务完成
    await Promise.allSettled(promises);
    this.runningTasks.clear();
    this.sessionTasks.clear();

    log.info('所有子代理已停止');
  }

  // ─── 私有方法 ───

  /**
   * 执行子代理核心逻辑
   */
  private async runSubagent(
    taskId: string,
    task: string,
    label: string,
    origin: OriginContext,
    abortSignal: AbortSignal,
  ): Promise<void> {
    let resultText: string;
    let status: 'ok' | 'error' = 'ok';

    try {
      // 1. 构建受限工具集
      const subToolRegistry = this.createSubagentToolRegistry();

      // 2. 设置超时
      const timeoutId = setTimeout(() => {
        const taskObj = this.runningTasks.get(taskId);
        if (taskObj && taskObj.status === 'running') {
          taskObj.abortController.abort();
          log.warn({ taskId, timeout: this.config.timeout }, '子代理执行超时');
        }
      }, this.config.timeout);

      try {
        // 3. 执行受限 LLM 循环
        resultText = await this.runSubagentLoop(
          taskId,
          task,
          subToolRegistry,
          abortSignal,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      // 如果被取消了，不发通知
      if (abortSignal.aborted) {
        log.info({ taskId }, '子代理已被取消，跳过通知');
        return;
      }
    } catch (err) {
      status = 'error';
      resultText = (err as Error).message;
      log.error({ err, taskId }, '子代理执行失败');
    }

    // 4. 通知主代理
    try {
      await this.announceResult(taskId, label, task, resultText, origin, status);
    } catch (err) {
      log.error({ err, taskId }, '子代理结果通知失败');
    }
  }

  /**
   * 子代理的 LLM 循环（受限版本）
   */
  private async runSubagentLoop(
    taskId: string,
    task: string,
    toolRegistry: ToolRegistry,
    abortSignal: AbortSignal,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'user', content: task },
    ];

    const maxIterations = this.config.maxIterations;
    const model = this.config.model || this.model;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // 检查是否已取消
      if (abortSignal.aborted) {
        return '[子代理任务已取消]';
      }

      log.debug({ taskId, iteration: iterations, messageCount: messages.length }, '子代理 LLM 迭代');

      // 调用 LLM
      const llmResponse = await this.provider.chat({
        model,
        messages,
        tools: toolRegistry.size > 0 ? toolRegistry.getToolDefinitions() : undefined,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      });

      // LLM 调用完成后再次检查取消
      if (abortSignal.aborted) {
        return '[子代理任务已取消]';
      }

      // 如果没有工具调用，返回文本响应
      if (llmResponse.toolCalls.length === 0) {
        return llmResponse.content || '[子代理无输出]';
      }

      // 有工具调用 —— 保存 assistant 消息
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls,
      };
      messages.push(assistantMessage);

      // 执行所有工具调用
      for (const tc of llmResponse.toolCalls) {
        if (abortSignal.aborted) {
          return '[子代理任务已取消]';
        }

        let resultContent: string;
        try {
          // 子代理使用临时工作目录上下文
          const toolContext: ToolContext = {
            sessionId: `subagent-${taskId}`,
            workspaceDir: process.cwd(),
          };
          resultContent = await toolRegistry.execute(tc.name, tc.arguments, toolContext);
        } catch (err) {
          log.error({ err, toolName: tc.name, taskId }, '子代理工具执行失败');
          resultContent = `工具执行错误: ${(err as Error).message}`;
        }

        // 将工具结果添加到消息列表
        const toolMessage: ChatMessage = {
          role: 'tool',
          content: resultContent,
          toolCallId: tc.id,
          name: tc.name,
        };
        messages.push(toolMessage);
      }

      // 继续循环，让 LLM 处理工具结果
    }

    // 超过最大迭代次数，返回当前已有的最后一个 assistant 回复
    const lastAssistant = messages
      .filter((m) => m.role === 'assistant' && m.content)
      .pop();

    return lastAssistant?.content
      || `[子代理超过最大迭代次数 (${maxIterations})，任务可能未完全完成]`;
  }

  /**
   * 创建受限的子代理工具注册表
   *
   * 过滤掉不允许子代理使用的工具：
   * - spawn（避免嵌套）
   * - 消息发送类工具（避免直接与用户交互）
   * - 会话管理类工具
   */
  private createSubagentToolRegistry(): ToolRegistry {
    const subRegistry = new ToolRegistry();
    const blacklist = new Set(this.config.toolBlacklist);

    for (const toolName of this.mainToolRegistry.listTools()) {
      if (blacklist.has(toolName)) {
        log.debug({ toolName }, '工具被子代理黑名单过滤');
        continue;
      }

      const tool = this.mainToolRegistry.get(toolName);
      subRegistry.register(tool);
    }

    log.debug(
      { totalTools: this.mainToolRegistry.size, subagentTools: subRegistry.size },
      '子代理工具集已创建',
    );

    return subRegistry;
  }

  /**
   * 将子代理结果通知给主代理（通过 MessageBus 发送入站消息）
   */
  private async announceResult(
    taskId: string,
    label: string,
    task: string,
    result: string,
    origin: OriginContext,
    status: 'ok' | 'error',
  ): Promise<void> {
    const statusText = status === 'ok' ? 'completed successfully' : 'failed';

    const notification = [
      `[Subagent '${label}' ${statusText}]`,
      '',
      `Task: ${task}`,
      '',
      'Result:',
      result,
      '',
      'Summarize this naturally for the user. Keep it brief (1-2 sentences).',
      'Do not mention technical details like "subagent" or task IDs.',
    ].join('\n');

    // 通过 MessageBus 发送系统消息到原始会话
    this.messageBus.publishInbound({
      id: randomUUID(),
      channel: origin.channel,
      sessionId: origin.sessionId,
      text: notification,
      sender: 'system:subagent',
      timestamp: Date.now(),
      metadata: {
        isSubagentResult: true,
        taskId,
        label,
        status,
      },
    });

    log.info({ taskId, label, status }, '子代理结果已通知');
  }

  /**
   * 清理已完成的任务
   */
  private cleanup(taskId: string): void {
    const task = this.runningTasks.get(taskId);
    if (!task) return;

    // 更新状态
    if (task.status === 'running') {
      task.status = 'completed';
    }
    task.completedAt = Date.now();

    // 从会话映射中移除
    const sessionTaskSet = this.sessionTasks.get(task.origin.sessionId);
    if (sessionTaskSet) {
      sessionTaskSet.delete(taskId);
      if (sessionTaskSet.size === 0) {
        this.sessionTasks.delete(task.origin.sessionId);
      }
    }

    // 延迟清理任务信息（保留一段时间用于查询）
    setTimeout(() => {
      this.runningTasks.delete(taskId);
    }, 60_000); // 1 分钟后清理

    log.debug({ taskId, status: task.status }, '子代理任务已清理');
  }
}
