/**
 * Version utility — auto-reads version from package.json.
 *
 * Instead of hardcoding version strings throughout the codebase,
 * all modules should import and use `getVersion()` from this file.
 * The version is read from package.json at runtime, ensuring a
 * single source of truth.
 *
 * Resolution strategy:
 *   1. Try import.meta.url + walk up to find package.json
 *   2. Fallback to a known constant if reading fails
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Cache the version after first read
let cachedVersion: string | null = null;

/**
 * Get the current version from package.json.
 *
 * Reads package.json relative to this module's location,
 * walking up the directory tree if needed.
 * Falls back to a hardcoded version if reading fails.
 */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    // Strategy 1: Read from package.json relative to this module
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Try several possible locations for package.json
    const candidates = [
      join(__dirname, "..", "package.json"),   // dist/version.js -> package.json (project root)
      join(__dirname, "package.json"),           // same dir
      join(__dirname, "..", "..", "package.json"), // deeper nesting
    ];

    for (const pkgPath of candidates) {
      try {
        const content = readFileSync(pkgPath, "utf-8");
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
    // import.meta.url may not be available in all contexts
  }

  // Fallback: hardcoded version (update when releasing)
  cachedVersion = "11.3.4";
  return cachedVersion;
}

/**
 * Get the full version string with prefix.
 * e.g. "yuanbao-lite v10.15.0"
 */
export function getVersionString(): string {
  return `yuanbao-lite v${getVersion()}`;
}
