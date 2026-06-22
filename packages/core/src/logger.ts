/**
 * Standalone logger module — no OpenClaw dependency.
 *
 * Provides structured logging with module prefix, log level control,
 * and optional sensitive data masking.
 */

export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";
let logPrefix = "[yuanbao-lite]";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setLogPrefix(prefix: string): void {
  logPrefix = prefix;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[minLevel];
}

function formatMessage(
  module: string,
  msg: string,
  data?: Record<string, unknown>,
): string {
  const prefix = module ? `${logPrefix}[${module}]` : logPrefix;
  if (data === undefined) {
    return `${prefix} ${msg}`;
  }
  return `${prefix} ${msg} ${sanitize(data)}`;
}

// ─── Sensitive data masking ───

const OMIT_KEYS = new Set(["msg_body"]);
const SENSITIVE_KEYS = new Set([
  "token",
  "signature",
  "app_key",
  "appkey",
  "appsecret",
  "app_secret",
  "secret",
  "password",
  "x-token",
  "user_input",
  "cloud_custom_data",
  "model_output",
]);

function maskValue(value: string): string {
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

function sanitizeObj(obj: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === "object" && item !== null ? sanitizeObj(item) : item,
    ) as unknown as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (OMIT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof val === "string") {
      result[key] = maskValue(val);
    } else if (typeof val === "object" && val !== null) {
      result[key] = sanitizeObj(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

export function sanitize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(sanitizeObj(parsed as Record<string, unknown>));
      }
    } catch {
      // Not a JSON string — return as-is
    }
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(sanitizeObj(value as Record<string, unknown>));
  }
  return typeof value === "symbol"
    ? value.toString()
    : String(value as string | number | boolean | bigint);
}

// ─── Module-scoped logger factory ───

export interface ModuleLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

export function createLog(
  module: string,
  sink?: Partial<PluginLogger>,
): ModuleLog {
  const target: PluginLogger = {
    info: sink?.info ?? ((msg: string) => console.log(msg)),
    warn: sink?.warn ?? ((msg: string) => console.warn(msg)),
    error: sink?.error ?? ((msg: string) => console.error(msg)),
    debug:
      sink?.debug ??
      ((msg: string) => shouldLog("debug") && console.debug(msg)),
  };

  return {
    info: (msg, data) =>
      shouldLog("info") && target.info(formatMessage(module, msg, data)),
    warn: (msg, data) =>
      shouldLog("warn") && target.warn(formatMessage(module, msg, data)),
    error: (msg, data) =>
      shouldLog("error") && target.error(formatMessage(module, msg, data)),
    debug: (msg, data) =>
      shouldLog("debug") && target.debug(formatMessage(module, msg, data)),
  };
}

/** Default logger singleton for convenience. */
export const logger: PluginLogger = createLog("");
