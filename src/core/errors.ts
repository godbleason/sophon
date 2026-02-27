/**
 * 错误类型定义
 * 
 * 所有自定义错误都继承自 SophonError 基类。
 * 错误信息必须包含关键上下文参数。
 */

/** 基础错误类 */
export class SophonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SophonError';
  }
}

/** 配置错误 */
export class ConfigError extends SophonError {
  constructor(message: string, context?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, 'CONFIG_ERROR', context, options);
    this.name = 'ConfigError';
  }
}

/** 工具执行错误 */
export class ToolExecutionError extends SophonError {
  constructor(
    public readonly toolName: string,
    public readonly params: Record<string, unknown>,
    cause?: Error,
  ) {
    super(
      `工具执行失败: ${toolName}`,
      'TOOL_EXECUTION_ERROR',
      { toolName, params },
      { cause },
    );
    this.name = 'ToolExecutionError';
  }
}

/** 工具未找到错误 */
export class ToolNotFoundError extends SophonError {
  constructor(toolName: string) {
    super(
      `工具未找到: ${toolName}`,
      'TOOL_NOT_FOUND',
      { toolName },
    );
    this.name = 'ToolNotFoundError';
  }
}

/** LLM 提供商错误 */
export class ProviderError extends SophonError {
  constructor(
    providerName: string,
    message: string,
    context?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(
      `[${providerName}] ${message}`,
      'PROVIDER_ERROR',
      { providerName, ...context },
      options,
    );
    this.name = 'ProviderError';
  }
}

/** 会话错误 */
export class SessionError extends SophonError {
  constructor(
    sessionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `[Session: ${sessionId}] ${message}`,
      'SESSION_ERROR',
      { sessionId },
      options,
    );
    this.name = 'SessionError';
  }
}

/** 通道错误 */
export class ChannelError extends SophonError {
  constructor(
    channelName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(
      `[Channel: ${channelName}] ${message}`,
      'CHANNEL_ERROR',
      { channelName },
      options,
    );
    this.name = 'ChannelError';
  }
}

/** 代理循环错误 */
export class AgentLoopError extends SophonError {
  constructor(
    message: string,
    context?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, 'AGENT_LOOP_ERROR', context, options);
    this.name = 'AgentLoopError';
  }
}
