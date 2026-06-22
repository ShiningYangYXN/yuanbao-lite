# Yuanbao Lite — Browser Decoupling Analysis

> Comprehensive analysis of `yuanbao-lite` core-logic Node.js dependencies and
> feasibility of running the bot core in a browser / Web Worker environment.
> Scope: **core logic only** (`src/index.ts`, `src/access/`, `src/business/`,
> `src/shared/`, `src/logger.ts`, `src/accounts.ts`, `src/types.ts`).
> Explicitly **out of scope**: `src/cli/` (REPL + HTTP daemon) and
> `src/commands/handlers/` (53 chat commands).

Generated: 2024 (analysis pass).

---

## 1. Project Architecture Overview

### 1.1 Build configuration

- **`package.json`**: `"type": "module"` (ESM), `"main": "./dist/index.js"`,
  `"bin": "./dist/cli/index.js"`. Built via `tsc` (no bundler).
- **`tsconfig.json`**:
  - `target: "ES2023"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`.
  - `verbatimModuleSyntax: true` (forces `import type` for type-only imports — good for tree-shaking).
  - `resolveJsonModule: true` (allows `import json from "./x.json"`).
  - `strict: true`, `declaration: true`, no source maps.
- **Runtime deps** (from `package.json`):
  - **Isomorphic**: `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`,
    `@ai-sdk/openai-compatible`, `@ai-sdk/provider`, `marked`, `protobufjs`.
  - **Node-only (likely)**: `ws`, `@ai-sdk/amazon-bedrock` (SigV4 — uses Node crypto).
  - **CLI-only (out of scope)**: `chalk`, `cli-table3`, `commander`, `@clack/prompts`,
    `markdown-table`, `marked-terminal`, `string-width`, `table`, `defuddle`, `linkedom`.

### 1.2 Module map (in-scope only)

| Module | Role | Primary Node deps |
|---|---|---|
| `src/index.ts` (1922 L) | `YuanbaoBot` main class — event emitter, lifecycle, message dispatch | `node:fs`, `node:path`, `node:os` |
| `src/access/ws/client.ts` | `YuanbaoWsClient` — connect/auth/heartbeat/reconnect | `node:crypto`, `ws` |
| `src/access/ws/conn-codec.ts` | Connection-layer protobuf codec (ConnMsg/AuthBind/Ping/Push) | — (protobufjs + JSON descriptor) |
| `src/access/ws/biz-codec.ts` | Business-layer protobuf codec (send/decode all biz messages) | — (protobufjs + JSON descriptor) |
| `src/access/ws/types.ts` | Type definitions | — |
| `src/access/http/request.ts` | Sign-token fetch + HMAC signing + cache + refresh timers | `node:crypto`, `node:os` |
| `src/access/http/media.ts` | COS upload + legacy upload + download + image-size parsing | `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `Buffer` |
| `src/access/http/gofile.ts` | GoFile upload (alt file sharing) | `node:fs`, `node:fs/promises`, `node:path`, `Buffer` |
| `src/access/http/tempfile.ts` | Multi-provider temp file upload | `node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `Buffer` |
| `src/business/llm-takeover.ts` | `LlmTakeoverEngine` — Vercel AI SDK + key/provider pools + persistence | `node:fs`, `node:path`, `ai`, `@ai-sdk/*`, `marked` |
| `src/business/alias.ts` | `AliasStore` (id↔alias) + file persistence | `node:fs`, `node:path` |
| `src/business/contacts.ts` | `ContactStore` + file persistence | `node:fs`, `node:path` |
| `src/business/groups.ts` | `GroupStore` + file persistence | `node:fs`, `node:path` |
| `src/business/history.ts` | `MessageHistoryStore` (ring buffer + JSONL persistence) | `node:fs`, `node:path` |
| `src/business/trust.ts` | Trust list + per-command grants (file persistence) | `node:fs`, `node:path`, `node:os` |
| `src/business/block.ts` | Block list (file persistence) | `node:fs`, `node:path`, `node:os` |
| `src/business/reminders.ts` | `/remind` + `/cron` jobs (file persistence + `setTimeout`) | `node:fs`, `node:path`, `node:os` |
| `src/business/sticker.ts` | Sticker registry + pack loading + image upload | `node:fs`, `node:path`, `node:os` |
| `src/business/interpolate.ts` | `${...}` interpolation engine (uses `new Function`) | — (already `typeof process` guarded) |
| `src/business/multi-account.ts` | `MultiAccountManager` (pure logic) | — |
| `src/business/batch.ts` | `BatchRunner` (pure logic + `setTimeout`) | — |
| `src/business/search.ts` | `SearchEngine` (fuzzy over groups/members) | — |
| `src/business/mention.ts` | `@mention` parser & msg-body builder (pure) | — |
| `src/business/messaging/extract.ts` | Convert `YuanbaoInboundMessage` → `ChatMessage` | — |
| `src/business/messaging/forward-records-proto.ts` | Decode base64 protobuf forwarded-records | `Buffer.from(b64)` (single line, replaceable) |
| `src/business/messaging/forward-records.ts` | Pure logic for forwarded-record text rendering | — |
| `src/business/content-store.ts` | In-memory LRU content store (no persistence) | — |
| `src/shared/config.ts` | `ConfigStore` (file persistence, multi-profile) | `node:fs`, `node:path`, `node:os` |
| `src/logger.ts` | Structured logger (console-based, sensitive-key masking) | — |
| `src/accounts.ts` | `resolveAccount` (defaults + validation, pure) | — |
| `src/version.ts` | `getVersion()` from package.json (uses `import.meta.url`) | `node:fs`, `node:path`, `node:url` |
| `src/types.ts` | Type definitions only | — |
| `src/commands/registry.ts` | `CommandSystem` — calls `registerAll()` from constructor | (transitively pulls all 53 handlers) |
| `src/commands/session-utils.ts` | Session key helper (pure) | — |
| `src/commands/types.ts` | Type definitions only | — |

### 1.3 Entry-point dependency chain

`src/index.ts` **statically imports** `CommandSystem` from `./commands/registry.js`
(line 45). `CommandSystem`'s constructor calls `registerBuiltinCommands()` →
`registerAll(this)` (line 923) which imports all 53 command handler files
from `./handlers/index.js`. Several handlers transitively import
`node:child_process` (`system/shell.ts`, `system/term.ts`), `node:os`
(`info/myip.ts`), `node:fs`/`node:path` (`media/tempfile.ts`, `chat/stickers.ts`).

**Consequence**: Even though `YuanbaoBotConfig` supports `commands: false` to
disable command instantiation at runtime, the **static import graph** still
drags in every handler module. A browser bundler will try to resolve
`node:child_process` etc. and fail (or include broken polyfills).

**This is the single most important architectural blocker.** It must be
fixed first — see §6, §8 (Risk #1), and §10 (Phase 1).

---

## 2. Node.js Dependency Audit (by file, with line numbers)

### 2.1 `src/index.ts`
- L35: `import { existsSync, readFileSync } from "node:fs";`
- L36: `import { join } from "node:path";`
- L37: `import { homedir } from "node:os";`
- L45: `import { CommandSystem } from "./commands/registry.js";` ← **chain to handlers**
- L167-188, L212: `join(homedir(), ".yuanbao-lite", "...")` for alias/contact/group/history/LLM store paths.
- L1032-1034: `join(homedir(), ".yuanbao-lite", "runtime-prefs.json")` + `existsSync` + `readFileSync` (loadRuntimePrefs).
- L1102: `setImmediate(...)` (browser-safe; available in Web Workers too).
- L279, L287: `event.data instanceof Buffer` (in `handleMessage`, but that's in `access/ws/client.ts` — see below).

### 2.2 `src/access/ws/client.ts`
- L7: `import { randomUUID } from "node:crypto";` ← **replaceable** with `crypto.randomUUID()` (Web Crypto).
- L8: `import WebSocket from "ws";` ← **replaceable** with native `WebSocket`.
- L73: `MAX_MESSAGE_SIZE = 64 * 1024 * 1024` (passed to `ws` constructor — native WS has no such option; browser enforces its own limits).
- L126: `new WebSocket(url, { maxPayload: MAX_MESSAGE_SIZE })` — native `WebSocket` ctor accepts only `(url, protocols)`.
- L131-134: `ws.onopen = ...; ws.onmessage = ...; ws.onclose = ...; ws.onerror = ...` — works on both `ws` and native.
- L279: `event.data instanceof Buffer` — browser WS delivers `ArrayBuffer`/`Blob`, never `Buffer`.
- L445: `reason: string | Buffer` in `handleClose` signature — native passes `string`.
- L595: `WebSocket.OPEN` constant — exists on native too.

### 2.3 `src/access/ws/conn-codec.ts`
- L8: `import protobuf from "protobufjs";` ← **browser-compatible** (protobufjs ships a browser bundle).
- L10: `import jsonDescriptor from "./proto/conn.json" with { type: "json" };` ← **works in Vite/Rollup/esbuild** (JSON import assertion).
- No `fs`, no `.proto` loading at runtime. The `.proto` files in `proto/` directory are documentation only — runtime uses the inlined JSON descriptor via `protobuf.Root.fromJSON(jsonDescriptor)` (L16).

### 2.4 `src/access/ws/biz-codec.ts`
- L5: `import protobuf from "protobufjs";` ← browser-compatible.
- L14: `import bizDescriptor from "./proto/biz.json" with { type: "json" };` ← bundler-friendly.
- Pure encode/decode logic. **Browser-ready**.

### 2.5 `src/access/ws/types.ts`
- Pure types. **Browser-ready**.

### 2.6 `src/access/http/request.ts`
- L8: `import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";` ← **replaceable** with Web Crypto API (async).
- L9: `import os from "node:os";`
- L46: `os.type()` (used for `X-OperationSystem` header) ← replace with `"Browser"`/`"Web"`.
- L102-103: `createHmac("sha256", appSecret).update(plain).digest("hex")` (HMAC-SHA256, hex output).
- L107-112: `Buffer.from(s, "hex")` + `timingSafeEqual` — only used in `verifySignature` (webhook verification). **Not needed for outbound bot** — can be omitted in browser bundle.
- L130: `randomBytes(16).toString("hex")` (nonce) ← replace with `crypto.getRandomValues(new Uint8Array(16))` + hex encode.
- L152-156: `fetch(url, { method, headers, body })` ← native browser fetch.
- L198: `setTimeout` for token refresh scheduling (browser-safe; killed on page reload).
- **CORS concern**: `bot.yuanbao.tencent.com` (sign-token endpoint) likely does NOT return `Access-Control-Allow-Origin: *`. Direct browser calls will be blocked. **Mitigation**: route through a CORS proxy or a small serverless function in production.

### 2.7 `src/access/http/media.ts`
- L16-19: `node:fs`, `node:fs/promises`, `node:path`, `node:crypto` (`randomBytes`, `createHash`, `createHmac`).
- L140: `parseImageSize(buf: Buffer)` — operates on raw bytes for JPEG/PNG/GIF/WebP size detection. Replace `Buffer` with `Uint8Array` (use `DataView` for `readUInt32BE` etc.).
- L399, L404-405: `createHmac("sha1", secretKey)` + `createHash("sha1")` — COS v1 signature. Replaceable with Web Crypto (async).
- L435: `body: new Uint8Array(data)` for fetch — browser OK.
- L491: `createHash("md5").update(fileBuffer).digest("hex")` — Web Crypto doesn't support MD5. Use a small MD5 lib or skip (MD5 used as `uuid`, not security-critical).
- L558: `body: Buffer.from(formData)` — `formData` is already `Uint8Array`; `Buffer.from` is redundant.
- L677: `const buffer = Buffer.from(arrayBuffer); await writeFile(filePath, buffer);` — in browser, use `IndexedDB`/`showSaveFilePicker` (File System Access API) or memory-only.
- L659: `process.cwd()` (default download dir) ← browser has no cwd; inject a default.
- **COS upload CORS concern**: `${bucket}.cos.${region}.myqcloud.com` PUT requests with custom Authorization headers are preflighted (`OPTIONS`) — Tencent COS may not handle preflight correctly from arbitrary origins. **Mitigation**: same as 2.6 — proxy or serverless.

### 2.8 `src/access/http/gofile.ts`
- L12-14: `node:fs`, `node:fs/promises`, `node:path`.
- L78: `body: Buffer.from(formData)` — same as media.ts, redundant.
- CORS: `store1.gofile.io` — likely allows CORS (GoFile is designed for browser uploads), but verify.

### 2.9 `src/access/http/tempfile.ts`
- L13-16: `node:fs`, `node:fs/promises`, `node:path`, `node:crypto` (`randomBytes`).
- 4× `body: Buffer.from(formData)` (lines 155, 227, 310 — different providers).
- Same adapter pattern needed as media.ts.

### 2.10 `src/business/llm-takeover.ts`
- L22-28: `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/openai-compatible`, `marked`.
- L29-30: `node:fs`, `node:path`.
- L667-673: `dirname(persistencePath)` + `existsSync` + `mkdirSync` + `writeFileSync` (`persistConfig`).
- L680-689: `existsSync` + `readFileSync` + `JSON.parse` (`loadPersistedConfig`).
- L776-781: `generateText({ model, system, messages, temperature })` ← isomorphic.
- **`@ai-sdk/amazon-bedrock`** uses AWS SigV4 signing internally — likely pulls `node:crypto` (or `@aws-sdk/*` which may polyfill). **Risk**: bundler errors or runtime failures in browser. **Mitigation**: skip Bedrock in browser bundle (only register 4 of 5 API formats), or use a Bedrock-proxy endpoint.

### 2.11 `src/business/alias.ts`
- L16-17: `node:fs` (`existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`), `node:path` (`dirname`).
- Pattern: constructor checks `existsSync(persistencePath)`, calls `load()` (reads file), `save()` writes JSON. Same pattern in `contacts.ts`, `groups.ts`, `history.ts`.

### 2.12 `src/business/contacts.ts`, `groups.ts`, `history.ts`
- Identical pattern to `alias.ts`. `history.ts` additionally uses `appendFileSync` (JSONL append) and `writeFileSync` (full rewrite on save).

### 2.13 `src/business/trust.ts`, `block.ts`, `reminders.ts`
- L28-30 (`trust.ts`), L34-36 (`block.ts`), L11-13 (`reminders.ts`): `node:fs` + `node:path` + `node:os`.
- Module-level constants: `const TRUST_FILE = join(homedir(), ".yuanbao-lite", "trust.json");` — hard-coded path.
- Module-level `let cache: ... | null` and `load()/save()` — singleton pattern, not injectable.
- `reminders.ts` uses `setTimeout` (browser-safe, but killed on page reload).

### 2.14 `src/business/sticker.ts`
- L20-22: `node:fs` (`existsSync`, `readdirSync`, `readFileSync`, `statSync`, `writeFileSync`, `mkdirSync`), `node:path`, `node:os`.
- L25: `import { uploadMediaToCos } from "../access/http/media.js";` — pulls media.ts (and its Node deps).
- `loadStickerPacksFromDir(dir)` reads filesystem — needs adapter.

### 2.15 `src/business/interpolate.ts`
- L53-57: `typeof process !== "undefined" ? process.env : {}` — **already browser-guarded**.
- L109-110: `__dirname`/`__filename` regex patterns in `DANGEROUS_PATTERNS` (blocklist for unsafe expressions) — references in code only, not actual usage.
- L177: `new Function(...allKeys, "use strict; return (expr)")` — works in browser unless CSP blocks `unsafe-eval`. **Risk**: CSP-strict environments.

### 2.16 `src/business/multi-account.ts`, `batch.ts`, `search.ts`, `mention.ts`, `content-store.ts`, `messaging/extract.ts`, `messaging/forward-records.ts`
- Pure logic, no Node imports. **Browser-ready**.

### 2.17 `src/business/messaging/forward-records-proto.ts`
- L10: `import protobuf from "protobufjs";` — browser-compatible.
- L13-80: inline JSON descriptor (`FORWARD_PROTO_DESCRIPTOR` constant) — no file read.
- L93: `const bytes = Buffer.from(value, "base64");` ← **single Node dependency**. Replace with:
  ```ts
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  ```
  (or use a `base64-to-uint8array` utility).

### 2.18 `src/shared/config.ts`
- L16-18: `node:fs`, `node:path` (`join`, `resolve`), `node:os` (`homedir`).
- L89: `const DEFAULT_CONFIG_DIR = join(homedir(), ".yuanbao-lite");` — hard-coded.
- L102: `resolve(p)` in `normalizePath` — uses Node path resolution semantics (cwd + relative).
- L188: `existsSync(this.configPath)` (`exists()` method).
- L276: `writeFileSync(...)` (`save()`).
- L289: `readFileSync(...)` (`load()`).
- L274: `mkdirSync(this.configDir, { recursive: true })`.
- All persistence calls are inside class methods — **injectable via adapter**.

### 2.19 `src/logger.ts`
- No Node imports. Uses `console.log/warn/error/debug` only. **Browser-ready**.

### 2.20 `src/accounts.ts`
- No Node imports. Pure function. **Browser-ready**.

### 2.21 `src/version.ts`
- L14-16: `node:fs`, `node:path`, `node:url`.
- L33: `fileURLToPath(import.meta.url)` — Node-only construct.
- L60: hardcoded fallback `"11.4.3"` — works in any environment.
- **Mitigation**: in browser bundle, replace `getVersion()` body with constant return (bundler can do this via `define`).

### 2.22 `src/types.ts`
- Pure type definitions. **Browser-ready**.

### 2.23 `src/commands/registry.ts`, `commands/session-utils.ts`, `commands/types.ts`
- `registry.ts`: no direct Node imports, but constructor calls `registerAll()` from `./handlers/index.js` which transitively imports 53 handlers — **several** of which import `node:` builtins.
- `session-utils.ts`: pure logic.
- `types.ts`: pure types.

### 2.24 `src/commands/handlers/*` (OUT OF SCOPE per user request)
- The following handlers have **direct** Node imports (will break browser bundle if pulled in):
  - `system/shell.ts` L35: `await import("node:child_process")`
  - `system/term.ts` L52: `spawn("bash", ...)` from `node:child_process`
  - `info/myip.ts` L63: `await import("node:os")` (networkInterfaces)
  - `media/tempfile.ts` L13-14: `node:fs`, `node:path`
  - `chat/stickers.ts` L13: `node:path`
  - `system/config.ts`, `system/daemon.ts`, `system/init.ts` — likely use persistence modules.
  - `commands/utils/table.ts` L13: `markdown-table` (browser-OK but only used by handlers).

---

## 3. Module-by-Module Browser Feasibility Analysis

Legend: 🟢 Browser-ready · 🟡 Adaptable (needs shimming) · 🔴 Blocked (heavy Node deps)

| Module | Verdict | Notes |
|---|---|---|
| `src/index.ts` | 🟡 | Replace `node:fs`/`node:os` reads with adapter-injected persistence; break static `CommandSystem` import → dynamic import guarded by `config.commands !== false`. |
| `src/access/ws/client.ts` | 🟡 | Replace `ws` package with native `WebSocket`; replace `randomUUID` with `crypto.randomUUID()`; normalize `Buffer` → `ArrayBuffer` in message handler. |
| `src/access/ws/conn-codec.ts` | 🟢 | Already uses JSON descriptor via `protobuf.Root.fromJSON`. protobufjs works in browser. |
| `src/access/ws/biz-codec.ts` | 🟢 | Same as above. |
| `src/access/ws/types.ts` | 🟢 | Pure types. |
| `src/access/http/request.ts` | 🟡 | Replace `createHmac`/`randomBytes` with Web Crypto (async — refactor `computeSignature` to return `Promise<string>`); drop `timingSafeEqual`/`verifySignature` (webhook-only); replace `os.type()` with `"Browser"`; **CORS blocker** for `bot.yuanbao.tencent.com` direct calls. |
| `src/access/http/media.ts` | 🟡 | Inject `FileStorage` adapter for `readFile`/`writeFile`/`statSync`; replace `Buffer` with `Uint8Array`; replace MD5 (`createHash("md5")`) with small lib; replace COS HMAC-SHA1 with Web Crypto. **CORS blocker** for Tencent COS. |
| `src/access/http/gofile.ts` | 🟡 | Same as media.ts. GoFile may allow browser CORS. |
| `src/access/http/tempfile.ts` | 🟡 | Same as media.ts. |
| `src/business/llm-takeover.ts` | 🟡 | Inject persistence adapter; **`@ai-sdk/amazon-bedrock`** is the biggest risk — consider excluding it from browser bundle. Other AI SDK providers are isomorphic. `marked` is browser-compatible. |
| `src/business/alias.ts` | 🟡 | Inject persistence adapter. |
| `src/business/contacts.ts` | 🟡 | Same. |
| `src/business/groups.ts` | 🟡 | Same. |
| `src/business/history.ts` | 🟡 | Same; JSONL append pattern works with IndexedDB. |
| `src/business/trust.ts` | 🔴→🟡 | Module-level `TRUST_FILE` constant + module-level `cache` singleton — needs refactor to class-based or injectable path before adapter pattern can apply. |
| `src/business/block.ts` | 🔴→🟡 | Same as trust.ts. |
| `src/business/reminders.ts` | 🔴→🟡 | Same; plus `setTimeout`-based scheduling is killed on page reload — needs restart-on-load logic. |
| `src/business/sticker.ts` | 🟡 | Inject `FileStorage` adapter; `loadStickerPacksFromDir` is browser-incompatible (no filesystem) — make optional / replace with `loadStickerPacksFromUrls`. |
| `src/business/interpolate.ts` | 🟢 | Already `typeof process`-guarded. CSP-strict environments may block `new Function`. |
| `src/business/multi-account.ts` | 🟢 | Pure logic. |
| `src/business/batch.ts` | 🟢 | Pure logic + `setTimeout`. |
| `src/business/search.ts` | 🟢 | Pure logic. |
| `src/business/mention.ts` | 🟢 | Pure logic. |
| `src/business/messaging/extract.ts` | 🟢 | Pure logic. |
| `src/business/messaging/forward-records-proto.ts` | 🟡 | Single `Buffer.from(b64)` call — replace with `atob`-based decode. |
| `src/business/messaging/forward-records.ts` | 🟢 | Pure logic. |
| `src/business/content-store.ts` | 🟢 | In-memory LRU, no persistence. |
| `src/shared/config.ts` | 🟡 | Inject persistence adapter; replace `resolve()` with simple path-join (no cwd in browser). |
| `src/logger.ts` | 🟢 | Console-based. |
| `src/accounts.ts` | 🟢 | Pure function. |
| `src/version.ts` | 🟡 | Replace `import.meta.url` + `readFileSync` body with constant return (bundler `define` or runtime fallback already covers it). |
| `src/types.ts` | 🟢 | Pure types. |
| `src/commands/registry.ts` | 🔴 (transitive) | No direct Node imports, but `registerAll()` from constructor pulls all 53 handlers. **Must break the static import chain** (see §6). |
| `src/commands/session-utils.ts` | 🟢 | Pure logic. |
| `src/commands/types.ts` | 🟢 | Pure types. |

### 3.1 Specific WS-layer analysis (per user request)

`src/access/ws/` uses the `ws` npm package only inside `client.ts` (1 file, 1 import).
The browser has native `WebSocket` (RFC 6455), so this is a near-perfect replacement.
The differences to bridge:

| `ws` API | Native `WebSocket` API |
|---|---|
| `new WebSocket(url, { maxPayload })` | `new WebSocket(url)` (no options arg; browser enforces frame limits) |
| `ws.onopen = fn` | `ws.onopen = fn` (same) |
| `ws.onmessage = fn` | `ws.onmessage = fn` (same — but `event.data` is `ArrayBuffer`/`Blob`, never `Buffer`) |
| `ws.onclose = fn` | `ws.onclose = fn` (`CloseEvent.reason` is `string`, never `Buffer`) |
| `ws.onerror = fn` | `ws.onerror = fn` (`event` is `Event`, no `message` field — must use `onclose` for details) |
| `ws.send(Uint8Array)` | `ws.send(Uint8Array)` (same; binaryType = "arraybuffer" required) |
| `ws.close(code, reason)` | `ws.close(code, reason)` (same) |
| `WebSocket.OPEN` constant | Same |
| `event.data instanceof Buffer` | `event.data instanceof ArrayBuffer` |

**Conclusion**: WS layer is **highly adaptable** — a single wrapper file can present
the `YuanbaoWsClient` interface to the bot core, with native WebSocket underneath
in the browser entry and `ws` underneath in the Node entry.

### 3.2 HTTP signing analysis (per user request)

`src/access/http/request.ts` `computeSignature` (L96-104):

```ts
const plain = nonce + timestamp + appKey + appSecret;
return createHmac("sha256", appSecret).update(plain).digest("hex");
```

**Web Crypto replacement** (note: Web Crypto HMAC is async):

```ts
async function computeSignatureBrowser(p: {
  nonce: string; timestamp: string; appKey: string; appSecret: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(p.appSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const plain = p.nonce + p.timestamp + p.appKey + p.appSecret;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(plain));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

**Callers** of `computeSignature` (only `doFetchSignToken` at L136) — refactor
`getSignToken` flow to await the async signature.

**Other crypto**:
- `randomBytes(16).toString("hex")` → `crypto.getRandomValues(new Uint8Array(16))` + hex helper.
- `timingSafeEqual` / `verifySignature` (L106-113) → **only used for inbound webhook verification, which the bot doesn't do**. Safe to omit in browser bundle.

**HTTPS calls** to Tencent endpoints:
- `bot.yuanbao.tencent.com/api/v5/robotLogic/sign-token` — sign-token
- `bot.yuanbao.tencent.com/api/resource/genUploadInfo` — COS upload config
- `bot.yuanbao.tencent.com/api/resource/v1/download` — download URL
- `${bucket}.cos.${region}.myqcloud.com` — COS PUT upload

**All of these will face CORS preflight (`OPTIONS`) from browsers.** Tencent's
servers almost certainly do not include `Access-Control-Allow-Origin` headers
for arbitrary browser origins. **Direct browser→Tencent is infeasible in
production** without:

(a) A CORS proxy (e.g., `cors-anywhere`), or
(b) A thin serverless function (Cloudflare Workers, Vercel Edge) that forwards
    requests with the right headers, or
(c) A self-hosted relay (the existing `cli/daemon/server.ts` could be adapted
    for this purpose, but that's out of scope per user request).

**Recommendation**: design the browser entry to accept an `httpProxy` config
option (a URL prefix) that wraps all outbound HTTP calls. Production deployments
always supply one. Local development can use `cors-anywhere` or similar.

---

## 4. Protobuf Dependency Analysis

### 4.1 Layout
```
src/access/ws/proto/
├── conn.proto          (177 lines — documentation only, NOT imported at runtime)
├── conn.json           (392 lines — runtime descriptor, imported via import assertion)
├── biz/
│   ├── *.proto         (8 files — documentation only)
│   └── ...
└── biz.json            (runtime descriptor, imported via import assertion)
```

### 4.2 Loading mechanism

`src/access/ws/conn-codec.ts` L10:
```ts
import jsonDescriptor from "./proto/conn.json" with { type: "json" };
```

`src/access/ws/biz-codec.ts` L14:
```ts
import bizDescriptor from "./proto/biz.json" with { type: "json" };
```

`src/business/messaging/forward-records-proto.ts` L13-80:
inline JSON descriptor constant (`FORWARD_PROTO_DESCRIPTOR`).

All three use `protobuf.Root.fromJSON(descriptor)` (not `protobuf.load(...)`,
which would read from filesystem). **No `.proto` file is ever read at runtime.**

### 4.3 Browser compatibility of `protobufjs`

- `protobufjs` ships a `dist/protobuf.min.js` browser bundle (~50KB gzipped).
- The `Root.fromJSON()` / `Type.encode/decode` API is fully browser-compatible.
- The npm package's `"browser"` field in its `package.json` redirects `"./"` to the
  browser build (so bundlers like Vite/Webpack/Rollup pick it automatically).
- **One caveat**: `protobufjs/minimal` pulls in `long.js` for int64 support. Both
  bundle cleanly to browser.

**Conclusion**: protobuf layer is **browser-ready with zero code changes**.
Bundlers handle the JSON import assertions natively (Vite, esbuild, Rollup,
Webpack 5+ all support `with { type: "json" }`).

---

## 5. HTTP Signing Logic Analysis

(See §3.2 above for full analysis.)

**Summary**:
- HMAC-SHA256 (sign-token) and HMAC-SHA1 (COS v1 signature) — both replaceable with Web Crypto API.
- MD5 (file UUID) — Web Crypto doesn't support MD5. Use `js-md5` or skip (UUID is not security-critical).
- `randomBytes` — replaceable with `crypto.getRandomValues`.
- `timingSafeEqual` — only used in `verifySignature` (webhook verification, unused by outbound bot). Drop in browser.
- All HTTPS endpoints face CORS blockers → must use HTTP proxy in production.

---

## 6. CLI/Command System Scope

### 6.1 Out-of-scope confirmation

Per user request, the browser decoupling targets **core logic only**:
- ✅ In scope: `src/index.ts`, `src/access/`, `src/business/`, `src/shared/`,
  `src/logger.ts`, `src/accounts.ts`, `src/types.ts`, `src/version.ts`,
  `src/commands/session-utils.ts` (pure helper), `src/commands/types.ts` (pure types).
- ❌ Out of scope: `src/cli/` (REPL, wizard, daemon HTTP server, PID file, daemon-client
  with `node:child_process` spawn) and `src/commands/handlers/` (53 chat commands).

### 6.2 The `CommandSystem` blocker in `src/index.ts`

**Critical finding**: Even though `src/cli/` and `src/commands/handlers/` are out
of scope for browser decoupling, `src/index.ts` **statically imports** `CommandSystem`
from `./commands/registry.js` (L45) and instantiates it unless
`config.commands === false` (L191).

`CommandSystem`'s constructor calls `registerBuiltinCommands()` (L67) → `registerAll(this)` (L923).
`registerAll()` (in `./handlers/index.js`) statically imports all 53 handler files,
several of which import `node:child_process`, `node:os`, `node:fs`, `node:path`.

**Result**: Any bundler attempting to produce a browser bundle for `src/index.ts`
will transitively encounter `node:child_process` etc. and either:
1. Fail outright (Vite default — no Node polyfills).
2. Include broken polyfills (Webpack with `node-polyfill-webpack-plugin`).
3. Pull in dead code that won't run but bloats the bundle.

**Mitigation options**:

| Option | Effort | Trade-off |
|---|---|---|
| A. Use `await import("./commands/registry.js")` only when `config.commands !== false` | Small (5-line change in index.ts) | Slight startup latency; bundler can split commands into a separate chunk that browser bundle excludes. |
| B. Conditional re-export: `src/index.ts` becomes a thin re-exporter; `src/index-node.ts` includes commands, `src/index-browser.ts` excludes them | Medium (split file + package.json exports map) | Clean separation; two entry points to maintain. |
| C. Make `registerAll()` itself a dynamic-import inside `registerBuiltinCommands()` | Small | Doesn't help — `registerAll` is itself statically imported at the top of `registry.ts`. Would require restructuring `handlers/index.ts` to use `await import()` per handler — invasive. |
| D. Move `CommandSystem` to a separate subpath (`yuanbao-lite/commands`) and never import it from `src/index.ts` | Medium-large refactor | Cleanest long-term; but breaks the existing `import { YuanbaoBot, CommandSystem } from "yuanbao-lite"` public API. |

**Recommendation**: combine A + B. See §9.

---

## 7. Build/Bundler Considerations

### 7.1 TypeScript config

Current `tsconfig.json` uses `module: "NodeNext"`, which is correct for Node
ESM but **not ideal for browser bundlers**. Vite/esbuild prefer `module: "ESNext"`
or `moduleResolution: "bundler"`. However, since the existing build pipeline is
`tsc → dist/`, and bundlers can consume `NodeNext` output with appropriate
settings, this is not a blocker — only an ergonomic issue.

For a browser bundle, recommended approach:
1. Keep `tsc` build for Node (`dist/`).
2. Add a **separate** bundler step (Vite library mode or Rollup) that produces
   `dist-browser/yuanbao-lite.js` from `src/index-browser.ts`.
3. Add `"browser"` field to `package.json` pointing to the browser bundle.

### 7.2 `import.meta.url`

Used in `src/version.ts` (L33) and `src/cli/daemon/server.ts` (L393, out of scope).

- In a browser bundle, `import.meta.url` works (returns the bundle URL), but
  `fileURLToPath(...)` will throw. The existing fallback at L60 (`cachedVersion = "11.4.3"`)
  already handles this gracefully — `try/catch` falls through to the hardcoded version.
- For a cleaner browser build, the bundler can `define` `import.meta.url` or
  replace `getVersion()` body entirely with a constant.

### 7.3 JSON import assertions

`with { type: "json" }` syntax (used in conn-codec.ts L10, biz-codec.ts L14):

```ts
import jsonDescriptor from "./proto/conn.json" with { type: "json" };
```

**Browser bundler support**:
- ✅ Vite (4+)
- ✅ Webpack 5+ (with `experiments.futureDefaults: true` or `parser.javascript.commonjsMagicComments`)
- ✅ Rollup (with `@rollup/plugin-json`)
- ✅ esbuild (supports JSON imports natively)

No issues expected.

### 7.4 Dynamic imports in `src/index.ts`

- L1083: `await import("./business/trust.js")` (lazy load `setMasterUserId`)
- L1104: `void import("./business/reminders.js").then(...)` (lazy load `startAllJobs`)
- L1599: `await import("./business/llm-takeover.js")` (lazy load `formatChatMessageForContext`)
- L1635: `await import("./business/block.js")`
- L1673: `await import("./business/trust.js")`

These are all `await import("./business/...")` — bundlers handle them cleanly
(code-splitting into chunks). No issues.

### 7.5 `verbatimModuleSyntax: true`

Forces `import type` for type-only imports. Good for tree-shaking — bundlers
can drop type-only imports. **No issues** for browser bundling.

---

## 8. Risk Inventory (Top 10)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Static import chain** from `src/index.ts` → `CommandSystem` → all 53 handlers pulls `node:child_process`/`node:os`/`node:fs` into the browser bundle | 🔴 Critical | Convert `import { CommandSystem }` to `await import(...)` guarded by `config.commands !== false`. OR provide a separate `src/index-browser.ts` entry that doesn't import commands. |
| 2 | **CORS blockers** on `bot.yuanbao.tencent.com`, Tencent COS, `tmpfiles.org`, etc. — direct browser calls fail preflight | 🔴 Critical | Add `httpProxy` config option (URL prefix). Production deployments route through a CORS proxy or serverless function. Document required proxy headers. |
| 3 | **`ws` package** vs native `WebSocket` API differences (constructor options, `Buffer` vs `ArrayBuffer` events, `CloseEvent.reason` type) | 🟡 High | Write `YuanbaoWsClientBrowser` that wraps native `WebSocket` and presents the same callback interface as the `ws`-based client. |
| 4 | **File persistence in 8+ modules** (alias, contacts, groups, history, trust, block, reminders, llm-config, runtime-prefs, config.json) | 🟡 High | Define `PersistenceAdapter` interface (`read(path): string | null`, `write(path, data): void`, `exists(path): boolean`, `mkdir(path): void`). Provide 2 implementations: `NodeFsAdapter` and `BrowserIndexedDbAdapter`. Inject at `YuanbaoBot` construction. |
| 5 | **`node:crypto`** (`createHmac`, `randomBytes`, `timingSafeEqual`, `createHash`) — Web Crypto is async, breaking sync call sites | 🟡 High | Define `CryptoAdapter` interface with async `hmacSha256(secret, data): Promise<string>`, `hmacSha1(...)`, `randomBytes(n): Uint8Array`, `md5(data): Promise<string>`. Refactor `computeSignature` and COS signing to be async. |
| 6 | **`@ai-sdk/amazon-bedrock`** uses AWS SigV4 (likely Node crypto internally) | 🟡 Medium | Mark Bedrock as Node-only. In browser entry, only register 4 of 5 API formats. Throw a clear error if a user configures `aws-bedrock-converse` in browser. |
| 7 | **Module-level singletons** in `trust.ts`, `block.ts`, `reminders.ts` (hard-coded file paths + module-level `cache`) — not injectable | 🟡 Medium | Refactor to class-based or accept a module-level `configure({ persistencePath, adapter })` function called once at startup. |
| 8 | **`Buffer` usage** in 6 files (media.ts ×3, gofile.ts ×1, tempfile.ts ×3, request.ts ×2, forward-records-proto.ts ×1) | 🟡 Medium | Replace with `Uint8Array` + `TextEncoder`/`TextDecoder` + `atob`/`btoa`. Mechanical refactor; ~15 call sites. |
| 9 | **`setTimeout`-based persistence** (token refresh, reminder jobs, unsafe-mode expiry, merge windows) — killed on page reload | 🟡 Medium | On bot startup, persist pending timers' next-fire timestamps; on reload, recompute delta and reschedule. For reminders, this is already half-done (`activeTimers` Map persists jobs to disk, but not the next-fire timestamp — needs enhancement). |
| 10 | **CSP `unsafe-eval` requirement** for `interpolate.ts` (`new Function(...)`) | 🟢 Low | Most browser apps allow `unsafe-eval` in their CSP. For strict-CSP environments, fall back to a `${var}` simple substitution (lose JS expression evaluation). Document as a known limitation. |

### 8.1 Bonus risks (lower priority)

- **`os.type()`** in `request.ts` (X-OperationSystem header) — Tencent may reject `"Browser"` value. Test with `"Linux"` or `"Windows"` fallback.
- **`process.cwd()`** in `media.ts` (default download dir) — replace with config-injected path or omit.
- **`@ai-sdk/openai-compatible` fetch streaming** — verify it uses `ReadableStream` (browser-native) not Node `stream.Readable`.
- **`marked` v18** — uses `import.meta.url` internally for some features; verify browser bundle.

---

## 9. Recommended Decoupling Strategy

### 9.1 Three architectural approaches

#### Approach A — Adapter Pattern (dependency injection at construction)

```ts
// New: src/adapters/types.ts
export interface PersistenceAdapter {
  read(path: string): Promise<string | null>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  append(path: string, data: string): Promise<void>;
}

export interface CryptoAdapter {
  hmacSha256Hex(secret: string, data: string): Promise<string>;
  hmacSha1Hex(secret: string, data: string): Promise<string>;
  randomBytesHex(n: number): string;
  md5Hex(data: Uint8Array): Promise<string>;
}

export interface WebSocketAdapter {
  // Constructs a WebSocket-like object with the same on* callback API
  create(url: string): WebSocketLike;
}

// YuanbaoBotConfig gains:
//   adapters?: { persistence?: PersistenceAdapter; crypto?: CryptoAdapter; ws?: WebSocketAdapter; }
```

**Pros**: Minimal entry-point duplication; same `YuanbaoBot` class works in Node and browser; user chooses adapters.
**Cons**: Every call site that currently does `existsSync(path)` must become `await adapters.persistence.exists(path)` — large diff; makes persistence async-only (currently sync).

#### Approach B — Conditional Exports (package.json `"browser"` field)

```jsonc
// package.json
{
  "main": "./dist/index.js",
  "browser": "./dist-browser/index.js",
  "exports": {
    ".": {
      "node": "./dist/index.js",
      "browser": "./dist-browser/index.js",
      "default": "./dist/index.js"
    },
    "./browser": "./dist-browser/index.js",
    "./node": "./dist/index.js"
  }
}
```

**Pros**: Bundlers auto-select the right entry; users don't need to think about adapters.
**Cons**: Two entry files to maintain; can't share all source — must duplicate `YuanbaoBot` class or factor it into a shared internal module.

#### Approach C — Subpath Separation (`yuanbao-lite/browser` vs `yuanbao-lite/node`)

Same as B but explicit subpaths. Users do `import { YuanbaoBot } from "yuanbao-lite/browser"`.

**Pros**: Most explicit; clear documentation surface.
**Cons**: Breaking change for existing `import { YuanbaoBot } from "yuanbao-lite"` users.

### 9.2 Recommendation: **A + B combined**

1. **Internal refactor**: introduce `PersistenceAdapter`, `CryptoAdapter`, `WebSocketAdapter` interfaces (Approach A). Plumb them through `YuanbaoBot` constructor to all stores and access-layer modules. Default to Node implementations (`NodeFsAdapter`, `NodeCryptoAdapter`, `WsPackageAdapter`) so the Node public API is unchanged.

2. **Browser entry**: add `src/index-browser.ts` (Approach B) that:
   - Re-exports `YuanbaoBot` from a shared core module.
   - Provides `BrowserIndexedDbAdapter`, `WebCryptoAdapter`, `NativeWebSocketAdapter`.
   - Does **not** import `CommandSystem` (drops the 53-handler chain — fixes Risk #1).
   - Allows `commands: false` only in browser entry (or provides a `BrowserCommandSystem` stub with no builtins).

3. **package.json `"browser"` field** points to the browser bundle produced by Vite/Rollup from `src/index-browser.ts`.

**Why this combination**:
- Adapter pattern (A) keeps the public API stable and lets advanced users swap implementations.
- Conditional exports (B) make the browser path "just work" for bundlers.
- Avoids the breaking change of explicit subpaths (C).
- Cleanly solves Risk #1 by having the browser entry never import `CommandSystem`.

**Code-organization refactor**:

```
src/
├── core/                       # NEW: pure-logic core (browser-safe)
│   ├── bot.ts                  # YuanbaoBot class (moved from index.ts)
│   ├── adapters/
│   │   ├── types.ts            # PersistenceAdapter, CryptoAdapter, WebSocketAdapter
│   │   ├── node-fs.ts          # NodeFsAdapter (uses node:fs)
│   │   ├── node-crypto.ts      # NodeCryptoAdapter (uses node:crypto)
│   │   ├── node-ws.ts          # WsPackageAdapter (uses ws)
│   │   ├── browser-idb.ts      # BrowserIndexedDbAdapter
│   │   ├── browser-crypto.ts   # WebCryptoAdapter
│   │   └── browser-ws.ts       # NativeWebSocketAdapter
│   └── ...
├── index.ts                    # Node entry — imports core + Node adapters + CommandSystem
├── index-browser.ts            # Browser entry — imports core + Browser adapters, no CommandSystem
├── access/                     # (existing — refactored to use adapters)
├── business/                   # (existing — refactored to use adapters)
├── shared/                     # (existing — refactored to use adapters)
├── commands/                   # (existing — Node-only)
└── cli/                        # (existing — Node-only)
```

---

## 10. Phase Plan (4 phases, each shippable)

### Phase 1 — Break the static CommandSystem chain (achievable in this session)

**Goal**: Make `src/index.ts` importable by a browser bundler without dragging in `node:child_process` etc.

**Steps**:
1. In `src/index.ts`:
   - Convert `import { CommandSystem } from "./commands/registry.js";` to a top-level `let CommandSystem: typeof import("./commands/registry.js").CommandSystem | null = null;`
   - Wrap usage in `constructor` and `registerCommand` / `unregisterCommand` / `getCommandSystem` in `if (config.commands !== false) { CommandSystem = (await import("./commands/registry.js")).CommandSystem; ... }` (use a private async `ensureCommandSystem()` helper).
2. Update `tsconfig.json` if needed (no change expected).
3. Verify Node build still passes (`pnpm build`).
4. Verify `node dist/cli/index.js daemon start` still works end-to-end (sanity check).

**Shippable milestone**: A browser bundler can now produce a bundle from `src/index.ts` (with `commands: false` config) without encountering `node:child_process`. Bundle still won't *run* in browser (other Node deps present), but the import graph is clean.

**Risk**: Async constructor pattern is awkward. Alternative: lazy initialization on first `dispatch()` call (the bot already only dispatches commands after WS connection, so startup latency is hidden).

### Phase 2 — Introduce adapter interfaces (PersistenceAdapter + CryptoAdapter + WebSocketAdapter)

**Goal**: All Node-only I/O is behind interfaces; default Node adapters preserve existing behavior.

**Steps**:
1. Create `src/core/adapters/types.ts` with the three interfaces.
2. Create `src/core/adapters/node-fs.ts`, `node-crypto.ts`, `node-ws.ts` — thin wrappers around existing `node:fs`/`node:crypto`/`ws` calls.
3. Refactor `src/business/alias.ts`, `contacts.ts`, `groups.ts`, `history.ts`, `trust.ts`, `block.ts`, `reminders.ts`, `llm-takeover.ts`, `sticker.ts`, `shared/config.ts` to accept an optional `PersistenceAdapter` (fall back to a global default set by `YuanbaoBot` constructor).
4. Refactor `src/business/trust.ts`, `block.ts`, `reminders.ts` from module-level singletons to class-based or `configure()`-based.
5. Refactor `src/access/http/request.ts` to accept a `CryptoAdapter` (make `computeSignature` async). Update `getSignToken` to await it.
6. Refactor `src/access/http/media.ts`, `gofile.ts`, `tempfile.ts` to accept both `PersistenceAdapter` (for file reads/writes) and `CryptoAdapter` (for HMAC/MD5).
7. Refactor `src/access/ws/client.ts` to accept a `WebSocketAdapter`.
8. Wire adapters through `YuanbaoBot` constructor: `config.adapters?: { persistence?, crypto?, ws? }`. Defaults: Node adapters.
9. Replace `Buffer.from(b64)` in `forward-records-proto.ts` with `Uint8Array.from(atob(...), c => c.charCodeAt(0))` (works in both Node 18+ and browsers).
10. Replace `Buffer` usage in media.ts/gofile.ts/tempfile.ts/request.ts with `Uint8Array` (or `cryptoAdapter` helper methods).
11. Replace `os.type()` in request.ts with `config.operationSystem ?? (typeof process !== "undefined" ? os.type() : "Browser")`.
12. Replace `process.cwd()` in media.ts with `config.defaultDownloadDir ?? (typeof process !== "undefined" ? process.cwd() : "/downloads")`.

**Shippable milestone**: All Node-only I/O is behind interfaces. The same code runs in Node with the existing behavior. A test harness can inject mock adapters. **No browser bundle yet** — but the code is *ready* for one.

**Tests**: add a `mock-persistence.ts` and `mock-crypto.ts` adapter for unit tests. Run the existing test suite (if any) against the refactored code.

### Phase 3 — Browser entry point + adapters

**Goal**: Produce a working browser bundle that can connect, send/receive messages, and persist state to IndexedDB.

**Steps**:
1. Create `src/core/adapters/browser-idb.ts` — `PersistenceAdapter` backed by IndexedDB (one object store per "file path", key = path, value = string).
2. Create `src/core/adapters/browser-crypto.ts` — `CryptoAdapter` backed by `crypto.subtle` + `crypto.getRandomValues`. Implement MD5 with `js-md5` (small lib) or omit (return random UUID instead — MD5 is only used as a non-security-critical file UUID).
3. Create `src/core/adapters/browser-ws.ts` — `WebSocketAdapter` wrapping native `WebSocket` with the same on* callback API as the `ws`-based client.
4. Create `src/index-browser.ts`:
   - Re-export `YuanbaoBot` (from `src/core/bot.ts` extracted in Phase 2).
   - Pre-wire browser adapters as defaults.
   - Do **not** import `CommandSystem`. If user passes `commands !== false`, throw a clear error: "CommandSystem is not available in the browser bundle; use the Node bundle or set commands: false."
   - Provide `httpProxy` config option (URL prefix) that wraps `fetch` calls in `request.ts`, `media.ts`, `gofile.ts`, `tempfile.ts`.
5. Add `package.json` `"browser"` field pointing to `dist-browser/index.js`.
6. Add Vite library-mode config (`vite.config.ts`) to produce `dist-browser/`:
   ```ts
   build: {
     lib: { entry: "src/index-browser.ts", formats: ["es", "cjs"], name: "YuanbaoLite" },
     rollupOptions: { external: ["ai", "@ai-sdk/*", "marked", "protobufjs"] }
   }
   ```
7. Document required CSP headers: `connect-src wss://bot-wss.yuanbao.tencent.com https://<proxy-domain>`; `script-src 'self' 'unsafe-eval'` (for interpolation) — or document the simple-substitution fallback.
8. Document required CORS proxy setup (small serverless function spec).
9. Test in a browser: open a test HTML page, `import { YuanbaoBot } from "yuanbao-lite"`, instantiate with browser-default adapters, send a DM.

**Shippable milestone**: `yuanbao-lite` works in a browser tab (via `<script type="module">` or bundler). Bot can connect, send/receive text messages, persist state across reloads (IndexedDB). CLI commands not available. LLM auto-reply available (excluding Bedrock). Media upload/download available through proxy.

### Phase 4 — Polish, parity, and documentation

**Goal**: Production-ready browser bundle, documented, tested.

**Steps**:
1. Implement a reference CORS-proxy serverless function (Cloudflare Workers + Vercel Edge variants) and publish the spec in `BROWSER_PROXY.md`.
2. Add browser E2E test (Playwright) that:
   - Loads the bundle.
   - Mocks the WS gateway.
   - Verifies connect/auth/send/receive.
3. Sticker pack loading for browser: replace `loadStickerPacksFromDir` with `loadStickerPacksFromUrls` (fetch JSON manifest from a URL).
4. Reminders/cron restart-on-reload: persist `nextFireAt` to IndexedDB; on bot startup, reschedule pending jobs.
5. Bundle-size optimization: tree-shake unused AI SDK providers (Vite supports `optimizeDeps.exclude`). Document bundle size budget (~150KB gzipped without AI SDK, ~300KB with).
6. Type definitions: ship `dist-browser/index.d.ts` alongside `dist-browser/index.js`.
7. Update `README.md` with a "Browser usage" section.
8. Cut a `yuanbao-lite@12.0.0` major release (breaking: `PersistenceAdapter` injection is opt-in but the module-level `trust.ts`/`block.ts`/`reminders.ts` refactor is breaking for direct importers).

**Shippable milestone**: v12.0.0 released with full browser support, documented, tested.

---

## Appendix A — Node-only import summary (in-scope files only)

```
src/index.ts
  ├─ node:fs  (existsSync, readFileSync)            [L35]
  ├─ node:path (join)                               [L36]
  ├─ node:os  (homedir)                             [L37]
  └─ ./commands/registry.js  ← CHAIN TO 53 HANDLERS [L45]

src/access/ws/client.ts
  ├─ node:crypto (randomUUID)                       [L7]
  └─ ws                                            [L8]

src/access/http/request.ts
  ├─ node:crypto (createHmac, randomBytes, timingSafeEqual) [L8]
  └─ node:os (os.type)                              [L9]

src/access/http/media.ts
  ├─ node:fs (existsSync, mkdirSync, statSync)      [L16]
  ├─ node:fs/promises (readFile, writeFile)         [L17]
  ├─ node:path (basename, extname, join)            [L18]
  ├─ node:crypto (randomBytes, createHash, createHmac) [L19]
  └─ process.cwd()                                  [L659]
  └─ Buffer.from(...)                               [L558, L677]

src/access/http/gofile.ts
  ├─ node:fs (existsSync, statSync)                 [L12]
  ├─ node:fs/promises (readFile)                    [L13]
  ├─ node:path (basename)                           [L14]
  └─ Buffer.from(formData)                          [L78]

src/access/http/tempfile.ts
  ├─ node:fs (existsSync, statSync)                 [L13]
  ├─ node:fs/promises (readFile)                    [L14]
  ├─ node:path (basename)                           [L15]
  ├─ node:crypto (randomBytes)                      [L16]
  └─ Buffer.from(formData) ×3                       [L155, L227, L310]

src/business/llm-takeover.ts
  ├─ node:fs (existsSync, readFileSync, writeFileSync, mkdirSync) [L29]
  ├─ node:path (dirname)                            [L30]
  ├─ ai, @ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google,
  │   @ai-sdk/amazon-bedrock, @ai-sdk/openai-compatible  [L22-27]
  └─ marked                                         [L28]

src/business/alias.ts      — node:fs, node:path                  [L16-17]
src/business/contacts.ts   — node:fs, node:path                  [L17-18]
src/business/groups.ts     — node:fs, node:path                  [L19-20]
src/business/history.ts    — node:fs (+ appendFileSync), node:path [L14-15]
src/business/trust.ts      — node:fs, node:path, node:os          [L28-30]
src/business/block.ts      — node:fs, node:path, node:os          [L34-36]
src/business/reminders.ts  — node:fs, node:path, node:os          [L11-13]
src/business/sticker.ts    — node:fs, node:path, node:os          [L20-22]

src/business/messaging/forward-records-proto.ts
  ├─ protobufjs                                     [L10] (browser-compatible)
  └─ Buffer.from(value, "base64")                   [L93]

src/shared/config.ts
  ├─ node:fs (existsSync, readFileSync, writeFileSync, mkdirSync) [L16]
  ├─ node:path (join, resolve)                      [L17]
  └─ node:os (homedir)                              [L18]

src/version.ts
  ├─ node:fs (readFileSync)                         [L14]
  ├─ node:path (join, dirname)                      [L15]
  └─ node:url (fileURLToPath) + import.meta.url     [L16, L33]
```

## Appendix B — Already browser-safe modules (zero changes needed)

```
src/access/ws/conn-codec.ts       (protobufjs + JSON descriptor only)
src/access/ws/biz-codec.ts        (protobufjs + JSON descriptor only)
src/access/ws/types.ts            (pure types)
src/business/interpolate.ts       (typeof process-guarded)
src/business/multi-account.ts     (pure logic)
src/business/batch.ts             (pure logic + setTimeout)
src/business/search.ts            (pure logic)
src/business/mention.ts           (pure logic)
src/business/messaging/extract.ts (pure logic)
src/business/messaging/forward-records.ts (pure logic)
src/business/content-store.ts     (in-memory LRU)
src/logger.ts                     (console-based)
src/accounts.ts                   (pure function)
src/types.ts                      (pure types)
src/commands/session-utils.ts     (pure logic)
src/commands/types.ts             (pure types)
```

---

**End of analysis.**
