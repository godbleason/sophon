/**
 * Web 聊天 UI
 * 
 * 从同目录的 web-chat-ui.html 读取聊天界面 HTML。
 * 启动时一次性读取并缓存到内存中。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 缓存的 HTML 内容（进程生命周期内只读一次） */
const chatPageHTML = readFileSync(
  resolve(__dirname, 'web-chat-ui.html'),
  'utf-8',
);

export function getChatPageHTML(): string {
  return chatPageHTML;
}
