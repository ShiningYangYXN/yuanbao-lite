# Yuanbao Lite

轻量级独立腾讯元宝机器人客户端 — 聊天、命令、媒体、贴纸、LLM 接管、交互式 CLI。

[![npm version](https://img.shields.io/npm/v/yuanbao-lite.svg)](https://www.npmjs.com/package/yuanbao-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 特性

- **daemon-first 架构** — CLI 与 daemon 分离，零 WebSocket 重连
- **Vercel AI SDK** — 支持 5 种 API 格式（OpenAI/Anthropic/Gemini/Bedrock/Azure）
- **命令系统** — 45+ 内置斜杠命令，CLI 与 IM 共享同一套实现
- **LLM 接管** — 密钥池+供应商池+自动切换，命令 invoke 迭代调用
- **安全机制** — 用户信任系统，群聊插值屏蔽，危险命令限制
- **持久化提醒** — /remind + /cron 自动持久化，daemon 重启后恢复
- **@提及** — `@[昵称](id)` / `@[](id)` / `@[昵称]()` / `@[所有人]()`
- **Shell 体验** — readline + 历史记录 + Tab 补全 + 多行输入

## 快速开始

### 1. 安装

```bash
npm install yuanbao-lite
# 或
pnpm add yuanbao-lite
```text

### 2. 初始化配置

```bash
# 交互式配置向导
npx yb-cli config init

# 或直接设置
npx yb-cli config set appKey 你的AppKey
npx yb-cli config set appSecret 你的AppSecret

# 验证
npx yb-cli config show
```text

### 3. 启动 daemon

```bash
npx yb-cli daemon start
# 或
pnpm daemon
```text

### 4. 使用 CLI

```bash
# 交互式 REPL
npx yb-cli

# 非交互式命令（自动通过 daemon 执行）
npx yb-cli send dm <userId> "你好"
npx yb-cli status
npx yb-cli rc /help
```text

## LLM 配置

### 通过 CLI 向导

```bash
npx yb-cli interactive
# 然后在 REPL 中输入:
/llm config
```text

### 通过 IM 私聊

```text
/llm config
# 向导引导: API格式 → 供应商名称 → 模型 → 端点 → 密钥 → 系统提示词
```text

### 支持的 API 格式

| 格式 | 说明 | 默认端点 |
|------|------|----------|
| openai-chat-completions | OpenAI 及兼容 API (DeepSeek/Moonshot 等) | https://api.openai.com/v1 |
| anthropic-messages | Anthropic Claude | https://api.anthropic.com |
| google-gemini-rest | Google Gemini | https://generativelanguage.googleapis.com/v1beta |
| aws-bedrock-converse | AWS Bedrock | (region-based) |
| azure-openai | Azure OpenAI | https://{resource}.openai.azure.com/openai |

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
```text

## 命令列表

### 核心

| 命令 | 说明 |
|------|------|
| `/help [命令名]` | 显示帮助 |
| `/status` | bot 状态 |
| `/version` | 版本 |
| `/ping` | 延迟测试 |
| `/echo <文本>` | 回显 |
| `/calc <表达式>` | 数学计算 |
| `/time [时区]` | 时间查询 |
| `/whoami` | 查看自己的信息 |

### 网络

| 命令 | 说明 |
|------|------|
| `/ip <IP>` | IP 地理位置查询（IPv4+IPv6，多服务商并发） |
| `/whois <域名>` | 域名 WHOIS 查询（RDAP） |
| `/myip` | 服务器 IP 信息（双栈+AS+地区，仅私聊） |

### 提醒与定时

| 命令 | 说明 |
|------|------|
| `/remind <时间> <消息>` | 定时提醒（持久化，任意时长/时间点） |
| `/remind list` | 查看提醒列表 |
| `/remind cancel <ID>` | 取消提醒 |
| `/cron <表达式> <消息>` | 周期定时任务（持久化，仅私聊） |
| `/cron list` | 查看定时任务 |
| `/cron cancel <ID>` | 取消定时任务 |

时间格式: `30s` `5m` `2h` `1d` `1w` `1mo` `1y` `14:30` `2026-06-18 14:30` `1d2h3m`

cron 表达式: `分 时 日 月 周`（如 `30 9 * * 1-5` = 工作日9:30）

### 安全

| 命令 | 说明 |
|------|------|
| `/trust status` | 查看信任状态（全局开放） |
| `/trust list` | 信任列表（仅私聊） |
| `/trust add <ID> [昵称]` | 添加受信用户（仅私聊） |
| `/trust remove <ID>` | 移除受信用户（仅私聊，主人不可移除） |
| `/unsafe status` | 查看危险模式状态（全局开放） |
| `/unsafe on [分钟]` | 开启危险模式（需受信） |
| `/unsafe off` | 关闭危险模式 |

### LLM

| 命令 | 说明 |
|------|------|
| `/llm status` | LLM 状态（含密钥池/供应商池） |
| `/llm billing` | 用量统计（调用次数/Token/按供应商分组） |
| `/llm on` / `/llm off` | 开关自动回复 |
| `/llm config` | 交互式配置向导 |
| `/llm chat <消息>` | 单次对话 |
| `/llm customprovider ...` | 供应商管理 |
| `/llm model <名称>` | 切换模型 |

### daemon 管理（仅私聊，3次确认）

| 命令 | 说明 |
|------|------|
| `/daemon status` | daemon 状态 |
| `/daemon stop` | 停止（1分钟内3次） |
| `/daemon restart` | 重启（1分钟内3次） |
| `/daemon reset` | 重置（1分钟内3次） |

### 配置（仅私聊）

| 命令 | 说明 |
|------|------|
| `/init` | 交互式配置向导（阻塞） |
| `/init appkey <值>` | 设置 App Key |
| `/config show` | 显示配置 |
| `/config set <key> <value>` | 设置配置项 |
| `/config profile list` | 档案列表 |
| `/config profile switch <name>` | 切换档案 |

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
@[](id)        — 用默认昵称 @指定用户（自动获取昵称）
@[昵称]()      — 群聊中按昵称自动匹配 ID
@[所有人]()    — @所有人
@[](all)       — @所有人（等价）
@[所有人](all) — @所有人（等价）
\@             — 转义 @
```text

## 插值语法

```text
${i + 1}              — 表达式求值
${new Date().toISOString()}  — JS 表达式
\${literal}           — 转义，输出 ${literal}
```text

群聊中（非 unsafe 模式）自动屏蔽危险全局变量（process、env、require、fetch 等）。

## pnpm 脚本

```bash
pnpm build          # 编译
pnpm cli            # 启动 CLI
pnpm daemon         # 启动 daemon
pnpm daemon:stop    # 停止 daemon
pnpm daemon:status  # daemon 状态
pnpm daemon:restart # 重启 daemon
pnpm lint           # ESLint
```text

## 项目结构

```text
src/
├── index.ts              # YuanbaoBot 主入口
├── types.ts              # 类型定义
├── logger.ts             # 日志
├── access/               # WS/HTTP 访问层
├── business/
│   ├── llm-takeover.ts   # LLM 引擎 (Vercel AI SDK)
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
│   ├── daemon/           # HTTP 服务器
│   └── client/           # CLI 客户端
└── version.ts            # 版本
```text

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
├── llm-config.json      # LLM 配置
├── trust.json           # 信任列表
└── reminders.json       # 提醒和定时任务
```text

## 开发

```bash
git clone https://github.com/ShiningYangYXN/yuanbao-lite.git
cd yuanbao-lite
pnpm install
pnpm build
pnpm lint
```text

## 许可证

MIT
