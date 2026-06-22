# 浏览器解耦

Yuanbao Lite 采用同构（isomorphic）架构，同一份 TypeScript 源码可在 Node.js 和现代浏览器中运行。本文档说明浏览器支持的实现原理、限制和打包指南。

## 设计目标

1. **零平台分支**：业务代码不包含 `if (isBrowser)` / `if (isNode)` 逻辑
2. **零 `require()`**：纯 ESM，所有 Node 内置模块通过动态 `import()` 加载
3. **零 polyfill**：使用 Web 标准 API（Web Crypto、原生 WebSocket、fetch、TextEncoder）
4. **tree-shaking 友好**：浏览器 bundle 不包含任何 `node:*` 代码

## 支持矩阵

| 功能                           | Node 18+          | Node 21+   | 浏览器     | Edge Worker  |
| ------------------------------ | ----------------- | ---------- | ---------- | ------------ |
| WebSocket 连接                 | ✅（via `ws` 包） | ✅（原生） | ✅（原生） | ⚠️（需提供） |
| 消息收发                       | ✅                | ✅         | ✅         | ✅           |
| 命令系统                       | ✅                | ✅         | ✅         | ✅           |
| LLM（OpenAI/Anthropic/Gemini） | ✅                | ✅         | ✅         | ✅           |
| LLM（AWS Bedrock）             | ✅                | ✅         | ❌         | ❌           |
| 持久化（NodeFsAdapter）        | ✅                | ✅         | ❌         | ❌           |
| 持久化（自定义适配器）         | ✅                | ✅         | ✅         | ✅           |
| 文件上传                       | ✅                | ✅         | ❌         | ❌           |
| /shell、/term                  | ✅                | ✅         | ❌         | ❌           |
| /tempfile                      | ✅                | ✅         | ❌         | ❌           |

## 实现原理

### 1. Node 模块懒加载

所有 `node:*` 模块通过 top-level `await import()` 加载，受 `typeof process` 守卫保护：

```typescript
// src/access/persistence/adapter.ts
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

**打包工具行为**：

- esbuild/Vite/Rollup 识别 `await import("node:*")` 模式
- 将其拆分为独立 chunk，仅在运行时条件满足时加载
- 浏览器 bundle 不包含 `node:*` 代码

### 2. Web Crypto API

所有加密操作使用 Web Crypto API（Node 18+ 和所有现代浏览器内置）：

| 操作        | 旧实现（node:crypto）                                 | 新实现（Web Crypto）                             |
| ----------- | ----------------------------------------------------- | ------------------------------------------------ |
| HMAC-SHA256 | `createHmac("sha256", key).update(msg).digest("hex")` | `crypto.subtle.importKey` + `crypto.subtle.sign` |
| HMAC-SHA1   | `createHmac("sha1", ...)`                             | 同上（hash: "SHA-1"）                            |
| SHA-1 哈希  | `createHash("sha1").update(data).digest("hex")`       | `crypto.subtle.digest("SHA-1", data)`            |
| 随机数      | `randomBytes(16).toString("hex")`                     | `crypto.getRandomValues(new Uint8Array(16))`     |
| UUID        | `randomUUID()`                                        | `crypto.randomUUID()`（Node 18+ 原生）           |
| MD5         | `createHash("md5")`                                   | `js-md5` 库（Web Crypto 不支持 MD5）             |

**注意**：Web Crypto API 要求安全上下文（HTTPS 或 localhost）。HTTP 环境下 `crypto.subtle` 为 undefined。

### 3. 原生 WebSocket

```typescript
// src/access/ws/client.ts
let webSocketCtor: WebSocketCtor | null = null;

if (typeof globalThis.WebSocket !== "undefined") {
  // Node 21+ 或浏览器 —— 使用原生
  webSocketCtor = class NativeWebSocketWrapper extends globalThis.WebSocket {
    constructor(url: string, _options?: unknown) {
      super(url); // 原生 WebSocket 只接受 (url, protocols)
    }
  };
} else {
  // Node 18-20 —— 动态加载 ws 包
  const wsModule = await import("ws");
  webSocketCtor = wsModule.default;
}
```

**差异处理**：

- `ws` 包接受 options 对象（`{ maxPayload }`）
- 原生 WebSocket 只接受 `protocols`（字符串/数组）
- `NativeWebSocketWrapper` 忽略 options 参数

**消息事件差异**：

- `ws` 包：`event.data` 可能是 `Buffer`
- 原生 WebSocket：`event.data` 是 `ArrayBuffer`
- `handleMessage` 中通过 `typeof Buffer !== "undefined"` 守卫处理

### 4. 文件 I/O 适配

所有文件操作通过 `PersistenceAdapter` 接口抽象：

```typescript
// Node 实现
class NodeFsAdapter implements PersistenceAdapter {
  exists(path) {
    return this.fs.existsSync(path);
  }
  read(path) {
    return this.fs.readFileSync(path, "utf-8");
  }
  // ...
}

// 浏览器实现（用户自定义）
class BrowserLocalStorageAdapter implements PersistenceAdapter {
  exists(path) {
    return localStorage.getItem(path) !== null;
  }
  read(path) {
    return localStorage.getItem(path) ?? "";
  }
  // ...
}
```

详见 [持久化适配器文档](./persistence-adapter.md)。

### 5. 命令系统浏览器移植

所有 53 个命令 handler 已重构为浏览器安全：

| 命令             | Node 依赖            | 浏览器处理                                 |
| ---------------- | -------------------- | ------------------------------------------ |
| `/shell`         | `node:child_process` | `await import()` + try/catch，返回错误信息 |
| `/term`          | `node:child_process` | 同上                                       |
| `/config reset`  | `node:fs`            | 改用 `PersistenceAdapter.remove()`         |
| `/log`           | `node:fs`            | 改用 `PersistenceAdapter`                  |
| `/llm reset`     | `node:fs`            | 改用 `PersistenceAdapter.remove()`         |
| `/myip`          | `node:os`            | `getNodeModules().os`，跳过本地接口        |
| `/tempfile`      | `node:fs`            | `getNodeModules().fs`，返回错误            |
| `/stickers load` | `node:fs`            | `getNodeModules().fs`，返回错误            |

## 打包指南

### esbuild

```bash
esbuild src/index.ts \
  --bundle \
  --platform=browser \
  --format=esm \
  --outfile=dist/browser-bundle.mjs \
  --external:ai \
  --external:@ai-sdk/* \
  --external:protobufjs \
  --external:marked \
  --external:node:* \
  --external:util \
  --external:os
```

**说明**：

- `--external:node:*` —— 所有 `node:*` 模块标记为外部（运行时由 Node 提供，浏览器跳过）
- `--external:util` / `--external:os` —— `@colors/colors` 的间接依赖
- `ai` / `@ai-sdk/*` / `protobufjs` / `marked` 根据需要选择是否打包

### Vite

```typescript
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        "ai",
        "@ai-sdk/*",
        "protobufjs",
        "marked",
        "node:*",
        "util",
        "os",
      ],
    },
  },
});
```

### Webpack 5

```javascript
// webpack.config.js
module.exports = {
  target: "web",
  experiments: { outputModule: true },
  externals: {
    ai: "ai",
    "@ai-sdk/openai": "@ai-sdk/openai",
    // ...
  },
  // node:* 自动被视为外部
};
```

## 浏览器使用示例

```typescript
import { YuanbaoBot } from "yuanbao-lite";
import { BrowserLocalStorageAdapter } from "./browser-adapter.js";

const bot = new YuanbaoBot({
  appKey: "你的AppKey",
  appSecret: "你的AppSecret",
  commands: false, // 可选：减小 bundle
  persistence: {
    dir: "yuanbao-lite",
    adapter: new BrowserLocalStorageAdapter(),
  },
});

bot.on("message", (msg) => {
  console.log(`[${msg.fromNickname}]: ${msg.text}`);
});

bot.on("ready", () => {
  console.log("已连接！");
});

await bot.start();
```

## CORS 限制

**重要**：Tencent HTTP 端点（`bot.yuanbao.tencent.com`、COS 上传端点）不允许浏览器直连。

### 解决方案

1. **开发环境**：使用 Vite/webpack dev server 的 proxy

```typescript
// vite.config.ts
export default {
  server: {
    proxy: {
      "/api": "https://bot.yuanbao.tencent.com",
    },
  },
};
```

2. **生产环境**：部署 serverless function 作为 CORS 代理

```typescript
// 例如 Cloudflare Worker / Vercel Edge Function
export async function handleRequest(req: Request) {
  const url = new URL(req.url);
  const targetUrl = "https://bot.yuanbao.tencent.com" + url.pathname;
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers });
}
```

3. **未来版本**：将内置 `httpProxy` 配置项

## 已知限制

1. **AWS Bedrock 不可用**：`@ai-sdk/amazon-bedrock` 依赖 SigV4 签名（Node-only）
2. **文件上传不可用**：`uploadMedia` / `downloadMedia` 需要 `node:fs`
3. **CORS**：所有 Tencent HTTP 端点需要代理
4. **安全上下文要求**：Web Crypto API 仅在 HTTPS 或 localhost 下可用
5. **localStorage 容量**：~5MB，不适合大数据量持久化

## 验证浏览器兼容性

```bash
# 打包测试
npx esbuild src/index.ts --bundle --platform=browser --format=esm \
  --external:ai --external:@ai-sdk/* --external:protobufjs --external:marked \
  --external:node:* --external:util --external:os \
  --outfile=/tmp/browser-test.mjs

# 应该成功，无 ERROR 输出
```

## 相关文档

- [持久化适配器](./persistence-adapter.md)
- [架构总览](./architecture.md)
- [BROWSER_DECOUPLE_ANALYSIS.md](../BROWSER_DECOUPLE_ANALYSIS.md) —— 详细的依赖审计报告
