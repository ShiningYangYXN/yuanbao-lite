# Yuanbao Lite

轻量级独立腾讯元宝机器人客户端 — 聊天、命令、媒体、贴纸、LLM 接管、交互式 CLI。

[![npm version](https://img.shields.io/npm/v/yuanbao-lite.svg)](https://www.npmjs.com/package/yuanbao-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **OpenClaw 实例请查看 [CLAW.md](CLAW.md)** — 包含从源码部署、daemon 管理、systemd 集成、技能生成引导等完整运维指南。

## 特性

- **daemon-first 架构** — CLI 与 daemon 分离，零 WebSocket 重连
- **Vercel AI SDK** — 支持 5 种 API 格式（OpenAI/Anthropic/Gemini/Bedrock/Azure）
- **命令系统** — 50+ 内置斜杠命令，CLI 与 IM 共享同一套实现
- **LLM 接管** — 密钥池+供应商池+自动切换，命令 invoke 迭代调用，用量统计
- **安全机制** — 用户信任系统，单命令授权（带过期），群聊插值屏蔽
- **持久化提醒** — /remind（任意时长+时间点）+ /cron（cron 表达式），自动持久化
- **@提及** — `@[昵称](id)` / `@[所有人]()` / `@[](all)` / 别名解析 / ID 昵称获取
- **交互式终端** — /term 进入阻塞式 shell 会话，5 分钟超时
- **Shell 体验** — readline + 历史记录 + Tab 补全 + 多行输入

## 快速开始

### 1. 安装

```bash
npm install yuanbao-lite
# 或
pnpm add yuanbao-lite
```

### 2. 初始化配置

```bash
# 交互式配置向导
npx yb-cli config init

# 或直接设置
npx yb-cli config set appKey 你的AppKey
npx yb-cli config set appSecret 你的AppSecret

# 验证
npx yb-cli config show
```

### 3. 启动 daemon

```bash
npx yb-cli daemon start
# 或
pnpm daemon
```

daemon 默认监听 `127.0.0.1:8992`（T9:TXYB 腾讯元宝）。

### 4. 使用 CLI

```bash
# 交互式 REPL
npx yb-cli

# 非交互式命令（自动通过 daemon 执行）
npx yb-cli send dm <userId> "你好"
npx yb-cli rc /help
npx yb-cli rc /ip 8.8.8.8
```

## LLM 配置

### 通过向导

私聊发送 `/llm config` 或在 CLI REPL 中输入 `/llm config`，向导引导完成配置：

1. 选择 API 格式（5 种）
2. 输入供应商名称
3. 输入模型名称
4. 输入端点 URL
5. 输入 API Key
6. 输入系统提示词（可选）

### 支持的 API 格式

| 格式 | 说明 |
|------|------|
| openai-chat-completions | OpenAI 及兼容 API (DeepSeek/Moonshot 等) |
| anthropic-messages | Anthropic Claude |
| google-gemini-rest | Google Gemini |
| aws-bedrock-converse | AWS Bedrock |
| azure-openai | Azure OpenAI |

### 供应商管理

```text
# 添加供应商 (API格式、端点、模型、密钥均为必填)
/llm customprovider add my-openai openai-chat-completions gpt-4o https://api.openai.com/v1 sk-xxx

# 添加密钥到池
/llm customprovider addkey my-openai sk-yyy

# 切换供应商
/llm customprovider use my-openai

# 查看用量
/llm billing
```

### 系统提示词

- 默认系统提示词**不可被覆盖**，包含命令执行、迭代调用、安全机制、@提及语法等完整文档
- 用户可通过 `userSystemPrompt` 配置项追加自定义提示词
- 自定义提示词以「用户添加的系统提示词」为标头拼接在默认提示词之后

## 命令列表

### 核心

| 命令 | 说明 |
|------|------|
| `/help [命令名]` | 显示帮助（任意命令加 `--help`/`-h`/`-?` 显示详细帮助） |
| `/status` | bot 状态 |
| `/version` | 版本 |
| `/ping` | 延迟测试 |
| `/echo <文本>` | 回显 |
| `/calc <表达式>` | 数学计算 |
| `/time [时区]` | 时间查询 |
| `/whoami` | 查看自己的信息（用户ID、昵称、信任状态） |

### 网络

| 命令 | 说明 |
|------|------|
| `/ip <IP>` | IP 地理位置查询（IPv4+IPv6，多服务商并发，含 AS） |
| `/whois <域名>` | 域名 WHOIS 查询（RDAP） |
| `/myip` | 服务器 IP 信息（双栈+AS+地区+本地接口，仅私聊） |

### 提醒与定时

| 命令 | 说明 |
|------|------|
| `/remind <时间> <消息>` | 定时提醒（持久化，任意时长/时间点，可指定目标） |
| `/remind list` / `cancel <ID>` | 管理提醒 |
| `/cron <表达式> <消息>` | 周期定时任务（持久化，仅私聊，可指定目标） |
| `/cron list` / `cancel <ID>` | 管理定时任务 |

时间格式: `30s` `5m` `2h` `1d` `1w` `1mo` `1y` `14:30` `2026-06-18 14:30` `1d2h3m`
目标: `--to <用户ID/群号>` `--group`（默认当前会话）
cron: `分 时 日 月 周`（如 `30 9 * * 1-5` = 工作日9:30）

### 安全

| 命令 | 说明 |
|------|------|
| `/trust status` | 查看信任状态（全局开放） |
| `/trust list/add/remove` | 管理信任列表（仅私聊，主人不可移除） |
| `/unsafe status` | 查看危险模式+授权白名单+过期时间（全局开放） |
| `/unsafe on [分钟/forever]` | 开启全局危险模式（默认5分钟，需受信） |
| `/unsafe off` | 关闭危险模式 |
| `/unsafe allow <命令> [分钟/forever]` | 授权单个 dmOnly 命令（默认5分钟） |
| `/unsafe disallow <命令>` | 取消授权（非 dmOnly 命令无法 disallow） |

不可授权命令: unsafe, trust, config, init, daemon

### 系统管理

| 命令 | 说明 |
|------|------|
| `/shell [--all] <命令>` | 执行系统命令（仅私聊，`--all` 不截断输出） |
| `/term` | 进入交互式终端（仅私聊，5分钟超时，`/term exit` 退出） |
| `/log <级别>` | 切换日志级别 |
| `/daemon status` | daemon 状态 |
| `/daemon stop/restart/reset` | daemon 管理（1分钟内3次确认，CLI 直接执行） |

### LLM

| 命令 | 说明 |
|------|------|
| `/llm status` | LLM 状态（含密钥池/供应商池/API格式/端点） |
| `/llm billing` | 用量统计（调用次数/Token/按供应商分组/最近记录） |
| `/llm on` / `off` | 开关自动回复 |
| `/llm config` | 交互式配置向导（阻塞） |
| `/llm chat <消息>` | 单次对话 |
| `/llm customprovider ...` | 供应商管理（add/remove/addkey/use） |
| `/llm model <名称>` | 切换模型 |

### 配置（仅私聊）

| 命令 | 说明 |
|------|------|
| `/init` | 交互式配置向导（阻塞） |
| `/init appkey/appsecret/token <值>` | 直接设置认证信息 |
| `/config show` / `set <key> <value>` | 查看/设置配置 |
| `/config profile list/switch/add/remove` | 档案管理 |

### 聊天与媒体

| 命令 | 说明 |
|------|------|
| `/dm <ID> <消息>` | 私聊 |
| `/group <群号> <消息>` | 群聊 |
| `/atall <群号> <消息>` | @所有人 |
| `/upload <文件>` | 上传文件 |
| `/download <URL>` | 下载文件 |
| `/sticker <ID>` | 发送贴纸 |
| `/stickers search <关键词>` | 搜索贴纸 |
| `/batch text/sticker/image/file ...` | 批量发送 |

## @提及语法

```text
@[昵称](id)    — 用指定昵称 @指定用户
@[](id)        — 自动获取昵称 @指定用户
@[昵称]()      — 群聊中按昵称自动匹配 ID（也支持别名）
@[所有人]()    — @所有人
@[](all)       — @所有人（等价）
@[所有人](all) — @所有人（等价）
\@             — 转义 @
```

## 插值语法

```text
${i + 1}              — 表达式求值
${new Date().toISOString()}  — JS 表达式
\${literal}           — 转义，输出 ${literal}
```

群聊中（非 unsafe 模式）自动屏蔽危险全局变量（process、env、require、fetch 等）。

## pnpm 脚本

```bash
pnpm build          # 编译
pnpm cli            # 启动 CLI
pnpm daemon         # 启动 daemon (端口 8992)
pnpm daemon:stop    # 停止 daemon
pnpm daemon:status  # daemon 状态
pnpm daemon:restart # 重启 daemon
pnpm lint           # ESLint
```

## OpenClaw 部署

OpenClaw 实例请查看 **[CLAW.md](CLAW.md)** 获取完整部署指南，包括：

- 从源码包快速部署
- daemon 管理和配置
- systemd 服务部署（可选）
- LLM 供应商配置
- 安全机制说明
- 故障排查
- 技能生成引导

## 项目结构

```text
src/
├── index.ts              # YuanbaoBot 主入口
├── types.ts              # 类型定义
├── logger.ts             # 日志
├── access/               # WS/HTTP 访问层
├── business/
│   ├── llm-takeover.ts   # LLM 引擎 (Vercel AI SDK + invoke + billing)
│   ├── mention.ts        # @提及（含 @all + 别名解析 + ID 昵称获取）
│   ├── interpolate.ts     # ${} 插值（安全屏蔽）
│   ├── reminders.ts      # 持久化提醒 + cron
│   ├── trust.ts          # 用户信任系统
│   ├── batch.ts          # 批量发送
│   ├── sticker.ts        # 贴纸
│   ├── alias.ts          # 别名
│   ├── contacts.ts       # 联系人
│   ├── groups.ts         # 群组
│   ├── history.ts        # 消息历史
│   └── search.ts         # 搜索
├── commands/
│   ├── registry.ts       # 命令注册与分发
│   ├── help-text.ts      # 帮助文本
│   └── types.ts          # 命令类型
├── shared/               # CLI 与 commands 共享模块
│   ├── config.ts         # ConfigStore
│   ├── rich-history.ts   # 命令历史
│   ├── auto-complete.ts  # Tab 补全
│   └── syntax-highlight.ts
├── cli/                  # daemon-first CLI
│   ├── index.ts          # 入口
│   ├── config.ts         # 重新导出 shared/config
│   ├── theme.ts          # 颜色 + 无边框渲染
│   ├── daemon/           # HTTP 服务器 (端口 8992)
│   └── client/           # CLI 客户端
└── version.ts            # 版本
```

## 配置文件

```text
~/.yuanbao-lite/
├── config.json          # 主配置（档案/凭证）
├── daemon.pid           # daemon PID
├── contacts.json        # 联系人
├── groups.json          # 群组
├── aliases.json         # 别名
├── history.jsonl        # 消息历史
├── history              # CLI 命令历史
├── llm-config.json      # LLM 配置（含密钥池/供应商池）
├── trust.json           # 信任列表
└── reminders.json       # 提醒和定时任务
```

## 开发

```bash
git clone https://github.com/ShiningYangYXN/yuanbao-lite.git
cd yuanbao-lite
pnpm install
pnpm build
pnpm lint
```

## 许可证

MIT
