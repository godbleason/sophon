/**
 * 应用核心 - 组装和启动所有组件
 */

import type { Config } from '../types/config.js';
import type { LLMProvider } from '../types/provider.js';
import type { Channel } from '../channels/base-channel.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { SqliteStorageProvider } from '../storage/sqlite-provider.js';
import { MessageBus } from './message-bus.js';
import { SessionManager } from './session-manager.js';
import { ToolRegistry } from './tool-registry.js';
import { AgentLoop } from './agent-loop.js';
import { Scheduler } from './scheduler.js';
import { SubagentManager } from './subagent-manager.js';
import { createProvider } from '../providers/provider-factory.js';
import { CLIChannel } from '../channels/cli-channel.js';
import { WebChannel } from '../channels/web-channel.js';
import { TelegramChannel } from '../channels/telegram-channel.js';
import { getBuiltinTools } from '../tools/index.js';
import { setScheduler } from '../tools/schedule-tool.js';
import { setSubagentManager } from '../tools/spawn-tool.js';
import { setMessageToolDeps } from '../tools/message-tool.js';
import { setMemoryToolDeps } from '../tools/memory-tool.js';
import { MemoryStore } from '../memory/memory-store.js';
import { SkillsLoader } from '../skills/skills-loader.js';
import { UserStore } from './user-store.js';
import { SpaceManager } from './space-manager.js';
import { McpManager } from './mcp-manager.js';
import { setLogLevel, createChildLogger } from './logger.js';
import { ConfigError } from './errors.js';

const log = createChildLogger('App');

/**
 * 根据配置创建 StorageProvider
 */
function createStorageProvider(config: Config): StorageProvider {
  switch (config.storage.type) {
    case 'sqlite':
      return new SqliteStorageProvider({ dbPath: config.storage.sqlitePath });
    default:
      throw new ConfigError(`不支持的存储类型: ${config.storage.type as string}`);
  }
}

/**
 * Sophon 应用实例
 */
export class SophonApp {
  private readonly config: Config;
  private readonly storage: StorageProvider;
  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly provider: LLMProvider;
  private readonly memoryStore: MemoryStore;
  private readonly skillsLoader: SkillsLoader;
  private readonly scheduler: Scheduler;
  private readonly subagentManager: SubagentManager;
  private readonly userStore: UserStore;
  private readonly spaceManager: SpaceManager;
  private readonly mcpManager: McpManager;
  private readonly agentLoop: AgentLoop;
  private readonly channels: Channel[] = [];

  constructor(config: Config) {
    this.config = config;

    // 设置日志级别
    setLogLevel(config.logLevel);

    log.info('初始化 Sophon...');

    // 初始化存储层
    this.storage = createStorageProvider(config);

    // 初始化核心组件（注入 StorageProvider）
    this.messageBus = new MessageBus();
    this.sessionManager = new SessionManager(config.session, this.storage);
    this.toolRegistry = new ToolRegistry();
    this.memoryStore = new MemoryStore(config.memory, this.storage);
    this.skillsLoader = new SkillsLoader(config.skillsDir);
    this.userStore = new UserStore(this.storage);
    this.spaceManager = new SpaceManager(this.storage);
    this.mcpManager = new McpManager(config.mcpServers);

    // 初始化定时任务调度器（使用 StorageProvider）
    this.scheduler = new Scheduler(config.scheduler, this.messageBus, this.storage);
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

    // 注入消息工具依赖
    setMessageToolDeps({
      messageBus: this.messageBus,
      sessionManager: this.sessionManager,
      spaceManager: this.spaceManager,
      userStore: this.userStore,
    });

    // 注入记忆工具依赖
    setMemoryToolDeps(this.memoryStore);

    // 创建 Agent Loop
    this.agentLoop = new AgentLoop({
      messageBus: this.messageBus,
      sessionManager: this.sessionManager,
      toolRegistry: this.toolRegistry,
      provider: this.provider,
      config: config.agent,
      memoryStore: this.memoryStore,
      skillsLoader: this.skillsLoader,
      userStore: this.userStore,
      spaceManager: this.spaceManager,
      mcpManager: this.mcpManager,
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

    // 初始化存储层（建表、连接等）
    await this.storage.init();
    log.info({ type: this.config.storage.type }, '存储层已初始化');

    // 初始化 Session 元数据索引（从存储恢复 userId/channel 映射）
    await this.sessionManager.init();

    // 初始化用户系统
    await this.userStore.init();
    log.info({ userCount: this.userStore.size }, '用户系统已初始化');

    // 初始化 Space 系统
    await this.spaceManager.init();
    log.info({ spaceCount: this.spaceManager.size }, 'Space 系统已初始化');

    // 加载技能
    try {
      const skills = await this.skillsLoader.loadAll();
      log.info({ skillCount: skills.length }, '技能加载完成');
    } catch (err) {
      log.warn({ err }, '技能加载失败，继续启动');
    }

    // 初始化 MCP 连接并注册 MCP 工具
    try {
      await this.mcpManager.init();
      const mcpTools = this.mcpManager.getAllTools();
      if (mcpTools.length > 0) {
        this.toolRegistry.registerAll(mcpTools);
        log.info({ mcpToolCount: mcpTools.length }, 'MCP 工具已注册');
      }
    } catch (err) {
      log.warn({ err }, 'MCP 初始化失败，继续启动');
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

    // 断开 MCP 连接
    await this.mcpManager.shutdown();

    // 停止定时任务调度器
    await this.scheduler.stop();

    // 停止所有通道
    await Promise.allSettled(
      this.channels.map((ch) => ch.stop()),
    );

    // 保存用户数据
    await this.userStore.save();
    log.info('用户数据已保存');

    // 保存 Space 数据
    await this.spaceManager.save();
    log.info('Space 数据已保存');

    // 关闭存储层
    await this.storage.close();
    log.info('存储层已关闭');

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

    // CLI 通道（仅在交互式终端环境下启用，非 TTY 环境如 Railway 自动跳过）
    if (channels.cli.enabled) {
      if (process.stdin.isTTY) {
      this.channels.push(
        new CLIChannel({
          messageBus: this.messageBus,
          prompt: channels.cli.prompt,
        }),
      );
      log.info('CLI 通道已配置');
      } else {
        log.info('stdin 不是 TTY，跳过 CLI 通道（云部署环境）');
      }
    }

    // Web 通道
    if (channels.web.enabled) {
      this.channels.push(
        new WebChannel({
          messageBus: this.messageBus,
          sessionManager: this.sessionManager,
          userStore: this.userStore,
          port: channels.web.port,
          host: channels.web.host,
        }),
      );
      log.info({ port: channels.web.port }, 'Web 通道已配置');
    }

    // Telegram 通道
    if (channels.telegram.enabled) {
      if (!channels.telegram.token) {
        throw new ConfigError('Telegram 通道已启用但未配置 token，请设置 TELEGRAM_BOT_TOKEN 环境变量或在配置文件中添加 channels.telegram.token');
      }
      this.channels.push(
        new TelegramChannel({
          messageBus: this.messageBus,
          sessionManager: this.sessionManager,
          userStore: this.userStore,
          token: channels.telegram.token,
          allowedUsers: channels.telegram.allowedUsers,
        }),
      );
      log.info('Telegram 通道已配置');
    }

    // TODO: 其他通道（Discord 等）

    if (this.channels.length === 0) {
      throw new ConfigError('没有启用任何通道，请至少启用一个通道');
    }
  }
}
