# Yuanbao Lite

轻量级独立腾讯元宝机器人客户端 — 聊天、命令、媒体、贴纸、LLM 接管、交互式 CLI。

[![npm version](https://img.shields.io/npm/v/yuanbao-lite.svg)](https://www.npmjs.com/package/yuanbao-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **OpenClaw 实例请查看 [CLAW.md](CLAW.md)** — 包含从源码部署、daemon 管理、systemd 集成、技能生成引导等完整运维指南。

## 特性

- **daemon-first 架构** — CLI 与 daemon 分离，零 WebSocket 重连
- **Vercel AI SDK** — 支持 5 种 API 格式（OpenAI/Anthropic/Gemini/Bedrock/Azure）
- **命令系统** — 53 个内置斜杠命令，CLI 与 IM 共享同一套实现，一命令一文件按分类组织
- **LLM 接管** — 密钥池+供应商池+自动切换，命令 invoke 迭代调用，用量统计，日期时间戳上下文
- **安全机制** — 用户信任系统 + 封禁系统（block > trust > unsafe 优先级），单命令单用户授权，CLI 全局最高权限
- **阻塞式会话** — /init 向导、/llm config 向导、/term 终端、/switch 上下文切换，统一 session-scoped 隔离，5 分钟无操作自动退出
- **@提及** — `@[昵称](id)` / `@[所有人]()` / `@[](all)` / 别名解析 / ID 昵称获取 / 命令参数 @ 引用解析
- **消息上下文** — `[YYYY-MM-DD HH:MM:SS] [昵称](用户ID)@群名: 文本 [引用: #尾号]`，@提及原位注入，Bot 回复自动注入
- **持久化提醒** — /remind（任意时长+时间点）+ /cron（cron 表达式），自动持久化
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

daemon 默认监听 `127.0.0.1:8992`。

### 4. 使用 CLI

```bash
# 交互式 REPL
npx yb-cli

# 非交互式命令（自动通过 daemon 执行，CLI 无需确认）
npx yb-cli send dm <userId> "你好"
npx yb-cli rc /help
npx yb-cli rc /ip 8.8.8.8
```

## LLM 配置

### 通过向导

私聊发送 `/llm config` 或在 CLI 中输入 `/llm config`，向导引导完成配置：

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

- 默认系统提示词**不可被覆盖**，包含命令执行、迭代调用、安全机制、@提及语法、消息条目格式等完整文档
- 用户可通过 `userSystemPrompt` 配置项追加自定义提示词
- 自定义提示词以「用户添加的系统提示词」为标头拼接在默认提示词之后

## 命令列表

### 信息与工具

| 命令 | 说明 |
|------|------|
| `/help [命令名]` | 显示帮助 |
| `/commands` | 列出所有命令和别名（紧凑格式） |
| `/status` | bot 状态 |
| `/version` | 版本 |
| `/ping` | 延迟测试 |
| `/echo <文本>` | 回显 |
| `/calc <表达式>` | 数学计算 |
| `/time [时区]` | 时间查询 |
| `/whoami` | 查看自己的信息（用户ID、昵称、群名、信任状态） |
| `/inspect [消息ID/#尾号]` | 输出消息内部表示法（无参数用引用消息） |

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
| `/cron <表达式> <消息>` | 周期定时任务（持久化，仅私聊，可指定目标） |

时间格式: `30s` `5m` `2h` `1d` `1w` `1mo` `1y` `14:30` `2026-06-18 14:30` `1d2h3m`
cron: `分 时 日 月 周`（如 `30 9 * * 1-5` = 工作日9:30）

### 安全

| 命令 | 说明 |
|------|------|
| `/trust status` | 查看信任状态 + 单命令授权（全局开放） |
| `/trust list/add/remove` | 管理信任列表（仅私聊，主人不可移除） |
| `/trust grant <ID> <命令> [分钟]` | 授权单命令给单用户（支持别名，如 sh = shell） |
| `/trust revoke <ID> <命令>` | 撤销单用户单命令授权 |
| `/trust grants [ID]` | 查看单命令授权 |
| `/block status` | 查看封禁状态（全局开放） |
| `/block list` | 查看封禁列表 |
| `/block add <ID\|*> <范围>` | 封禁用户（范围: `[all]` `[llm]` `[command]` `<命令名>`） |
| `/block remove <ID\|*> [范围]` | 解封 |
| `/unsafe status` | 查看危险模式+授权白名单 |
| `/unsafe on [分钟/forever]` | 开启全局危险模式（默认5分钟，需受信） |
| `/unsafe allow <命令> [分钟]` | 全局授权单命令（支持别名） |
| `/unsafe disallow <命令>` | 取消授权 |

优先级: **block > trust > unsafe**。被封禁用户不能被信任。CLI 全局最高权限绕过所有限制。

### 系统管理

| 命令 | 说明 |
|------|------|
| `/shell [--all] <命令>` | 执行系统命令（仅私聊，`--all` 不截断输出） |
| `/term` | 进入交互式终端（仅私聊，5分钟超时，`/term exit` 退出） |
| `/log <级别>` | 切换日志级别 |
| `/daemon status` | daemon 状态 |
| `/daemon stop/restart/reset` | daemon 管理（1分钟内3次确认，CLI 直接执行） |
| `/config reset` | 清空所有配置文件（3次确认，CLI 直接执行） |
| `/llm reset` | 清空所有LLM配置（3次确认，CLI 直接执行） |

### LLM

| 命令 | 说明 |
|------|------|
| `/llm status` | LLM 状态 |
| `/llm billing` | 用量统计 |
| `/llm on` / `off` | 开关自动回复 |
| `/llm config` | 交互式配置向导（阻塞） |
| `/llm chat <消息>` | 单次对话 |
| `/llm customprovider ...` | 供应商管理 |
| `/llm model <名称>` | 切换模型 |
| `/llm merge [ms]` | 消息合并窗口（0=关闭，默认0） |
| `/llm cooldown [ms]` | 响应冷却（0=关闭，默认0） |
| `/llm reset` | 清空所有LLM配置 |
| `/new [dm <ID>\|group <群号>]` | 清空当前或指定会话的LLM上下文 |

### 配置

| 命令 | 说明 |
|------|------|
| `/init` | 交互式配置向导（阻塞） |
| `/config show` / `set <key> <value>` | 查看/设置配置 |
| `/config profile list/switch/add/remove` | 档案管理 |
| `/config reset` | 清空所有配置文件 |

### 聊天、贴纸与媒体

| 命令 | 说明 |
|------|------|
| `/dm <ID> <消息>` | 私聊 |
| `/group <群号> <消息>` | 群聊 |
| `/reply [消息ID] <内容>` | 引用回复（省略ID用引用消息） |
| `/atall <群号> <消息>` | @所有人（逐个展开） |
| `/mention <目标> <消息>` | 发送含@提及的消息 |
| `/upload <文件>` | 上传文件 |
| `/download <URL>` | 下载文件 |
| `/sticker <ID>` | 发送贴纸 |
| `/stickers search <关键词>` | 搜索贴纸 |
| `/batch text/sticker/image/file ...` | 批量发送 |

### 群聊与历史

| 命令 | 说明 |
|------|------|
| `/groups list/add/remove` | 群组管理 |
| `/groupinfo <群号>` | 群信息 |
| `/members <群号>` | 群成员列表 |
| `/join <群号>` | 加入群聊（阻塞式切换上下文） |
| `/switch group <群号>\|dm <ID>\|exit` | 阻塞式上下文切换（可嵌套） |
| `/history recent [数量]` | 当前会话最近消息 |
| `/history search <关键词>` | 搜索历史 |
| `/hsearch <关键词>` | 搜索历史 |
| `/hclear` | 清空历史 |

### 实用工具

| 命令 | 说明 |
|------|------|
| `/alias add/remove/list` | 别名管理 |
| `/contacts list/add/remove/dm` | 联系人管理 |
| `/account add/remove/list/switch` | 多账号管理 |

## @提及语法

```text
@[昵称](id)    — 用指定昵称 @指定用户
@[](id)        — 自动获取昵称 @指定用户
@[昵称]()      — 群聊中按昵称自动匹配 ID（也支持别名）
@[所有人]()    — @所有人（逐个展开每个群成员）
@[](all)       — @所有人（等价）
\@             — 转义 @
```

命令参数中引用用户可用 `@` 代替 ID：`/trust add @小明 10分钟`（支持 `@[nick](id)`、`@nick`、`@<bareId>` 和别名）

## 消息上下文格式

LLM 上下文中的每条消息格式：

```text
[YYYY-MM-DD HH:MM:SS] [昵称](用户ID)@群名或DM: 消息文本 [引用: #消息ID尾号]
```

- @提及在原位以 `@[昵称](用户ID)` 语法显示
- Bot 回复自动注入为 ASSISTANT 上下文（按会话分开）
- 其他 bot 的消息也注入上下文

## 阻塞式会话

所有阻塞式会话统一使用 session-scoped 隔离（同一用户 + 同一会话才捕获），5 分钟无操作自动退出：

| 会话 | 启动命令 | 退出方式 |
|------|----------|----------|
| /init 向导 | `/init` | 完成或 `/init cancel` |
| /llm config 向导 | `/llm config` | 完成或 `/llm config cancel` |
| /term 终端 | `/term` | `/term exit` 或 `exit` |
| /switch 上下文 | `/switch group <群号>` | `/switch exit` |
| /join 群聊 | `/join <群号>` | `/switch exit` |

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

## 项目结构

```text
src/
├── index.ts              # YuanbaoBot 主入口
├── types.ts              # 类型定义
├── logger.ts             # 日志
├── access/               # WS/HTTP 访问层
├── business/
│   ├── llm-takeover.ts   # LLM 引擎 (Vercel AI SDK + invoke + billing)
│   ├── mention.ts        # @提及（含 @all 逐个展开 + escapeMentionSyntax）
│   ├── trust.ts          # 用户信任系统（持久化 + 单命令授权）
│   ├── block.ts          # 封禁系统（block > trust > unsafe）
│   ├── interpolate.ts    # ${} 插值（安全屏蔽）
│   ├── reminders.ts      # 持久化提醒 + cron
│   ├── messaging/        # 消息提取（含 link card URL 提取）
│   └── ...
├── commands/
│   ├── registry.ts       # 命令注册与分发（config/log/UNAUTHORIZABLE 已公开）
│   ├── handlers/         # 一命令一文件，按分类子目录
│   │   ├── info/         # 信息与工具
│   │   ├── system/       # 系统管理
│   │   ├── chat/         # 聊天与贴纸
│   │   ├── group/        # 群聊管理
│   │   ├── media/        # 媒体与文件
│   │   ├── history/      # 消息历史
│   │   ├── llm/          # LLM 接管
│   │   └── utility/      # 实用工具
│   ├── session-utils.ts  # 阻塞式会话 session key + 超时
│   ├── help-text.ts      # 帮助文本（8 个分类）
│   └── types.ts          # 命令类型
├── shared/
│   └── config.ts         # ConfigStore（CLI + commands 共享）
├── cli/
│   ├── index.ts          # 入口（daemon-first 路由）
│   ├── client/           # CLI 客户端 + rich-history + auto-complete
│   ├── daemon/           # HTTP 服务器 (端口 8992) + ensureSecurityFiles
│   └── theme.ts          # 颜色 + 无边框渲染
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
├── llm-config.json      # LLM 配置（含密钥池/供应商池）
├── trust.json           # 信任列表 + 单命令授权
├── block.json           # 封禁列表
└── reminders.json       # 提醒和定时任务
```

daemon 启动时自动检查所有安全模块文件，缺失或损坏时自动创建空壳。

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
