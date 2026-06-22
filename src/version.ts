/**
 * Version utility — reads version from package.json when running under Node,
 * with a hardcoded fallback for browser/edge runtimes.
 *
 * Resolution strategy (in priority order):
 *   1. Cached value (if previously resolved)
 *   2. Runtime read of package.json via indirect `require()` (Node only —
 *      the indirect call keeps `node:fs` / `node:path` / `node:url` out of
 *      the bundler's static import graph so this module is browser-safe)
 *   3. Hardcoded fallback constant below
 *
 * Why indirect require? Static `import { readFileSync } from "node:fs"`
 * would force browser bundlers (Vite, Rollup, esbuild, Webpack 5) to either
 * fail the build or include a broken shim. By wrapping `require` in
 * `new Function(...)`, the reference is opaque to bundlers and the Node
 * built-in is only loaded at runtime when actually running under Node.
 */

// Hardcoded fallback — keep in sync with package.json `version` on release.
// This is the value browser/edge callers will see.
const FALLBACK_VERSION = "11.5.2";

// Cache the version after first read
let cachedVersion: string | null = null;

/**
 * Lazily-resolved indirect `require` — only available when running under
 * Node. Returns `null` in browser/edge runtimes.
 *
 * Implementation note: in Node ESM, `require` is not defined globally,
 * so we use `createRequire` from `node:module`. We load it via top-level
 * `await import("node:module")` so that:
 *
 *   - Under Node: the dynamic import resolves and `indirectRequire` is set.
 *   - Under browser: the `typeof process` check fails and the import never
 *     happens, so `node:module` is NOT pulled into the browser bundle.
 *   - Bundlers (Vite/Rollup/esbuild): create a separate chunk for
 *     `node:module` that's only loaded when the runtime check passes.
 *
 * Top-level await is supported in ESM (Node 14+, all modern bundlers).
 */
let indirectRequire: NodeRequire | null = null;

if (typeof process !== "undefined" && process.versions?.node) {
  try {
    const { createRequire } = await import("node:module");
    indirectRequire = createRequire(import.meta.url);
  } catch {
    // Dynamic import failed at runtime — fall through to fallback version.
  }
}

/**
 * Get the current version from package.json.
 *
 * Reads package.json relative to this module's location under Node,
 * walking up the directory tree if needed. Falls back to a hardcoded
 * version if reading fails or when running in a non-Node runtime
 * (browser, edge workers, etc.).
 */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  // Try the runtime package.json read under Node only.
  if (indirectRequire) {
    try {
      const fs = indirectRequire("node:fs");
      const path = indirectRequire("node:path");
      const url = indirectRequire("node:url");
      const __filename = url.fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);

      // Try several possible locations for package.json
      const candidates = [
        path.join(__dirname, "..", "package.json"),   // dist/version.js -> package.json (project root)
        path.join(__dirname, "package.json"),           // same dir
        path.join(__dirname, "..", "..", "package.json"), // deeper nesting
      ];

      for (const pkgPath of candidates) {
        try {
          const content = fs.readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(content) as { version?: string };
          if (pkg.version) {
            cachedVersion = pkg.version;
            return cachedVersion;
          }
        } catch {
          // Try next candidate
        }
      }
    } catch {
      // Indirect require failed at runtime — fall through to fallback.
    }
  }

  cachedVersion = FALLBACK_VERSION;
  return cachedVersion;
}

/**
 * Get the full version string with prefix.
 * e.g. "yuanbao-lite v10.15.0"
 */
export function getVersionString(): string {
  return `yuanbao-lite v${getVersion()}`;
}
