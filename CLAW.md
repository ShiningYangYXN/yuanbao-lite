# CLAW.md — OpenClaw 部署与管理指南

本文件指导 OpenClaw 实例如何从源码包部署、运行和管理 yuanbao-lite。

## 你是谁

你是 OpenClaw 实例，负责管理 yuanbao-lite 机器人服务。本文件是你的操作手册。

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

# 4. 初始化配置
node dist/cli/index.js config init
# 或直接写入:
node dist/cli/index.js config set appKey YOUR_APP_KEY
node dist/cli/index.js config set appSecret YOUR_APP_SECRET

# 5. 启动 daemon
node dist/cli/index.js daemon start

# 6. 验证连接
node dist/cli/index.js daemon status
```

## systemd 部署（推荐生产环境）

创建 systemd 服务文件实现开机自启和崩溃自动重启：

```bash
sudo tee /etc/systemd/system/yuanbao-lite.service << 'EOF'
[Unit]
Description=Yuanbao Lite Bot Daemon
After=network.target

[Service]
Type=simple
User={YOUR_USER}
WorkingDirectory={INSTALL_DIR}
ExecStart={NODE_PATH} {INSTALL_DIR}/dist/cli/index.js daemon start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 替换占位符
sudo sed -i 's|{YOUR_USER}|'"$USER"'|g' /etc/systemd/system/yuanbao-lite.service
sudo sed -i 's|{INSTALL_DIR}|'"$(pwd)"'|g' /etc/systemd/system/yuanbao-lite.service
sudo sed -i 's|{NODE_PATH}|'"$(which node)"'|g' /etc/systemd/system/yuanbao-lite.service

# 启用并启动
sudo systemctl daemon-reload
sudo systemctl enable yuanbao-lite
sudo systemctl start yuanbao-lite

# 查看状态
sudo systemctl status yuanbao-lite

# 查看日志
sudo journalctl -u yuanbao-lite -f
```

### systemd 管理命令

```bash
sudo systemctl start yuanbao-lite     # 启动
sudo systemctl stop yuanbao-lite      # 停止
sudo systemctl restart yuanbao-lite   # 重启
sudo systemctl status yuanbao-lite    # 状态
sudo journalctl -u yuanbao-lite -f    # 实时日志
sudo journalctl -u yuanbao-lite --since "1 hour ago"  # 最近1小时日志
```

### 非 systemd 部署

如果不需要 systemd，可以直接用 daemon 模式运行：

```bash
# 前台运行（调试用）
node dist/cli/index.js daemon start

# 后台运行
nohup node dist/cli/index.js daemon start > /var/log/yuanbao-lite.log 2>&1 &
```

daemon 会自动杀菌：新 daemon 启动时自动 SIGTERM 旧 daemon（通过 PID 文件）。

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
| llm-config.json | LLM 配置 (含密钥池/供应商池) |
| trust.json | 信任列表 |
| reminders.json | 提醒和定时任务 |

## daemon 管理端口

默认端口 `8992`（T9:TXYB 腾讯元宝）。修改：

```bash
node dist/cli/index.js daemon start --port 9000
```

或通过 CLI 命令：

```bash
node dist/cli/index.js rc /daemon status
node dist/cli/index.js rc /daemon stop
node dist/cli/index.js rc /daemon restart
```

## LLM 配置

### 通过向导配置

私聊机器人发送 `/llm config`，或在 CLI 中：

```bash
node dist/cli/index.js rc "/llm config"
```

向导会引导完成：API格式 → 供应商名称 → 模型 → 端点 → 密钥 → 系统提示词。

### 直接命令配置

```bash
# 添加供应商 (5种API格式可选)
node dist/cli/index.js rc "/llm customprovider add my-openai openai-chat-completions gpt-4o https://api.openai.com/v1 sk-xxx"

# 添加密钥到池
node dist/cli/index.js rc "/llm customprovider addkey my-openai sk-yyy"

# 切换到供应商
node dist/cli/index.js rc "/llm customprovider use my-openai"

# 开启自动回复
node dist/cli/index.js rc "/llm on"

# 查看用量
node dist/cli/index.js rc "/llm billing"
```

### 支持的 API 格式

- `openai-chat-completions` — OpenAI 及兼容 API (DeepSeek/Moonshot/通义千问)
- `anthropic-messages` — Anthropic Claude
- `google-gemini-rest` — Google Gemini
- `aws-bedrock-converse` — AWS Bedrock
- `azure-openai` — Azure OpenAI

## 安全机制

### 信任系统
- 主人 (bot owner) 自动受信，不可移除
- 受信用户才能开启危险模式或管理信任列表
- `/trust status` — 查看信任状态（全局开放）
- `/trust list|add|remove` — 管理信任列表（仅私聊）

### 危险模式
- `/unsafe on [分钟]` — 开启全局危险模式（默认5分钟）
- `/unsafe on forever` — 永久开启
- `/unsafe off` — 关闭
- `/unsafe status` — 查看状态 + 已授权命令白名单 + 过期时间

### 单命令授权
- `/unsafe allow <命令名> [分钟|forever]` — 授权单个 dmOnly 命令（默认5分钟）
- `/unsafe disallow <命令名>` — 取消授权（非 dmOnly 命令无法被 disallow）
- `/unsafe allow` — 查看已授权命令列表 + 过期时间
- 不可授权命令: unsafe, trust, config, init, daemon

### 系统提示词
- 默认系统提示词不可被用户覆盖
- 用户可通过 `userSystemPrompt` 追加自定义提示词
- 自定义提示词以「用户添加的系统提示词」为标头拼接在默认提示词之后

### 插值安全
- 群聊中非 unsafe 模式自动屏蔽危险插值 (process/env/require 等)

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

## 日志

默认日志级别 `warn`。修改：

```bash
node dist/cli/index.js config set logLevel debug
# 然后重启 daemon (systemd: sudo systemctl restart yuanbao-lite)
```

## 故障排查

1. **连接失败**: 检查 appKey/appSecret 是否正确
2. **daemon 不启动**: 检查端口 8992 是否被占用
3. **LLM 不工作**: 检查 `/llm status`，确保供应商已配置且有密钥
4. **命令不可用**: 检查 `/help <命令名>` 查看是否 dmOnly，使用 `/unsafe allow` 授权
5. **systemd 启动失败**: 检查 `journalctl -u yuanbao-lite` 日志，确认路径和权限

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

# 查看安全状态
node dist/cli/index.js rc /unsafe status
```

## 技能生成引导

作为 OpenClaw 实例，你应该基于本文件生成以下技能：

1. **部署技能**: 从源码包完成安装、编译、配置、启动的完整流程
2. **systemd 管理技能**: 创建、启用、管理 systemd 服务，包括日志查看和故障恢复
3. **LLM 配置技能**: 通过命令行或私聊完成 LLM 供应商配置，包括密钥池管理
4. **安全审计技能**: 检查信任列表、危险模式状态、授权白名单，确保安全配置合理
5. **故障诊断技能**: 通过日志、健康检查、状态查询定位问题并修复

生成技能时，请参考本文件中的具体命令和配置示例。
