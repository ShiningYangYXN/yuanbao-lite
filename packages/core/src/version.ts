/**
 * Version utility — reads version from package.json when running under Node,
 * with a hardcoded fallback for browser/edge runtimes.
 *
 * Resolution strategy (in priority order):
 *   1. Cached value (if previously resolved)
 *   2. Runtime read of package.json via ESM dynamic import() (Node only)
 *   3. Hardcoded fallback constant below
 *
 * Why dynamic import()? Static `import { readFileSync } from "node:fs"`
 * would force browser bundlers (Vite, Rollup, esbuild, Webpack 5) to either
 * fail the build or include a broken shim. By using `await import("node:fs")`
 * guarded by `typeof process`, bundlers split the Node built-ins into a
 * separate chunk that's only fetched under Node — the browser bundle
 * contains zero `node:*` code.
 *
 * Top-level await is supported in ESM (Node 14+, all modern bundlers).
 */

// Hardcoded fallback — keep in sync with package.json `version` on release.
// This is the value browser/edge callers will see.
const FALLBACK_VERSION = "12.2.0";

// Cache the version after first read
let cachedVersion: string | null = null;

/**
 * Detect whether we're running under Node.js with ESM dynamic import
 * available (Node 18+, where `import()` can resolve `node:*` specifiers).
 */
function isNodeRuntime(): boolean {
  return typeof process !== "undefined" && process.versions?.node != null;
}

/**
 * Read the version from `package.json` under Node via ESM dynamic imports.
 *
 * Uses `node:fs` / `node:path` / `node:url` loaded via `await import(...)`.
 * Returns `null` if running outside Node, or if the read fails for any reason.
 */
async function readVersionFromPackageJson(): Promise<string | null> {
  if (!isNodeRuntime()) return null;
  try {
    // Three parallel dynamic imports — bundlers split each into its own
    // chunk, fetched only when this code path runs (i.e. under Node).
    const [fs, path, url] = await Promise.all([
      import("node:fs"),
      import("node:path"),
      import("node:url"),
    ]);
    const __filename = url.fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Try several possible locations for package.json
    const candidates = [
      path.join(__dirname, "..", "package.json"), // dist/version.js -> package.json (project root)
      path.join(__dirname, "package.json"), // same dir
      path.join(__dirname, "..", "..", "package.json"), // deeper nesting
    ];

    for (const pkgPath of candidates) {
      try {
        const content = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(content) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // Try next candidate
      }
    }
  } catch {
    // Dynamic import failed at runtime — fall through to fallback.
  }
  return null;
}

// Kick off the read at module init time. The promise is stored so callers
// that need the resolved version immediately can `await versionReady`.
const versionReady: Promise<string> = (async () => {
  const v = await readVersionFromPackageJson();
  if (v) {
    cachedVersion = v;
    return v;
  }
  cachedVersion = FALLBACK_VERSION;
  return FALLBACK_VERSION;
})();

export { versionReady };

/**
 * Get the current version.
 *
 * Returns the version resolved from package.json under Node (if the
 * top-level `await import()` has completed by the time this is called),
 * otherwise the hardcoded fallback.
 *
 * Callers that need to guarantee the resolved version is available should
 * `await versionReady` first — useful for /version commands and CLI banners.
 */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  // Top-level await hasn't completed yet — return fallback optimistically.
  // The real version will be cached shortly; subsequent calls will return it.
  return FALLBACK_VERSION;
}

/**
 * Get the full version string with prefix.
 * e.g. "yuanbao-lite v10.15.0"
 */
export function getVersionString(): string {
  return `yuanbao-lite v${getVersion()}`;
}
