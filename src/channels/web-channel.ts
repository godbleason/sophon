/**
 * Web 通道
 * 
 * 提供基于网页的聊天交互界面。
 * - HTTP 服务器: 托管聊天 UI 页面
 * - WebSocket 服务器: 实时消息通信
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ChannelName, OutboundMessage } from '../types/message.js';
import type { MessageBus } from '../core/message-bus.js';
import type { Channel } from './base-channel.js';
import { createChildLogger } from '../core/logger.js';
import { getChatPageHTML } from './web-chat-ui.js';

const log = createChildLogger('WebChannel');

/** Web 通道配置 */
interface WebChannelConfig {
  messageBus: MessageBus;
  port?: number;
  host?: string;
}

/** WebSocket 客户端连接信息 */
interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
  connectedAt: number;
}

/**
 * Web 通道实现
 */
export class WebChannel implements Channel {
  readonly name: ChannelName = 'web';

  private readonly messageBus: MessageBus;
  private readonly port: number;
  private readonly host: string;
  private httpServer: Server | null = null;
  private wsServer: WebSocketServer | null = null;
  private readonly clients = new Map<string, ClientConnection>();

  constructor(config: WebChannelConfig) {
    this.messageBus = config.messageBus;
    this.port = config.port || 3000;
    this.host = config.host || 'localhost';
  }

  async start(): Promise<void> {
    // 注册出站消息处理器
    this.messageBus.registerOutboundHandler('web', this.handleOutbound.bind(this));

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
   */
  private handleWsConnection(ws: WebSocket): void {
    const clientId = randomUUID();
    const sessionId = `web-${clientId.substring(0, 8)}`;

    const client: ClientConnection = {
      ws,
      sessionId,
      connectedAt: Date.now(),
    };

    this.clients.set(clientId, client);
    log.info({ clientId, sessionId }, '客户端已连接');

    // 发送欢迎消息
    this.sendToClient(ws, {
      type: 'connected',
      sessionId,
      message: '已连接到 Sophon AI 助手',
    });

    // 处理消息
    ws.on('message', (data: Buffer) => {
      try {
        const parsed = JSON.parse(data.toString()) as { type: string; text?: string };

        if (parsed.type === 'message' && parsed.text) {
          const text = parsed.text.trim();
          if (!text) return;

          log.debug({ clientId, text: text.substring(0, 100) }, '收到消息');

          // 发布入站消息
          this.messageBus.publishInbound({
            id: randomUUID(),
            channel: 'web',
            sessionId,
            text,
            sender: clientId,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        log.warn({ err, clientId }, '解析客户端消息失败');
      }
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      log.info({ clientId }, '客户端已断开');
    });

    ws.on('error', (err: Error) => {
      log.error({ err, clientId }, 'WebSocket 错误');
      this.clients.delete(clientId);
    });
  }

  /**
   * 处理出站消息（推送 AI 回复到对应的客户端）
   */
  private async handleOutbound(message: OutboundMessage): Promise<void> {
    const { sessionId, text } = message;

    // 找到对应 session 的客户端
    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId) {
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
   * 向客户端发送 JSON 消息
   */
  private sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}
