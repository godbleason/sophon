/**
 * Web 通道
 * 
 * 提供基于网页的聊天交互界面。
 * - HTTP 服务器: 托管聊天 UI 页面
 * - WebSocket 服务器: 实时消息通信
 * - 身份持久化: 前端通过 localStorage 持久化 clientId，
 *   后端基于 clientId 恢复 session 和对话历史
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ChannelName, OutboundMessage, ProgressMessage } from '../types/message.js';
import type { MessageBus } from '../core/message-bus.js';
import type { SessionManager } from '../core/session-manager.js';
import type { Channel } from './base-channel.js';
import { createChildLogger } from '../core/logger.js';
import { getChatPageHTML } from './web-chat-ui.js';

const log = createChildLogger('WebChannel');

/** Web 通道配置 */
interface WebChannelConfig {
  messageBus: MessageBus;
  sessionManager: SessionManager;
  port?: number;
  host?: string;
}

/** WebSocket 客户端连接信息 */
interface ClientConnection {
  ws: WebSocket;
  /** 客户端持久化标识（来自 localStorage） */
  clientId: string;
  /** 基于 clientId 的稳定 sessionId */
  sessionId: string;
  connectedAt: number;
  /** 是否已完成身份识别 */
  identified: boolean;
}

/**
 * Web 通道实现
 * 
 * 连接流程：
 * 1. 客户端建立 WebSocket 连接
 * 2. 客户端发送 { type: 'identify', clientId: '<持久化ID>' }
 * 3. 服务端基于 clientId 恢复或创建 session
 * 4. 服务端返回 { type: 'connected', history: [...] }
 * 5. 后续正常收发消息
 */
export class WebChannel implements Channel {
  readonly name: ChannelName = 'web';

  private readonly messageBus: MessageBus;
  private readonly sessionManager: SessionManager;
  private readonly port: number;
  private readonly host: string;
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  /** 所有活跃连接，key = 内部连接 ID（随机） */
  private readonly clients = new Map<string, ClientConnection>();

  constructor(config: WebChannelConfig) {
    this.messageBus = config.messageBus;
    this.sessionManager = config.sessionManager;
    this.port = config.port || 3000;
    this.host = config.host || 'localhost';
  }

  async start(): Promise<void> {
    // 注册出站消息处理器
    this.messageBus.registerOutboundHandler('web', this.handleOutbound.bind(this));

    // 注册进度消息处理器
    this.messageBus.registerProgressHandler('web', this.handleProgress.bind(this));

    // 创建 HTTP 服务器
    this.httpServer = createServer(this.handleHttpRequest.bind(this));

    // 创建 WebSocket 服务器
    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on('connection', this.handleWsConnection.bind(this));

    // 启动监听
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, this.host, () => {
        log.info({ port: this.port, host: this.host }, 'Web 通道已启动');
        console.log(`\n🌐 Web 界面: http://${this.host}:${this.port}\n`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // 关闭所有 WebSocket 连接
    for (const [id, client] of this.clients) {
      client.ws.close(1000, '服务器关闭');
      this.clients.delete(id);
    }

    // 关闭 WebSocket 服务器
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }

    // 关闭 HTTP 服务器
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.messageBus.removeOutboundHandler('web');
    this.messageBus.removeProgressHandler('web');
    log.info('Web 通道已停止');
  }

  /**
   * 处理 HTTP 请求
   */
  private handleHttpRequest(_req: IncomingMessage, res: ServerResponse): void {
    // 返回聊天页面
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(getChatPageHTML());
  }

  /**
   * 处理 WebSocket 连接
   * 
   * 连接建立后不立即创建 session，而是等待客户端发送 identify 消息。
   * 这确保同一设备（同一 clientId）始终映射到同一 session。
   */
  private handleWsConnection(ws: WebSocket): void {
    const connId = randomUUID();

    const client: ClientConnection = {
      ws,
      clientId: '', // 等待 identify
      sessionId: '', // 等待 identify
      connectedAt: Date.now(),
      identified: false,
    };

    this.clients.set(connId, client);
    log.debug({ connId }, 'WebSocket 连接已建立，等待身份识别');

    // 设置身份识别超时（10 秒内必须发送 identify）
    const identifyTimeout = setTimeout(() => {
      if (!client.identified) {
        log.warn({ connId }, '客户端未在超时时间内发送身份识别，断开连接');
        ws.close(4001, '未发送身份识别');
        this.clients.delete(connId);
      }
    }, 10_000);

    // 处理消息
    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as {
          type: string;
          text?: string;
          clientId?: string;
        };

        // 身份识别消息
        if (parsed.type === 'identify') {
          clearTimeout(identifyTimeout);
          this.handleIdentify(connId, client, parsed.clientId);
          return;
        }

        // 普通消息 —— 必须已完成身份识别
        if (!client.identified) {
          log.warn({ connId }, '收到消息但客户端尚未完成身份识别，忽略');
          return;
        }

        if (parsed.type === 'message' && parsed.text) {
          const text = parsed.text.trim();
          if (!text) return;

          log.debug({ clientId: client.clientId, text: text.substring(0, 100) }, '收到消息');

          // 发布入站消息
          this.messageBus.publishInbound({
            id: randomUUID(),
            channel: 'web',
            sessionId: client.sessionId,
            text,
            sender: client.clientId,
            timestamp: Date.now(),
            metadata: {
              displayName: `Web User (${client.sessionId})`,
            },
          });
        }
      } catch (err) {
        log.warn({ err, connId }, '解析客户端消息失败');
      }
    });

    ws.on('close', () => {
      clearTimeout(identifyTimeout);
      this.clients.delete(connId);
      if (client.identified && client.sessionId) {
      // 取消该会话正在执行的代理循环，避免资源浪费
        this.messageBus.cancelSession(client.sessionId);
        log.info({ clientId: client.clientId, sessionId: client.sessionId }, '客户端已断开，会话已取消');
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(identifyTimeout);
      log.error({ err, connId }, 'WebSocket 错误');
      this.clients.delete(connId);
      if (client.identified && client.sessionId) {
        this.messageBus.cancelSession(client.sessionId);
      }
    });
  }

  /**
   * 处理客户端身份识别
   * 
   * 基于客户端持久化的 clientId 生成稳定的 sessionId，
   * 从而在页面刷新或重连时恢复同一 session 及其对话历史。
   */
  private async handleIdentify(
    connId: string,
    client: ClientConnection,
    clientId: string | undefined,
  ): Promise<void> {
    if (!clientId || typeof clientId !== 'string' || clientId.trim().length === 0) {
      log.warn({ connId }, '收到无效的 identify 消息，缺少 clientId');
      client.ws.close(4002, '无效的 clientId');
      this.clients.delete(connId);
      return;
    }

    // 使用 clientId 前 8 位生成稳定的 sessionId
    const sessionId = `web-${clientId.substring(0, 8)}`;
    client.clientId = clientId;
    client.sessionId = sessionId;
    client.identified = true;

    log.info({ connId, clientId, sessionId }, '客户端身份识别完成');

    // 如果同一 clientId 有旧连接，关闭旧连接（同一设备只允许一个活跃连接）
    for (const [existingConnId, existingClient] of this.clients) {
      if (existingConnId !== connId && existingClient.clientId === clientId) {
        log.info({ existingConnId, clientId }, '关闭同一客户端的旧连接');
        existingClient.ws.close(4003, '同一客户端的新连接已建立');
        this.clients.delete(existingConnId);
      }
    }

    // 确保 session 已创建（如果已存在则从磁盘恢复）
    await this.sessionManager.getOrCreate(sessionId, 'web');

    // 获取历史对话消息用于前端恢复
    const history = this.buildClientHistory(sessionId);

    // 发送身份确认和历史消息
    this.sendToClient(client.ws, {
      type: 'connected',
      sessionId,
      message: '已连接到 Sophon AI 助手',
      history,
    });
  }

  /**
   * 构建前端可显示的历史消息列表
   * 
   * 只提取 user 和 assistant 角色的消息，跳过 system/tool 等内部消息。
   * 限制最多返回最近 50 条，避免前端一次性渲染过多。
   */
  private buildClientHistory(sessionId: string): Array<{ role: string; content: string }> {
    const messages = this.sessionManager.getFullHistory(sessionId);
    if (messages.length === 0) return [];

    const displayMessages: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        // 跳过内容为空的消息（比如只有 tool_calls 的 assistant 消息）
        if (typeof msg.content === 'string' && msg.content.trim().length > 0) {
          displayMessages.push({
            role: msg.role,
            content: msg.content,
          });
        }
      }
    }

    // 最多返回最近 50 条
    const MAX_HISTORY = 50;
    if (displayMessages.length > MAX_HISTORY) {
      return displayMessages.slice(-MAX_HISTORY);
    }

    return displayMessages;
  }

  /**
   * 处理出站消息（推送 AI 回复到对应的客户端）
   */
  private async handleOutbound(message: OutboundMessage): Promise<void> {
    const { sessionId, text } = message;

    // 找到对应 session 的客户端
    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId && client.identified) {
        this.sendToClient(client.ws, {
          type: 'response',
          text,
          timestamp: message.timestamp,
        });
        return;
      }
    }

    log.warn({ sessionId }, '未找到对应的客户端连接');
  }

  /**
   * 处理进度消息（推送 Agent 每一步过程到前端）
   */
  private handleProgress(message: ProgressMessage): void {
    const { sessionId } = message;

    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId && client.identified) {
        this.sendToClient(client.ws, {
          type: 'progress',
          step: message.step,
          iteration: message.iteration,
          toolName: message.toolName,
          toolArgs: message.toolArgs,
          toolCallId: message.toolCallId,
          content: message.content,
          isError: message.isError,
          timestamp: message.timestamp,
        });
        return;
      }
    }
  }

  /**
   * 向客户端发送 JSON 消息
   */
  private sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
