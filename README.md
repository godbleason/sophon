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
- **前后端分离** — 后端（sophonai）与前端（web）独立部署，松耦合
- **现代前端** — React + Vite + TypeScript + Tailwind CSS + shadcn/ui
- **结构化日志** — 基于 pino 的 JSON 格式日志，支持多级别
- **配置灵活** — JSON 配置 + `.env` 环境变量 + CLI 参数，三层覆盖

## 项目结构

```
sophon/
├── sophonai/                     # 后端服务（独立部署）
│   ├── config/
│   │   └── default.json          # 默认配置
│   ├── skills/                   # 技能定义（Markdown）
│   ├── data/                     # 运行时数据（git ignored）
│   │   ├── sophon.db             # SQLite 数据库
│   │   └── sessions/             # 会话工作区
│   ├── src/
│   │   ├── index.ts              # 入口，CLI 参数解析
│   │   ├── config/               # 配置加载与验证
│   │   ├── core/                 # 核心模块（App、Agent、Session 等）
│   │   ├── storage/              # 持久化抽象层（StorageProvider）
│   │   ├── channels/             # 通道（CLI、Web、Telegram）
│   │   ├── providers/            # LLM 提供商
│   │   ├── tools/                # 内置工具集
│   │   ├── memory/               # 记忆存储
│   │   ├── skills/               # 技能加载器
│   │   └── types/                # TypeScript 类型定义
│   ├── Dockerfile                # 后端 Docker 镜像
│   ├── docker-compose.yml        # Docker Compose 配置
│   ├── package.json
│   └── tsconfig.json
├── web/                          # 前端工程（独立部署）
│   ├── src/
│   │   ├── App.tsx               # 主应用组件
│   │   ├── main.tsx              # 入口
│   │   ├── hooks/                # 自定义 Hooks（WebSocket、Chat）
│   │   ├── components/           # UI 组件
│   │   └── types/                # 类型定义
│   ├── Dockerfile                # 前端 Docker 镜像（Nginx）
│   ├── vite.config.ts
│   ├── package.json
│   └── tsconfig.json
├── .gitignore
└── README.md
```

## 快速开始

### 环境要求

- Node.js >= 18.0.0

### 安装

```bash
git clone <repo-url> sophon
cd sophon

# 安装后端依赖
cd sophonai && npm install

# 安装前端依赖
cd ../web && npm install
```

### 配置

1. 在 `sophonai/` 目录下创建 `.env` 文件，设置 API Key：

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
```

2. 默认配置文件位于 `sophonai/config/default.json`，可按需修改。

### 启动

```bash
# ── 后端 ──
cd sophonai

# 开发模式
npm run dev

# 或构建后运行
npm run build
npm start

# ── 前端 ──
cd web

# 开发模式（自动代理 WebSocket 到后端）
npm run dev

# 或构建后预览
npm run build
npm run preview
```

### 独立部署

前后端分离部署时，前端通过环境变量 `VITE_WS_URL` 指定后端 WebSocket 地址：

```bash
# 构建前端时注入后端地址
cd web
VITE_WS_URL=wss://api.example.com npm run build
```

### Docker 部署

```bash
# 后端
cd sophonai
docker build -t sophonai .
docker run -d -p 3000:3000 --env-file .env sophonai

# 前端
cd web
docker build -t sophon-web --build-arg VITE_WS_URL=wss://api.example.com .
docker run -d -p 80:80 sophon-web
```

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                      Frontend (web/)                         │
│   React + Vite + TypeScript + Tailwind CSS + shadcn/ui       │
│                                                              │
│   WebSocket ◄──────────────────────────────────────┐         │
└──────────────────────────────────────────────────────┼────────┘
                                                       │
                                                       ▼
┌──────────────────────────────────────────────────────────────┐
│                     Backend (sophonai/)                       │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐      │
│  │  CLI Channel │ │  Web Channel │ │ Telegram Channel │ ...  │
│  └──────┬───────┘ └──────┬───────┘ └────────┬─────────┘      │
│         │                │                  │                │
│         ▼                ▼                  ▼                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                    Message Bus                       │    │
│  └──────────────────────────┬───────────────────────────┘    │
│                             │                                │
│                             ▼                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                     Agent Loop                       │    │
│  │  ┌─────────────┐  ┌───────────────┐  ┌───────────┐  │    │
│  │  │ LLM Provider│  │ Tool Registry │  │ MCP Tools │  │    │
│  │  └─────────────┘  └───────────────┘  └───────────┘  │    │
│  └──────────┬───────────────┬───────────────┬───────────┘    │
│             │               │               │                │
│      ┌──────┴──────┐  ┌─────┴─────┐  ┌──────┴──────┐        │
│      │   Session   │  │  Memory   │  │  Subagent   │        │
│      │   Manager   │  │   Store   │  │  Manager    │        │
│      └──────┬──────┘  └─────┬─────┘  └─────────────┘        │
│             │               │                                │
│      ┌──────┴──────┐  ┌─────┴─────┐                          │
│      │  User Store │  │ Scheduler │                          │
│      │ Space Mgr   │  │           │                          │
│      └──────┬──────┘  └─────┬─────┘                          │
│             │               │                                │
│             ▼               ▼                                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              StorageProvider (SQLite)                 │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
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

`sophonai/config/default.json` 完整配置项：

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
    "maxConcurrentMessages": 5       // 全局最大并发消息数
  },

  // 存储配置
  "storage": {
    "type": "sqlite",                // 存储后端类型（目前支持 sqlite）
    "sqlitePath": "data/sophon.db"   // SQLite 数据库文件路径
  },

  // 通道配置
  "channels": {
    "cli": { "enabled": false },
    "web": { "enabled": true, "port": 3000, "host": "localhost" },
    "telegram": { "enabled": false, "token": "", "allowedUsers": [] }
  },

  // 定时任务
  "scheduler": { "enabled": true },

  // MCP 服务器（兼容 Cursor / Claude Desktop 格式）
  "mcpServers": {},

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
| `PORT` | Web 通道端口（云平台自动设置） |
| `VITE_WS_URL` | 前端构建时注入的后端 WebSocket 地址 |

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
# ── 后端开发 ──
cd sophonai

npm run dev        # 开发模式（tsx 热重载）
npm run lint       # 类型检查
npm run build      # 构建
npm start          # 运行构建产物

# ── 前端开发 ──
cd web

npm run dev        # Vite 开发服务器（代理 WS 到后端）
npm run build      # 构建生产版本
npm run preview    # 预览构建结果
npm run lint       # ESLint 检查
```

## 技能系统

在 `sophonai/skills/` 目录下创建 Markdown 文件即可添加技能。技能会被自动注入到系统提示中。

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
