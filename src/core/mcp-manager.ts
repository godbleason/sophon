/**
 * MCP (Model Context Protocol) 客户端管理器
 *
 * 连接到配置的 MCP 服务器，拉取工具列表，并将 MCP 工具适配为 Sophon Tool 接口。
 * 支持 stdio、SSE 和 Streamable HTTP 三种传输方式。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConfig, McpServerConfig } from '../types/config.js';
import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('MCPManager');

/** MCP 服务器连接实例 */
interface McpServerConnection {
  /** 服务器名称 */
  name: string;
  /** MCP Client 实例 */
  client: Client;
  /** 传输层实例 */
  transport: Transport;
  /** 从该服务器导出的工具 */
  tools: McpToolAdapter[];
  /** 连接状态 */
  connected: boolean;
}

/**
 * 将 MCP 工具适配为 Sophon Tool 接口
 *
 * MCP 工具的 inputSchema 已经是 JSON Schema 格式，直接映射为 Sophon 的 parameters。
 * 执行时通过 MCP Client 的 callTool 方法调用。
 */
class McpToolAdapter implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParametersSchema;

  private readonly client: Client;
  private readonly serverName: string;

  constructor(
    serverName: string,
    client: Client,
    mcpTool: {
      name: string;
      description?: string;
      inputSchema: {
        type: 'object';
        properties?: Record<string, object>;
        required?: string[];
        [key: string]: unknown;
      };
    },
  ) {
    this.serverName = serverName;
    this.client = client;
    // 工具名称加上服务器名前缀以避免冲突
    this.name = `mcp_${serverName}_${mcpTool.name}`;
    this.description = mcpTool.description || `MCP tool: ${mcpTool.name} (from ${serverName})`;
    this.parameters = this.convertInputSchema(mcpTool.inputSchema);
  }

  /**
   * 将 MCP 的 inputSchema 转换为 Sophon ToolParametersSchema
   */
  private convertInputSchema(inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  }): ToolParametersSchema {
    return {
      type: 'object',
      properties: (inputSchema.properties || {}) as ToolParametersSchema['properties'],
      required: inputSchema.required,
    };
  }

  /**
   * 执行 MCP 工具
   */
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    log.debug(
      { tool: this.name, server: this.serverName, params },
      'Calling MCP tool',
    );

    const result = await this.client.callTool({
      name: this.name.replace(`mcp_${this.serverName}_`, ''),
      arguments: params,
    });

    // MCP 工具返回的是 content 数组，将其拼接为字符串
    if ('content' in result && Array.isArray(result.content)) {
      const textParts: string[] = [];
      for (const item of result.content) {
        if (typeof item === 'object' && item !== null && 'type' in item) {
          if (item.type === 'text' && 'text' in item) {
            textParts.push(String(item.text));
          } else if (item.type === 'image' && 'data' in item) {
            textParts.push(`[Image: ${(item as { mimeType?: string }).mimeType || 'unknown'}]`);
          } else if (item.type === 'resource' && 'resource' in item) {
            const resource = item.resource as { uri: string; text?: string };
            textParts.push(resource.text || `[Resource: ${resource.uri}]`);
          } else {
            textParts.push(JSON.stringify(item));
          }
        }
      }

      const output = textParts.join('\n');
      if (result.isError) {
        throw new Error(`MCP tool error (${this.serverName}/${this.name}): ${output}`);
      }
      return output;
    }

    // 兼容旧格式 toolResult
    if ('toolResult' in result) {
      return typeof result.toolResult === 'string'
        ? result.toolResult
        : JSON.stringify(result.toolResult);
    }

    return JSON.stringify(result);
  }
}

/**
 * MCP 客户端管理器
 *
 * 负责连接到所有配置的 MCP 服务器并管理其生命周期。
 */
export class McpManager {
  private readonly config: McpConfig;
  private readonly connections = new Map<string, McpServerConnection>();

  constructor(config: McpConfig) {
    this.config = config;
  }

  /**
   * 初始化：连接到所有已启用的 MCP 服务器
   */
  async init(): Promise<void> {
    const serverEntries = Object.entries(this.config.servers);
    if (serverEntries.length === 0) {
      log.debug('No MCP servers configured');
      return;
    }

    log.info({ count: serverEntries.length }, 'Connecting to MCP servers...');

    const results = await Promise.allSettled(
      serverEntries.map(([name, serverConfig]) =>
        this.connectServer(name, serverConfig),
      ),
    );

    let successCount = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const [name] = serverEntries[i]!;
      if (result.status === 'fulfilled') {
        successCount++;
      } else {
        log.error(
          { server: name, err: result.reason },
          'Failed to connect MCP server',
        );
      }
    }

    log.info(
      { total: serverEntries.length, connected: successCount },
      'MCP server initialization complete',
    );
  }

  /**
   * 连接到单个 MCP 服务器
   */
  private async connectServer(
    name: string,
    serverConfig: McpServerConfig,
  ): Promise<void> {
    if (!serverConfig.enabled) {
      log.debug({ server: name }, 'MCP server disabled, skipping');
      return;
    }

    log.info(
      { server: name, transport: serverConfig.transport },
      'Connecting to MCP server...',
    );

    // 创建传输层
    const transport = this.createTransport(name, serverConfig);

    // 创建 MCP Client
    const client = new Client(
      { name: 'sophon', version: '0.1.0' },
      { capabilities: {} },
    );

    // 连接
    const connectTimeout = serverConfig.timeout || 30_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Connection timeout after ${connectTimeout}ms`)),
        connectTimeout,
      ),
    );

    await Promise.race([
      client.connect(transport),
      timeoutPromise,
    ]);

    // 获取服务器信息
    const serverVersion = client.getServerVersion();
    const serverCapabilities = client.getServerCapabilities();
    log.info(
      {
        server: name,
        serverName: serverVersion?.name,
        serverVersion: serverVersion?.version,
        capabilities: serverCapabilities
          ? Object.keys(serverCapabilities)
          : [],
      },
      'MCP server connected',
    );

    // 拉取工具列表
    const tools: McpToolAdapter[] = [];
    if (serverCapabilities?.tools) {
      const toolsResult = await client.listTools();
      for (const mcpTool of toolsResult.tools) {
        const adapter = new McpToolAdapter(name, client, mcpTool);
        tools.push(adapter);
        log.debug(
          { server: name, tool: adapter.name, originalName: mcpTool.name },
          'MCP tool registered',
        );
      }
      log.info(
        { server: name, toolCount: tools.length },
        'MCP tools loaded',
      );
    }

    // 保存连接
    const connection: McpServerConnection = {
      name,
      client,
      transport,
      tools,
      connected: true,
    };
    this.connections.set(name, connection);

    // 监听连接关闭
    transport.onclose = () => {
      log.warn({ server: name }, 'MCP server disconnected');
      connection.connected = false;
    };

    transport.onerror = (error) => {
      log.error({ server: name, err: error }, 'MCP server transport error');
    };
  }

  /**
   * 根据配置创建传输层
   */
  private createTransport(
    name: string,
    serverConfig: McpServerConfig,
  ): Transport {
    switch (serverConfig.transport) {
      case 'stdio': {
        if (!serverConfig.command) {
          throw new Error(
            `MCP server "${name}": stdio transport requires "command" field`,
          );
        }

        // 构建环境变量：合并当前进程环境和配置中的自定义环境
        const env: Record<string, string> = {};
        // 从当前进程继承安全的环境变量
        for (const [key, val] of Object.entries(process.env)) {
          if (val !== undefined) {
            env[key] = val;
          }
        }
        // 覆盖用户配置的环境变量
        if (serverConfig.env) {
          Object.assign(env, serverConfig.env);
        }

        return new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env,
          cwd: serverConfig.cwd,
          stderr: 'pipe',
        });
      }

      case 'sse': {
        if (!serverConfig.url) {
          throw new Error(
            `MCP server "${name}": sse transport requires "url" field`,
          );
        }
        const sseUrl = new URL(serverConfig.url);
        return new SSEClientTransport(sseUrl, {
          requestInit: serverConfig.headers
            ? { headers: serverConfig.headers }
            : undefined,
        });
      }

      case 'streamable-http': {
        if (!serverConfig.url) {
          throw new Error(
            `MCP server "${name}": streamable-http transport requires "url" field`,
          );
        }
        const httpUrl = new URL(serverConfig.url);
        return new StreamableHTTPClientTransport(httpUrl, {
          requestInit: serverConfig.headers
            ? { headers: serverConfig.headers }
            : undefined,
        });
      }

      default:
        throw new Error(
          `MCP server "${name}": unknown transport type "${serverConfig.transport}"`,
        );
    }
  }

  /**
   * 获取所有已连接 MCP 服务器的工具列表
   */
  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const connection of this.connections.values()) {
      if (connection.connected) {
        tools.push(...connection.tools);
      }
    }
    return tools;
  }

  /**
   * 获取 MCP 服务器状态摘要
   */
  getStatus(): Array<{
    name: string;
    connected: boolean;
    toolCount: number;
  }> {
    return Array.from(this.connections.values()).map((conn) => ({
      name: conn.name,
      connected: conn.connected,
      toolCount: conn.tools.length,
    }));
  }

  /**
   * 获取所有已连接服务器的总工具数
   */
  get toolCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.connected) {
        count += conn.tools.length;
      }
    }
    return count;
  }

  /**
   * 断开所有 MCP 服务器连接
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down MCP connections...');
    const closePromises: Promise<void>[] = [];

    for (const [name, connection] of this.connections) {
      if (connection.connected) {
        log.debug({ server: name }, 'Closing MCP connection');
        closePromises.push(
          connection.client
            .close()
            .catch((err) =>
              log.warn({ server: name, err }, 'Error closing MCP connection'),
            ),
        );
      }
    }

    await Promise.allSettled(closePromises);
    this.connections.clear();
    log.info('MCP connections closed');
  }
}
