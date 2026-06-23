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

// ─── Unified file sink with rotation ───

import { join } from "node:path";
import { homedir } from "node:os";

let fileSinkInitialized = false;
let fileWriteStream: import("node:fs").WriteStream | null = null;
let currentLogPath = "";
let currentLogSize = 0;
let rotationTimer: NodeJS.Timeout | null = null;

/** Max log file size before rotation (default: 5 MB). */
const MAX_LOG_SIZE = 5 * 1024 * 1024;
/** Max number of rotated log files to keep (daemon.log.1, .2, ...). */
const MAX_LOG_FILES = 5;
/** Check for rotation every 30 seconds. */
const ROTATION_CHECK_INTERVAL = 30_000;

/**
 * Initialize the unified file sink. All log messages are appended to
 * ~/.yuanbao-lite/daemon.log. Called once at daemon startup.
 *
 * Includes automatic rotation: when the log file exceeds MAX_LOG_SIZE,
 * it is rotated to daemon.log.1 (and .1→.2, .2→.3, etc., up to
 * MAX_LOG_FILES). This prevents the log file from growing unbounded.
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
    currentLogPath = join(logDir, "daemon.log");

    // Check current file size
    try {
      const stat = fs.statSync(currentLogPath);
      currentLogSize = stat.size;
    } catch {
      currentLogSize = 0;
    }

    openWriteStream(fs);

    // Periodic rotation check
    rotationTimer = setInterval(() => {
      void checkRotation();
    }, ROTATION_CHECK_INTERVAL);
  } catch {
    // node:fs not available (browser/edge) — skip file logging
  }
}

function openWriteStream(fs: typeof import("node:fs")): void {
  fileWriteStream = fs.createWriteStream(currentLogPath, {
    flags: "a",
    encoding: "utf-8",
  });
  fileWriteStream.on("error", () => {
    fileWriteStream = null;
  });
}

/**
 * Check if the current log file exceeds the max size and rotate if needed.
 * Rotation: daemon.log → daemon.log.1 → daemon.log.2 → ... → daemon.log.5 (deleted)
 */
async function checkRotation(): Promise<void> {
  if (!fileWriteStream || !currentLogPath) return;
  try {
    const fs = await import("node:fs");
    try {
      const stat = fs.statSync(currentLogPath);
      currentLogSize = stat.size;
    } catch {
      return;
    }
    if (currentLogSize < MAX_LOG_SIZE) return;

    // Close current stream
    fileWriteStream.end();
    fileWriteStream = null;

    const logDir = join(currentLogPath, "..");
    // Shift existing rotated files: .4→.5 (delete .5), .3→.4, .2→.3, .1→.2
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = join(logDir, `daemon.log.${i}`);
      const to = join(logDir, `daemon.log.${i + 1}`);
      try {
        if (fs.existsSync(from)) {
          if (i + 1 > MAX_LOG_FILES) {
            fs.unlinkSync(from);
          } else {
            fs.renameSync(from, to);
          }
        }
      } catch {
        // ignore individual rotation errors
      }
    }
    // Rotate current log to .1
    try {
      fs.renameSync(currentLogPath, join(logDir, "daemon.log.1"));
    } catch {
      // ignore
    }

    // Reopen fresh stream
    currentLogSize = 0;
    openWriteStream(fs);
  } catch {
    // ignore rotation errors
  }
}

/**
 * Write a formatted log line to the file sink (if initialized).
 * Tracks size for rotation checking.
 */
function writeToFile(line: string): void {
  if (fileWriteStream) {
    try {
      const data = line + "\n";
      fileWriteStream.write(data);
      currentLogSize += Buffer.byteLength(data, "utf-8");
      // Inline size check (in addition to the periodic timer) for fast rotation
      if (currentLogSize >= MAX_LOG_SIZE) {
        void checkRotation();
      }
    } catch {
      // ignore write errors
    }
  }
}

/** Shutdown the file sink (called on daemon stop). */
export function closeFileSink(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
  if (fileWriteStream) {
    try {
      fileWriteStream.end();
    } catch {
      // ignore
    }
    fileWriteStream = null;
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
