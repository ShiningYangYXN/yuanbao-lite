# CLAW.md — OpenClaw 部署指南

本文件指导 OpenClaw 实例如何从源码包快速部署 yuanbao-lite。

## 环境要求

- Node.js >= 18
- pnpm >= 8
- 网络: 可访问 `bot.yuanbao.tencent.com` 和 `bot-wss.yuanbao.tencent.com`

## 从源码部署

```bash
# 1. 解压源码包
tar xzf yuanbao-lite-{version}.tar.gz
cd yuanbao-lite

# 2. 安装依赖
pnpm install

# 3. 编译
pnpm build

# 4. 初始化配置 (需要元宝平台 appKey/appSecret)
node dist/cli/index.js config init
# 或直接写入:
node dist/cli/index.js config set appKey YOUR_APP_KEY
node dist/cli/index.js config set appSecret YOUR_APP_SECRET

# 5. 启动 daemon (后台运行)
node dist/cli/index.js daemon start

# 6. 验证连接
node dist/cli/index.js daemon status
```

## 配置文件位置

所有配置和数据文件位于 `~/.yuanbao-lite/`:

| 文件 | 用途 |
|------|------|
| config.json | 主配置 (档案/凭证) |
| daemon.pid | daemon PID |
| contacts.json | 联系人 |
| groups.json | 群组 |
| aliases.json | 别名 |
| history.jsonl | 消息历史 |
| llm-config.json | LLM 配置 |
| trust.json | 信任列表 |
| reminders.json | 提醒和定时任务 |

## LLM 配置 (可选)

通过私聊发送 `/llm config` 启动配置向导，或直接使用命令:

```bash
# 添加 OpenAI 兼容供应商
# 语法: /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]
/llm customprovider add my-openai openai-chat-completions gpt-4o https://api.openai.com/v1 sk-xxx

# 切换到供应商
/llm customprovider use my-openai

# 开启自动回复
/llm on
```

支持的 API 格式:
- `openai-chat-completions` — OpenAI 及兼容 API
- `anthropic-messages` — Claude
- `google-gemini-rest` — Gemini
- `aws-bedrock-converse` — AWS Bedrock
- `azure-openai` — Azure OpenAI

## 守护进程管理

```bash
# 启动 / 停止 / 重启 / 状态
node dist/cli/index.js daemon start
node dist/cli/index.js daemon stop
node dist/cli/index.js daemon restart
node dist/cli/index.js daemon status
```

daemon 自动杀菌: 新 daemon 启动时自动 SIGTERM 旧 daemon。

## CLI 使用

```bash
# 交互式 REPL
node dist/cli/index.js

# 执行任意命令 (共享 CommandSystem)
node dist/cli/index.js rc /help
node dist/cli/index.js rc /status
node dist/cli/index.js rc /ip 8.8.8.8

# 发送消息
node dist/cli/index.js send dm <userId> "hello"
node dist/cli/index.js send group <groupCode> "hello"
```

## 安全机制

- **信任系统**: 主人 (bot owner) 自动受信，不可移除
- **危险模式**: `/unsafe on [分钟]` 临时允许 dmOnly 命令在群聊使用
- **永久危险模式**: `/unsafe on forever`
- **单命令授权**: `/unsafe allow <命令名>` 授权单个命令
- **插值安全**: 群聊中非 unsafe 模式自动屏蔽危险插值 (process/env/require 等)

## 日志

默认日志级别 `warn`。修改:

```bash
node dist/cli/index.js config set logLevel debug
# 然后重启 daemon
```

## 故障排查

1. **连接失败**: 检查 appKey/appSecret 是否正确
2. **daemon 不启动**: 检查端口 8992 是否被占用
3. **LLM 不工作**: 检查 `/llm status`，确保供应商已配置且有密钥
4. **命令不可用**: 检查 `/help <命令名>` 查看是否 dmOnly

## 快速验证

```bash
# 启动 daemon
node dist/cli/index.js daemon start

# 等待连接
sleep 5

# 检查状态
node dist/cli/index.js rc /status

# 测试计算
node dist/cli/index.js rc /calc 2+2

# 测试 IP 查询
node dist/cli/index.js rc /ip 8.8.8.8
```
