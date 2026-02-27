/**
 * 代理循环 (Agent Loop)
 * 
 * 核心 AI 代理逻辑：
 * 1. 从 MessageBus 消费入站消息
 * 2. 构建上下文（历史、记忆、系统提示）
 * 3. 调用 LLM
 * 4. 执行工具调用（如有）
 * 5. 循环直到 LLM 不再请求工具调用
 * 6. 将最终响应发布为出站消息
 */

import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../types/provider.js';
import type { ChatMessage, ToolCall, InboundMessage } from '../types/message.js';
import type { AgentConfig } from '../types/config.js';
import { MessageBus } from './message-bus.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { AgentLoopError } from './errors.js';
import { createChildLogger } from './logger.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { SkillsLoader } from '../skills/skills-loader.js';

const log = createChildLogger('AgentLoop');

/** 代理循环配置 */
interface AgentLoopDeps {
  messageBus: MessageBus;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  provider: LLMProvider;
  config: AgentConfig;
  workspaceDir: string;
  memoryStore?: MemoryStore;
  skillsLoader?: SkillsLoader;
}

/**
 * 代理循环
 */
export class AgentLoop {
  private running = false;
  private abortController: AbortController | null = null;

  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly provider: LLMProvider;
  private readonly config: AgentConfig;
  private readonly workspaceDir: string;
  private readonly memoryStore?: MemoryStore;
  private readonly skillsLoader?: SkillsLoader;

  constructor(deps: AgentLoopDeps) {
    this.messageBus = deps.messageBus;
    this.sessionManager = deps.sessionManager;
    this.toolRegistry = deps.toolRegistry;
    this.provider = deps.provider;
    this.config = deps.config;
    this.workspaceDir = deps.workspaceDir;
    this.memoryStore = deps.memoryStore;
    this.skillsLoader = deps.skillsLoader;
  }

  /**
   * 启动代理循环
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('代理循环已在运行');
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    log.info('代理循环已启动');

    try {
      for await (const message of this.messageBus.inboundMessages()) {
        if (!this.running) break;

        try {
          await this.handleMessage(message);
        } catch (err) {
          log.error({ err, messageId: message.id }, '处理消息时发生错误');
          // 发送错误响应给用户
          await this.sendErrorResponse(message, err as Error);
        }
      }
    } catch (err) {
      if (this.running) {
        log.error({ err }, '代理循环异常退出');
        throw new AgentLoopError('代理循环异常退出', undefined, { cause: err as Error });
      }
    } finally {
      this.running = false;
      log.info('代理循环已停止');
    }
  }

  /**
   * 停止代理循环
   */
  stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.messageBus.close();
    log.info('停止代理循环');
  }

  /**
   * 处理单条入站消息
   */
  private async handleMessage(message: InboundMessage): Promise<void> {
    const { sessionId, text, channel } = message;

    // 处理特殊命令
    if (text.startsWith('/')) {
      await this.handleCommand(message);
      return;
    }

    log.info({ sessionId, channel, textLength: text.length }, '处理消息');

    // 获取或创建会话
    const session = await this.sessionManager.getOrCreate(sessionId, channel);

    // 添加用户消息到会话
    const userMessage: ChatMessage = { role: 'user', content: text };
    await this.sessionManager.addMessage(session.meta.id, userMessage);

    // 获取历史消息
    const history = this.sessionManager.getHistory(sessionId);

    // 执行 LLM 循环（可能包含多轮工具调用）
    const response = await this.runLLMLoop(sessionId, history);

    // 发送响应
    await this.messageBus.publishOutbound({
      id: randomUUID(),
      channel,
      sessionId,
      text: response,
      timestamp: Date.now(),
    });
  }

  /**
   * 构建增强的系统提示（包含记忆和技能上下文）
   */
  private async buildSystemPrompt(): Promise<string> {
    let prompt = this.config.systemPrompt;

    // 注入记忆上下文
    if (this.memoryStore) {
      const memoryContext = await this.memoryStore.getContextForPrompt();
      if (memoryContext) {
        prompt += memoryContext;
      }
    }

    // 注入技能上下文
    if (this.skillsLoader) {
      const skillsContext = this.skillsLoader.getSkillsForPrompt();
      if (skillsContext) {
        prompt += skillsContext;
      }
    }

    return prompt;
  }

  /**
   * LLM 循环：调用 LLM -> 执行工具 -> 再调用 LLM，直到完成
   */
  private async runLLMLoop(sessionId: string, history: ChatMessage[]): Promise<string> {
    const messages = [...history];
    let iterations = 0;

    // 构建增强的系统提示
    const systemPrompt = await this.buildSystemPrompt();

    while (iterations < this.config.maxIterations) {
      iterations++;

      log.debug({ sessionId, iteration: iterations, messageCount: messages.length }, 'LLM 迭代');

      // 调用 LLM
      const llmResponse = await this.provider.chat({
        model: this.config.model,
        messages,
        tools: this.toolRegistry.size > 0 ? this.toolRegistry.getToolDefinitions() : undefined,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        systemPrompt,
      });

      // 如果没有工具调用，返回文本响应
      if (llmResponse.toolCalls.length === 0) {
        const assistantContent = llmResponse.content || '';

        // 保存 assistant 消息到会话
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: assistantContent,
        };
        await this.sessionManager.addMessage(sessionId, assistantMessage);

        return assistantContent;
      }

      // 有工具调用 —— 保存 assistant 消息（含工具调用）
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls,
      };
      messages.push(assistantMessage);
      await this.sessionManager.addMessage(sessionId, assistantMessage);

      // 执行所有工具调用
      const toolResults = await this.executeToolCalls(llmResponse.toolCalls, sessionId);

      // 将工具结果添加到消息列表
      for (const result of toolResults) {
        const toolMessage: ChatMessage = {
          role: 'tool',
          content: result.content,
          toolCallId: result.toolCallId,
          name: result.name,
        };
        messages.push(toolMessage);
        await this.sessionManager.addMessage(sessionId, toolMessage);
      }

      // 继续循环，让 LLM 处理工具结果
    }

    throw new AgentLoopError(
      `超过最大迭代次数 (${this.config.maxIterations})`,
      { sessionId, iterations },
    );
  }

  /**
   * 执行工具调用列表
   */
  private async executeToolCalls(
    toolCalls: ToolCall[],
    sessionId: string,
  ): Promise<Array<{ toolCallId: string; name: string; content: string }>> {
    const results: Array<{ toolCallId: string; name: string; content: string }> = [];

    for (const tc of toolCalls) {
      log.info({ toolName: tc.name, toolCallId: tc.id }, '执行工具调用');

      let content: string;
      try {
        content = await this.toolRegistry.execute(tc.name, tc.arguments, {
          sessionId,
          workspaceDir: this.workspaceDir,
        });
      } catch (err) {
        log.error({ err, toolName: tc.name }, '工具执行失败');
        content = `工具执行错误: ${(err as Error).message}`;
      }

      results.push({
        toolCallId: tc.id,
        name: tc.name,
        content,
      });
    }

    return results;
  }

  /**
   * 处理特殊命令
   */
  private async handleCommand(message: InboundMessage): Promise<void> {
    const { text, channel, sessionId } = message;
    const command = text.trim().toLowerCase();

    let response: string;

    switch (command) {
      case '/help':
        response = this.getHelpText();
        break;

      case '/clear':
        await this.sessionManager.clearSession(sessionId);
        response = '🗑️ 会话已清除';
        break;

      case '/tools':
        response = this.getToolsText();
        break;

      case '/stop':
        response = '⏹️ 已停止当前任务';
        break;

      case '/status': {
        const sessions = this.sessionManager.listSessions();
        const tools = this.toolRegistry.listTools();
        response = [
          '📊 状态信息:',
          `  模型: ${this.config.model}`,
          `  活跃会话: ${sessions.length}`,
          `  已注册工具: ${tools.length}`,
          `  提供商: ${this.provider.name}`,
        ].join('\n');
        break;
      }

      default:
        response = `❓ 未知命令: ${command}\n使用 /help 查看可用命令`;
        break;
    }

    await this.messageBus.publishOutbound({
      id: randomUUID(),
      channel,
      sessionId,
      text: response,
      timestamp: Date.now(),
    });
  }

  /** 帮助文本 */
  private getHelpText(): string {
    return [
      '📖 可用命令:',
      '  /help   - 显示此帮助信息',
      '  /clear  - 清除当前会话',
      '  /tools  - 列出可用工具',
      '  /status - 显示状态信息',
      '  /stop   - 停止当前任务',
    ].join('\n');
  }

  /** 工具列表文本 */
  private getToolsText(): string {
    const tools = this.toolRegistry.listTools();
    if (tools.length === 0) {
      return '🔧 没有已注册的工具';
    }
    return '🔧 可用工具:\n' + tools.map((t) => `  - ${t}`).join('\n');
  }

  /**
   * 发送错误响应
   */
  private async sendErrorResponse(message: InboundMessage, error: Error): Promise<void> {
    await this.messageBus.publishOutbound({
      id: randomUUID(),
      channel: message.channel,
      sessionId: message.sessionId,
      text: `❌ 处理消息时发生错误: ${error.message}`,
      timestamp: Date.now(),
    });
  }
}
