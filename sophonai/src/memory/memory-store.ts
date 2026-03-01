/**
 * 记忆系统
 * 
 * 两层记忆架构:
 * - Memory: 长期事实记忆（AI 总结的用户偏好、关键信息等）
 * - History: 可搜索的历史日志（对话摘要时间线）
 * 
 * 持久化委托给 StorageProvider，本模块只管记忆业务逻辑。
 */

import type { MemoryConfig } from '../types/config.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('MemoryStore');

/** 记忆条目 */
export interface MemoryEntry {
  timestamp: number;
  content: string;
  source?: string;
}

/**
 * 记忆存储
 */
export class MemoryStore {
  private readonly enabled: boolean;

  constructor(
    config: MemoryConfig,
    private readonly storage: StorageProvider,
  ) {
    this.enabled = config.enabled;
  }

  /**
   * 获取长期记忆内容
   */
  async getMemory(): Promise<string> {
    if (!this.enabled) return '';

    try {
      return await this.storage.loadMemoryContent();
    } catch (err) {
      log.error({ err }, '读取记忆失败');
      throw err;
    }
  }

  /**
   * 更新长期记忆（覆盖写入）
   */
  async updateMemory(content: string): Promise<void> {
    if (!this.enabled) return;

    const header = `# Sophon Memory\n\n> 最后更新: ${new Date().toISOString()}\n\n`;
    await this.storage.saveMemoryContent(header + content);
    log.info('长期记忆已更新');
  }

  /**
   * 获取历史日志
   */
  async getHistory(): Promise<string> {
    if (!this.enabled) return '';

    try {
      return await this.storage.loadHistoryContent();
    } catch (err) {
      log.error({ err }, '读取历史失败');
      throw err;
    }
  }

  /**
   * 追加历史记录
   */
  async appendHistory(entry: MemoryEntry): Promise<void> {
    if (!this.enabled) return;

    const dateStr = new Date(entry.timestamp).toISOString().split('T')[0];
    const timeStr = new Date(entry.timestamp).toISOString().split('T')[1]?.replace('Z', '');
    const source = entry.source ? ` [${entry.source}]` : '';
    const line = `- **${dateStr} ${timeStr}**${source}: ${entry.content}\n`;

    // 如果历史为空，先写入头部
    const existing = await this.storage.loadHistoryContent();
    if (!existing) {
      const header = `# Sophon History Log\n\n`;
      await this.storage.appendHistoryContent(header);
    }

    await this.storage.appendHistoryContent(line);
    log.debug({ entry: entry.content.substring(0, 50) }, '历史记录已追加');
  }

  /**
   * 获取用于注入系统提示的记忆上下文
   */
  async getContextForPrompt(): Promise<string> {
    if (!this.enabled) return '';

    const memory = await this.getMemory();
    if (!memory.trim()) return '';

    return `\n\n<memory>\n${memory}\n</memory>`;
  }

  /**
   * 搜索历史记录（简单的文本搜索）
   */
  async searchHistory(query: string): Promise<string[]> {
    if (!this.enabled) return [];

    const history = await this.getHistory();
    if (!history) return [];

    const lines = history.split('\n').filter((line) => line.startsWith('- **'));
    const queryLower = query.toLowerCase();

    return lines.filter((line) => line.toLowerCase().includes(queryLower));
  }
}
