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
```

### 非 systemd 部署

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
| trust.json | 信任列表 + 单命令授权 |
| block.json | 封禁列表 |
| reminders.json | 提醒和定时任务 |

daemon 启动时自动检查所有安全模块文件，缺失或损坏时自动创建空壳（trust.json/block.json 等均为有效 JSON 结构，非全空）。

## daemon 管理端口

默认端口 `8992`。修改：

```bash
node dist/cli/index.js daemon start --port 9000
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

# 切换到供应商
node dist/cli/index.js rc "/llm customprovider use my-openai"

# 开启自动回复
node dist/cli/index.js rc "/llm on"

# 查看用量
node dist/cli/index.js rc "/llm billing"
```

### 重置 LLM 配置

```bash
# CLI 直接执行（无需确认）
node dist/cli/index.js rc "/llm reset"

# 私聊中需要3次确认
/llm reset
/llm reset
/llm reset
```

### 支持的 API 格式

- `openai-chat-completions` — OpenAI 及兼容 API (DeepSeek/Moonshot/通义千问)
- `anthropic-messages` — Anthropic Claude
- `google-gemini-rest` — Google Gemini
- `aws-bedrock-converse` — AWS Bedrock
- `azure-openai` — Azure OpenAI

## 安全机制

### 优先级

**block > trust > unsafe**

被封禁用户不能被添加到信任列表，会被立即从信任列表移除。CLI 全局最高权限绕过所有限制。

### 信任系统

- 主人 (bot owner) 自动受信，不可移除
- 受信用户才能开启危险模式或管理信任列表
- `/trust status` — 查看信任状态 + 单命令授权（全局开放）
- `/trust list|add|remove` — 管理信任列表（仅私聊，unsafe 模式下可在群聊使用）
- `/trust grant <ID> <命令> [分钟|forever]` — 授权单命令给单用户
- `/trust revoke <ID> <命令>` — 撤销授权
- 命令名可加/也可不加，支持别名（如 sh = shell）

### 封禁系统

- `/block add <ID|*> <范围> [昵称]` — 封禁用户
  - 范围: `[all]` `[llm]` `[command]` 或命令名（如 shell）
  - 权限组必须加方括号，命令名无需加/
  - `*` 作为用户ID可封禁所有用户（全局）
  - 多次操作附加范围
- `/block remove <ID|*> [范围]` — 解封
- 主人不能被封禁
- unsafe 模式下可在群聊管理封禁

### 危险模式

- `/unsafe on [分钟]` — 开启全局危险模式（默认5分钟）
- `/unsafe on forever` — 永久开启
- `/unsafe allow <命令> [分钟|forever]` — 全局授权单命令
- 不可授权命令: unsafe, trust, block, config, init, daemon

### 系统提示词

- 默认系统提示词不可被用户覆盖
- 用户可通过 `userSystemPrompt` 追加自定义提示词

## 阻塞式会话

所有阻塞式会话统一使用 session-scoped 隔离（同一用户 + 同一会话才捕获），5 分钟无操作自动退出：

| 会话 | 启动 | 退出 |
|------|------|------|
| /init 向导 | `/init` | 完成或 `/init cancel` |
| /llm config 向导 | `/llm config` | 完成或 `/llm config cancel` |
| /term 终端 | `/term` | `/term exit` 或 `exit` |
| /switch 上下文 | `/switch group <群号>` | `/switch exit` |
| /join 群聊 | `/join <群号>` | `/switch exit` |

## CLI 使用

```bash
# 交互式 REPL
node dist/cli/index.js

# 执行任意命令 (CLI 无需确认，全局最高权限)
node dist/cli/index.js rc /help
node dist/cli/index.js rc /status
node dist/cli/index.js rc /ip 8.8.8.8

# 发送消息
node dist/cli/index.js send dm <userId> "hello"
node dist/cli/index.js send group <groupCode> "hello"

# 配置管理
node dist/cli/index.js config show
node dist/cli/index.js config set logLevel debug

# daemon 管理
node dist/cli/index.js daemon start
node dist/cli/index.js daemon stop
node dist/cli/index.js daemon restart
node dist/cli/index.js daemon status
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
5. **安全文件缺失**: daemon 启动时自动创建空壳，无需手动处理
6. **systemd 启动失败**: 检查 `journalctl -u yuanbao-lite` 日志，确认路径和权限

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

# 查看安全状态
node dist/cli/index.js rc /trust status
node dist/cli/index.js rc /block status
node dist/cli/index.js rc /unsafe status

# 查看所有命令
node dist/cli/index.js rc /commands
```

## 技能生成引导

作为 OpenClaw 实例，你应该基于本文件生成以下技能：

1. **部署技能**: 从源码包完成安装、编译、配置、启动的完整流程
2. **systemd 管理技能**: 创建、启用、管理 systemd 服务，包括日志查看和故障恢复
3. **LLM 配置技能**: 通过命令行或私聊完成 LLM 供应商配置，包括密钥池管理
4. **安全审计技能**: 检查信任列表、封禁列表、危险模式状态、授权白名单，确保安全配置合理
5. **故障诊断技能**: 通过日志、健康检查、状态查询定位问题并修复

生成技能时，请参考本文件中的具体命令和配置示例。
