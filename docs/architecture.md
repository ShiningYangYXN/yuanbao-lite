# 架构总览

## 设计哲学

Yuanbao Lite 采用 **同构（isomorphic）架构** —— 同一份 TypeScript 源码可在 Node.js 和现代浏览器中运行，无需条件编译或平台分支。核心设计原则：

1. **daemon-first**：CLI 与 daemon 分离，零 WebSocket 重连
2. **适配器模式**：所有平台相关 I/O（文件系统、加密、WebSocket）通过接口抽象
3. **懒加载**：重型子系统的导入推迟到首次使用时
4. **零 `require()`**：纯 ESM，所有 Node 内置模块通过动态 `import()` 加载

## 模块层级

```
┌─────────────────────────────────────────────────────────┐
│                    应用层（用户代码）                      │
├─────────────────────────────────────────────────────────┤
│  src/index.ts — YuanbaoBot 主类（公开 API）              │
├──────────────┬──────────────┬───────────────────────────┤
│  business/   │  commands/   │  access/                  │
│  业务逻辑     │  命令系统     │  访问层（WS/HTTP/持久化）  │
│              │              │                           │
│ • llm-takeover│ • registry  │ • ws/client.ts            │
│ • alias       │ • handlers/ │ • http/request.ts         │
│ • contacts    │   (53个)    │ • http/media.ts           │
│ • groups      │ • types.ts  │ • persistence/adapter.ts  │
│ • history     │              │                           │
│ • mention     │              │                           │
│ • trust/block │              │                           │
│ • reminders   │              │                           │
│ • sticker     │              │                           │
│ • interpolate │              │                           │
│ • search      │              │                           │
├──────────────┴──────────────┴───────────────────────────┤
│  shared/ + logger.ts + version.ts + types.ts + accounts │
│  共享基础设施（无平台依赖）                                │
├─────────────────────────────────────────────────────────┤
│  cli/ — CLI 客户端 + daemon HTTP 服务器（仅 Node）        │
└─────────────────────────────────────────────────────────┘
```

## 核心数据流

### 消息接收流

```
Tencent WSS ──→ ws/client.ts ──→ conn-codec.ts (解码 ConnMsg)
                                      │
                                      ▼
                               biz-codec.ts (解码业务消息)
                                      │
                                      ▼
                               index.ts handleDispatch()
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
              emit("message")   命令分发          LLM 上下文注入
              (用户监听)        (/cmd ...)       (feedLlmContext)
                                      │
                                      ▼
                               tryLlmAutoReply()
                                      │
                                      ▼
                               llm-takeover.ts
                               (Vercel AI SDK)
                                      │
                                      ▼
                               bot.sendText()
```

### 消息发送流

```
用户代码 ──→ bot.sendText({ to, text, isGroup })
                    │
                    ▼
             interpolate() — ${} 表达式求值
                    │
                    ▼
             buildMentionMsgBody() — @提及解析
                    │
                    ▼
             ws/client.ts sendGroupMessage / sendC2CMessage
                    │
                    ▼
             biz-codec.ts (Protobuf 编码)
                    │
                    ▼
             Tencent WSS
```

## 关键子系统说明

### 1. PersistenceAdapter（持久化适配器）

**位置**：`src/access/persistence/adapter.ts`

**目的**：抽象文件 I/O，让所有 store（alias、contacts、groups、history、trust、block、reminders、llm-config、sticker-cache）可在任意运行时工作。

**接口**：
```typescript
interface PersistenceAdapter {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, data: string): void;
  ensureParentDir(path: string): void;
  append?(path: string, data: string): void;     // 可选
  remove?(path: string): boolean;                 // 可选
  listDir?(path: string): Array<{name, isDirectory}>;  // 可选
}
```

**实现**：
- `NodeFsAdapter`（默认，Node 环境）—— 使用 `node:fs`
- 浏览器适配器（用户自定义）—— 基于 `localStorage` 或 `IndexedDB`

**Node 模块加载机制**：
```typescript
// adapter.ts 顶层
let nodeModules = { fs: null, path: null, os: null };
if (typeof process !== "undefined" && process.versions?.node) {
  const [fs, path, os] = await Promise.all([
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  nodeModules = { fs, path, os };
}
```

打包工具（esbuild/Vite/Rollup）会将这三个动态 `import()` 拆分为独立 chunk，仅在 Node 运行时加载。浏览器 bundle 不包含任何 `node:*` 代码。

### 2. CommandSystem（命令系统）

**位置**：`src/commands/registry.ts` + `src/commands/handlers/`

**特点**：
- 53 个内置命令，一命令一文件，按分类组织
- 命令系统本身是浏览器安全的（所有 Node-only 操作通过动态 `import()` + try/catch）
- 通过 `await bot.init()` 懒加载，避免增加初始 bundle 体积

**Node-only 命令的处理方式**：
- `/shell`、`/term`：`await import("node:child_process")`，浏览器调用返回明确错误
- `/tempfile`：`getNodeModules().fs`，浏览器不可用
- `/myip`：`getNodeModules().os`，浏览器跳过本地接口检测

### 3. LLM 接管引擎

**位置**：`src/business/llm-takeover.ts`

**依赖**：Vercel AI SDK（`ai` + `@ai-sdk/*`）

**特性**：
- 5 种 API 格式：OpenAI、Anthropic、Google Gemini、AWS Bedrock、Azure OpenAI
- 密钥池 + 供应商池 + 自动切换
- 迭代调用（invoke 模式）
- 用量统计
- AWS Bedrock 在浏览器中不可用（依赖 SigV4 签名，Node-only）

### 4. WebSocket 客户端

**位置**：`src/access/ws/client.ts`

**同构策略**：
```typescript
if (typeof globalThis.WebSocket !== "undefined") {
  // Node 21+ 或浏览器 —— 使用原生 WebSocket
  webSocketCtor = class NativeWebSocketWrapper extends globalThis.WebSocket { ... };
} else {
  // Node 18-20 —— 动态加载 ws 包
  const wsModule = await import("ws");
  webSocketCtor = wsModule.default;
}
```

### 5. HTTP 签名层

**位置**：`src/access/http/request.ts`

**加密实现**：
- HMAC-SHA256（sign-token 签名）：`crypto.subtle.importKey` + `sign`（Web Crypto API）
- HMAC-SHA1（COS 上传签名）：同上
- 随机数：`crypto.getRandomValues`
- 操作系统检测：Node 下 `getNodeModules().os.type()`，浏览器返回 `"Browser"`

## 包结构（package.json exports）

```json
{
  "exports": {
    ".":           "./dist/index.js",          // 核心库
    "./commands":  "./dist/commands-entry.js", // CommandSystem 运行时类
    "./cli":       "./dist/cli/index.js",      // CLI 入口（仅 Node）
    "./package.json": "./package.json"
  }
}
```

**使用方式**：
```typescript
// 核心库（Node + 浏览器）
import { YuanbaoBot } from "yuanbao-lite";

// CommandSystem 运行时类（如果需要直接 new）
import { CommandSystem } from "yuanbao-lite/commands";

// CLI（仅 Node，通常通过 npx yb-cli 调用）
// 不需要在代码中 import —— 使用 bin 入口
```

## 依赖关系图

### 核心库依赖（yuanbao-lite）

| 依赖 | 用途 | 浏览器可用 |
|------|------|-----------|
| `ai` + `@ai-sdk/*` | LLM 引擎 | ✅（Bedrock 除外） |
| `protobufjs` | WebSocket 消息编解码 | ✅ |
| `marked` | Markdown → 纯文本转换 | ✅ |
| `js-md5` | 文件上传 MD5 哈希（COS 协议） | ✅ |
| `chalk` | 命令帮助文本着色 | ✅ |
| `string-width` | 表格对齐宽度计算 | ✅ |
| `markdown-table` | Markdown 表格生成 | ✅ |
| `linkedom` + `defuddle` | /visit 命令网页清洗 | ✅ |
| `ws` | Node 18-20 WebSocket 回退 | N/A（Node 21+ 不需要） |

### CLI 专属依赖（仅 `yuanbao-lite/cli` 使用）

| 依赖 | 用途 |
|------|------|
| `commander` | CLI 参数解析 |
| `@clack/prompts` | 交互式向导 |
| `cli-table3` | 终端表格渲染 |
| `marked-terminal` | 终端 Markdown 渲染 |
| `table` | 终端表格（备用） |

## 性能特征

- **初始 bundle 大小**（浏览器，esbuild --platform=browser，minified）：~2.9MB
  - 其中 `ai` + `@ai-sdk/*` 占 ~60%
  - `protobufjs` 占 ~15%
  - 业务逻辑占 ~25%
- **命令系统懒加载 chunk**：~275KB（仅在 `await bot.init()` 时加载）
- **Node 模块预加载**：`nodeModulesReady` Promise 通常在 <5ms 内完成

## 扩展点

1. **自定义命令**：`bot.registerCommand(def)` 或创建 `src/commands/handlers/<category>/<name>.ts`
2. **自定义持久化**：实现 `PersistenceAdapter` 接口，通过 `config.persistence.adapter` 注入
3. **自定义 LLM 供应商**：通过 `config.llmConfig.customProviders` 配置
4. **自定义消息处理**：`bot.on("message", handler)` 监听所有入站消息
