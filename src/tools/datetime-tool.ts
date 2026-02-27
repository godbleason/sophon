/**
 * 日期时间工具
 * 
 * 获取当前日期时间信息。
 */

import type { Tool, ToolParametersSchema, ToolContext } from '../types/tool.js';

export class DateTimeTool implements Tool {
  readonly name = 'get_datetime';
  readonly description = '获取当前日期和时间信息';
  readonly parameters: ToolParametersSchema = {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: '时区名称，如 "Asia/Shanghai"、"America/New_York"。默认使用系统时区。',
      },
      format: {
        type: 'string',
        description: '输出格式: "full" (完整) | "date" (仅日期) | "time" (仅时间)',
        enum: ['full', 'date', 'time'],
        default: 'full',
      },
    },
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<string> {
    const timezone = params['timezone'] as string | undefined;
    const format = (params['format'] as string) || 'full';

    const now = new Date();

    const options: Intl.DateTimeFormatOptions = {
      timeZone: timezone,
    };

    switch (format) {
      case 'date':
        options.year = 'numeric';
        options.month = '2-digit';
        options.day = '2-digit';
        options.weekday = 'long';
        break;
      case 'time':
        options.hour = '2-digit';
        options.minute = '2-digit';
        options.second = '2-digit';
        options.hour12 = false;
        break;
      default: // full
        options.year = 'numeric';
        options.month = '2-digit';
        options.day = '2-digit';
        options.weekday = 'long';
        options.hour = '2-digit';
        options.minute = '2-digit';
        options.second = '2-digit';
        options.hour12 = false;
        break;
    }

    const formatted = new Intl.DateTimeFormat('zh-CN', options).format(now);
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    return JSON.stringify({
      formatted,
      timezone: tz,
      iso: now.toISOString(),
      timestamp: now.getTime(),
    });
  }
}
