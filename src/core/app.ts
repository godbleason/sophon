/**
 * 应用核心 - 组装和启动所有组件
 */

import type { Config } from '../types/config.js';
import type { LLMProvider } from '../types/provider.js';
import type { Channel } from '../channels/base-channel.js';
import { MessageBus } from './message-bus.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { AgentLoop } from './agent-loop.js';
import { Scheduler } from './scheduler.js';
import { SubagentManager } from './subagent-manager.js';
import { createProvider } from '../providers/provider-factory.js';
import { CLIChannel } from '../channels/cli-channel.js';
import { WebChannel } from '../channels/web-channel.js';
import { getBuiltinTools } from '../tools/index.js';
import { setScheduler } from '../tools/schedule-tool.js';
import { setSubagentManager } from '../tools/spawn-tool.js';
import { MemoryStore } from '../memory/memory-store.js';
import { SkillsLoader } from '../skills/skills-loader.js';
import { setLogLevel, createChildLogger } from './logger.js';
import { ConfigError } from './errors.js';

const log = createChildLogger('App');

/**
 * Sophon 应用实例
 */
export class SophonApp {
  private readonly config: Config;
  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly provider: LLMProvider;
  private readonly memoryStore: MemoryStore;
  private readonly skillsLoader: SkillsLoader;
  private readonly scheduler: Scheduler;
  private readonly subagentManager: SubagentManager;
  private readonly agentLoop: AgentLoop;
  private readonly channels: Channel[] = [];

  constructor(config: Config) {
    this.config = config;

    // 设置日志级别
    setLogLevel(config.logLevel);

    log.info('初始化 Sophon...');

    // 初始化核心组件
    this.messageBus = new MessageBus();
    this.sessionManager = new SessionManager(config.session);
    this.toolRegistry = new ToolRegistry();
    this.memoryStore = new MemoryStore(config.memory);
    this.skillsLoader = new SkillsLoader(config.skillsDir);

    // 初始化定时任务调度器
    this.scheduler = new Scheduler(config.scheduler, this.messageBus, this.sessionManager);
    setScheduler(this.scheduler);

    // 注册内置工具（含定时任务工具和子代理工具）
    this.toolRegistry.registerAll(getBuiltinTools());
    log.info({ toolCount: this.toolRegistry.size }, '内置工具已注册');

    // 创建 LLM Provider
    this.provider = this.createLLMProvider();

    // 初始化子代理管理器
    this.subagentManager = new SubagentManager(
      config.subagent,
      this.messageBus,
      this.provider,
      this.toolRegistry,
      config.agent.model,
    );
    setSubagentManager(this.subagentManager);
    log.info('子代理管理器已初始化');

    // 创建 Agent Loop
    this.agentLoop = new AgentLoop({
      messageBus: this.messageBus,
      sessionManager: this.sessionManager,
      toolRegistry: this.toolRegistry,
      provider: this.provider,
      config: config.agent,
      memoryStore: this.memoryStore,
      skillsLoader: this.skillsLoader,
    });

    // 初始化通道
    this.initChannels();

    log.info('Sophon 初始化完成');
  }

  /**
   * 启动应用
   */
  async start(): Promise<void> {
    log.info('启动 Sophon...');

    // 加载技能
    try {
      const skills = await this.skillsLoader.loadAll();
      log.info({ skillCount: skills.length }, '技能加载完成');
    } catch (err) {
      log.warn({ err }, '技能加载失败，继续启动');
    }

    // 启动定时任务调度器
    await this.scheduler.start();

    // 启动所有通道
    const channelResults = await Promise.allSettled(
      this.channels.map((ch) => ch.start()),
    );

    // 检查通道启动结果
    for (let i = 0; i < channelResults.length; i++) {
      const result = channelResults[i]!;
      const channel = this.channels[i]!;
      if (result.status === 'rejected') {
        log.error({ channel: channel.name, err: result.reason }, '通道启动失败');
      } else {
        log.info({ channel: channel.name }, '通道已启动');
      }
    }

    // 启动 Agent Loop（阻塞运行）
    await this.agentLoop.start();
  }

  /**
   * 停止应用
   */
  async stop(): Promise<void> {
    log.info('停止 Sophon...');

    // 停止 Agent Loop
    this.agentLoop.stop();

    // 停止所有子代理
    await this.subagentManager.stopAll();

    // 停止定时任务调度器
    await this.scheduler.stop();

    // 停止所有通道
    await Promise.allSettled(
      this.channels.map((ch) => ch.stop()),
    );

    log.info('Sophon 已停止');
  }

  /**
   * 创建 LLM Provider
   */
  private createLLMProvider(): LLMProvider {
    const providers = this.config.providers;
    const providerNames = Object.keys(providers);

    if (providerNames.length === 0) {
      throw new ConfigError('未配置任何 LLM 提供商，请设置 OPENAI_API_KEY 或在配置文件中添加 providers');
    }

    // 使用第一个提供商
    const name = providerNames[0]!;
    const config = providers[name]!;

    log.info({ provider: name }, '使用 LLM 提供商');
    return createProvider(name, config);
  }

  /**
   * 初始化通道
   */
  private initChannels(): void {
    const { channels } = this.config;

    // CLI 通道
    if (channels.cli.enabled) {
      this.channels.push(
        new CLIChannel({
          messageBus: this.messageBus,
          prompt: channels.cli.prompt,
        }),
      );
      log.info('CLI 通道已配置');
    }

    // Web 通道
    if (channels.web.enabled) {
      this.channels.push(
        new WebChannel({
          messageBus: this.messageBus,
          port: channels.web.port,
          host: channels.web.host,
        }),
      );
      log.info({ port: channels.web.port }, 'Web 通道已配置');
    }

    // TODO: 其他通道（Telegram, Discord 等）

    if (this.channels.length === 0) {
      throw new ConfigError('没有启用任何通道，请至少启用一个通道');
    }
  }
}
