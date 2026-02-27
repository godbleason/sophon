#!/usr/bin/env node

/**
 * Sophon - 轻量级个人 AI 助手框架
 * 
 * 入口文件：解析 CLI 参数并启动应用。
 */

import { Command } from 'commander';
import { loadConfig } from './config/config-manager.js';
import { SophonApp } from './core/app.js';
import { logger } from './core/logger.js';

const program = new Command();

program
  .name('sophon')
  .description('轻量级个人 AI 助手框架')
  .version('0.1.0');

program
  .command('start', { isDefault: true })
  .description('启动 Sophon 助手')
  .option('-c, --config <path>', '配置文件路径')
  .option('-m, --model <model>', '指定 LLM 模型')
  .option('-v, --verbose', '详细日志输出')
  .action(async (options: { config?: string; model?: string; verbose?: boolean }) => {
    try {
      // 设置环境变量覆盖
      if (options.model) {
        process.env['SOPHON_MODEL'] = options.model;
      }
      if (options.verbose) {
        process.env['SOPHON_LOG_LEVEL'] = 'debug';
      }

      // 加载配置
      const config = await loadConfig(options.config);

      // 创建并启动应用
      const app = new SophonApp(config);

      // 优雅关闭
      const shutdown = async (): Promise<void> => {
        logger.info('收到关闭信号...');
        await app.stop();
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());

      await app.start();
    } catch (err) {
      logger.fatal({ err }, '启动失败');
      process.exit(1);
    }
  });

program
  .command('config')
  .description('验证并显示当前配置')
  .option('-c, --config <path>', '配置文件路径')
  .action(async (options: { config?: string }) => {
    try {
      const config = await loadConfig(options.config);
      console.log(JSON.stringify(config, null, 2));
    } catch (err) {
      logger.error({ err }, '配置验证失败');
      process.exit(1);
    }
  });

program.parse();
