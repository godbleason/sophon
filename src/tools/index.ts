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
};
