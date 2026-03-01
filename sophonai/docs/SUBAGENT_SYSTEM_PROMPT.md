# Subagent 系统设计提示词

## 概述

Subagent（子代理）系统是一种后台任务执行机制，允许主 AI 代理将耗时或复杂的任务委托给独立的子代理在后台异步执行，从而保持主代理的响应性和并发处理能力。

## 核心设计目标

### 1. 非阻塞执行
- 主代理不应被长时间运行的任务阻塞
- 用户可以继续与主代理交互，同时后台任务在执行
- 支持多个子代理并发执行

### 2. 任务隔离
- 每个子代理有独立的执行环境
- 不共享主代理的会话历史
- 避免任务间的相互干扰

### 3. 结果通知
- 子代理完成后自动通知主代理
- 主代理将结果以自然语言形式返回给用户
- 支持成功和失败两种状态的通知

### 4. 资源控制
- 限制子代理的迭代次数，防止无限运行
- 支持取消正在执行的子代理
- 管理子代理的生命周期

## 架构设计

### 核心组件

#### 1. Subagent Manager（子代理管理器）

**职责**:
- 创建和管理子代理实例
- 跟踪所有运行中的子代理
- 处理子代理的生命周期（创建、执行、完成、取消）
- 管理子代理与主会话的关联关系

**关键方法**:
```typescript
interface SubagentManager {
  // 创建子代理
  spawn(task: string, options?: SpawnOptions): Promise<string>;
  
  // 取消指定会话的所有子代理
  cancelBySession(sessionKey: string): Promise<number>;
  
  // 获取运行中的子代理数量
  getRunningCount(): number;
}
```

**设计要点**:
- 使用唯一 ID 标识每个子代理
- 维护任务映射：`taskId -> asyncio.Task`
- 维护会话映射：`sessionKey -> Set<taskId>`
- 任务完成后自动清理资源

#### 2. Spawn Tool（生成工具）

**职责**:
- 作为主代理的工具，允许主代理创建子代理
- 接收任务描述和可选标签
- 返回子代理启动确认信息

**工具定义**:
```typescript
{
  name: "spawn",
  description: "Spawn a subagent to handle a task in the background. Use this for complex or time-consuming tasks that can run independently.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task for the subagent to complete"
      },
      label: {
        type: "string",
        description: "Optional short label for the task (for display)"
      }
    },
    required: ["task"]
  }
}
```

**设计要点**:
- 工具执行时记录原始会话信息（channel, chat_id）
- 子代理完成后会通知到原始会话
- 立即返回确认消息，不等待任务完成

#### 3. Subagent 执行环境

**职责**:
- 在独立环境中执行任务
- 使用受限的工具集
- 生成任务结果并通知主代理

**关键特性**:

1. **受限工具集**:
   - ✅ 可用：文件操作、shell 命令、网络搜索等基础工具
   - ❌ 不可用：消息发送工具、子代理生成工具
   - 原因：子代理不应直接与用户交互或创建嵌套子代理

2. **独立上下文**:
   - 不继承主代理的会话历史
   - 有独立的系统提示
   - 专注于完成指定任务

3. **迭代限制**:
   - 比主代理更严格的迭代限制（如 15 次 vs 40 次）
   - 防止子代理运行过久
   - 超时后返回当前结果

#### 4. 结果通知机制

**职责**:
- 子代理完成后将结果发送给主代理
- 格式化通知消息
- 触发主代理处理结果

**通知格式**:
```
[Subagent '任务标签' completed successfully/failed]

Task: 原始任务描述

Result:
任务执行结果

Summarize this naturally for the user. Keep it brief (1-2 sentences). 
Do not mention technical details like "subagent" or task IDs.
```

**设计要点**:
- 通过消息总线发送系统消息
- 包含原始任务和结果
- 要求主代理以自然语言总结
- 隐藏技术细节（如 subagent、task ID）

## 实现细节

### 1. 子代理创建流程

```
用户请求
  ↓
主代理分析任务
  ↓
主代理调用 spawn 工具
  ↓
SubagentManager.spawn()
  ↓
创建异步任务 _run_subagent()
  ↓
立即返回确认消息
  ↓
子代理在后台执行
  ↓
完成后发送通知
  ↓
主代理处理通知并返回用户
```

### 2. 子代理执行流程

```typescript
async function runSubagent(
  taskId: string,
  task: string,
  label: string,
  origin: OriginContext
): Promise<void> {
  try {
    // 1. 构建受限工具集
    const tools = createSubagentToolRegistry();
    
    // 2. 构建系统提示
    const systemPrompt = buildSubagentPrompt(task);
    
    // 3. 执行代理循环（受限迭代）
    const result = await runAgentLoop(
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task }
      ],
      tools: tools,
      maxIterations: 15  // 比主代理更严格
    );
    
    // 4. 通知主代理
    await announceResult(taskId, label, task, result, origin, "ok");
  } catch (error) {
    // 5. 错误处理
    await announceResult(taskId, label, task, error.message, origin, "error");
  }
}
```

### 3. 工具集限制

**子代理可用工具**:
- 文件系统工具（read, write, edit, list）
- Shell 执行工具
- 网络工具（search, fetch）
- 其他基础工具

**子代理不可用工具**:
- 消息发送工具（避免直接与用户交互）
- 子代理生成工具（避免嵌套）
- 会话管理工具（子代理不应管理会话）

### 4. 系统提示设计

子代理的系统提示应强调：

```markdown
# Subagent

You are a subagent spawned by the main agent to complete a specific task.

## Rules
1. Stay focused - complete only the assigned task, nothing else
2. Your final response will be reported back to the main agent
3. Do not initiate conversations or take on side tasks
4. Be concise but informative in your findings

## What You Can Do
- Read and write files in the workspace
- Execute shell commands
- Search the web and fetch web pages
- Complete the task thoroughly

## What You Cannot Do
- Send messages directly to users (no message tool available)
- Spawn other subagents
- Access the main agent's conversation history

When you have completed the task, provide a clear summary of your findings or actions.
```

### 5. 会话关联

**设计要点**:
- 每个子代理关联到原始会话（session_key）
- 支持按会话取消所有子代理
- 子代理结果发送到原始会话

**实现**:
```typescript
// 会话到任务映射
sessionTasks: Map<sessionKey, Set<taskId>>

// 取消会话的所有子代理
async cancelBySession(sessionKey: string): Promise<number> {
  const taskIds = this.sessionTasks.get(sessionKey) || [];
  const tasks = taskIds
    .map(id => this.runningTasks.get(id))
    .filter(task => task && !task.done());
  
  tasks.forEach(task => task.cancel());
  await Promise.allSettled(tasks);
  
  return tasks.length;
}
```

## 使用场景

### 适合使用 Subagent 的任务

1. **耗时任务**:
   - 代码库分析
   - 大量文件处理
   - 复杂数据计算
   - 网络爬取

2. **独立任务**:
   - 不需要用户交互的任务
   - 可以完全自动化完成的任务
   - 结果可以异步返回的任务

3. **并发处理**:
   - 需要同时处理多个独立任务
   - 主代理需要保持响应性

### 不适合使用 Subagent 的任务

1. **需要用户交互**:
   - 需要确认的任务
   - 需要用户输入的任务
   - 需要实时反馈的任务

2. **简单快速任务**:
   - 可以在主代理中快速完成的任务
   - 不需要后台执行的任务

3. **依赖主会话上下文**:
   - 需要访问完整会话历史的任务
   - 需要理解对话上下文的任务

## 设计原则

### 1. 隔离原则
- 子代理与主代理完全隔离
- 不共享状态、历史、配置
- 每个子代理独立执行

### 2. 限制原则
- 限制工具集，防止滥用
- 限制迭代次数，防止无限运行
- 限制资源使用

### 3. 通知原则
- 子代理完成后必须通知
- 通知包含完整上下文
- 主代理负责格式化结果

### 4. 生命周期原则
- 明确的生命周期管理
- 自动资源清理
- 支持手动取消

## 错误处理

### 1. 子代理执行错误
- 捕获所有异常
- 将错误信息包含在通知中
- 标记为失败状态

### 2. 通知失败
- 记录日志
- 不阻塞主代理
- 可选的错误重试机制

### 3. 资源清理
- 任务完成后自动清理
- 取消时立即清理
- 防止内存泄漏

## 性能考虑

### 1. 并发控制
- 支持多个子代理并发执行
- 使用异步任务管理
- 避免阻塞主事件循环

### 2. 资源限制
- 限制同时运行的子代理数量（可选）
- 监控资源使用情况
- 防止资源耗尽

### 3. 超时处理
- 设置子代理执行超时
- 超时后自动取消
- 返回超时信息

## 扩展性

### 1. 可配置参数
- 迭代次数限制
- 超时时间
- 并发数量限制
- 工具集配置

### 2. 监控和日志
- 记录子代理创建和完成
- 跟踪执行时间
- 统计成功/失败率

### 3. 优先级支持（可选）
- 支持任务优先级
- 高优先级任务优先执行
- 队列管理

## 实现检查清单

- [ ] SubagentManager 实现
  - [ ] spawn() 方法
  - [ ] cancelBySession() 方法
  - [ ] 任务跟踪和清理
  - [ ] 会话关联管理

- [ ] Spawn Tool 实现
  - [ ] 工具定义和注册
  - [ ] 上下文设置
  - [ ] 参数验证

- [ ] 子代理执行环境
  - [ ] 受限工具集
  - [ ] 独立系统提示
  - [ ] 迭代限制
  - [ ] 错误处理

- [ ] 通知机制
  - [ ] 结果格式化
  - [ ] 消息发送
  - [ ] 主代理处理

- [ ] 生命周期管理
  - [ ] 任务创建
  - [ ] 任务执行
  - [ ] 任务完成
  - [ ] 资源清理

- [ ] 取消机制
  - [ ] 按会话取消
  - [ ] 按任务 ID 取消
  - [ ] 优雅关闭

## 测试建议

### 1. 单元测试
- SubagentManager 的方法
- Spawn Tool 的执行
- 工具集限制验证

### 2. 集成测试
- 完整的子代理创建和执行流程
- 通知机制
- 取消机制

### 3. 并发测试
- 多个子代理同时执行
- 主代理继续处理其他请求
- 资源清理验证

## 总结

Subagent 系统是一个强大的并发处理机制，通过以下方式提升系统能力：

1. **响应性**: 主代理不被长时间任务阻塞
2. **并发性**: 支持多个任务同时执行
3. **隔离性**: 任务间相互独立，互不干扰
4. **可控性**: 支持取消和资源管理

实现时需要注意工具限制、生命周期管理和错误处理，确保系统的稳定性和可靠性。
