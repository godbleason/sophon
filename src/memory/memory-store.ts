/**
 * 记忆系统
 * 
 * 两层记忆架构:
 * - MEMORY.md: 长期事实记忆（AI 总结的用户偏好、关键信息等）
 * - HISTORY.md: 可搜索的历史日志（对话摘要时间线）
 * 
 * 记忆文件使用 Markdown 格式，人类可读。
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { MemoryConfig } from '../types/config.js';
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
  private readonly memoryFilePath: string;
  private readonly historyFilePath: string;
  private readonly enabled: boolean;

  constructor(config: MemoryConfig) {
    this.enabled = config.enabled;
    this.memoryFilePath = join(config.storageDir, 'MEMORY.md');
    this.historyFilePath = join(config.storageDir, 'HISTORY.md');
  }

  /**
   * 获取长期记忆内容
   */
  async getMemory(): Promise<string> {
    if (!this.enabled) return '';

    if (!existsSync(this.memoryFilePath)) {
      return '';
    }

    try {
      return await readFile(this.memoryFilePath, 'utf-8');
    } catch (err) {
      log.error({ err }, '读取记忆文件失败');
      throw err;
    }
  }

  /**
   * 更新长期记忆（覆盖写入）
   */
  async updateMemory(content: string): Promise<void> {
    if (!this.enabled) return;

    await this.ensureDir(this.memoryFilePath);

    const header = `# Sophon Memory\n\n> 最后更新: ${new Date().toISOString()}\n\n`;
    await writeFile(this.memoryFilePath, header + content, 'utf-8');
    log.info('长期记忆已更新');
  }

  /**
   * 获取历史日志
   */
  async getHistory(): Promise<string> {
    if (!this.enabled) return '';

    if (!existsSync(this.historyFilePath)) {
      return '';
    }

    try {
      return await readFile(this.historyFilePath, 'utf-8');
    } catch (err) {
      log.error({ err }, '读取历史文件失败');
      throw err;
    }
  }

  /**
   * 追加历史记录
   */
  async appendHistory(entry: MemoryEntry): Promise<void> {
    if (!this.enabled) return;

    await this.ensureDir(this.historyFilePath);

    const dateStr = new Date(entry.timestamp).toISOString().split('T')[0];
    const timeStr = new Date(entry.timestamp).toISOString().split('T')[1]?.replace('Z', '');
    const source = entry.source ? ` [${entry.source}]` : '';
    const line = `- **${dateStr} ${timeStr}**${source}: ${entry.content}\n`;

    // 如果文件不存在，先写入头部
    if (!existsSync(this.historyFilePath)) {
      await writeFile(
        this.historyFilePath,
        `# Sophon History Log\n\n`,
        'utf-8',
      );
    }

    await appendFile(this.historyFilePath, line, 'utf-8');
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

  /** 确保目录存在 */
  private async ensureDir(filePath: string): Promise<void> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }
}
