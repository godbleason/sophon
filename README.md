# Sophon

轻量级多用户 AI 助手框架。支持多通道交互、多用户身份管理、Space 协作、工具调用、定时任务、子代理、长期记忆和 MCP 协议。

🌐 **官网**：[https://www.sophonai.online/](https://www.sophonai.online/)

## 特性

- **多通道接入** — CLI / Web（WebSocket）/ Telegram，可扩展更多通道
- **多用户系统** — 自动识别用户身份，支持跨通道关联（同一用户在 CLI + Telegram 使用同一身份）
- **Space 协作** — 创建家庭、工作等协作空间，AI 自动识别对话上下文，支持跨用户消息推送
- **Agent Loop** — 完整的 LLM 工具调用循环，支持多轮迭代、并发控制、进度推送和会话取消
- **内置工具集** — 文件操作、Shell 命令、Web 搜索、日期时间、定时任务、记忆管理、跨用户消息、子代理
- **子代理系统** — 将耗时任务委托给后台子代理异步执行，完成后自动通知
- **定时任务** — 基于 Cron 表达式的任务调度，持久化自动恢复
- **记忆系统** — 长期事实记忆 + 历史日志 + 语义搜索，跨会话保留上下文
- **对话压缩** — 超出窗口的历史自动由 LLM 摘要化，保留关键信息
- **技能系统** — Markdown 文件定义可插拔技能提示词
- **MCP 支持** — 作为 MCP 客户端连接外部工具服务器（兼容 Cursor / Claude Desktop 配置格式）
- **多 LLM 支持** — OpenAI / DeepSeek / OpenRouter，统一接口可扩展
- **持久化抽象层** — StorageProvider 接口，当前实现 SQLite（better-sqlite3），可扩展 PostgreSQL 等
- **结构化日志** — 基于 pino 的 JSON 格式日志，支持多级别
- **配置灵活** — JSON 配置 + `.env` 环境变量 + CLI 参数，三层覆盖

## 快速开始

### 环境要求

- Node.js >= 18.0.0

### 安装

```bash
git clone <repo-url> sophon
cd sophon
npm install
```

### 配置

1. 创建 `.env` 文件，设置 API Key：

```bash
# 至少配置一个 LLM 提供商
DEEPSEEK_API_KEY=your-api-key-here

# 可选
OPENAI_API_KEY=your-openai-key
OPENROUTER_API_KEY=your-openrouter-key

# Telegram Bot（可选）
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# Web 搜索增强（可选，不配置则使用 DuckDuckGo）
SERPER_API_KEY=your-serper-key
# 或
SERPAPI_KEY=your-serpapi-key
```

2. 默认配置文件位于 `config/default.json`，可按需修改，也可创建 `config/config.json` 进行覆盖。

### 启动

```bash
# 开发模式
npm run dev

# 或构建后运行
npm run build
npm start
```

启动后将同时提供：
- **CLI 交互** — 终端内直接输入对话
- **Web 界面** — 浏览器访问 `http://localhost:3000`
- **Telegram Bot** — 如已配置 Token，自动连接

### CLI 选项

```bash
# 指定配置文件
npm run dev -- -c path/to/config.json

# 指定模型
npm run dev -- -m gpt-4o

# 详细日志
npm run dev -- -v
```

## 项目结构

```
sophon/
├── config/
│   └── default.json              # 默认配置
├── skills/                       # 技能定义（Markdown）
├── data/                         # 运行时数据（git ignored）
│   ├── sophon.db                 # SQLite 数据库（用户、Space、记忆、消息等）
│   └── sessions/                 # 会话工作区（工具产生的文件）
├── src/
│   ├── index.ts                  # 入口，CLI 参数解析
│   ├── config/
│   │   └── config-manager.ts     # 配置加载与验证（Zod Schema）
│   ├── core/
│   │   ├── app.ts                # 应用组装与启动
│   │   ├── agent-loop.ts         # Agent 循环（LLM ↔ 工具，并发控制）
│   │   ├── message-bus.ts        # 消息总线（入站 / 出站 / 进度）
│   │   ├── session-manager.ts    # 会话管理（内存缓存 + 持久化）
│   │   ├── user-store.ts         # 多用户身份管理与跨通道关联
│   │   ├── space-manager.ts      # Space 协作空间管理
│   │   ├── scheduler.ts          # 定时任务调度器
│   │   ├── subagent-manager.ts   # 子代理管理器
│   │   ├── mcp-manager.ts        # MCP 客户端管理器
│   │   ├── tool-registry.ts      # 工具注册表
│   │   ├── semaphore.ts          # 并发信号量
│   │   ├── async-queue.ts        # 异步队列
│   │   ├── errors.ts             # 错误类型
│   │   └── logger.ts             # 日志系统（pino）
│   ├── storage/
│   │   ├── storage-provider.ts   # 持久化抽象接口（StorageProvider）
│   │   ├── sqlite-provider.ts    # SQLite 实现（better-sqlite3）
│   │   └── index.ts              # 统一导出
│   ├── channels/
│   │   ├── base-channel.ts       # 通道接口
│   │   ├── cli-channel.ts        # CLI 通道
│   │   ├── web-channel.ts        # Web 通道（HTTP + WebSocket）
│   │   ├── web-chat-ui.ts        # Web 聊天 UI
│   │   └── telegram-channel.ts   # Telegram 通道
│   ├── providers/
│   │   ├── openai-compatible-base.ts  # OpenAI 兼容基类
│   │   ├── openai-provider.ts
│   │   ├── deepseek-provider.ts
│   │   ├── openrouter-provider.ts
│   │   └── provider-factory.ts
│   ├── tools/                    # 内置工具集
│   ├── memory/
│   │   └── memory-store.ts       # 记忆存储
│   ├── skills/
│   │   └── skills-loader.ts      # 技能加载器
│   └── types/                    # TypeScript 类型定义
└── package.json
```

## 架构概览

```
┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
│  CLI Channel │ │  Web Channel │ │ Telegram Channel │  ...
└──────┬───────┘ └──────┬───────┘ └────────┬─────────┘
       │                │                  │
       ▼                ▼                  ▼
┌──────────────────────────────────────────────────────┐
│                    Message Bus                       │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│                     Agent Loop                       │
│  ┌─────────────┐  ┌───────────────┐  ┌───────────┐  │
│  │ LLM Provider│  │ Tool Registry │  │ MCP Tools │  │
│  └─────────────┘  └───────────────┘  └───────────┘  │
└──────────┬───────────────┬───────────────┬───────────┘
           │               │               │
    ┌──────┴──────┐  ┌─────┴─────┐  ┌──────┴──────┐
    │   Session   │  │  Memory   │  │  Subagent   │
    │   Manager   │  │   Store   │  │  Manager    │
    └──────┬──────┘  └─────┬─────┘  └─────────────┘
           │               │
    ┌──────┴──────┐  ┌─────┴─────┐
    │  User Store │  │ Scheduler │
    │ Space Mgr   │  │           │
    └──────┬──────┘  └─────┬─────┘
           │               │
           ▼               ▼
┌──────────────────────────────────────────────────────┐
│              StorageProvider (SQLite)                 │
└──────────────────────────────────────────────────────┘
```

## 内置工具

| 工具 | 名称 | 说明 |
|------|------|------|
| 📁 | `read_file` | 读取文件内容 |
| ✏️ | `write_file` | 写入文件 |
| 📂 | `list_dir` | 列出目录内容 |
| 🖥️ | `run_shell` | 在工作区执行 Shell 命令 |
| 🕐 | `get_datetime` | 获取当前日期时间 |
| 🔍 | `web_search` | Web 搜索（DuckDuckGo / Serper / SerpAPI） |
| 🌐 | `fetch_url` | 获取网页内容（自动提取正文） |
| 🧠 | `update_memory` | 更新长期记忆 |
| 📝 | `append_history` | 追加历史日志 |
| 🔎 | `search_history` | 搜索历史日志 |
| 💬 | `send_message` | 向 Space 成员发送消息 |
| ⏰ | `create_schedule` | 创建定时任务（Cron） |
| 📋 | `list_schedules` | 列出定时任务 |
| 🗑️ | `remove_schedule` | 删除定时任务 |
| 🔀 | `toggle_schedule` | 启用 / 禁用定时任务 |
| 🚀 | `spawn` | 生成后台子代理 |
| 📊 | `subagent_status` | 查询子代理状态 |
| ❌ | `cancel_subagent` | 取消子代理 |

> 通过 MCP 连接的外部工具服务器会自动注册为 `mcp_<server>_<tool>` 格式的工具。

## 内置命令

在对话中输入以下命令：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/about` | 了解平台功能和 Space 介绍 |
| `/clear` | 清除当前会话历史 |
| `/tools` | 列出可用工具 |
| `/status` | 显示系统状态 |
| `/stop` | 停止当前任务 |
| `/whoami` | 查看当前用户身份 |
| `/link` | 生成跨通道关联码 |
| `/link <code>` | 使用关联码绑定到另一个通道的用户 |
| `/unlink` | 解绑当前通道 |
| `/space create <名称>` | 创建一个新 Space |
| `/space list` | 查看我加入的所有 Space |
| `/space info <名称或ID>` | 查看 Space 详情 |
| `/space invite <名称或ID>` | 生成邀请码 |
| `/space join <邀请码>` | 通过邀请码加入 Space |
| `/space leave <名称或ID>` | 离开一个 Space |
| `/space nick <名称或ID> <昵称>` | 设置在某个 Space 中的昵称 |
| `/space members <名称或ID>` | 查看 Space 成员 |

## 配置说明

`config/default.json` 完整配置项：

```jsonc
{
  // LLM 提供商（至少配置一个，API Key 建议放 .env）
  "providers": {
    "deepseek": {},
    "openrouter": {},
    "openai": {}
  },

  // 代理配置
  "agent": {
    "model": "deepseek-chat",        // 使用的模型
    "temperature": 0.7,
    "maxTokens": 4096,
    "maxIterations": 50,             // 单次对话最大工具调用轮次
    "maxConcurrentMessages": 5,      // 全局最大并发消息数
    "systemPrompt": "..."
  },

  // 存储配置
  "storage": {
    "type": "sqlite",                // 存储后端类型（目前支持 sqlite）
    "sqlitePath": "data/sophon.db"   // SQLite 数据库文件路径
  },

  // 会话配置
  "session": {
    "storageDir": "data/sessions",   // 工作区文件目录
    "memoryWindow": 50               // 历史窗口大小（超出自动压缩摘要）
  },

  // 记忆配置
  "memory": {
    "enabled": true
  },

  // 通道配置
  "channels": {
    "cli": { "enabled": true, "prompt": "you> " },
    "web": { "enabled": true, "port": 3000, "host": "localhost" },
    "telegram": { "enabled": false, "token": "", "allowedUsers": [] }
  },

  // 定时任务
  "scheduler": {
    "enabled": true,
    "maxTasksPerSession": 20
  },

  // 子代理
  "subagent": {
    "enabled": true,
    "maxIterations": 15,
    "maxConcurrent": 5,
    "timeout": 300000,
    "toolBlacklist": ["spawn", "subagent_status", "cancel_subagent"]
  },

  // MCP 服务器（兼容 Cursor / Claude Desktop 格式）
  "mcpServers": {
    "example-server": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": {}
    }
  },

  "logLevel": "info"
}
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_API_BASE` | OpenAI API 基础 URL |
| `OPENROUTER_API_KEY` | OpenRouter API Key |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `SERPER_API_KEY` | Serper.dev 搜索 API Key |
| `SERPAPI_KEY` | SerpAPI 搜索 API Key |
| `SOPHON_MODEL` | 覆盖默认模型 |
| `SOPHON_TEMPERATURE` | 覆盖温度参数 |
| `SOPHON_LOG_LEVEL` | 覆盖日志级别 |

## 持久化架构

所有数据通过 `StorageProvider` 接口统一管理，当前使用 SQLite 实现：

| 数据 | 存储方式 | 说明 |
|------|----------|------|
| 会话元数据 | `session_metas` 表 | 会话 ID、通道、用户关联 |
| 对话消息 | `messages` 表 | 每条消息有唯一 ID，按插入顺序排列 |
| 对话摘要 | `summaries` 表 | 压缩后的旧对话摘要 |
| 定时任务 | `schedules` 表 | Cron 任务定义 |
| 用户数据 | `kv` 表 | 用户列表 JSON |
| Space 数据 | `kv` 表 | Space 列表 JSON |
| 长期记忆 | `kv` 表 | Markdown 格式的记忆内容 |
| 历史日志 | `kv` 表 | 时间线格式的历史记录 |

**扩展新存储后端**只需三步：
1. 实现 `StorageProvider` 接口
2. 在配置 Schema 中加入新类型
3. 在 `app.ts` 中加入工厂分支

## 开发

```bash
# 类型检查
npm run lint

# 运行测试
npm test

# 监听模式测试
npm run test:watch

# 构建
npm run build

# 查看当前配置
npx tsx src/index.ts config
```

## 技能系统

在 `skills/` 目录下创建 Markdown 文件即可添加技能。技能会被自动注入到系统提示中。

```markdown
---
name: my-skill
description: 我的自定义技能
always_load: true
---

# 技能内容

这里写技能相关的提示词指导...
```

## License

MIT
