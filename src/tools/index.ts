/**
 * 内置工具集合
 */

import type { Tool } from '../types/tool.js';
import { DateTimeTool } from './datetime-tool.js';
import { ShellTool } from './shell-tool.js';
import { ReadFileTool, WriteFileTool, ListDirTool } from './file-tools.js';
import {
  CreateScheduleTool,
  ListSchedulesTool,
  RemoveScheduleTool,
  ToggleScheduleTool,
} from './schedule-tool.js';
import {
  SpawnTool,
  SubagentStatusTool,
  CancelSubagentTool,
} from './spawn-tool.js';
import { SendMessageTool } from './message-tool.js';
import { WebSearchTool, FetchUrlTool } from './web-tool.js';
import {
  UpdateMemoryTool,
  AppendHistoryTool,
  SearchHistoryTool,
} from './memory-tool.js';

/**
 * 获取所有内置工具
 */
export function getBuiltinTools(): Tool[] {
  return [
    new DateTimeTool(),
    new ShellTool(),
    new ReadFileTool(),
    new WriteFileTool(),
    new ListDirTool(),
    new CreateScheduleTool(),
    new ListSchedulesTool(),
    new RemoveScheduleTool(),
    new ToggleScheduleTool(),
    new SpawnTool(),
    new SubagentStatusTool(),
    new CancelSubagentTool(),
    new SendMessageTool(),
    new WebSearchTool(),
    new FetchUrlTool(),
    new UpdateMemoryTool(),
    new AppendHistoryTool(),
    new SearchHistoryTool(),
  ];
}

export {
  DateTimeTool,
  ShellTool,
  ReadFileTool,
  WriteFileTool,
  ListDirTool,
  CreateScheduleTool,
  ListSchedulesTool,
  RemoveScheduleTool,
  ToggleScheduleTool,
  SpawnTool,
  SubagentStatusTool,
  CancelSubagentTool,
  SendMessageTool,
  WebSearchTool,
  FetchUrlTool,
  UpdateMemoryTool,
  AppendHistoryTool,
  SearchHistoryTool,
};
