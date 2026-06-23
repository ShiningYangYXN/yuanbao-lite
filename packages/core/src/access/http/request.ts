/**
 * HTTP request layer — token signing, caching, and HTTP utilities.
 *
 * Standalone version without OpenClaw dependencies.
 * Uses the global Web Crypto API (available in Node 18+ and all modern
 * browsers) and global fetch — no static node:* imports, so this module
 * is browser-bundleable.
 *
 * Note: `computeSignature` is ASYNC because Web Crypto's HMAC API returns
 * a Promise. Callers must `await` it.
 */

import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import { getNodeModules } from "../persistence/adapter.js";

export type SignTokenData = {
  bot_id: string;
  duration: number;
  product: string;
  source: string;
  token: string;
};

export type Log = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

// ─── Constants ───

export const SIGN_TOKEN_PATH = "/api/v5/robotLogic/sign-token";
const RETRYABLE_SIGN_CODE = 10099;
const SIGN_MAX_RETRIES = 3;
const SIGN_RETRY_DELAY_MS = 1000;
const CACHE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_SAFE_TIMEOUT_MS = 24 * 24 * 3600 * 1000;
const HTTP_AUTH_RETRY_MAX = 1;

// ─── Version info (standalone) ───

const PLUGIN_VERSION = "1.0.0";

function getPluginVersion(): string {
  return PLUGIN_VERSION;
}

/**
 * Detect the operating system for the X-OperationSystem header.
 *
 * Returns "Browser" when running in a browser/edge runtime, otherwise
 * the Node `os.type()` value (e.g. "Linux", "Darwin", "Windows_NT").
 *
 * Uses the cached `nodeModules.os` (loaded via ESM dynamic import in
 * adapter.ts). If `os` is null (browser runtime or modules not yet
 * loaded), returns "Browser" or "Unknown" respectively.
 */
function getOperationSystem(): string {
  const os = getNodeModules().os;
  if (!os) {
    // Either browser/edge (no process.versions.node) or Node modules
    // haven't been preloaded yet. Distinguish by checking process.
    if (typeof process === "undefined" || !process.versions?.node) {
      return "Browser";
    }
    return "Unknown";
  }
  try {
    return os.type();
  } catch {
    return "Unknown";
  }
}

// ─── Web Crypto helpers ───

/**
 * Encode a UTF-8 string as Uint8Array. Uses TextEncoder when available
 * (Node 11+ and all modern browsers), falls back to a manual UTF-8 encoder.
 */
function encodeUtf8(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  // Fallback: manual UTF-8 encoding (rare path — TextEncoder is universal)
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c < 0xe000) {
      // surrogate pair
      i++;
      const c2 = input.charCodeAt(i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Convert a Uint8Array to a lowercase hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Generate a cryptographically random hex string of the given byte length.
 *
 * Uses `crypto.getRandomValues` (Web Crypto API — available in Node 18+
 * and all modern browsers). The output is hex-encoded, so `byteLength = 16`
 * produces a 32-character hex string.
 */
function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  // `globalThis.crypto` is the Web Crypto API, available in Node 18+ and
  // all modern browsers.
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.getRandomValues) {
    throw new Error(
      "randomHex: globalThis.crypto.getRandomValues is not available. " +
        "This requires Node 18+ or a modern browser runtime.",
    );
  }
  cryptoObj.getRandomValues(bytes);
  return bytesToHex(bytes);
}

// ─── Token cache ───

type CacheEntry = {
  data: SignTokenData;
  expiresAt: number;
};

const tokenCacheMap = new Map<string, CacheEntry>();
const tokenFetchPromises = new Map<string, Promise<SignTokenData>>();
const tokenRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ─── HTTP proxy support ───
//
// Browsers cannot directly call Tencent endpoints (bot.yuanbao.tencent.com,
// COS upload endpoints) due to CORS. Setting an httpProxy rewrites all
// outbound URLs to go through the proxy, which should forward the request
// and add the necessary CORS headers.
//
// Example proxy: a Cloudflare Worker / Vercel Edge Function that does:
//   fetch(targetUrl, { method, headers, body })
//   and returns the response with Access-Control-Allow-Origin: *
//
// The proxy URL can be:
//   - A full URL prefix: "https://my-proxy.workers.dev/"
//     → "https://bot.yuanbao.tencent.com/api/..." becomes
//       "https://my-proxy.workers.dev/https://bot.yuanbao.tencent.com/api/..."
//   - A path prefix (same-origin): "/api/proxy/"
//     → "https://bot.yuanbao.tencent.com/api/..." becomes
//       "/api/proxy/https://bot.yuanbao.tencent.com/api/..."

let httpProxyUrl: string | null = null;

/**
 * Configure a global HTTP proxy for all outbound requests to Tencent
 * endpoints. Primarily intended for browser environments where CORS
 * prevents direct calls.
 *
 * Pass `null` to disable proxying (default — direct calls).
 *
 * @example
 * ```typescript
 * import { setHttpProxy } from "yuanbao-lite";
 *
 * // Browser: route through a Cloudflare Worker
 * setHttpProxy("https://my-proxy.workers.dev/");
 *
 * // Dev: route through Vite dev server proxy
 * setHttpProxy("/api/yb-proxy/");
 * ```
 */
export function setHttpProxy(proxyUrl: string | null): void {
  httpProxyUrl = proxyUrl;
}

/**
 * Get the current HTTP proxy URL (or null if not set).
 */
export function getHttpProxy(): string | null {
  return httpProxyUrl;
}

/**
 * Rewrite a target URL to go through the configured HTTP proxy.
 *
 * If no proxy is set, returns the original URL unchanged.
 *
 * The rewriting strategy:
 *   - proxy ends with "/": target URL is appended as-is (full URL)
 *     e.g. proxy="https://pw.dev/" + target="https://bot.yb.com/api"
 *          → "https://pw.dev/https://bot.yb.com/api"
 *   - proxy doesn't end with "/": a "/" separator is added
 *
 * The proxy implementation is responsible for parsing the trailing
 * URL-encoded target and forwarding the request.
 */
function applyProxy(targetUrl: string): string {
  if (!httpProxyUrl) return targetUrl;
  const separator = httpProxyUrl.endsWith("/") ? "" : "/";
  return `${httpProxyUrl}${separator}${targetUrl}`;
}

export function clearSignTokenCache(accountId: string): void {
  tokenCacheMap.delete(accountId);
  const timer = tokenRefreshTimers.get(accountId);
  if (timer) {
    clearTimeout(timer);
    tokenRefreshTimers.delete(accountId);
  }
}

export function clearAllSignTokenCache(): void {
  tokenCacheMap.clear();
  for (const timer of tokenRefreshTimers.values()) {
    clearTimeout(timer);
  }
  tokenRefreshTimers.clear();
}

export function getTokenStatus(accountId: string): {
  status: "valid" | "expired" | "refreshing" | "none";
  expiresAt: number | null;
} {
  if (tokenFetchPromises.has(accountId)) {
    return {
      status: "refreshing",
      expiresAt: tokenCacheMap.get(accountId)?.expiresAt ?? null,
    };
  }
  const cached = tokenCacheMap.get(accountId);
  if (!cached) {
    return { status: "none", expiresAt: null };
  }
  return {
    status: cached.expiresAt > Date.now() ? "valid" : "expired",
    expiresAt: cached.expiresAt,
  };
}

// ─── Signature ───

/**
 * Compute the HMAC-SHA256 signature for the sign-token request.
 *
 * ASYNC since v11.5.3 — uses the Web Crypto API (`crypto.subtle.importKey`
 * + `crypto.subtle.sign`), which is async. This makes the module
 * browser-bundleable (no static `node:crypto` import).
 *
 * The signature is computed over `nonce + timestamp + appKey + appSecret`
 * using `appSecret` as the HMAC key, then hex-encoded.
 *
 * Available in Node 18+ (global `crypto`) and all modern browsers.
 */
export async function computeSignature(params: {
  nonce: string;
  timestamp: string;
  appKey: string;
  appSecret: string;
}): Promise<string> {
  const plain =
    params.nonce + params.timestamp + params.appKey + params.appSecret;
  const keyBytes = encodeUtf8(params.appSecret);
  const msgBytes = encodeUtf8(plain);

  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error(
      "computeSignature: globalThis.crypto.subtle is not available. " +
        "This requires Node 18+ or a secure browser context (https or localhost).",
    );
  }

  const key = await cryptoObj.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await cryptoObj.subtle.sign(
    "HMAC",
    key,
    msgBytes as BufferSource,
  );
  return bytesToHex(new Uint8Array(sigBuf));
}

/**
 * Constant-time string comparison (hex strings).
 *
 * Replaces `node:crypto.timingSafeEqual` with a pure-JS implementation
 * that works in both Node and browser. The comparison time is independent
 * of where the first mismatch occurs, preventing timing side-channels.
 *
 * Used for verifying inbound webhook signatures (the bot itself uses
 * WebSocket, so this is only relevant for users implementing custom
 * webhook receivers).
 */
export function verifySignature(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Sign token fetch ───

async function doFetchSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  const mlog = createLog("http", log);
  const { appKey, appSecret, apiDomain } = account;
  if (!appKey || !appSecret) {
    throw new Error("sign-token failed: missing appKey or appSecret");
  }

  const url = applyProxy(`https://${apiDomain}${SIGN_TOKEN_PATH}`);

  for (let attempt = 0; attempt <= SIGN_MAX_RETRIES; attempt++) {
    const nonce = randomHex(16);
    const bjTime = new Date(Date.now() + 8 * 3600000);
    const timestamp = bjTime
      .toISOString()
      .replace("Z", "+08:00")
      .replace(/\.\d{3}/, "");
    const signature = await computeSignature({
      nonce,
      timestamp,
      appKey,
      appSecret,
    });
    const body = { app_key: appKey, nonce, signature, timestamp };

    mlog.info(
      `signing token: url=${url}${attempt > 0 ? ` (retry ${attempt}/${SIGN_MAX_RETRIES})` : ""}`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AppVersion": getPluginVersion(),
      "X-OperationSystem": getOperationSystem(),
      "X-Instance-Id": "16",
    };

    if (account.config?.routeEnv) {
      headers["x-route-env"] = account.config.routeEnv;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `sign-token HTTP error: ${response.status} ${response.statusText}`,
      );
    }

    const result = (await response.json()) as {
      code: number;
      data: SignTokenData;
      msg: string;
    };

    if (result.code === 0) {
      mlog.info(`sign-token success: bot_id=${result.data.bot_id}`);
      return result.data;
    }

    if (result.code === RETRYABLE_SIGN_CODE && attempt < SIGN_MAX_RETRIES) {
      mlog.warn(
        `sign-token retryable: code=${result.code}, retrying in ${SIGN_RETRY_DELAY_MS}ms`,
      );
      await new Promise((r) => setTimeout(r, SIGN_RETRY_DELAY_MS));
      continue;
    }

    throw new Error(`sign-token error: code=${result.code}, msg=${result.msg}`);
  }

  throw new Error("sign-token failed: max retries exceeded");
}

// ─── Token refresh scheduling ───

function scheduleTokenRefresh(
  account: ResolvedYuanbaoAccount,
  durationSec: number,
  log?: Log,
): void {
  const mlog = createLog("http", log);
  const existing = tokenRefreshTimers.get(account.accountId);
  if (existing) {
    clearTimeout(existing);
  }

  const rawMs = durationSec * 1000 - CACHE_REFRESH_MARGIN_MS;
  const refreshAfterMs = Math.min(Math.max(rawMs, 60_000), MAX_SAFE_TIMEOUT_MS);
  mlog.info(
    `[${account.accountId}][token-timer] scheduled refresh: ${Math.round(refreshAfterMs / 1000)}s later`,
  );

  const timer = setTimeout(async () => {
    tokenRefreshTimers.delete(account.accountId);
    try {
      mlog.info(
        `[${account.accountId}][token-timer] scheduled refresh triggered`,
      );
      await forceRefreshSignToken(account, log);
    } catch (err) {
      mlog.error(
        `[${account.accountId}][token-timer] scheduled refresh failed: ${String(err)}`,
      );
    }
  }, refreshAfterMs);

  tokenRefreshTimers.set(account.accountId, timer);
}

// ─── Public API ───

export async function getSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  // Static token takes priority
  if (account.token) {
    return {
      bot_id: account.botId || "",
      duration: 0,
      product: "yuanbao",
      source: "bot",
      token: account.token,
    };
  }

  const tlog = createLog("http", log);
  const cached = tokenCacheMap.get(account.accountId);
  if (cached && cached.expiresAt > Date.now()) {
    const remainSec = Math.round((cached.expiresAt - Date.now()) / 1000);
    tlog.info(
      `[${account.accountId}] using cached token (${remainSec}s remaining)`,
    );
    return cached.data;
  }

  // Singleflight
  let fetchPromise = tokenFetchPromises.get(account.accountId);
  if (fetchPromise) {
    tlog.info(`[${account.accountId}] sign-token in progress, waiting`);
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const data = await doFetchSignToken(account, log);
      const ttlMs = data.duration > 0 ? data.duration * 1000 : 0;
      if (ttlMs > 0) {
        tokenCacheMap.set(account.accountId, {
          data,
          expiresAt: Date.now() + ttlMs,
        });
        if (data.bot_id) {
          account.botId = data.bot_id;
        }
        scheduleTokenRefresh(account, data.duration, log);
      }
      return data;
    } finally {
      tokenFetchPromises.delete(account.accountId);
    }
  })();

  tokenFetchPromises.set(account.accountId, fetchPromise);
  return fetchPromise;
}

export async function forceRefreshSignToken(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<SignTokenData> {
  const flog = createLog("http", log);
  flog.warn(
    `[${account.accountId}][force-refresh] clearing cache and re-signing token`,
  );
  clearSignTokenCache(account.accountId);
  tokenFetchPromises.delete(account.accountId);
  return getSignToken(account, log);
}

export type AuthHeaders = {
  "X-ID": string;
  "X-Token": string;
  "X-Source": string;
  "X-Route-Env"?: string;
  "X-AppVersion": string;
  "X-OperationSystem": string;
  "X-Instance-Id": string;
};

export async function getAuthHeaders(
  account: ResolvedYuanbaoAccount,
  log?: Log,
): Promise<AuthHeaders> {
  const data = await getSignToken(account, log);

  if (data.bot_id && !account.botId) {
    account.botId = data.bot_id;
  }

  const authHeaders: AuthHeaders = {
    "X-ID": data.bot_id || account.botId || "",
    "X-Token": data.token,
    "X-Source": data.source || "bot",
    "X-AppVersion": getPluginVersion(),
    "X-OperationSystem": getOperationSystem(),
    "X-Instance-Id": "16",
  };

  if (account.config?.routeEnv) {
    authHeaders["X-Route-Env"] = account.config.routeEnv;
  }

  return authHeaders;
}

export async function yuanbaoPost<T>(
  account: ResolvedYuanbaoAccount,
  path: string,
  body: unknown,
  log?: Log,
): Promise<T> {
  const plog = createLog("http", log);
  const url = applyProxy(`https://${account.apiDomain}${path}`);

  for (let attempt = 0; attempt <= HTTP_AUTH_RETRY_MAX; attempt++) {
    const authHeaders = await getAuthHeaders(account, log);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401 && attempt < HTTP_AUTH_RETRY_MAX) {
      plog.warn(
        `[post][${account.accountId}] ${path} received 401, refreshing token`,
      );
      await forceRefreshSignToken(account, log);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `[yuanbao-api][POST] ${path} HTTP ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      code?: number;
      data?: T;
      msg?: string;
    };

    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(
        `[yuanbao-api][POST] ${path} business error: code=${json.code}, msg=${json.msg}`,
      );
    }

    plog.info(`[post][${account.accountId}] ${path} succeeded`);
    return (json.data ?? json) as T;
  }

  throw new Error(`[yuanbao-api][POST] ${path} 401 retries exhausted`);
}

export async function yuanbaoGet<T>(
  account: ResolvedYuanbaoAccount,
  path: string,
  params?: Record<string, string>,
  log?: Log,
): Promise<T> {
  const glog = createLog("http", log);
  const url = applyProxy(
    `https://${account.apiDomain}${path}${params ? `?${new URLSearchParams(params).toString()}` : ""}`,
  );

  for (let attempt = 0; attempt <= HTTP_AUTH_RETRY_MAX; attempt++) {
    const authHeaders = await getAuthHeaders(account, log);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
    });

    if (response.status === 401 && attempt < HTTP_AUTH_RETRY_MAX) {
      glog.warn(
        `[get][${account.accountId}] ${path} received 401, refreshing token`,
      );
      await forceRefreshSignToken(account, log);
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `[yuanbao-api][GET] ${path} HTTP ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      code?: number;
      data?: T;
      msg?: string;
    };

    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(
        `[yuanbao-api][GET] ${path} business error: code=${json.code}, msg=${json.msg}`,
      );
    }

    return (json.data ?? json) as T;
  }

  throw new Error(`[yuanbao-api][GET] ${path} 401 retries exhausted`);
}
