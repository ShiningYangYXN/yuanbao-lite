/**
 * Persistence adapter — abstracts file I/O so core logic can run in
 * environments without a native filesystem (browsers, edge workers, etc.).
 *
 * The interface is **synchronous** to match the existing AliasStore /
 * ContactStore / GroupStore / etc. APIs. Implementations:
 *
 *   - {@link NodeFsAdapter}            — uses node:fs (default in Node)
 *   - BrowserLocalStorageAdapter       — uses window.localStorage (Phase 3)
 *   - BrowserIndexedDbAdapter          — async, not supported by this interface
 *
 * Async-only backends (IndexedDB, OPFS) cannot implement this interface.
 * They would need a separate AsyncPersistenceAdapter variant, which is
 * deferred until a real-world caller requires it.
 *
 * Node-only modules (node:fs, node:path, node:os) are loaded via ESM
 * `await import("node:*")` guarded by `typeof process` checks. Bundlers
 * (Vite/Rollup/esbuild) split these dynamic imports into separate chunks
 * that are only fetched under Node, so the browser bundle never includes
 * any node:* code.
 *
 * @module access/persistence/adapter
 */

/**
 * Synchronous key/value-style persistence interface.
 *
 * The `path` parameter is treated as an opaque string by adapter
 * implementations — for filesystem adapters it's a real path, for
 * localStorage adapters it's a storage key, for IndexedDB it would be
 * a record key (but IndexedDB is async, so not supported here).
 */
export interface PersistenceAdapter {
  /**
   * Check if a path/key exists.
   *
   * MUST NOT throw if the path/key doesn't exist — that's the whole
   * point of this method. MAY throw for genuine I/O errors (permissions,
   * disk full, quota exceeded, etc.).
   */
  exists(path: string): boolean;

  /**
   * Read a path/key as a UTF-8 string.
   *
   * Throws if the path/key doesn't exist (callers should check
   * {@link PersistenceAdapter.exists} first) or if the read fails for
   * any other reason.
   */
  read(path: string): string;

  /**
   * Write a string to a path/key.
   *
   * Implementations should ensure parent directories / namespaces exist
   * before writing (see {@link PersistenceAdapter.ensureParentDir}).
   */
  write(path: string, data: string): void;

  /**
   * Ensure the parent directory (or namespace prefix) of a path exists.
   *
   * For filesystem adapters: `mkdir -p $(dirname path)`.
   * For localStorage adapters: no-op (keys are flat).
   *
   * Calling this separately is useful when a caller wants to pre-create
   * a directory before multiple writes.
   */
  ensureParentDir(path: string): void;

  /**
   * Optional: append data to an existing path. If the path doesn't exist,
   * it's created. Adapters that support atomic append (e.g. NodeFsAdapter
   * with `appendFileSync`) should implement this for efficiency.
   *
   * Adapters that DON'T implement it (e.g. localStorage-based adapters)
   * will cause callers to fall back to read-modify-write. This is correct
   * but inefficient for large append-heavy workloads (e.g. JSONL history).
   *
   * Callers should always check `if (adapter.append)` before calling.
   */
  append?(path: string, data: string): void;

  /**
   * Optional: remove a path/key. Returns true if the path existed and was
   * removed, false if it didn't exist.
   *
   * Adapters that DON'T implement it (rare) will cause callers to fall
   * back to a no-op or throw, depending on context.
   */
  remove?(path: string): boolean;

  /**
   * Optional: list all paths/keys under a given prefix (directory).
   *
   * For filesystem adapters: `readdirSync(dir, { withFileTypes: true })`.
   * For localStorage adapters: scan keys with the given prefix.
   *
   * Returns an array of entries, each with `name` (the path/key relative
   * to the prefix) and `isDirectory` (whether the entry is itself a
   * container for other entries).
   *
   * Callers should check `if (adapter.listDir)` before calling.
   */
  listDir?(path: string): Array<{ name: string; isDirectory: boolean }>;

  /**
   * Optional: rename/move a path to a new path.
   *
   * For filesystem adapters: `renameSync(from, to)`.
   * Used by log/history file rotation.
   *
   * Callers should check `if (adapter.rename)` before calling.
   */
  rename?(from: string, to: string): void;

  /**
   * Optional: get file size in bytes.
   *
   * For filesystem adapters: `statSync(path).size`.
   * Used by log/history file rotation to check if rotation is needed.
   *
   * Callers should check `if (adapter.stat)` before calling.
   */
  stat?(path: string): { size: number } | null;
}

// ─── Node module loader (ESM dynamic import, browser-safe) ───

/**
 * Cached Node module namespaces — populated by `ensureNodeModules()`
 * on first access under Node. All fields are `null` in browser/edge.
 *
 * We use top-level `await import("node:*")` guarded by a `typeof process`
 * check. Bundlers (Vite/Rollup/esbuild) recognize this pattern and split
 * the dynamic imports into separate chunks that are only fetched when
 * the runtime check passes — so the browser bundle contains zero
 * `node:*` code.
 */
interface NodeModules {
  fs: typeof import("node:fs") | null;
  path: typeof import("node:path") | null;
  os: typeof import("node:os") | null;
}

let nodeModules: NodeModules = {
  fs: null,
  path: null,
  os: null,
};

let nodeModulesLoaded = false;

/**
 * Lazy-load Node built-in modules via ESM dynamic import.
 *
 * Under Node: imports `node:fs`, `node:path`, `node:os` and caches them
 * in {@link nodeModules}. Returns true.
 *
 * Under browser/edge: the `typeof process` guard fails and no import
 * is attempted. Returns false.
 *
 * Idempotent — subsequent calls return the cached result.
 */
async function ensureNodeModules(): Promise<boolean> {
  if (nodeModulesLoaded) {
    return nodeModules.fs !== null;
  }
  nodeModulesLoaded = true;
  if (typeof process === "undefined" || !process.versions?.node) {
    return false;
  }
  try {
    // Three parallel dynamic imports — bundlers split each into its own
    // chunk, fetched only when this code path runs (i.e. under Node).
    const [fs, path, os] = await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:os"),
    ]);
    nodeModules = { fs, path, os };
    return true;
  } catch {
    // Import failed at runtime — leave nodeModules as {null, null, null}.
    return false;
  }
}

// Kick off the lazy load at module init time. Top-level await is supported
// in ESM (Node 14+, all modern bundlers). The promise is stored so callers
// that need to be sure the modules are loaded can `await nodeModulesReady`.
const nodeModulesReady: Promise<boolean> = ensureNodeModules();

/**
 * Synchronously access the cached Node modules.
 *
 * Returns `{fs: null, path: null, os: null}` if:
 *   - Running in a browser/edge runtime (no Node built-ins available)
 *   - The dynamic import failed for some reason
 *
 * Callers that need to ensure the modules are loaded BEFORE accessing
 * them should `await nodeModulesReady` first.
 */
export function getNodeModules(): NodeModules {
  return nodeModules;
}

/**
 * Promise that resolves when the Node module preload is complete.
 *
 * Under Node: resolves to `true` once `node:fs` / `node:path` / `node:os`
 * are loaded and cached. Resolves to `false` under browser/edge.
 *
 * Stores call `getDefaultPersistenceAdapter()` synchronously, which uses
 * the cached `nodeModules`. If the constructor runs before this promise
 * resolves, the NodeFsAdapter construction will throw — the user can
 * retry, or pass an explicit adapter.
 */
export { nodeModulesReady };

// ─── NodeFsAdapter (default for Node) ───

/**
 * Filesystem-backed PersistenceAdapter using `node:fs` and `node:path`.
 *
 * Construction throws if running outside Node or if the Node modules
 * haven't been loaded yet (caller should `await nodeModulesReady` first
 * if constructing at app startup before top-level await completes).
 *
 * The `node:fs` and `node:path` modules are loaded via ESM dynamic
 * import (see {@link ensureNodeModules}), so this class — and any module
 * that imports `adapter.ts` — is browser-safe at the bundler level
 * (no static `node:*` imports).
 */
export class NodeFsAdapter implements PersistenceAdapter {
  private readonly fs: typeof import("node:fs");
  private readonly path: typeof import("node:path");

  constructor() {
    const { fs, path } = nodeModules;
    if (!fs || !path) {
      throw new Error(
        "NodeFsAdapter requires Node.js runtime with node:fs and node:path loaded. " +
          "If constructing at app startup, `await nodeModulesReady` first. " +
          "Browser callers must use a browser-compatible PersistenceAdapter " +
          "(e.g. BrowserLocalStorageAdapter).",
      );
    }
    this.fs = fs;
    this.path = path;
  }

  exists(path: string): boolean {
    return this.fs.existsSync(path);
  }

  read(path: string): string {
    return this.fs.readFileSync(path, "utf-8");
  }

  write(path: string, data: string): void {
    this.ensureParentDir(path);
    this.fs.writeFileSync(path, data, "utf-8");
  }

  ensureParentDir(path: string): void {
    const dir = this.path.dirname(path);
    if (!this.fs.existsSync(dir)) {
      this.fs.mkdirSync(dir, { recursive: true });
    }
  }

  append(path: string, data: string): void {
    this.ensureParentDir(path);
    this.fs.appendFileSync(path, data, "utf-8");
  }

  remove(path: string): boolean {
    if (!this.fs.existsSync(path)) return false;
    this.fs.unlinkSync(path);
    return true;
  }

  listDir(dirPath: string): Array<{ name: string; isDirectory: boolean }> {
    if (!this.fs.existsSync(dirPath)) return [];
    const entries = this.fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  }

  rename(from: string, to: string): void {
    this.fs.renameSync(from, to);
  }

  stat(path: string): { size: number } | null {
    try {
      const s = this.fs.statSync(path);
      return { size: s.size };
    } catch {
      return null;
    }
  }
}

// ─── Default adapter / path resolution ───

let defaultAdapter: PersistenceAdapter | null = null;
let defaultAdapterInitFailed = false;
let defaultAdapterInitError: Error | null = null;

/**
 * Lazily resolve a default PersistenceAdapter for the current runtime.
 *
 * - Under Node.js: returns a singleton {@link NodeFsAdapter}.
 * - Under browser/edge: throws. Browser callers MUST explicitly pass
 *   their own adapter (e.g. `BrowserLocalStorageAdapter`) via the store
 *   config — there is no implicit default.
 *
 * This is called automatically by stores that don't receive an explicit
 * adapter. Throwing in browser forces the caller to make a conscious
 * choice of backend, which is the right behavior (silent fallback to
 * an in-memory store would lose data without warning).
 */
export function getDefaultPersistenceAdapter(): PersistenceAdapter {
  if (defaultAdapter) return defaultAdapter;
  if (defaultAdapterInitFailed) {
    // Cache the failure so we don't retry on every call.
    throw defaultAdapterInitError;
  }
  try {
    defaultAdapter = new NodeFsAdapter();
    return defaultAdapter;
  } catch (err) {
    defaultAdapterInitFailed = true;
    defaultAdapterInitError =
      err instanceof Error
        ? err
        : new Error(
            `Failed to initialize default PersistenceAdapter: ${String(err)}`,
          );
    throw defaultAdapterInitError;
  }
}

/**
 * Override the default adapter (useful for tests and for browser runtimes
 * that want a global default instead of per-store injection).
 *
 * Pass `null` to clear the override and revert to runtime auto-detection.
 */
export function setDefaultPersistenceAdapter(
  adapter: PersistenceAdapter | null,
): void {
  defaultAdapter = adapter;
  defaultAdapterInitFailed = false;
  defaultAdapterInitError = null;
}

// ─── Path helpers ───

/**
 * Compute the default persistence directory: `~/.yuanbao-lite/` under Node.
 *
 * Throws in browser/edge — callers MUST provide an explicit `persistencePath`
 * (which can be any opaque string the adapter understands, e.g. a
 * localStorage key prefix).
 */
export function getDefaultPersistenceDir(): string {
  const { os, path } = nodeModules;
  if (!os || !path) {
    throw new Error(
      "getDefaultPersistenceDir() requires Node.js runtime with node:os and node:path loaded. " +
        "If calling at app startup, `await nodeModulesReady` first. " +
        "Browser callers must provide an explicit persistencePath.",
    );
  }
  return path.join(os.homedir(), ".yuanbao-lite");
}

/**
 * Join path segments — uses `node:path.join` under Node, falls back to
 * `/`-separated join in browser/edge (sufficient for opaque adapter keys).
 *
 * Use this instead of `import { join } from "node:path"` in any module
 * that needs to be browser-compatible.
 */
export function joinPath(...parts: string[]): string {
  const { path } = nodeModules;
  if (path) return path.join(...parts);
  // Browser fallback: simple /-join. Trims trailing/leading slashes on
  // adjacent parts to avoid double-slashes. Empty parts are skipped.
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p, i) => {
      let s = String(p);
      if (i > 0) s = s.replace(/^\/+/, "");
      if (i < parts.length - 1) s = s.replace(/\/+$/, "");
      return s;
    })
    .join("/");
}

// ─── BrowserLocalStorageAdapter (browser default) ───

/**
 * Browser PersistenceAdapter backed by `window.localStorage`.
 *
 * Suitable for small-to-medium data volumes (config, aliases, contacts,
 * small history). localStorage has a ~5MB per-origin limit and synchronous
 * API (which blocks the main thread on large writes).
 *
 * For large data volumes (e.g. full message history), consider implementing
 * a `BrowserIndexedDbAdapter` — but note that IndexedDB is async-only and
 * cannot implement the synchronous `PersistenceAdapter` interface directly.
 *
 * The `path` parameter is treated as a localStorage key suffix. The
 * optional `prefix` (default `"yuanbao-lite:"`) is prepended to avoid
 * collisions with other localStorage users on the same origin.
 *
 * @example
 * ```typescript
 * import { YuanbaoBot, BrowserLocalStorageAdapter } from "yuanbao-lite";
 *
 * const bot = new YuanbaoBot({
 *   appKey, appSecret,
 *   persistence: {
 *     dir: "my-app",
 *     adapter: new BrowserLocalStorageAdapter({ prefix: "my-app:" }),
 *   },
 * });
 * ```
 */
export class BrowserLocalStorageAdapter implements PersistenceAdapter {
  private readonly prefix: string;
  private readonly storage: Storage;

  constructor(opts?: { prefix?: string; storage?: Storage }) {
    this.prefix = opts?.prefix ?? "yuanbao-lite:";
    // Allow injecting a custom storage (for testing or for SSR environments
    // with a polyfill). Default to globalThis.localStorage.
    const storage =
      opts?.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) {
      throw new Error(
        "BrowserLocalStorageAdapter requires globalThis.localStorage. " +
          "In non-browser environments, pass a `storage` option (e.g. a polyfill).",
      );
    }
    this.storage = storage;
  }

  private key(path: string): string {
    return this.prefix + path;
  }

  exists(path: string): boolean {
    return this.storage.getItem(this.key(path)) !== null;
  }

  read(path: string): string {
    const data = this.storage.getItem(this.key(path));
    if (data === null) {
      throw new Error(`BrowserLocalStorageAdapter: path not found: ${path}`);
    }
    return data;
  }

  write(path: string, data: string): void {
    try {
      this.storage.setItem(this.key(path), data);
    } catch (err) {
      // Most likely QuotaExceededError — rethrow with a clearer message.
      throw new Error(
        `BrowserLocalStorageAdapter: failed to write ${path} (likely quota exceeded): ${(err as Error).message}`,
      );
    }
  }

  ensureParentDir(_path: string): void {
    // localStorage is flat — no directory concept. No-op.
  }

  append(path: string, data: string): void {
    // localStorage doesn't support atomic append. Read-modify-write.
    const key = this.key(path);
    const existing = this.storage.getItem(key) ?? "";
    try {
      this.storage.setItem(key, existing + data);
    } catch (err) {
      throw new Error(
        `BrowserLocalStorageAdapter: failed to append to ${path}: ${(err as Error).message}`,
      );
    }
  }

  remove(path: string): boolean {
    const key = this.key(path);
    if (this.storage.getItem(key) === null) return false;
    this.storage.removeItem(key);
    return true;
  }

  listDir(prefix: string): Array<{ name: string; isDirectory: boolean }> {
    // List all keys that start with the prefix.
    const fullPrefix = this.key(prefix);
    const results: Array<{ name: string; isDirectory: boolean }> = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key && key.startsWith(fullPrefix)) {
        // Relative name (strip prefix)
        const relativeName = key.slice(fullPrefix.length);
        // localStorage is flat — no directories. Everything is a "file".
        if (relativeName) {
          results.push({ name: relativeName, isDirectory: false });
        }
      }
    }
    return results;
  }
}

// ─── MemoryAdapter (for tests and ephemeral sessions) ───

/**
 * In-memory PersistenceAdapter — stores data in a Map.
 *
 * Primarily intended for:
 *   - Unit tests (no filesystem side effects)
 *   - Ephemeral sessions (data lost on process exit)
 *   - Browser demos where persistence isn't needed
 *
 * @example
 * ```typescript
 * import { MemoryAdapter } from "yuanbao-lite";
 *
 * const bot = new YuanbaoBot({
 *   appKey, appSecret,
 *   persistence: { dir: "", adapter: new MemoryAdapter() },
 * });
 * ```
 */
export class MemoryAdapter implements PersistenceAdapter {
  private readonly files = new Map<string, string>();

  exists(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new Error(`MemoryAdapter: path not found: ${path}`);
    }
    return data;
  }

  write(path: string, data: string): void {
    this.files.set(path, data);
  }

  ensureParentDir(_path: string): void {
    // No-op — in-memory has no directory concept.
  }

  append(path: string, data: string): void {
    const existing = this.files.get(path) ?? "";
    this.files.set(path, existing + data);
  }

  remove(path: string): boolean {
    return this.files.delete(path);
  }

  listDir(prefix: string): Array<{ name: string; isDirectory: boolean }> {
    const results: Array<{ name: string; isDirectory: boolean }> = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        const relativeName = key.slice(prefix.length);
        if (relativeName) {
          results.push({ name: relativeName, isDirectory: false });
        }
      }
    }
    return results;
  }

  /** Clear all stored data (test helper). */
  clear(): void {
    this.files.clear();
  }

  /** Get the number of stored paths (test helper). */
  get size(): number {
    return this.files.size;
  }
}
