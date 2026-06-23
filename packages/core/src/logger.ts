/**
 * Standalone logger module — no OpenClaw dependency.
 *
 * Provides structured logging with module prefix, log level control,
 * optional sensitive data masking, and unified file output.
 *
 * All log output is mirrored to a single log file (~/.yuanbao-lite/daemon.log)
 * when running under Node.js, so daemon logs are persisted across restarts.
 * Console output is also preserved for interactive debugging.
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
  const ts = new Date().toISOString();
  if (data === undefined) {
    return `${ts} ${prefix} ${msg}`;
  }
  return `${ts} ${prefix} ${msg} ${sanitize(data)}`;
}

// ─── Unified file sink ───

import { join } from "node:path";
import { homedir } from "node:os";

let fileSinkInitialized = false;
let fileWriteStream: import("node:fs").WriteStream | null = null;

/**
 * Initialize the unified file sink. All log messages are appended to
 * ~/.yuanbao-lite/daemon.log. Called once at daemon startup.
 *
 * This is lazy and guarded so browser/edge runtimes that don't have
 * node:fs won't crash — they just skip file logging.
 */
export async function initFileSink(): Promise<void> {
  if (fileSinkInitialized) return;
  fileSinkInitialized = true;
  try {
    const fs = await import("node:fs");
    const logDir = join(homedir(), ".yuanbao-lite");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logPath = join(logDir, "daemon.log");
    fileWriteStream = fs.createWriteStream(logPath, {
      flags: "a", // append
      encoding: "utf-8",
    });
    fileWriteStream.on("error", () => {
      // If the file sink fails, silently disable it
      fileWriteStream = null;
    });
  } catch {
    // node:fs not available (browser/edge) — skip file logging
  }
}

/**
 * Write a formatted log line to the file sink (if initialized).
 */
function writeToFile(line: string): void {
  if (fileWriteStream) {
    try {
      fileWriteStream.write(line + "\n");
    } catch {
      // ignore write errors
    }
  }
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
    info: (msg, data) => {
      if (shouldLog("info")) {
        const formatted = formatMessage(module, msg, data);
        target.info(formatted);
        writeToFile(formatted);
      }
    },
    warn: (msg, data) => {
      if (shouldLog("warn")) {
        const formatted = formatMessage(module, msg, data);
        target.warn(formatted);
        writeToFile(formatted);
      }
    },
    error: (msg, data) => {
      if (shouldLog("error")) {
        const formatted = formatMessage(module, msg, data);
        target.error(formatted);
        writeToFile(formatted);
      }
    },
    debug: (msg, data) => {
      if (shouldLog("debug")) {
        const formatted = formatMessage(module, msg, data);
        target.debug(formatted);
        writeToFile(formatted);
      }
    },
  };
}

/** Default logger singleton for convenience. */
export const logger: PluginLogger = createLog("");
