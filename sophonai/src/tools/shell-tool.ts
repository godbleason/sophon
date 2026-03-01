/**
 * Shell 命令工具
 * 
 * 在工作区目录中执行 shell 命令。
 * 安全限制: 只允许在工作区内执行。
 */

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';
import { ToolExecutionError } from '../core/errors.js';

const MAX_OUTPUT_LENGTH = 10000;
const DEFAULT_TIMEOUT = 30000; // 30 秒

export class ShellTool implements Tool {
  readonly name = 'run_shell';
  readonly description = '在工作区中执行 shell 命令。返回命令的标准输出和标准错误。';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      timeout: {
        type: 'number',
        description: '超时时间（毫秒），默认 30000',
      },
    },
    required: ['command'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<string> {
    const command = params['command'] as string;
    const timeout = (params['timeout'] as number) || DEFAULT_TIMEOUT;

    if (!command || command.trim().length === 0) {
      throw new ToolExecutionError(this.name, params, new Error('命令不能为空'));
    }

    const cwd = resolve(context.workspaceDir);

    return new Promise<string>((resolvePromise, reject) => {
      execFile(
        '/bin/sh',
        ['-c', command],
        {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024, // 1MB
          env: { ...process.env, PATH: process.env['PATH'] },
        },
        (error, stdout, stderr) => {
          let output = '';

          if (stdout) {
            output += stdout;
          }
          if (stderr) {
            output += (output ? '\n--- stderr ---\n' : '') + stderr;
          }

          // 截断过长输出
          if (output.length > MAX_OUTPUT_LENGTH) {
            output = output.substring(0, MAX_OUTPUT_LENGTH) + '\n... (输出已截断)';
          }

          if (error) {
            // 命令执行出错但有输出，返回输出和错误信息
            if (output) {
              resolvePromise(`[Exit code: ${error.code ?? 'unknown'}]\n${output}`);
            } else {
              reject(
                new ToolExecutionError(this.name, params, error),
              );
            }
            return;
          }

          resolvePromise(output || '(无输出)');
        },
      );
    });
  }
}
