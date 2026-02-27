/**
 * 工具系统类型定义
 */

/** JSON Schema 属性定义 */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** 工具参数的 JSON Schema */
export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** 工具定义（OpenAI 兼容格式） */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParametersSchema;
  };
}

/** 工具执行上下文 */
export interface ToolContext {
  sessionId: string;
  workspaceDir: string;
}

/** 工具接口 */
export interface Tool {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 JSON Schema */
  parameters: ToolParametersSchema;
  /** 执行工具 */
  execute(params: Record<string, unknown>, context: ToolContext): Promise<string>;
}
