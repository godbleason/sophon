# TypeScript AI 助手框架架构设计指南

## 项目概述

这是一个用于指导构建轻量级个人 AI 助手框架的架构设计指南。框架采用 TypeScript 实现，充分利用类型安全和现代 JavaScript 生态系统的优势。核心设计理念是保持代码精简、模块清晰、易于扩展。

## 核心架构原则

### 1. 保持轻量级
- 避免过度抽象和设计模式
- 优先使用标准库和成熟的小型依赖

### 2. 类型安全优先
- 充分利用 TypeScript 的类型系统
- 使用严格的类型检查（`strict: true`）
- 定义清晰的接口和类型定义
- 避免使用 `any`，必要时使用 `unknown`

### 3. 异步优先
- 全面使用 async/await
- 使用 Promise 和 async 迭代器
- 避免回调地狱

### 4. 模块化设计
- 每个模块职责单一
- 清晰的模块边界
- 最小化模块间耦合

### 5. 错误处理
- 快速失败原则（Fail-Fast）
- 明确的错误类型
- 不静默失败
- 错误信息包含上下文

## 架构分层

框架采用分层架构，主要分为以下几个层次：

1. **接入层**: 负责与外部平台（聊天应用、CLI等）的交互
2. **通信层**: 消息路由和队列管理，解耦各组件
3. **处理层**: 核心 AI 代理逻辑，包括 LLM 调用和工具执行
4. **存储层**: 会话、记忆、配置等数据的持久化
5. **扩展层**: 工具、技能、插件等可扩展功能

各层之间通过清晰的接口通信，保持低耦合高内聚。

## 核心设计思想

### 1. 代理循环（Agent Loop）

**核心职责**:
- 从 MessageBus 消费消息
- 构建上下文（历史、记忆、技能）
- 调用 LLM
- 执行工具调用
- 管理迭代循环

**关键设计要点**:
- 使用 async 迭代器处理消息流
- 工具调用结果通过消息历史传递
- 支持进度回调（streaming）
- 支持任务取消（通过 `/stop` 命令）

### 2. 消息总线（Message Bus）

**设计思想**:
- 解耦通道和代理
- 异步消息队列
- 消息路由

**关键设计要点**:
- 使用 `AsyncQueue` 或类似实现
- 支持背压（backpressure）
- 消息序列化/反序列化

### 3. LLM 提供商抽象（Provider Abstraction）

**设计思想**:
- 统一的 LLM 调用接口
- 工具调用支持
- 响应解析

**关键设计要点**:
- 抽象基类，各提供商实现具体逻辑
- 使用 LiteLLM 或直接调用 API
- 统一的错误处理
- 支持流式响应（可选）

### 4. 工具系统（Tool System）

**设计思想**:
- 工具注册和管理
- 工具定义生成（OpenAI 格式）
- 工具执行和参数验证

**关键设计要点**:
- 使用 JSON Schema 验证参数
- 工具执行错误返回给 LLM
- 支持动态注册（如 MCP 工具）

### 5. 多通道支持（Multi-Channel Support）

**设计思想**:
- 管理所有通道
- 消息路由
- 通道生命周期管理

**关键设计要点**:
- 每个通道独立实现
- 支持 WebSocket、HTTP、轮询等多种连接方式
- 统一的错误处理和重连逻辑

### 6. 会话管理（Session Management）

**设计思想**:
- 会话持久化
- 会话历史管理
- 会话隔离

**关键设计要点**:
- 使用 JSONL 格式存储（便于追加）
- 内存缓存 + 文件持久化
- 支持会话迁移

### 7. 记忆系统（Memory System）

**设计思想**:
- 两层记忆系统（MEMORY.md + HISTORY.md）
- 记忆整合
- 记忆检索

**关键设计要点**:
- MEMORY.md: 长期事实
- HISTORY.md: 可搜索的历史日志
- 使用 LLM 进行记忆整合

### 8. 技能系统（Skills System）

**设计思想**:
- 加载技能文件（Markdown）
- 技能元数据解析
- 依赖检查

**关键设计要点**:
- 支持 YAML frontmatter
- 依赖检查（CLI 工具、环境变量）
- 按需加载 vs 总是加载

## TypeScript 特定设计

### 1. 类型定义

**使用严格类型**:
```typescript
// 避免 any
type ConfigValue = string | number | boolean | ConfigObject | ConfigArray;
type ConfigObject = Record<string, ConfigValue>;
type ConfigArray = ConfigValue[];

// 使用联合类型
type ChannelName = 'telegram' | 'discord' | 'whatsapp' | 'cli' | ...;
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// 使用泛型
interface Tool<TParams = Record<string, unknown>> {
  execute(params: TParams): Promise<string>;
}
```

### 2. 接口 vs 类型别名

- **接口**: 用于可扩展的对象形状（如 `LLMProvider`, `Tool`）
- **类型别名**: 用于联合类型、元组、工具类型

### 3. 错误处理

```typescript
// 定义明确的错误类型
class ToolExecutionError extends Error {
  constructor(
    public toolName: string,
    public params: Record<string, unknown>,
    cause?: Error
  ) {
    super(`Tool execution failed: ${toolName}`);
    this.name = 'ToolExecutionError';
  }
}

// 使用 Result 类型（可选）
type Result<T, E = Error> = 
  | { success: true; value: T }
  | { success: false; error: E };
```

### 4. 异步处理

```typescript
// 使用 async 迭代器
async function* messageStream(bus: MessageBus): AsyncGenerator<InboundMessage> {
  while (true) {
    yield await bus.consumeInbound();
  }
}

// 使用 Promise.allSettled 处理并发
const results = await Promise.allSettled([
  channel1.start(),
  channel2.start(),
  channel3.start(),
]);
```

### 5. 配置管理

```typescript
// 使用 Zod 或类似库进行运行时验证
import { z } from 'zod';

const ConfigSchema = z.object({
  providers: z.record(z.object({
    apiKey: z.string().optional(),
    apiBase: z.string().url().optional(),
  })),
  agents: z.object({
    defaults: z.object({
      model: z.string(),
      temperature: z.number().min(0).max(2),
    }),
  }),
  // ...
});

type Config = z.infer<typeof ConfigSchema>;
```

## 依赖选择建议

### 核心依赖
- **运行时**: Node.js 18+ (ESM 支持)
- **HTTP 客户端**: `undici` 或 `node-fetch`
- **WebSocket**: `ws` (服务器) 或 `@cloudflare/workers-types` (Cloudflare Workers)
- **配置验证**: `zod` 或 `ajv`
- **日志**: `pino` 或 `winston`
- **CLI**: `commander` 或 `yargs`

### 可选依赖
- **LLM SDK**: 直接使用 HTTP 客户端或 `@anthropic-ai/sdk` 等
- **文件系统**: Node.js `fs/promises`
- **定时任务**: `node-cron` 或 `croner`
- **Markdown 解析**: `marked` 或 `remark`

### 避免的依赖
- 避免过度抽象的工具库
- 避免重复功能的依赖

## 实现优先级

### Phase 1: 核心功能
1. ✅ Message Bus
2. ✅ Agent Loop（基础版本）
3. ✅ Tool Registry（基础工具）
4. ✅ LLM Provider（至少一个提供商）
5. ✅ Session Manager
6. ✅ CLI 接口

### Phase 2: 通道支持
1. ✅ CLI 通道
2. ✅ Telegram
3. ✅ Discord
4. ✅ 其他通道（按需）

### Phase 3: 高级功能
1. ✅ Memory Store
2. ✅ Skills Loader
3. ✅ Cron Service
4. ✅ Heartbeat Service
5. ✅ MCP 支持

### Phase 4: 优化和扩展
1. ✅ 性能优化
2. ✅ 错误处理改进
3. ✅ 测试覆盖
4. ✅ 文档完善

## 关键设计决策

### 1. ESM vs CommonJS
- **推荐**: 使用 ESM（ES Modules）
- **原因**: 现代标准，更好的 tree-shaking，与浏览器兼容

### 2. 单文件 vs 多文件
- **推荐**: 每个类/接口一个文件
- **原因**: 更好的可维护性和类型检查

### 3. 错误处理策略
- **推荐**: 抛出异常，不返回错误码
- **原因**: TypeScript 的类型系统支持异常流控制

### 4. 配置管理
- **推荐**: 使用 JSON + Zod 验证
- **原因**: 简单、类型安全、易于调试

### 5. 日志策略
- **推荐**: 结构化日志（JSON）
- **原因**: 便于分析和调试

## 测试策略

### 单元测试
- 使用 `vitest` 或 `jest`
- 每个模块独立测试
- Mock 外部依赖（LLM API、文件系统等）

### 集成测试
- 测试模块间交互
- 使用真实的消息流
- 测试错误场景

### E2E 测试
- 测试完整的用户流程
- 使用测试 LLM（如 mock API）
- 验证工具执行结果

## 性能考虑

### 1. 异步处理
- 所有 I/O 操作异步
- 使用流式处理大文件
- 并发处理多个通道

### 2. 内存管理
- 会话历史限制（memory_window）
- 工具结果截断
- 及时清理不需要的数据

### 3. 缓存策略
- 会话内存缓存
- 技能内容缓存
- 配置缓存

## 安全考虑

### 1. 工作区限制
- 文件操作限制在工作区
- Shell 命令限制在工作区
- 路径验证和规范化

### 2. 输入验证
- 所有用户输入验证
- 工具参数验证（JSON Schema）
- 配置验证

### 3. 敏感信息
- API 密钥不记录日志
- 配置文件权限控制
- 环境变量优先

## 技术选型建议

### 语言特性对比

1. **类型系统**: 充分利用 TypeScript 的静态类型，避免运行时类型错误
2. **异步模型**: 使用 async/await，比回调更清晰
3. **文件操作**: Node.js fs/promises 提供现代化的异步文件 API
4. **配置管理**: 使用运行时验证库（如 Zod）确保配置正确性
5. **CLI**: 选择成熟的 CLI 框架，提供良好的用户体验

### 数据格式建议

- **配置文件**: JSON 格式，简单易读
- **会话存储**: JSONL 格式，便于追加和流式处理
- **记忆文件**: Markdown 格式，人类可读
- **技能文件**: Markdown + YAML frontmatter，结合文档和元数据


## 总结

本指南提供了构建轻量级 AI 助手框架的核心设计思想。关键原则：

1. **保持轻量级**: 核心代码精简，避免过度设计
2. **类型安全**: 充分利用 TypeScript 的类型系统，减少运行时错误
3. **模块化**: 清晰的模块边界和职责划分
4. **异步优先**: 全面使用现代异步模式，提高并发性能
5. **错误处理**: 明确的错误类型和处理策略，快速失败原则
6. **可扩展性**: 通过插件化机制支持功能扩展

遵循这些原则，可以构建一个类型安全、易于维护、性能良好的 AI 助手框架。
