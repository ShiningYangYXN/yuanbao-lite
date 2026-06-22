# Yuanbao Lite

轻量级独立腾讯元宝机器人客户端 — 同构架构，支持 Node.js 与浏览器。

[![npm version](https://img.shields.io/npm/v/yuanbao-lite.svg)](https://www.npmjs.com/package/yuanbao-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OctoCounts](https://api.octocounts.com/badge/YuanbaoTeam/yuanbao-openclaw-plugin/branch/main)](https://octocounts.com/github/YuanbaoTeam/yuanbao-openclaw-plugin/tree/main)

> 📖 完整开发文档请查看 [docs/](docs/README.md)
> 🦞 OpenClaw实例请查看 [CLAW.md](CLAW.md)

## 特性

- **同构架构** — 同一份 TypeScript 源码，Node.js 与浏览器均可运行
- **daemon-first** — CLI 与 daemon 分离，零 WebSocket 重连
- **53 个内置命令** — 聊天、群管、媒体、LLM、系统管理
- **LLM 接管** — 多供应商（OpenAI/Claude/Gemini/Bedrock/Azure）、密钥池、迭代调用
- **安全机制** — 信任系统 + 封禁系统 + unsafe 模式 + 插值安全
- **持久化适配器** — `PersistenceAdapter` 接口抽象文件 I/O，支持浏览器自定义后端
- **Web Crypto API** — 所有加密操作使用 Web 标准，无 `node:crypto` 依赖
- **零 `require()`** — 纯 ESM，所有 Node 模块通过动态 `import()` 加载

## 快速开始

### 安装

```bash
npm install yuanbao-lite
```

### Node.js

```typescript
import { YuanbaoBot } from "yuanbao-lite";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
});

bot.on("message", (msg) => {
  console.log(`[${msg.fromNickname}]: ${msg.text}`);
});

bot.on("ready", () => {
  console.log("已连接！");
});

await bot.start();
```

### 浏览器

```typescript
import { YuanbaoBot } from "yuanbao-lite";
import { BrowserLocalStorageAdapter } from "./browser-adapter.js";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
  persistence: {
    dir: "yuanbao-lite",
    adapter: new BrowserLocalStorageAdapter(),
  },
});

await bot.start();
```

> ⚠️ 浏览器直连 Tencent 端点存在 CORS 限制，需部署代理。详见 [浏览器解耦文档](docs/browser-decouple.md)。

### CLI

```bash
# 初始化配置
npx yb-cli config init

# 启动 daemon
npx yb-cli daemon start

# 使用 CLI
npx yb-cli                    # 交互式 REPL
npx yb-cli send dm <userId> "你好"
npx yb-cli rc /help
```

## 运行时支持

| 运行时      | 核心功能 | 命令系统 | 文件上传 | /shell |
| ----------- | -------- | -------- | -------- | ------ |
| Node.js 21+ | ✅       | ✅       | ✅       | ✅     |
| Node.js 18+ | ✅       | ✅       | ✅       | ✅     |
| 现代浏览器  | ✅       | ✅       | ❌       | ❌     |
| Edge Worker | ✅       | ✅       | ❌       | ❌     |

## 包结构

本包通过 `exports` 字段提供多个入口：

| 子路径                  | 说明                                         | 浏览器可用 |
| ----------------------- | -------------------------------------------- | ---------- |
| `yuanbao-lite`          | 核心库（YuanbaoBot + 所有 store + 业务逻辑） | ✅         |
| `yuanbao-lite/commands` | CommandSystem 运行时类                       | ✅         |
| `yuanbao-lite/cli`      | CLI 入口（仅 Node）                          | ❌         |

## 核心概念

### YuanbaoBot

主类，提供事件驱动的 WebSocket 客户端。

```typescript
const bot = new YuanbaoBot(config);
bot.on("message", handler);
bot.on("ready", handler);
await bot.start();
```

### 持久化

通过 `PersistenceAdapter` 接口抽象，默认使用 `NodeFsAdapter`（Node）或自定义适配器（浏览器）。

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  persistence: {
    dir: "my-app",
    adapter: myAdapter, // 实现 PersistenceAdapter 接口
  },
});
```

### 命令系统

53 个内置命令，支持自定义。通过 `await bot.init()` 懒加载。

```typescript
await bot.registerCommand({
  name: "ping",
  handler: async (ctx) => {
    await ctx.reply("pong!");
    return { handled: true };
  },
});
```

### LLM 接管

基于 Vercel AI SDK，支持多供应商、密钥池、自动切换。

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  llmConfig: {
    provider: "my-openai",
    customProviders: {
      "my-openai": {
        apiFormat: "openai-chat-completions",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
        apiKeys: ["sk-xxx"],
      },
    },
  },
});
```

## 文档

完整开发文档位于 [docs/](docs/README.md)：

- [架构总览](docs/architecture.md)
- [快速上手](docs/getting-started.md)
- [核心 API 参考](docs/api-reference.md)
- [命令系统](docs/command-system.md)
- [LLM 接管引擎](docs/llm-takeover.md)
- [持久化适配器](docs/persistence-adapter.md)
- [浏览器解耦](docs/browser-decouple.md)
- [CLI 与 Daemon](docs/cli-daemon.md)
- [消息协议](docs/message-protocol.md)
- [安全模型](docs/security.md)
- [贡献指南](docs/contributing.md)

## 项目结构

```text
src/
├── index.ts              # YuanbaoBot 主入口（核心库）
├── types.ts              # 类型定义
├── version.ts            # 版本（浏览器安全，无 node:fs 静态导入）
├── logger.ts             # 日志
├── accounts.ts           # 账号解析
├── access/               # 访问层
│   ├── ws/               # WebSocket 客户端 + Protobuf 编解码
│   ├── http/             # HTTP 签名 + 媒体上传
│   └── persistence/      # PersistenceAdapter 接口 + NodeFsAdapter
├── business/             # 业务逻辑（全部浏览器安全）
│   ├── llm-takeover.ts   # LLM 引擎
│   ├── alias.ts          # 别名 store
│   ├── contacts.ts       # 联系人 store
│   ├── groups.ts         # 群组 store
│   ├── history.ts        # 消息历史 store
│   ├── trust.ts          # 信任系统
│   ├── block.ts          # 封禁系统
│   ├── reminders.ts      # 提醒 + cron
│   ├── sticker.ts        # 贴纸系统
│   ├── mention.ts        # @提及解析
│   ├── interpolate.ts    # ${} 插值
│   └── search.ts         # 模糊搜索
├── commands/             # 命令系统（全部浏览器安全）
│   ├── registry.ts       # 命令注册与分发
│   ├── handlers/         # 53 个命令 handler（按分类组织）
│   ├── types.ts          # 命令类型
│   └── help-text.ts      # 帮助文本
├── shared/
│   └── config.ts         # CLI 配置 store（浏览器安全）
└── cli/                  # CLI + daemon（仅 Node）
    ├── index.ts          # CLI 入口
    ├── client/           # CLI 客户端 + REPL
    └── daemon/           # HTTP 服务器 + 路由
```

## 配置文件

```text
~/.yuanbao-lite/
├── config.json          # 主配置
├── contacts.json        # 联系人
├── groups.json          # 群组
├── aliases.json         # 别名
├── history.jsonl        # 消息历史
├── llm-config.json      # LLM 配置
├── trust.json           # 信任列表
├── block.json           # 封禁列表
├── reminders.json       # 提醒
└── sticker-cache.json   # 贴纸缓存
```

## 开发

```bash
git clone https://github.com/ShiningYangYXN/yuanbao-lite.git
cd yuanbao-lite
npm install --legacy-peer-deps
npm run build
npm run lint
```

详见 [贡献指南](docs/contributing.md)。

## 许可证

MIT
