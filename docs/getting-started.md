# 快速上手

## 安装

```bash
npm install yuanbao-lite
# 或
pnpm add yuanbao-lite
```

## 环境要求

- **Node.js** 18+（推荐 21+ 以使用原生 `globalThis.WebSocket`，无需 `ws` 包）
- **现代浏览器**（支持 ESM、Web Crypto API、原生 WebSocket）

## 第一个 Bot

### Node.js

```typescript
import { YuanbaoBot } from "yuanbao-lite";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
});

// 监听消息
bot.on("message", (msg) => {
  console.log(`[${msg.fromNickname}]: ${msg.text}`);
});

// 监听连接就绪
bot.on("ready", (data) => {
  console.log(`已连接，connectId=${data.connectId}`);
});

// 启动
await bot.start();
```

### 浏览器

```typescript
import { YuanbaoBot, NodeFsAdapter } from "yuanbao-lite";
// 浏览器需要自定义 PersistenceAdapter（见 persistence-adapter.md）
import { BrowserLocalStorageAdapter } from "./my-browser-adapter.js";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
  commands: false, // 可选：禁用命令系统减小 bundle
  persistence: {
    dir: "yuanbao-lite",
    adapter: new BrowserLocalStorageAdapter(),
  },
});

bot.on("message", (msg) => {
  console.log(`[${msg.fromNickname}]: ${msg.text}`);
});

await bot.start();
```

## 使用 CLI

### 1. 初始化配置

```bash
npx yb-cli config init
# 或直接设置
npx yb-cli config set appKey 你的AppKey
npx yb-cli config set appSecret 你的AppSecret
```

### 2. 启动 daemon

```bash
npx yb-cli daemon start
# daemon 默认监听 127.0.0.1:8992
```

### 3. 使用 CLI

```bash
# 交互式 REPL
npx yb-cli

# 非交互式命令（通过 daemon 执行）
npx yb-cli send dm <userId> "你好"
npx yb-cli rc /help
npx yb-cli rc /echo hello
```

## 凭据获取

1. 前往 [腾讯元宝开放平台](https://yuanbao.tencent.com/) 注册开发者账号
2. 创建机器人应用，获取 `appKey` 和 `appSecret`
3. 配置机器人的 WebSocket 回调地址（如需接收消息）

## 验证连接

```typescript
import { YuanbaoBot } from "yuanbao-lite";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
});

bot.on("ready", (data) => {
  console.log("✅ 连接成功！");
  console.log(`   connectId: ${data.connectId}`);
  console.log(`   botId: ${bot.getAccount().botId}`);
  console.log(`   ownerId: ${bot.getAccount().botOwnerId}`);

  // 发送测试消息给自己
  const selfId = bot.getAccount().botOwnerId;
  if (selfId) {
    bot.sendDirectMessage(selfId, "🤖 Bot 已上线！");
  }
});

bot.on("error", (err) => {
  console.error("❌ 连接失败:", err.message);
});

await bot.start();
```

## 下一步

- [核心 API 参考](./api-reference.md) —— 了解所有公开 API
- [命令系统](./command-system.md) —— 使用 49 个内置命令或自定义命令
- [LLM 接管引擎](./llm-takeover.md) —— 配置 AI 自动回复
- [浏览器解耦](./browser-decouple.md) —— 在浏览器中使用

## 常见问题

### Q: 启动时报 "No WebSocket constructor available"

**A**: 运行在 Node 18-20 且未安装 `ws` 包。解决：

```bash
npm install ws
```

或升级到 Node 21+（内置 `globalThis.WebSocket`）。

### Q: 启动时报 "getDefaultPersistenceDir() requires Node.js runtime"

**A**: 在浏览器中未提供持久化配置。解决：

```typescript
new YuanbaoBot({
  appKey,
  appSecret,
  persistence: {
    dir: "my-app",
    adapter: myBrowserAdapter,
  },
});
```

### Q: `getAliasStore()` 抛出 "not initialized"

**A**: 使用默认 Node 持久化时，store 构造是异步的（需 `await nodeModulesReady`）。解决：

```typescript
const bot = new YuanbaoBot({ appKey, appSecret });
await bot.init(); // 显式初始化
const store = bot.getAliasStore(); // 现在 OK
```

或直接 `await bot.start()`（内部会调用 `init()`）。

### Q: CORS 错误（浏览器）

**A**: Tencent HTTP 端点（`bot.yuanbao.tencent.com`）不允许浏览器直连。需要部署一个 CORS 代理：

- 开发环境：使用 Vite/webpack 的 proxy 配置
- 生产环境：部署 serverless function 转发请求

（未来版本将内置 `httpProxy` 配置项）
