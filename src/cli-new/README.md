# Yuanbao Lite CLI — 全新版本

完整重写后的 CLI，使用成熟库替代手写 readline 和文本对齐：

- **@clack/prompts** — 交互式输入/菜单/确认
- **commander** — 子命令解析（非交互式模式）
- **table** — 表格渲染（联系人/群组/历史列表），无边框

## 三种模式

| 模式 | 命令 | 说明 |
|------|------|------|
| 交互式 REPL | `node src/cli-new/index.ts` 或 `interactive` | 传统 REPL 体验，Clack 驱动 |
| 守护进程 | `node src/cli-new/index.ts daemon` | 后台运行，带 HTTP 健康检查 |
| 非交互式子命令 | `node src/cli-new/index.ts send dm ...` | 一次性命令 |

## 用法

```bash
# 交互式 REPL（默认）
npx tsx src/cli-new/index.ts
node src/cli-new/index.js

# 显式指定模式
node src/cli-new/index.ts interactive
node src/cli-new/index.ts repl

# 守护进程模式
node src/cli-new/index.ts daemon
node src/cli-new/index.ts daemon --port 8080
node src/cli-new/index.ts daemon --no-health-check

# 非交互式命令（与原版兼容）
node src/cli-new/index.ts send dm <userId> "<message>"
node src/cli-new/index.ts send group <groupCode> "<message>"
node src/cli-new/index.ts status
node src/cli-new/index.ts upload <filePath>
node src/cli-new/index.ts config init
node src/cli-new/index.ts config show
node src/cli-new/index.ts contacts list
```

## 代码复用

**不复制业务逻辑。** 所有命令处理通过以下方式复用：

- `src/commands/registry.ts` — CommandSystem 类（注册/匹配/调度命令）
- `src/cli/config.ts` — ConfigStore 类（配置读写）
- `src/index.ts` — YuanbaoBot 类（bot 核心）

新 CLI 只负责：命令行路由、用户交互、输出格式化。

## 文件结构

```
src/cli-new/
├── index.ts              # 入口，模式路由
├── core/
│   ├── interactive.ts    # 交互式 REPL 循环
│   ├── daemon.ts         # 守护进程模式
│   ├── config-loader.ts  # 配置加载/初始化 (Clack prompts)
│   ├── bot-helper.ts     # Bot 生命周期 (connect/disconnect)
│   ├── render.ts         # 输出渲染 (欢迎信息、状态消息)
│   └── index.ts          # Barrel export
└── commands/
    └── non-interactive.ts # Commander 子命令定义
```

## 主入口

参见 `src/cli-new/index.ts`
