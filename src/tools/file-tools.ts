/**
 * 文件操作工具集
 * 
 * 提供文件读写能力。
 * 安全限制: 所有操作限制在工作区目录内。
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import { ToolExecutionError } from '../core/errors.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB

/**
 * 验证路径在工作区内
 */
function validatePath(filePath: string, workspaceDir: string): string {
  const absolutePath = resolve(workspaceDir, filePath);
  const rel = relative(workspaceDir, absolutePath);

  if (rel.startsWith('..') || resolve(absolutePath) !== absolutePath.replace(/\/$/, '')) {
    throw new Error(`路径不在工作区内: ${filePath}`);
  }

  return absolutePath;
}

/**
 * 读取文件工具
 */
export class ReadFileTool implements Tool {
  readonly name = 'read_file';
  readonly description = '读取工作区内的文件内容';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作区）',
      },
    },
    required: ['path'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const filePath = params['path'] as string;
    if (!filePath) {
      throw new ToolExecutionError(this.name, params, new Error('文件路径不能为空'));
    }

    const absolutePath = validatePath(filePath, context.workspaceDir);

    if (!existsSync(absolutePath)) {
      return `文件不存在: ${filePath}`;
    }

    const stats = await stat(absolutePath);
    if (stats.size > MAX_FILE_SIZE) {
      return `文件过大 (${(stats.size / 1024).toFixed(1)}KB)，超过限制 (${MAX_FILE_SIZE / 1024}KB)`;
    }

    const content = await readFile(absolutePath, 'utf-8');
    return content;
  }
}

/**
 * 写入文件工具
 */
export class WriteFileTool implements Tool {
  readonly name = 'write_file';
  readonly description = '写入内容到工作区内的文件（会覆盖已有内容）';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '文件路径（相对于工作区）',
      },
      content: {
        type: 'string',
        description: '要写入的内容',
      },
    },
    required: ['path', 'content'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const filePath = params['path'] as string;
    const content = params['content'] as string;

    if (!filePath) {
      throw new ToolExecutionError(this.name, params, new Error('文件路径不能为空'));
    }

    const absolutePath = validatePath(filePath, context.workspaceDir);
    await writeFile(absolutePath, content, 'utf-8');

    return `文件已写入: ${filePath} (${content.length} 字符)`;
  }
}

/**
 * 列出目录工具
 */
export class ListDirTool implements Tool {
  readonly name = 'list_dir';
  readonly description = '列出工作区内指定目录的文件和子目录';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '目录路径（相对于工作区），默认为根目录',
      },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const dirPath = (params['path'] as string) || '.';
    const absolutePath = validatePath(dirPath, context.workspaceDir);

    if (!existsSync(absolutePath)) {
      return `目录不存在: ${dirPath}`;
    }

    const entries = await readdir(absolutePath, { withFileTypes: true });
    const items = entries.map((entry) => {
      const prefix = entry.isDirectory() ? '📁 ' : '📄 ';
      return prefix + entry.name;
    });

    if (items.length === 0) {
      return `目录为空: ${dirPath}`;
    }

    return `📂 ${dirPath}/\n${items.map((item) => join('  ', item)).join('\n')}`;
  }
}
