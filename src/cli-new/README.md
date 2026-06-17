# Yuanbao Lite CLI (new) — daemon-first 架构

完整重写的 CLI，采用 **daemon-first** 架构：所有交互式/非交互式命令
一律先检查 daemon，未运行则自动启动，再通过 HTTP 与 daemon 通讯。
daemon 持有 YuanbaoBot 单例，避免每次命令都重连 WebSocket。

## 核心特性

- **daemon-first**：交互式与非交互式模式共享同一个 daemon，零 WebSocket 重连
- **自动杀菌**：daemon 启动时自动 SIGTERM 旧 daemon（通过 PID 文件）
- **命令共享**：所有 `/` 命令通过 `src/commands/registry.ts` 的 `CommandSystem` 分发
- **现代化库栈**：`@clack/prompts` · `commander` · `chalk` · `string-width` · `table`
- **无边框设计**：仅用颜色 + 空格对齐，无 box-drawing 字符
- **SSE 实时推送**：daemon 把入站 DM/群消息推给所有订阅的 CLI 客户端

## 三种模式

| 模式 | 命令 | 说明 |
|------|------|------|
| 交互式 REPL | `yb-cli-new` 或 `yb-cli-new interactive` | Clack 驱动，daemon 后台 |
| 非交互式 | `yb-cli-new send dm <userId> <msg>` | 单次 HTTP 调用 daemon |
| daemon 管理 | `yb-cli-new daemon start \| stop \| status` | 直接控制后台进程 |

## 用法

```bash
# 交互式 REPL（默认）
yb-cli-new
yb-cli-new interactive
yb-cli-new repl

# 非交互式（自动启动 daemon）
yb-cli-new send dm <userId> "<message>"
yb-cli-new send group <groupCode> "<message>"
yb-cli-new status
yb-cli-new upload <filePath>
yb-cli-new download <url> [fileName]
yb-cli-new contacts list
yb-cli-new contacts add <id> <name> [tag]
yb-cli-new contacts remove <nameOrId>
yb-cli-new contacts dm <nameOrId> <message>
yb-cli-new config init
yb-cli-new config show
yb-cli-new config set <key> <value>
yb-cli-new config profile list
yb-cli-new config profile switch <name>
yb-cli-new config profile add <name> [--app-key K --app-secret S]
yb-cli-new config profile remove <name>

# daemon 直接管理
yb-cli-new daemon start [--port 9100] [--host 127.0.0.1]
yb-cli-new daemon stop
yb-cli-new daemon status
```

## daemon-first 工作流

```text
yb-cli-new <任意命令>
   │
   ├─ ping GET /health
   │     ├─ 200 → 复用现有 daemon
   │     └─ 失败 → spawn detached `yb-cli-new daemon start`
   │                └─ 轮询 /health 直到就绪 (≤30s)
   │
   └─ 通过 HTTP 调用 daemon
         ├─ POST /send/dm          → bot.sendDirectMessage
         ├─ POST /send/group       → bot.sendGroupMessage
         ├─ POST /upload           → bot.uploadMedia
         ├─ POST /download         → downloadMedia
         ├─ POST /command          → bot.getCommandSystem().dispatch()
         ├─ GET  /events (SSE)     → 实时推送 directMessage/groupMessage
         ├─ GET  /health           → daemon + bot 状态
         └─ POST /shutdown         → 优雅关闭
```

## daemon 自动杀菌

daemon 启动时执行 `acquirePidFile()`：

1. 读取 `~/.yuanbao-lite/daemon.pid`
2. 若 PID 仍存活 → `SIGTERM`，等 ≤3s
3. 仍未退出 → `SIGKILL`，等 ≤1.5s
4. 写入自己的 PID

这保证同一端口上永远不会有两个 daemon。

## 命令共享（引用而非复制）

`yb-cli-new` 不复制任何命令处理器。所有 `/` 命令通过
`src/commands/registry.ts` 的 `CommandSystem.dispatch()` 分发：

- daemon 的 `POST /command` 路由调用 `dispatch(bot, msg, onReply)`
- `onReply` 回调把命令的输出捕获到数组，作为 HTTP 响应返回
- 交互式 REPL 把同样的 replies 渲染到终端

这意味着 IM bot、交互式 REPL、非交互式 CLI 三者看到的命令行为**完全一致**。

## 文件结构

```text
src/cli-new/
├── index.ts                  # 入口，daemon-first 路由
├── config.ts                 # 重新导出 src/cli/config.ts (共享 ConfigStore)
├── theme.ts                  # 颜色调色板 + 无边框渲染辅助
├── daemon/
│   ├── server.ts             # HTTP 服务器 + SSE
│   ├── routes.ts             # 路由处理器 (调用 YuanbaoBot + CommandSystem)
│   └── pid-file.ts           # PID 文件 + 自动杀菌
└── client/
    ├── daemon-client.ts      # HTTP 客户端 + ensureDaemon()
    ├── commands.ts           # Commander 程序 (非交互式)
    ├── interactive.ts        # Clack REPL (引用 RichHistory/auto-complete/syntax-highlight)
    └── wizard.ts             # 配置初始化向导 (Clack prompts)
```

## 复用的现成库

| 库 | 用途 |
|----|------|
| `@clack/prompts` | 交互式输入/菜单/确认 |
| `commander` | 子命令解析 |
| `chalk` | 颜色 |
| `string-width` | CJK 感知的列对齐 |
| `table` | 表格渲染（使用 `"void"` 边框 = 无边框） |
| `node:http` | daemon HTTP 服务器 |
| `node:child_process` | daemon 子进程 spawn |
| `node:fetch` | HTTP 客户端 |

## 主入口

参见 `src/cli-new/index.ts`
