# 贡献指南

感谢你对 Yuanbao Lite 项目的兴趣！本文档说明如何参与开发。

## 开发环境搭建

### 前置要求

- Node.js 18+（推荐 21+）
- npm 或 pnpm
- Git

### 克隆与安装

```bash
git clone https://github.com/ShiningYangYXN/yuanbao-lite.git
cd yuanbao-lite
npm install --legacy-peer-deps
```

### 构建

```bash
npm run build       # TypeScript 编译
npm run lint        # ESLint 检查
npm run lint:fix    # 自动修复
```

### 运行测试

```bash
# 端到端测试（需要凭据）
YB_CREDS="appKey:appSecret" npm run test:e2e
```

## 代码规范

### TypeScript

- **strict 模式**：`tsconfig.json` 中 `strict: true`
- **ESM only**：`"type": "module"`，禁止 CommonJS
- **verbatimModuleSyntax**：类型导入必须用 `import type`
- **target**：ES2023
- **module**：NodeNext

### 文件组织

- 一命令一文件：`src/commands/handlers/<category>/<name>.ts`
- Store 类：`src/business/<name>.ts`
- 访问层：`src/access/<layer>/<name>.ts`

### 命名约定

- **类**：PascalCase（`YuanbaoBot`、`AliasStore`）
- **函数/变量**：camelCase（`sendText`、`getAliasStore`）
- **常量**：UPPER_SNAKE_CASE（`DEFAULT_PREFIX`、`MAX_FILE_SIZE_MB`）
- **类型**：PascalCase（`ChatMessage`、`BotState`）
- **文件**：kebab-case（`llm-takeover.ts`、`conn-codec.ts`）

### 注释规范

每个公开 API 必须有 JSDoc 注释：

```typescript
/**
 * 发送文本消息。
 *
 * 支持 @提及语法和 ${} 插值。
 *
 * @param params - 发送参数
 * @throws {Error} Bot 未连接时抛出
 * @example
 * ```typescript
 * await bot.sendText({
 *   to: "user123",
 *   text: "你好 @小明(user456)!",
 *   isGroup: false,
 * });
 * ```
 */
async sendText(params: SendTextMessageParams): Promise<void> {
  // ...
}
```

## 浏览器兼容性要求

所有新增代码必须浏览器兼容：

### 允许

- ESM `import` / `export`
- 动态 `import()`
- Web 标准 API（fetch、Web Crypto、TextEncoder、WebSocket）
- `globalThis`

### 禁止

- 静态 `import "node:*"`
- `require()` 调用
- `process.env` 直接访问（用 `typeof process` 守卫）
- `Buffer` 直接使用（用 `typeof Buffer !== "undefined"` 守卫）
- `__dirname` / `__filename`（用 `import.meta.url`）

### Node-only 功能

如需使用 Node-only 功能：

```typescript
// 方式 1：动态 import + try/catch
try {
  const { spawn } = await import("node:child_process");
  // 使用 spawn
} catch (err) {
  // 浏览器回退
  throw new Error("此功能需要 Node.js 运行时");
}

// 方式 2：getNodeModules() 同步访问
const { fs } = getNodeModules();
if (!fs) {
  throw new Error("此功能需要 Node.js 运行时");
}
// 使用 fs
```

## 提交规范

### Commit Message 格式

```
<type>: v<version> — <summary>

<body>

<footer>
```

**type**：
- `feat` — 新功能
- `fix` — Bug 修复
- `refactor` — 重构（无功能变化）
- `docs` — 文档
- `test` — 测试
- `chore` — 构建/工具

**示例**：
```
feat: v11.7.0 — Phase 4 js-md5 replacement + core/CLI split + docs

- Replace hand-rolled MD5 with js-md5 library
- Add yuanbao-lite/cli subpath export
- Add comprehensive Chinese dev docs in docs/
- Rewrite README.md

Committer: Z.ai Agent <agent@z.ai>
```

### 版本号策略

遵循 SemVer：
- **主版本号**（12.0.0）：不兼容的 API 变更（不轻易递增）
- **次版本号**（11.7.0）：新增功能（向下兼容）
- **修订号**（11.6.1）：Bug 修复（向下兼容）

### 提交者信息

所有提交使用：
```
Author: Z.ai Agent <agent@z.ai>
```

## 添加新命令

### 1. 创建命令文件

`src/commands/handlers/<category>/<name>.ts`：

```typescript
/**
 * /mycommand command handler.
 * Category: utility
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "mycommand",
    aliases: ["mc", "我的命令"],
    description: "做某件事",
    usage: "/mycommand <参数>",
    category: "utility" as CommandCategory,
    elevated: false,  // 是否需要 elevated 权限
    handler: async (ctx) => {
      const arg = ctx.args[0];
      if (!arg) {
        await ctx.reply("用法: /mycommand <参数>");
        return { handled: true };
      }
      // 实现...
      await ctx.reply(`结果: ${arg}`);
      return { handled: true };
    },
  });
}
```

### 2. 注册命令

编辑 `src/commands/handlers/index.ts`：

```typescript
import { register as registerMyCommand } from "./utility/mycommand.js";

export function registerAll(cmdSys: CommandSystem): void {
  // ...现有命令...
  registerMyCommand(cmdSys);
}
```

### 3. 更新帮助文本

编辑 `src/commands/help-text.ts`，在对应分类下添加命令说明。

### 4. 测试

```bash
npm run build
npx yb-cli rc /mycommand test
```

## 添加新 Store

### 1. 创建 Store 类

`src/business/my-store.ts`：

```typescript
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { PersistenceAdapter } from "../access/persistence/adapter.js";
import { getDefaultPersistenceAdapter, getDefaultPersistenceDir, joinPath } from "../access/persistence/adapter.js";

export type MyEntry = {
  id: string;
  name: string;
};

export type MyStoreConfig = {
  persistencePath?: string;
  autoSave?: boolean;
  persistenceAdapter?: PersistenceAdapter;
};

export class MyStore {
  private entries = new Map<string, MyEntry>();
  private config: MyStoreConfig;
  private log: ModuleLog;
  private persistenceAdapter: PersistenceAdapter | null = null;

  constructor(config?: MyStoreConfig) {
    this.config = {
      persistencePath: config?.persistencePath,
      autoSave: config?.autoSave ?? false,
      persistenceAdapter: config?.persistenceAdapter,
    };
    this.log = createLog("my-store");
    if (this.config.persistencePath) {
      // 自动加载
    }
  }

  private getAdapter(): PersistenceAdapter {
    // ...同其他 store
  }

  add(entry: MyEntry): void {
    this.entries.set(entry.id, entry);
    // 持久化
  }

  // ...
}

// 全局单例
let globalStore: MyStore | null = null;
export function getGlobalMyStore(config?: MyStoreConfig): MyStore {
  if (!globalStore) globalStore = new MyStore(config);
  return globalStore;
}
```

### 2. 导出

在 `src/index.ts` 添加导出：

```typescript
export { MyStore, getGlobalMyStore } from "./business/my-store.js";
export type { MyEntry, MyStoreConfig } from "./business/my-store.js";
```

## 发布流程

### 1. 更新版本

```bash
# 修订号
npm version patch --no-git-tag-version

# 次版本号
npm version minor --no-git-tag-version
```

同步更新 `src/version.ts` 中的 `FALLBACK_VERSION`。

### 2. 更新文档

- 更新 `README.md` 的版本和变更记录
- 更新 `docs/` 下的相关文档
- 更新 `CHANGELOG`（如有）

### 3. 验证

```bash
npm run build
npm run lint
npm run test:e2e  # 需要凭据
```

### 4. 提交并推送

```bash
git add -A
git commit -m "feat: v11.7.0 — ..."
git push origin feat/browser-decouple
```

### 5. 发布到 npm（仅维护者）

```bash
npm publish
```

## 文档贡献

### 修改文档

- 中文文档位于 `docs/`
- README.md 是英文/中文混合的快速上手指南
- 代码注释使用英文（国际化考虑）

### 文档规范

- 使用 Markdown
- 代码块标注语言（```typescript、```bash）
- 表格对齐
- 链接使用相对路径

## 问题反馈

- [GitHub Issues](https://github.com/ShiningYangYXN/yuanbao-lite/issues)
- 提交 issue 时请包含：
  - 版本号（`npx yb-cli --version`）
  - 运行环境（Node 版本/浏览器）
  - 复现步骤
  - 期望行为 vs 实际行为
  - 日志（启用 `--log debug`）

## 行为准则

- 尊重所有贡献者
- 假设善意
- 接受建设性批评
- 关注项目最佳利益
