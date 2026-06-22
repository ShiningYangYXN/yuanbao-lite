# 持久化适配器

Yuanbao Lite 通过 `PersistenceAdapter` 接口抽象所有文件 I/O，让 store（alias、contacts、groups、history、trust、block、reminders、llm-config、sticker-cache）可在任意运行时工作。

## 接口定义

```typescript
// src/access/persistence/adapter.ts

export interface PersistenceAdapter {
  /** 检查路径/key 是否存在 */
  exists(path: string): boolean;

  /** 读取为 UTF-8 字符串。不存在时抛错 */
  read(path: string): string;

  /** 写入字符串。自动创建父目录 */
  write(path: string, data: string): void;

  /** 确保父目录存在（mkdir -p） */
  ensureParentDir(path: string): void;

  /** 可选：追加数据。用于 JSONL 历史 */
  append?(path: string, data: string): void;

  /** 可选：删除文件/key */
  remove?(path: string): boolean;

  /** 可选：列出目录条目 */
  listDir?(path: string): Array<{ name: string; isDirectory: boolean }>;
}
```

## 内置实现

### NodeFsAdapter（默认，Node 环境）

使用 `node:fs` 和 `node:path`，通过 ESM 动态 `import()` 加载。

```typescript
import { NodeFsAdapter } from "yuanbao-lite";

const adapter = new NodeFsAdapter();
adapter.write("/tmp/test.json", '{"hello":"world"}');
console.log(adapter.read("/tmp/test.json"));  // {"hello":"world"}
console.log(adapter.exists("/tmp/test.json")); // true
adapter.remove("/tmp/test.json");
```

**特点**：
- 支持所有可选方法（`append`、`remove`、`listDir`）
- `append` 使用 `appendFileSync`（高效追加）
- 构造函数在浏览器中抛错（无 `node:fs`）

## 浏览器适配器

### BrowserLocalStorageAdapter（示例实现）

基于 `window.localStorage`，适合小数据量场景：

```typescript
// my-browser-adapter.ts
import type { PersistenceAdapter } from "yuanbao-lite";

export class BrowserLocalStorageAdapter implements PersistenceAdapter {
  private prefix: string;

  constructor(prefix: string = "yuanbao-lite:") {
    this.prefix = prefix;
  }

  private key(path: string): string {
    return this.prefix + path;
  }

  exists(path: string): boolean {
    return localStorage.getItem(this.key(path)) !== null;
  }

  read(path: string): string {
    const data = localStorage.getItem(this.key(path));
    if (data === null) throw new Error(`Not found: ${path}`);
    return data;
  }

  write(path: string, data: string): void {
    localStorage.setItem(this.key(path), data);
  }

  ensureParentDir(_path: string): void {
    // localStorage 是扁平的，无需创建目录
  }

  // 不实现 append —— store 会回退到 read-modify-write
  // 不实现 remove、listDir（可选）

  // 如需实现 remove:
  remove(path: string): boolean {
    const key = this.key(path);
    if (localStorage.getItem(key) === null) return false;
    localStorage.removeItem(key);
    return true;
  }
}
```

**使用**：

```typescript
import { YuanbaoBot } from "yuanbao-lite";
import { BrowserLocalStorageAdapter } from "./my-browser-adapter.js";

const bot = new YuanbaoBot({
  appKey, appSecret,
  persistence: {
    dir: "",  // 路径作为 localStorage key 后缀
    adapter: new BrowserLocalStorageAdapter("my-app:"),
  },
});
```

### BrowserIndexedDbAdapter（异步后端）

IndexedDB 是异步的，无法实现同步的 `PersistenceAdapter` 接口。如需使用 IndexedDB（适合大数据量），有两个选择：

1. **使用 localStorage**（同步，~5MB 限制）—— 推荐用于小数据
2. **实现 AsyncPersistenceAdapter**（未来版本）—— 需要重构 store API 为异步

## 配置方式

### 1. 默认（Node）

```typescript
new YuanbaoBot({ appKey, appSecret });
// 自动使用 ~/.yuanbao-lite/ + NodeFsAdapter
```

### 2. 禁用持久化

```typescript
new YuanbaoBot({
  appKey, appSecret,
  persistence: null,  // 纯内存，重启丢失
});
```

### 3. 自定义适配器

```typescript
new YuanbaoBot({
  appKey, appSecret,
  persistence: {
    dir: "/data/my-bot",  // 基础目录
    adapter: myCustomAdapter,
  },
});
```

### 4. 全局默认覆盖

```typescript
import { setDefaultPersistenceAdapter } from "yuanbao-lite";

setDefaultPersistenceAdapter(myCustomAdapter);
// 之后所有未显式配置 adapter 的 store 都会使用这个
```

## Store 配置

每个 store 也可单独配置适配器：

### 类实例 store（AliasStore、ContactStore、GroupStore、MessageHistoryStore）

```typescript
import { AliasStore } from "yuanbao-lite";

const store = new AliasStore({
  persistencePath: "aliases",  // 路径或 key
  autoSave: true,
  persistenceAdapter: myAdapter,
});
```

### 模块级单例 store（block、trust、reminders、sticker-cache）

这些 store 使用模块级单例模式，通过 `initXxxStore()` 配置：

```typescript
import { initBlockStore, initTrustStore, initRemindersStore } from "yuanbao-lite";

initBlockStore({
  persistencePath: "block",
  persistenceAdapter: myAdapter,
});

initTrustStore({
  persistencePath: "trust",
  persistenceAdapter: myAdapter,
});

initRemindersStore({
  persistencePath: "reminders",
  persistenceAdapter: myAdapter,
});
```

`YuanbaoBot` 构造函数在检测到自定义 `persistence.adapter` 时会自动调用这些 `init` 函数。

## Node 模块加载机制

`adapter.ts` 在模块加载时通过 top-level `await import()` 预加载 Node 内置模块：

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

export const nodeModulesReady: Promise<boolean> = /* ... */;
export function getNodeModules(): NodeModules { return nodeModules; }
```

**打包工具行为**：
- esbuild / Vite / Rollup 会将三个 `import("node:*")` 拆分为独立 chunk
- 浏览器运行时：`typeof process` 检查失败，动态 import 不执行，chunk 不加载
- Node 运行时：动态 import 执行，`nodeModules` 填充

**对 store 构造的影响**：
- 使用默认 Node 持久化时，`NodeFsAdapter` 构造需要 `nodeModules` 已加载
- `YuanbaoBot` 构造函数将 store 构造推迟到 `init()` 中
- `init()` 内部 `await nodeModulesReady` 确保模块已加载

## 性能考虑

### localStorage 限制

- 容量：~5MB（因浏览器而异）
- 同步 API：大量数据会阻塞主线程
- 适合：配置、别名、联系人、小历史记录

### 大数据量场景

消息历史（`history.jsonl`）可能很大：
- Node：使用 `NodeFsAdapter.append`（高效追加）
- 浏览器 localStorage：回退到 read-modify-write（每次写入全量数据）
- 建议：浏览器中设置 `historyLimit` 较小值，或禁用历史持久化

```typescript
new YuanbaoBot({
  appKey, appSecret,
  historyLimit: 100,  // 仅保留最近 100 条
  persistence: {
    dir: "yb",
    adapter: myAdapter,
  },
});
```

## 调试

启用 debug 日志查看持久化操作：

```typescript
import { setLogLevel } from "yuanbao-lite";
setLogLevel("debug");
```

日志会显示：
- 文件读取/写入路径
- 加载的条目数
- 适配器解析过程
