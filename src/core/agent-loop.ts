/**
 * 代理循环 (Agent Loop)
 * 
 * 核心 AI 代理逻辑：
 * 1. 从 MessageBus 消费入站消息
 * 2. 并发分发消息到处理管道（最多 N 条并发，同一 session 排队串行）
 * 3. 构建上下文（历史、记忆、系统提示）
 * 4. 调用 LLM
 * 5. 执行工具调用（如有）
 * 6. 循环直到 LLM 不再请求工具调用
 * 7. 将最终响应发布为出站消息
 * 
 * 并发策略：
 * - 全局最多同时处理 maxConcurrentMessages 条消息
 * - 同一 session 同时只能处理 1 条消息，后续消息排队等待前一条完成
 * - 支持通过 AbortSignal 取消（通道断开 / /stop 命令）
 */

import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../types/provider.js';
import type { ChatMessage, InboundMessage, ProgressMessage, ChannelName } from '../types/message.js';
import type { AgentConfig } from '../types/config.js';
import { MessageBus } from './message-bus.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { Semaphore } from './semaphore.js';
import { AgentLoopError } from './errors.js';
import { createChildLogger } from './logger.js';
import { setCurrentOrigin, clearCurrentOrigin } from '../tools/spawn-tool.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { SkillsLoader } from '../skills/skills-loader.js';
import type { UserStore } from './user-store.js';

const log = createChildLogger('AgentLoop');

/** 代理循环配置 */
interface AgentLoopDeps {
  messageBus: MessageBus;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  provider: LLMProvider;
  config: AgentConfig;
  memoryStore?: MemoryStore;
  skillsLoader?: SkillsLoader;
  userStore?: UserStore;
}

/** 每个 session 的队列状态 */
interface SessionQueueState {
  /** 当前的处理链（所有排队消息的 Promise 链） */
  chain: Promise<void>;
  /** 所有活跃/排队的 AbortController（用于取消整个 session 的所有排队消息） */
  abortControllers: Set<AbortController>;
}

/**
 * 代理循环
 */
export class AgentLoop {
  private running = false;

  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly provider: LLMProvider;
  private readonly config: AgentConfig;
  private readonly memoryStore?: MemoryStore;
  private readonly skillsLoader?: SkillsLoader;
  private readonly userStore?: UserStore;

  /** 全局并发控制信号量 */
  private readonly semaphore: Semaphore;

  /** 每个 session 的队列状态（排队 + 处理中的消息链） */
  private readonly sessionQueues = new Map<string, SessionQueueState>();

  constructor(deps: AgentLoopDeps) {
    this.messageBus = deps.messageBus;
    this.sessionManager = deps.sessionManager;
    this.toolRegistry = deps.toolRegistry;
    this.provider = deps.provider;
    this.config = deps.config;
    this.memoryStore = deps.memoryStore;
    this.skillsLoader = deps.skillsLoader;
    this.userStore = deps.userStore;

    const maxConcurrent = deps.config.maxConcurrentMessages ?? 5;
    this.semaphore = new Semaphore(maxConcurrent);

    // 注册通道取消回调：当通道请求取消某会话时，中止其所有排队/处理中的消息
    this.messageBus.onSessionCancel((sessionId) => {
      this.cancelSessionProcessing(sessionId);
    });
  }

  /**
   * 启动代理循环
   * 
   * 消息派发采用 fire-and-forget 模式，不阻塞主循环。
   * 主循环持续从队列读取消息并分发到并发处理管道。
   */
  async start(): Promise<void> {
    if (this.running) {
      log.warn('代理循环已在运行');
      return;
    }

    this.running = true;
    const maxConcurrent = this.config.maxConcurrentMessages ?? 5;
    log.info({ maxConcurrent }, '代理循环已启动（并发模式）');

    try {
      for await (const message of this.messageBus.inboundMessages()) {
        if (!this.running) break;

        // fire-and-forget：不阻塞主循环，立即继续读取下一条消息
        this.dispatch(message);
      }
    } catch (err) {
      if (this.running) {
        log.error({ err }, '代理循环异常退出');
        throw new AgentLoopError('代理循环异常退出', undefined, { cause: err as Error });
      }
    } finally {
      // 等待所有 session 的处理链完成后再退出
      const chains = Array.from(this.sessionQueues.values()).map((s) => s.chain);
      if (chains.length > 0) {
        log.info({ count: chains.length }, '等待所有 session 处理链完成...');
        await Promise.allSettled(chains);
      }
      this.running = false;
      log.info('代理循环已停止');
    }
  }

  /**
   * 停止代理循环
   */
  stop(): void {
    this.running = false;
    // 取消所有 session 的所有排队/处理中的消息
    for (const [sessionId, state] of this.sessionQueues) {
      for (const controller of state.abortControllers) {
        controller.abort();
      }
      log.debug({ sessionId, count: state.abortControllers.size }, '已取消 session 的所有处理');
    }
    this.messageBus.close();
    log.info('停止代理循环');
  }

  /**
   * 取消指定 session 的所有排队和处理中的消息
   */
  private cancelSessionProcessing(sessionId: string): void {
    const state = this.sessionQueues.get(sessionId);
    if (state) {
      for (const controller of state.abortControllers) {
        controller.abort();
      }
      log.info(
        { sessionId, count: state.abortControllers.size },
        '已取消 session 的所有排队/处理中的消息',
      );
    }
  }

  /**
   * 分发消息到并发处理管道
   * 
   * 该方法是同步的（在注册 sessionQueues 之前不会 yield），
   * 保证同一 session 的连续消息按到达顺序串行排队。
   * 
   * 处理流程：
   * 1. 同一 session 已有排队 → 新消息链到队尾（排队串行执行）
   * 2. 不同 session → 并发执行（受全局信号量限制）
   */
  private dispatch(message: InboundMessage): void {
    const { sessionId } = message;

    const abortController = new AbortController();
    const existing = this.sessionQueues.get(sessionId);

    // 获取前一条消息的处理链（如果有），新消息排在其后
    const previousChain = existing?.chain ?? Promise.resolve();

    // 合并或创建 AbortController 集合
    const abortControllers = existing?.abortControllers ?? new Set<AbortController>();
    abortControllers.add(abortController);

    if (existing) {
      log.info(
        { sessionId, messageId: message.id, queueDepth: abortControllers.size },
        '同一会话有新消息到达，排入队列等待',
      );
    }

    // 创建新的处理链：等待前一条完成 → 获取槽位 → 处理
    const newChain = previousChain
      .catch(() => {
        // 忽略前一条消息的错误，保证链条不中断
      })
      .then(() => this.runDispatchPipeline(message, abortController))
      .catch((err) => {
        // 安全兜底：runDispatchPipeline 内部已处理所有错误，这里不应被触发
        log.error({ err, sessionId, messageId: message.id }, 'dispatch pipeline 未预期的错误');
      })
      .finally(() => {
        // 清理该消息的 AbortController
        abortControllers.delete(abortController);
        // 如果该 session 没有更多排队消息，清理 session 状态
        if (abortControllers.size === 0) {
          this.sessionQueues.delete(sessionId);
        }
      });

    // 同步更新 session 状态（在任何 await 之前），保证后续同 session 消息能看到
    this.sessionQueues.set(sessionId, {
      chain: newChain,
      abortControllers,
    });
  }

  /**
   * 单条消息的分发管道：获取槽位 → 执行处理
   */
  private async runDispatchPipeline(
    message: InboundMessage,
    abortController: AbortController,
  ): Promise<void> {
    const { sessionId } = message;

    // 1. 如果已被取消（通道断开 / /stop 命令），直接退出
    if (abortController.signal.aborted) {
      log.debug({ sessionId, messageId: message.id }, '消息在排队期间已被取消，跳过处理');
      return;
    }

    // 2. 获取并发槽位（如果所有槽位被占用则等待）
    await this.semaphore.acquire();

    try {
      // 3. 获取槽位后再次检查取消
      if (abortController.signal.aborted) {
        log.debug({ sessionId, messageId: message.id }, '消息在获取槽位后已被取消，跳过处理');
        return;
      }

      // 4. 执行消息处理
      await this.processMessage(message, abortController.signal);
    } catch (err) {
      // 如果是取消导致的，不算错误
      if (abortController.signal.aborted) {
        log.debug({ sessionId, messageId: message.id }, '消息处理被取消');
        return;
      }
      log.error({ err, messageId: message.id, sessionId }, '处理消息时发生错误');
      await this.sendErrorResponse(message, err as Error).catch((sendErr) => {
        log.error({ err: sendErr, sessionId }, '发送错误响应失败');
      });
    } finally {
      this.semaphore.release();
    }
  }

  /**
   * 处理单条入站消息
   */
  private async processMessage(message: InboundMessage, abortSignal: AbortSignal): Promise<void> {
    const { sessionId, text, channel } = message;

    // 确保会话已创建（必须在用户关联和命令处理之前）
    await this.sessionManager.getOrCreate(sessionId, channel);

    // 解析用户身份并关联到会话（在命令处理之前，确保 /link 等命令可以获取当前用户）
    if (this.userStore) {
      const senderName = (message.metadata?.['displayName'] as string | undefined)
        || (message.metadata?.['username'] as string | undefined);
      const user = await this.userStore.getOrCreateByChannel(
        channel,
        message.sender,
        senderName,
      );
      this.sessionManager.setSessionUser(sessionId, user.id);
      log.debug({ sessionId, userId: user.id, userName: user.name }, '会话已关联用户');
    }

    // 处理特殊命令
    if (text.startsWith('/')) {
      await this.handleCommand(message);
      return;
    }

    log.info({ sessionId, channel, textLength: text.length }, '处理消息');

    try {
      // 设置子代理来源上下文（让 SpawnTool 知道当前消息来源）
      setCurrentOrigin({ sessionId, channel });

      // 添加用户消息到会话
      const userMessage: ChatMessage = { role: 'user', content: text };
      await this.sessionManager.addMessage(sessionId, userMessage);

      // 获取历史消息
      const history = this.sessionManager.getHistory(sessionId);

      // 执行 LLM 循环（可能包含多轮工具调用）
      const response = await this.runLLMLoop(sessionId, channel, history, abortSignal);

      // 发送响应（仅在未取消时发送）
      if (!abortSignal.aborted) {
        await this.messageBus.publishOutbound({
          id: randomUUID(),
          channel,
          sessionId,
          text: response,
          timestamp: Date.now(),
        });
      }
    } finally {
      // 清理子代理来源上下文
      clearCurrentOrigin();
    }
  }

  /**
   * 发布进度消息到对应通道
   */
  private emitProgress(
    channel: ChannelName,
    sessionId: string,
    progress: Partial<ProgressMessage>,
  ): void {
    this.messageBus.publishProgress({
      id: randomUUID(),
      channel,
      sessionId,
      timestamp: Date.now(),
      step: 'thinking',
      ...progress,
    } as ProgressMessage);
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
   * 
   * 每一步都会通过 emitProgress 向通道推送实时进度。
   * 支持通过 AbortSignal 取消（通道断开 / /stop 命令）。
   */
  private async runLLMLoop(
    sessionId: string,
    channel: ChannelName,
    history: ChatMessage[],
    abortSignal: AbortSignal,
  ): Promise<string> {
    const messages = [...history];
    let iterations = 0;

    // 构建增强的系统提示
    const systemPrompt = await this.buildSystemPrompt();

    while (iterations < this.config.maxIterations) {
      iterations++;

      // 检查是否已取消
      if (abortSignal.aborted) {
        log.info({ sessionId, iteration: iterations }, '会话已取消，中止 LLM 循环');
        return '[会话已取消]';
      }

      log.debug({ sessionId, iteration: iterations, messageCount: messages.length }, 'LLM 迭代');

      // 进度: 正在思考
      this.emitProgress(channel, sessionId, {
        step: 'thinking',
        iteration: iterations,
      });

      // 调用 LLM
      const llmResponse = await this.provider.chat({
        model: this.config.model,
        messages,
        tools: this.toolRegistry.size > 0 ? this.toolRegistry.getToolDefinitions() : undefined,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        systemPrompt,
      });

      // LLM 调用完成后再次检查取消
      if (abortSignal.aborted) {
        log.info({ sessionId, iteration: iterations }, '会话已取消（LLM 返回后），中止循环');
        return '[会话已取消]';
      }

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

      // 有工具调用 —— 先推送 LLM 的中间回复（如果有文本内容）
      if (llmResponse.content) {
        this.emitProgress(channel, sessionId, {
          step: 'llm_response',
          iteration: iterations,
          content: llmResponse.content,
        });
      }

      // 保存 assistant 消息（含工具调用）
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: llmResponse.content,
        toolCalls: llmResponse.toolCalls,
      };
      messages.push(assistantMessage);
      await this.sessionManager.addMessage(sessionId, assistantMessage);

      // 执行所有工具调用，每个都推送进度
      const sessionWorkspaceDir = await this.sessionManager.getWorkspaceDir(sessionId);
      for (const tc of llmResponse.toolCalls) {
        // 每个工具执行前检查取消
        if (abortSignal.aborted) {
          log.info({ sessionId, iteration: iterations, toolName: tc.name }, '会话已取消，跳过剩余工具调用');
          return '[会话已取消]';
        }

        // 进度: 开始执行工具
        this.emitProgress(channel, sessionId, {
          step: 'tool_call',
          iteration: iterations,
          toolName: tc.name,
          toolArgs: tc.arguments,
          toolCallId: tc.id,
        });

        // 执行工具
        let resultContent: string;
        let isError = false;
        try {
          resultContent = await this.toolRegistry.execute(tc.name, tc.arguments, {
            sessionId,
            workspaceDir: sessionWorkspaceDir,
          });
        } catch (err) {
          log.error({ err, toolName: tc.name }, '工具执行失败');
          resultContent = `工具执行错误: ${(err as Error).message}`;
          isError = true;
        }

        // 进度: 工具执行完成
        this.emitProgress(channel, sessionId, {
          step: 'tool_result',
          iteration: iterations,
          toolName: tc.name,
          toolCallId: tc.id,
          content: resultContent,
          isError,
        });

        // 将工具结果添加到消息列表
        const toolMessage: ChatMessage = {
          role: 'tool',
          content: resultContent,
          toolCallId: tc.id,
          name: tc.name,
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
   * 处理特殊命令
   */
  private async handleCommand(message: InboundMessage): Promise<void> {
    const { text, channel, sessionId } = message;
    const parts = text.trim().split(/\s+/);
    const command = parts[0]!.toLowerCase();
    const args = parts.slice(1);

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
        this.cancelSessionProcessing(sessionId);
        response = '⏹️ 已停止当前任务';
        break;

      case '/status': {
        const sessions = this.sessionManager.listSessions();
        const tools = this.toolRegistry.listTools();
        const maxConcurrent = this.config.maxConcurrentMessages ?? 5;
        const activeSessionCount = this.sessionQueues.size;
        let totalQueued = 0;
        for (const state of this.sessionQueues.values()) {
          totalQueued += state.abortControllers.size;
        }
        response = [
          '📊 状态信息:',
          `  模型: ${this.config.model}`,
          `  活跃会话: ${sessions.length}`,
          `  已注册工具: ${tools.length}`,
          `  提供商: ${this.provider.name}`,
          `  处理中的 session: ${activeSessionCount}`,
          `  排队/处理中消息总数: ${totalQueued}`,
          `  并发上限: ${maxConcurrent}`,
          `  信号量可用: ${this.semaphore.available}/${this.semaphore.max}`,
        ].join('\n');
        break;
      }

      case '/link':
        response = await this.handleLinkCommand(message, args);
        break;

      case '/whoami':
        response = this.handleWhoamiCommand(message);
        break;

      case '/unlink':
        response = await this.handleUnlinkCommand(message);
        break;

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
      '  /help         - 显示此帮助信息',
      '  /clear        - 清除当前会话',
      '  /tools        - 列出可用工具',
      '  /status       - 显示状态信息',
      '  /stop         - 停止当前任务',
      '  /whoami       - 查看当前用户身份',
      '  /link         - 生成跨通道关联码',
      '  /link <code>  - 使用关联码绑定到另一个通道的用户',
      '  /unlink       - 解绑当前通道（需有多个通道绑定）',
    ].join('\n');
  }

  /**
   * 处理 /link 命令
   *
   * 流程：
   * 1. /link（无参数）→ 生成链接码，用户在另一个通道输入
   * 2. /link <code> → 用链接码将当前通道身份合并到另一个通道的用户
   */
  private async handleLinkCommand(message: InboundMessage, args: string[]): Promise<string> {
    if (!this.userStore) {
      return '❌ 用户系统未启用';
    }

    const userId = this.sessionManager.getSessionUserId(message.sessionId);
    if (!userId) {
      return '❌ 无法识别当前用户';
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return '❌ 用户数据异常';
    }

    // 无参数：生成链接码
    if (args.length === 0) {
      const code = this.userStore.generateLinkCode(userId);
      return [
        '🔗 跨通道关联码已生成：',
        '',
        `  📌  ${code}`,
        '',
        '请在另一个通道中发送以下命令完成关联：',
        `  /link ${code}`,
        '',
        '⏱️ 此关联码 5 分钟内有效。',
      ].join('\n');
    }

    // 有参数：使用链接码进行合并
    const code = args[0]!;
    const result = await this.userStore.redeemLinkCode(code, userId);

    if (!result) {
      return '❌ 关联码无效或已过期，请重新生成。';
    }

    // 迁移 session 关联
    this.sessionManager.migrateSessionsUser(result.mergedUserId, result.primaryUser.id);

    const bindingList = result.primaryUser.channelBindings
      .map((b) => `  - ${b.channel}: ${b.channelUserId}`)
      .join('\n');

    return [
      '✅ 通道关联成功！',
      '',
      `👤 统一用户: ${result.primaryUser.name}`,
      `📎 已绑定通道:`,
      bindingList,
    ].join('\n');
  }

  /**
   * 处理 /whoami 命令 — 显示当前用户身份信息
   */
  private handleWhoamiCommand(message: InboundMessage): string {
    if (!this.userStore) {
      return '❌ 用户系统未启用';
    }

    const userId = this.sessionManager.getSessionUserId(message.sessionId);
    if (!userId) {
      return '❌ 无法识别当前用户';
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return '❌ 用户数据异常';
    }

    const bindingList = user.channelBindings
      .map((b) => `  - ${b.channel}: ${b.channelUserId}`)
      .join('\n');

    return [
      '👤 当前用户信息:',
      `  ID: ${user.id}`,
      `  名称: ${user.name}`,
      `  创建时间: ${new Date(user.createdAt).toLocaleString()}`,
      `  最后活跃: ${new Date(user.lastActiveAt).toLocaleString()}`,
      '',
      '📎 已绑定通道:',
      bindingList,
      '',
      `📝 当前通道: ${message.channel}`,
      `📝 当前会话: ${message.sessionId}`,
    ].join('\n');
  }

  /**
   * 处理 /unlink 命令 — 解绑当前通道
   *
   * 将当前通道的身份从用户上移除，解绑后当前通道会被视为新用户。
   * 约束：至少保留一个通道绑定，不允许解绑最后一个。
   */
  private async handleUnlinkCommand(message: InboundMessage): Promise<string> {
    if (!this.userStore) {
      return '❌ 用户系统未启用';
    }

    const userId = this.sessionManager.getSessionUserId(message.sessionId);
    if (!userId) {
      return '❌ 无法识别当前用户';
    }

    const user = this.userStore.getById(userId);
    if (!user) {
      return '❌ 用户数据异常';
    }

    // 检查绑定数量
    if (user.channelBindings.length <= 1) {
      return '❌ 当前用户只有一个通道绑定，无法解绑。只有通过 /link 关联了多个通道后才能使用 /unlink。';
    }

    // 找到当前通道的绑定
    const currentBinding = user.channelBindings.find(
      (b) => b.channel === message.channel && b.channelUserId === message.sender,
    );

    if (!currentBinding) {
      return '❌ 未找到当前通道的绑定信息';
    }

    // 执行解绑
    await this.userStore.unbindChannel(userId, message.channel, message.sender);

    // 清除当前 session 的用户关联（下次发消息会自动创建新用户）
    this.sessionManager.setSessionUser(message.sessionId, '');

    const remainingBindings = user.channelBindings
      .map((b) => `  - ${b.channel}: ${b.channelUserId}`)
      .join('\n');

    return [
      '✅ 已解绑当前通道',
      '',
      `📎 已解绑: ${message.channel}:${message.sender}`,
      '',
      `👤 原用户 (${user.name}) 剩余绑定:`,
      remainingBindings,
      '',
      '下次发送消息时，当前通道将被分配为新用户。',
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
