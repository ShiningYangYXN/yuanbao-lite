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
}

// ─── Indirect Node require (browser-safe) ───

/**
 * Lazily-resolved indirect `require` — only available under Node. Returns
 * `null` in browser/edge runtimes.
 *
 * Implementation note: in Node ESM, `require` is not defined globally, so
 * we use `createRequire` from `node:module`. We load it via top-level
 * `await import("node:module")` so that:
 *
 *   - Under Node: the dynamic import resolves and `indirectRequire` is set.
 *   - Under browser: the `typeof process` check fails and the import never
 *     happens, so `node:module` is NOT pulled into the browser bundle.
 *   - Bundlers (Vite/Rollup/esbuild): create a separate chunk for
 *     `node:module` that's only loaded when the runtime check passes.
 *
 * Top-level await is supported in ESM (Node 14+, all modern bundlers).
 *
 * Exported so that modules with Node-only functionality (e.g.
 * `loadStickerPacksFromDir` in sticker.ts) can lazily load `node:fs` /
 * `node:path` without adding static imports that would break browser bundles.
 */
export let indirectRequire: NodeRequire | null = null;

if (typeof process !== "undefined" && process.versions?.node) {
  try {
    const { createRequire } = await import("node:module");
    indirectRequire = createRequire(import.meta.url);
  } catch {
    // Dynamic import failed at runtime — fall through to null.
    // Stores that need persistence will throw a clear error when used.
  }
}

/**
 * Node `os.homedir()` — lazily resolved via the same indirect-require
 * pattern. Returns `null` in browser/edge runtimes. Used by modules
 * (block.ts, trust.ts, reminders.ts, etc.) that compute a default
 * persistence path under `~/.yuanbao-lite/`.
 */
export const nodeHomedir: string | null = (() => {
  if (!indirectRequire) return null;
  try {
    const os = indirectRequire("node:os");
    return os.homedir();
  } catch {
    return null;
  }
})();

/**
 * Node `path.join` — lazily resolved. Returns `null` in browser/edge.
 * Used by modules that compute default persistence paths.
 */
export const nodePathJoin: ((...paths: string[]) => string) | null = (() => {
  if (!indirectRequire) return null;
  try {
    const path = indirectRequire("node:path");
    return path.join;
  } catch {
    return null;
  }
})();

/**
 * Compute the default persistence directory: `~/.yuanbao-lite/` under Node.
 *
 * Throws in browser/edge — callers MUST provide an explicit `persistencePath`
 * (which can be any opaque string the adapter understands, e.g. a
 * localStorage key prefix).
 */
export function getDefaultPersistenceDir(): string {
  if (!nodeHomedir || !nodePathJoin) {
    throw new Error(
      "getDefaultPersistenceDir() requires Node.js runtime. " +
        "Browser callers must provide an explicit persistencePath.",
    );
  }
  return nodePathJoin(nodeHomedir, ".yuanbao-lite");
}

/**
 * Join path segments — uses `node:path.join` under Node, falls back to
 * `/`-separated join in browser/edge (sufficient for opaque adapter keys).
 *
 * Use this instead of `import { join } from "node:path"` in any module
 * that needs to be browser-compatible.
 */
export function joinPath(...parts: string[]): string {
  if (nodePathJoin) return nodePathJoin(...parts);
  // Browser fallback: simple /-join. Trims trailing/leading slashes on
  // adjacent parts to avoid double-slashes. Empty parts are skipped.
  return parts
    .filter(p => p !== undefined && p !== null && p !== "")
    .map((p, i) => {
      let s = String(p);
      if (i > 0) s = s.replace(/^\/+/, "");
      if (i < parts.length - 1) s = s.replace(/\/+$/, "");
      return s;
    })
    .join("/");
}

// ─── NodeFsAdapter (default for Node) ───

/**
 * Filesystem-backed PersistenceAdapter using `node:fs` and `node:path`.
 *
 * Construction throws if running outside Node — browser callers must
 * explicitly use a browser-compatible adapter instead.
 *
 * The `node:fs` and `node:path` modules are loaded via the indirect
 * `require` resolved at module load time (see {@link indirectRequire}),
 * so this class — and any module that imports `adapter.ts` — is
 * browser-safe at the bundler level (no static `node:*` imports).
 */
export class NodeFsAdapter implements PersistenceAdapter {
  private readonly fs: typeof import("node:fs");
  private readonly path: typeof import("node:path");

  constructor() {
    if (!indirectRequire) {
      throw new Error(
        "NodeFsAdapter requires Node.js runtime. " +
          "Browser callers must use a browser-compatible PersistenceAdapter " +
          "(e.g. BrowserLocalStorageAdapter in Phase 3).",
      );
    }
    this.fs = indirectRequire("node:fs");
    this.path = indirectRequire("node:path");
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
}

// ─── Default adapter resolution ───

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
    // Cache the failure so we don't retry the indirect-require path
    // on every call (which would be wasteful in hot loops).
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
        : new Error(`Failed to initialize default PersistenceAdapter: ${String(err)}`);
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
