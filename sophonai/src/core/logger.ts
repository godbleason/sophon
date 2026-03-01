/**
 * 结构化日志系统
 * 
 * 使用 pino 提供 JSON 格式的结构化日志。
 */

import pino from 'pino';

/** 创建全局 logger 实例 */
function createLogger(level: string = 'info'): pino.Logger {
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  });
}

/** 全局 logger */
let logger = createLogger();

/** 更新日志级别 */
export function setLogLevel(level: string): void {
  logger = createLogger(level);
}

/** 获取 logger 实例 */
export function getLogger(): pino.Logger {
  return logger;
}

/** 创建子 logger（带模块标签） */
export function createChildLogger(module: string): pino.Logger {
  return logger.child({ module });
}

export { logger };
