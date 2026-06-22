# CLI 与 Daemon

Yuanbao Lite 采用 daemon-first 架构：CLI 是轻量客户端，所有重逻辑在 daemon 中执行。

## 架构

```
┌──────────────┐     HTTP      ┌──────────────────┐     WSS      ┌──────────┐
│   CLI 客户端  │ ──────────→  │   Daemon 服务     │ ──────────→ │  Tencent  │
│  (yb-cli)    │              │  (127.0.0.1:8992) │              │  元宝云    │
└──────────────┘              └──────────────────┘              └──────────┘
       │                              │
       │                              ├── YuanbaoBot 实例（常驻）
       │                              ├── 命令系统
       │                              ├── LLM 引擎
       │                              └── 所有 Store
       │
       └── 交互式 REPL / 非交互式命令
```

**优势**：
- 零 WebSocket 重连（daemon 保持连接）
- 多 CLI 会话共享同一 Bot 实例
- 配置更改即时生效（daemon 内部状态）

## 安装与启动

### 安装

```bash
npm install -g yuanbao-lite
# 或使用 npx
npx yb-cli --help
```

### 初始化配置

```bash
# 交互式向导
npx yb-cli config init

# 或直接设置
npx yb-cli config set appKey 你的AppKey
npx yb-cli config set appSecret 你的AppSecret

# 验证
npx yb-cli config show
```

### 启动 daemon

```bash
# 前台启动（调试用）
npx yb-cli daemon start --foreground

# 后台启动（默认）
npx yb-cli daemon start

# 查看状态
npx yb-cli daemon status

# 停止
npx yb-cli daemon stop

# 重启
npx yb-cli daemon restart
```

daemon 默认监听 `127.0.0.1:8992`。

## CLI 使用

### 交互式 REPL

```bash
npx yb-cli
```

进入交互式 Shell，支持：
- readline 行编辑
- 历史记录（上下箭头）
- Tab 补全（命令名、别名、联系人、群组）
- 多行输入（`\` 续行）
- 所有 `/cmd` 命令

### 非交互式命令

```bash
# 发送私聊
npx yb-cli send dm <userId> "你好"

# 发送群聊
npx yb-cli send group <groupCode> "大家好"

# 执行斜杠命令
npx yb-cli rc /help
npx yb-cli rc /echo hello
npx yb-cli rc /ip 8.8.8.8

# 查看状态
npx yb-cli status

# 查看 daemon 日志
npx yb-cli log
```

非交互式命令自动通过 daemon 执行，CLI 无需确认。

## Daemon HTTP API

daemon 监听 `127.0.0.1:8992`，提供以下 HTTP 路由：

| 路由 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/status` | GET | Bot 状态 |
| `/command` | POST | 执行斜杠命令 |
| `/send/dm` | POST | 发送私聊 |
| `/send/group` | POST | 发送群聊 |
| `/commands` | GET | 列出所有命令 |
| `/log` | GET | 获取日志 |
| `/daemon/stop` | POST | 停止 daemon |
| `/daemon/restart` | POST | 重启 daemon |

### 示例：通过 HTTP 执行命令

```bash
curl -X POST http://127.0.0.1:8992/command \
  -H "Content-Type: application/json" \
  -d '{"command":"/echo hello","fromUserId":"cli","chatType":"direct"}'
```

## 配置文件

```
~/.yuanbao-lite/
├── config.json          # 主配置（档案/凭证）
├── daemon.pid           # daemon PID 文件
├── contacts.json        # 联系人
├── groups.json          # 群组
├── aliases.json         # 别名
├── history.jsonl        # 消息历史
├── llm-config.json      # LLM 配置（含密钥池/供应商池）
├── trust.json           # 信任列表 + 单命令授权
├── block.json           # 封禁列表
├── reminders.json       # 提醒和定时任务
├── sticker-cache.json   # 贴纸缓存
└── runtime-prefs.json   # 运行时偏好（如日志级别）
```

### 多档案

支持多套配置档案切换：

```bash
npx yb-cli config profile list
npx yb-cli config profile add work
npx yb-cli config profile switch work
npx yb-cli config profile remove work
```

### 多账号

支持同时连接多个 Bot 账号：

```bash
npx yb-cli account add bot2 --appKey xxx --appSecret yyy
npx yb-cli account list
npx yb-cli account switch bot2
```

## systemd 集成

创建 `/etc/systemd/system/yuanbao-lite.service`：

```ini
[Unit]
Description=Yuanbao Lite Daemon
After=network.target

[Service]
Type=simple
User=your-username
ExecStart=/usr/bin/node /path/to/yuanbao-lite/dist/cli/index.js daemon start --foreground
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable yuanbao-lite
sudo systemctl start yuanbao-lite
sudo systemctl status yuanbao-lite
```

查看日志：

```bash
sudo journalctl -u yuanbao-lite -f
```

## 安全考虑

### daemon 仅监听本地

daemon 默认绑定 `127.0.0.1`，不接受外部连接。如需远程访问，建议通过 SSH 隧道：

```bash
ssh -L 8992:127.0.0.1:8992 user@server
# 然后本地访问 http://127.0.0.1:8992
```

### 凭据安全

- `config.json` 包含 appKey/appSecret，文件权限应为 `600`
- `llm-config.json` 包含 API Keys，同样应 `600`
- 避免将 `~/.yuanbao-lite/` 提交到版本控制

### CLI 全局权限

通过 CLI 执行命令时绕过所有限制（相当于永久 unsafe 模式）。这是设计行为，因为 CLI 用户通常就是 Bot 所有者。

## 故障排查

### daemon 无法启动

1. 检查端口占用：`lsof -i :8992`
2. 检查配置：`npx yb-cli config show`
3. 查看详细日志：`npx yb-cli daemon start --foreground --log debug`

### CLI 无法连接 daemon

1. 检查 daemon 状态：`npx yb-cli daemon status`
2. 检查 PID 文件：`cat ~/.yuanbao-lite/daemon.pid`
3. 如 PID 文件残留，删除后重启：`rm ~/.yuanbao-lite/daemon.pid && npx yb-cli daemon start`

### daemon 频繁重启

1. 检查网络连接（WebSocket 需要稳定网络）
2. 检查凭据是否过期
3. 查看 `journalctl` 或 daemon 日志

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `YB_DAEMON_PORT` | daemon 监听端口 | `8992` |
| `YB_DAEMON_HOST` | daemon 监听地址 | `127.0.0.1` |
| `YB_DAEMON_CHILD` | 标记为 daemon 子进程（内部用） | — |
| `YB_LOG_LEVEL` | 日志级别 | `info` |
| `HOME` | 用户主目录（配置文件位置） | — |
