/**
 * 工具注册表
 * 
 * 管理工具的注册、查询、执行。
 * 支持动态注册（如 MCP 工具）。
 */

import type { Tool, ToolDefinition, ToolContext } from '../types/tool.js';
import { ToolNotFoundError, ToolExecutionError } from './errors.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('ToolRegistry');

/**
 * 工具注册表
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  /**
   * 注册一个工具
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      log.warn({ toolName: tool.name }, '工具已存在，将被覆盖');
    }
    this.tools.set(tool.name, tool);
    log.debug({ toolName: tool.name }, '工具已注册');
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 移除工具
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      log.debug({ toolName: name }, '工具已移除');
    }
    return removed;
  }

  /**
   * 获取工具
   */
  get(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }
    return tool;
  }

  /**
   * 检查工具是否存在
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 执行工具
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const tool = this.get(name);

    log.debug({ toolName: name, params }, '执行工具');

    try {
      const result = await tool.execute(params, context);
      log.debug({ toolName: name, resultLength: result.length }, '工具执行成功');
      return result;
    } catch (err) {
      if (err instanceof ToolExecutionError) {
        throw err;
      }
      throw new ToolExecutionError(name, params, err as Error);
    }
  }

  /**
   * 获取所有工具的 OpenAI 格式定义
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 获取所有已注册工具名称
   */
  listTools(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 获取工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}
