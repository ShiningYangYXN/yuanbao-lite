# Yuanbao Lite

轻量级独立腾讯元宝机器人客户端 — 聊天、命令、媒体、贴纸、LLM 接管、交互式 CLI。

[![npm version](https://img.shields.io/npm/v/yuanbao-lite.svg)](https://www.npmjs.com/package/yuanbao-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 特性

- **daemon-first 架构** — CLI 与 daemon 分离，零 WebSocket 重连
- **命令系统** — 40+ 内置斜杠命令，CLI 与 IM 共享同一套实现
- **LLM 接管** — 支持 z-ai / openai / anthropic / deepseek / custom，密钥池+供应商池+自动切换
- **媒体处理** — 图片/文件/视频/语音上传下载，临时文件托管 (gofile/tmpfiles/uguu/litterbox)
- **贴纸系统** — 内置表情，模糊搜索，自定义贴纸包加载
- **批量发送** — text/sticker/image/file 模板插值，并发任务管理
- **@提及** — `@[昵称](id)` / `@[](id)` / `@[昵称]()` 自动匹配 / `@[所有人]()` @all
- **Shell 体验** — readline + 历史记录 + Tab 补全 + 多行输入
- **无边框设计** — 仅用颜色 + 空格对齐，无 box-drawing 字符

## 快速开始

### 1. 安装

```bash
npm install yuanbao-lite
# 或
pnpm add yuanbao-lite
```

### 2. 初始化配置（使用 CLI 向导）

```bash
# 启动交互式配置向导
npx yb-cli config init

# 或直接设置认证信息
npx yb-cli config set appKey 你的AppKey
npx yb-cli config set appSecret 你的AppSecret

# 验证配置
npx yb-cli config show
```

### 3. 启动 daemon（后台运行）

```bash
# 前台启动（开发调试）
npx yb-cli daemon start

# 或通过 pnpm
pnpm daemon

# daemon 启动后会自动连接元宝 WebSocket
```

### 4. 使用 CLI

```bash
# 交互式 REPL（shell 体验：↑↓ 历史 / Tab 补全 / \ 换行）
npx yb-cli

# 非交互式命令
npx yb-cli send dm <userId> "你好"
npx yb-cli send group <groupCode> "群消息"
npx yb-cli status
npx yb-cli contacts list
```

## daemon 管理

```bash
# 启动 / 停止 / 状态 / 重启
pnpm daemon:start
pnpm daemon:stop
pnpm daemon:status
pnpm daemon:restart

# daemon 自动杀菌：新 daemon 启动时自动 SIGTERM 旧 daemon
# daemon 持有 YuanbaoBot 单例，CLI 是瘦客户端
```

## IM 斜杠命令

通过私聊或群聊发送斜杠命令，与 CLI 共享同一套 CommandSystem。

### 核心命令

| 命令 | 说明 |
|------|------|
| `/help [命令名]` | 显示帮助（指定命令名显示详细用法） |
| `/status` | 查看 bot 连接状态 |
| `/version` | 查看版本 |
| `/uptime` | 查看运行时间 |
| `/ping` | 延迟测试 |

### 聊天命令

| 命令 | 说明 |
|------|------|
| `/chat [dm <id> \| group <code>]` | 切换聊天模式 |
| `/dm <用户ID> <消息>` | 发送私聊 |
| `/group <群号> <消息>` | 发送群聊 |
| `/mention <目标> <消息>` | 含 @提及的消息 |
| `/atall <群号> <消息>` | @所有人 |
| `/reply <消息ID> <回复>` | 引用回复 |
| `/join <群号>` | 加入群聊会话 |
| `/switch [编号]` | 查看/切换会话 |

### 配置命令（仅私聊）

| 命令 | 说明 |
|------|------|
| `/init` | 交互式配置向导 |
| `/init appkey <值>` | 设置 App Key |
| `/init appsecret <值>` | 设置 App Secret |
| `/init token <值>` | 设置 Token |
| `/config show` | 显示配置 |
| `/config set <key> <value>` | 设置配置项 |
| `/config profile list` | 列出档案 |
| `/config profile switch <name>` | 切换档案 |
| `/config export` | 导出配置 JSON |
| `/config import <json>` | 导入配置 |

### daemon 命令（仅私聊，3次确认）

| 命令 | 说明 |
|------|------|
| `/daemon status` | 查看 daemon 状态 |
| `/daemon stop` | 停止 daemon（1分钟内发3次） |
| `/daemon restart` | 重启 daemon（1分钟内发3次） |
| `/daemon reset` | 重置 daemon（清缓存+重启，1分钟内发3次） |

### LLM 命令

| 命令 | 说明 |
|------|------|
| `/llm status` | 查看 LLM 状态（含密钥池/供应商池） |
| `/llm on` / `/llm off` | 开关自动回复 |
| `/llm chat <消息>` | 单次对话 |
| `/llm model <名称>` | 切换模型 |
| `/llm provider <供应商>` | 切换供应商 |
| `/llm keypool add <key>` | 添加密钥到池 |
| `/llm providerpool add <provider> <model> <apiKey>` | 添加供应商到池 |

### 工具命令

| 命令 | 说明 |
|------|------|
| `/calc <表达式>` | 数学计算 (`/calc sqrt(16) + 10`) |
| `/time [时区]` | 显示时间 (`/time Asia/Tokyo`) |
| `/remind <时间> <消息>` | 定时提醒 (`/remind 5m 开会`) |
| `/ip <IP>` | IP 地理位置查询（多服务商并发） |
| `/echo <文本>` | 回显文本 |

### 批量发送

```bash
/batch text <目标> <数量> <间隔ms> "模板${i}"
/batch sticker <目标> <数量> <间隔ms> <stickerId模板>
/batch image <目标> <数量> <间隔ms> <文件路径模板>
/batch list          # 查看运行中的批量任务
/batch stop [id]     # 取消任务
/batch status [id]   # 查看进度
```

模板变量: `${i}` (索引), `${n}` (序号), `${total}` (总数), `${timestamp}` (时间戳)

## @提及语法

```text
@[昵称](id)    — 用指定昵称 @指定用户
@[](id)        — 用默认昵称 @指定用户
@[昵称]()      — 群聊中按昵称自动匹配 ID
@[所有人]()    — @所有人（逐个 @每个群成员）
@[](all)       — @所有人（等价写法）
\@             — 转义 @，不作为提及
```

## 插值语法

```text
${i + 1}              — 表达式求值
${new Date().toISOString()}  — JS 表达式
${Math.random()}      — 内置 Math/Date/JSON 等
${env.HOME}           — 环境变量（仅 unsafe 模式）
\${literal}           — 转义，输出 ${literal}
```

**安全机制**: 群聊中（非 unsafe 模式）插值会自动屏蔽危险全局变量（process、env、require、fetch 等），防止泄露服务器信息。私聊或 `/unsafe on` 后可使用完整插值。

## LLM 密钥池与供应商池

```bash
# 添加多个密钥，401/429 时自动轮转
/llm keypool add sk-key1
/llm keypool add sk-key2
/llm keypool add sk-key3

# 添加备用供应商，连续失败自动切换
/llm providerpool add openai gpt-4o sk-xxx
/llm providerpool add anthropic claude-3-5-sonnet sk-yyy

# 查看池状态
/llm status
```

- 密钥池：连续失败 3 次自动冷却 5 分钟并切换下一个密钥
- 供应商池：所有密钥耗尽后自动切换到下一个供应商
- 成功调用重置失败计数

## 自定义供应商管理

可以添加自定义名称的供应商，每个供应商有独立的密钥池：

```bash
# 添加自定义供应商 (name, type, [model], [baseUrl])
/llm customprovider add my-azure openai gpt-4o https://xxx.openai.azure.com
/llm customprovider add backup-claude anthropic claude-3-5-sonnet

# 为供应商添加密钥（独立密钥池）
/llm customprovider addkey my-azure sk-key1
/llm customprovider addkey my-azure sk-key2

# 列出所有自定义供应商
/llm customprovider list

# 切换到自定义供应商
/llm customprovider use my-azure

# 移除密钥/供应商
/llm customprovider removekey my-azure 0
/llm customprovider remove my-azure
```

type 可选: `openai` `anthropic` `deepseek` `custom` `z-ai`

## 用户信任机制

机器人主人（通过 appKey 识别）自动受信，不可被移除。受信用户可在群聊开启 unsafe 模式。

```bash
# 查看信任列表
/trust list

# 添加受信用户
/trust add <用户ID> [昵称]

# 移除受信用户（主人不可移除）
/trust remove <用户ID>

# 查看自己的信任状态
/trust status
```

**群聊受限命令流程**:
1. 非受信用户在群聊发 dmOnly 命令 → 提示联系主人添加信任
2. 受信用户在群聊发 dmOnly 命令 → 提示发送 `/unsafe on` 开启
3. `/unsafe on` 后 5 分钟内可在群聊使用 dmOnly 命令
4. `/unsafe off` 立即关闭

## /init 交互式配置

`/init` 启动后会阻塞当前对话，引导用户完成配置：

```bash
# 启动向导（仅私聊）
/init

# 向导流程:
# 1. 选择认证方式: 发送 "appkey" 或 "token"
# 2. 输入 App Key / Token
# 3. 输入 App Secret (仅 appkey 方式)
# 4. 配置完成，提示重启 daemon

# 取消向导
/init cancel

# 直接设置字段（非交互式）
/init appkey <值>
/init appsecret <值>
/init token <值>
```

向导有 5 分钟超时，超时自动取消。

## pnpm 脚本

```bash
pnpm build          # 编译 TypeScript
pnpm cli            # 启动 CLI (默认交互式)
pnpm daemon         # 启动 daemon
pnpm daemon:stop    # 停止 daemon
pnpm daemon:status  # 查看 daemon 状态
pnpm daemon:restart # 重启 daemon
pnpm lint           # ESLint 检查
pnpm lint:fix       # ESLint 自动修复
```

## 项目结构

```text
src/
├── index.ts                    # 主入口，YuanbaoBot 类
├── types.ts                    # 核心类型定义
├── accounts.ts                 # 账号解析
├── logger.ts                   # 日志与脱敏
├── access/
│   ├── http/                   # HTTP 访问层 (media, request, gofile, tempfile)
│   └── ws/                     # WebSocket 客户端
├── business/
│   ├── messaging/              # 消息提取与转换
│   ├── llm-takeover.ts         # LLM 接管（密钥池/供应商池）
│   ├── mention.ts              # @提及（含 @all）
│   ├── interpolate.ts          # ${} 插值（含安全屏蔽）
│   ├── batch.ts                # 批量发送
│   ├── sticker.ts              # 贴纸系统
│   ├── alias.ts                # 别名系统
│   ├── contacts.ts             # 联系人
│   ├── groups.ts               # 群组
│   ├── history.ts              # 消息历史
│   ├── multi-account.ts        # 多账号管理
│   └── search.ts               # 搜索引擎
├── commands/
│   ├── registry.ts             # 命令注册与分发（40+ 内置命令）
│   ├── help-text.ts            # 帮助文本生成
│   └── types.ts                # 命令类型定义
├── cli/                    # daemon-first 现代化 CLI
│   ├── index.ts                # 入口，daemon-first 路由
│   ├── config.ts               # 重新导出 src/cli-legacy/config.ts
│   ├── theme.ts                # 颜色调色板 + 无边框渲染
│   ├── daemon/
│   │   ├── server.ts           # HTTP 服务器 + SSE
│   │   ├── routes.ts           # REST 路由
│   │   └── pid-file.ts         # PID 文件 + 自动杀菌
│   └── client/
│       ├── daemon-client.ts    # HTTP 客户端 + ensureDaemon()
│       ├── commands.ts         # Commander 程序
│       ├── interactive.ts      # readline REPL
│       └── wizard.ts           # 配置向导
└── cli-legacy/                 # 旧版 CLI（保留向后兼容）
    ├── index.ts                # 旧版交互式 CLI
    ├── non-interactive.ts      # 旧版非交互式
    ├── config.ts               # ConfigStore（共享）
    ├── rich-history.ts         # 命令历史
    ├── auto-complete.ts        # Tab 补全
    └── syntax-highlight.ts     # 语法高亮
```

## 配置文件

配置文件位于 `~/.yuanbao-lite/config.json`：

```json
{
  "version": 1,
  "activeProfile": "default",
  "profiles": {
    "default": {
      "name": "default",
      "appKey": "***",
      "appSecret": "***",
      "logLevel": "info"
    }
  },
  "global": {
    "downloadDir": "~/Downloads/yuanbao-lite"
  }
}
```

其他文件：
- `~/.yuanbao-lite/daemon.pid` — daemon PID 文件
- `~/.yuanbao-lite/contacts.json` — 联系人
- `~/.yuanbao-lite/groups.json` — 群组
- `~/.yuanbao-lite/aliases.json` — 别名
- `~/.yuanbao-lite/history.jsonl` — 消息历史
- `~/.yuanbao-lite/history` — CLI 命令历史
- `~/.yuanbao-lite/llm-config.json` — LLM 配置（含密钥池/供应商池）

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
