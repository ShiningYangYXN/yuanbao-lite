/**
 * Daemon HTTP server.
 *
 * Routes (all JSON in/out unless noted):
 *   GET    /health                 → { ok, pid, version, uptime, bot: BotState, account: ResolvedYuanbaoAccount }
 *   POST   /shutdown               → { ok: true }   (graceful shutdown)
 *   POST   /send/dm                → { ok: true }   body: { userId, message }
 *   POST   /send/group             → { ok: true }   body: { groupCode, message }
 *   POST   /upload                 → { ok, uuid, url, fileSize, mediaType, fileName }   body: { filePath, type? }
 *   POST   /download               → { ok, filePath, fileSize, mediaType, fileName }    body: { url, dir?, fileName? }
 *   GET    /status                 → same as /health but without account-sensitive fields
 *   POST   /command                → { ok, handled, replies: string[] }   body: { text, chatMode?, chatTarget? }
 *   GET    /events                 → text/event-stream   (pushes incoming DM/group messages)
 *
 * All errors are returned as `{ ok: false, error: string }` with HTTP 4xx/5xx.
 *
 * The daemon owns a single `YuanbaoBot` instance for its entire lifetime —
 * this means a CLI command can fire-and-exit cheaply without re-establishing
 * the WebSocket on every invocation.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { YuanbaoBot } from "../../index.js";
import type { BotState } from "../../types.js";
import type { ChatMessage } from "../../types.js";
import { getGlobalConfigStore } from "../../shared/config.js";
import { createLog, setLogLevel } from "../../logger.js";
import { getVersion } from "../../version.js";
import { acquirePidFile, releasePidFile, getPidFilePath } from "./pid-file.js";
import { handleRoute } from "./routes.js";

const log = createLog("daemon");

export type DaemonOptions = {
  port?: number;
  /** Bind address — defaults to 127.0.0.1 (loopback only). */
  host?: string;
  /** Suppress health-check log lines. */
  quiet?: boolean;
};

export class Daemon {
  private bot: YuanbaoBot | null = null;
  private httpServer: Server | null = null;
  private port: number;
  private host: string;
  private quiet: boolean;
  private sseClients: Set<ServerResponse<IncomingMessage>> = new Set();
  private startedAt = 0;

  constructor(options: DaemonOptions = {}) {
    this.port = options.port ?? 8992;
    this.host = options.host ?? "127.0.0.1";
    this.quiet = options.quiet ?? false;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();

    // Install global handlers so a stray rejection doesn't silently kill us
    process.on("unhandledRejection", (reason) => {
      log.warn(`unhandledRejection: ${String(reason)}`);
    });
    process.on("uncaughtException", (err) => {
      log.error(`uncaughtException: ${err.message}`);
      // Don't exit — daemon should be resilient
    });

    // 1. Acquire PID file (auto-kills stale daemons)
    const { killedStale, stalePid } = await acquirePidFile();
    if (killedStale) {
      log.info(`killed stale daemon (pid=${stalePid})`);
    }

    // 2. Load config + build bot
    const store = getGlobalConfigStore({ autoSave: true });
    const profile = store.getActiveProfile();
    // Daemon should be quiet by default — bot connection chatter is noisy.
    // Users can override via `yb-cli config set logLevel debug`.
    const logLevel = (profile.logLevel ?? "warn") as "debug" | "info" | "warn" | "error";
    setLogLevel(logLevel);

    if (!store.hasCredentials()) {
      log.error("no credentials configured — run `yb-cli config init` first");
      process.exit(1);
    }

    const botConfig: Record<string, unknown> = {
      appKey: profile.appKey,
      appSecret: profile.appSecret,
      token: profile.token,
      apiDomain: profile.apiDomain,
      wsUrl: profile.wsUrl,
      logLevel,
    };

    this.bot = new YuanbaoBot(botConfig);

    // Forward incoming messages to all SSE subscribers
    this.bot.on("directMessage", (msg: ChatMessage) => this.broadcastSse("directMessage", msg));
    this.bot.on("groupMessage", (msg: ChatMessage) => this.broadcastSse("groupMessage", msg));
    this.bot.on("stateChange", (state: BotState) => this.broadcastSse("stateChange", state));

    // 3. Connect bot (fire-and-forget; HTTP server starts regardless so the
    //    client can poll /health for connection progress)
    this.bot.start().catch((err: Error) => {
      log.error(`bot start failed: ${err.message}`);
    });

    // 4. Start HTTP server
    await this.startHttpServer();

    // 5. Signal handlers
    process.on("SIGINT", () => void this.stop("SIGINT"));
    process.on("SIGTERM", () => void this.stop("SIGTERM"));

    this.printBanner();
  }

  async stop(signal?: string): Promise<void> {
    log.info(`stopping daemon${signal ? ` (signal=${signal})` : ""}...`);

    // Close SSE clients
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();

    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = null;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    releasePidFile();
    process.exit(0);
  }

  private async startHttpServer(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err: Error) => {
        log.error(`unhandled: ${err.message}`);
        this.sendJson(res, 500, { ok: false, error: err.message });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, this.host, () => resolve());
      this.httpServer!.on("error", reject);
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // CORS / preflight (harmless for localhost)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE upgrade for /events
    if (path === "/events" && method === "GET") {
      this.handleSse(req, res);
      return;
    }

    // Parse JSON body for POST
    let body: Record<string, unknown> = {};
    if (method === "POST") {
      body = await this.readJsonBody(req);
    }

    const ctx = {
      bot: this.bot,
      profile: getGlobalConfigStore({ autoSave: true }).getActiveProfile(),
      startedAt: this.startedAt,
      pid: process.pid,
      port: this.port,
      host: this.host,
      query: Object.fromEntries(url.searchParams.entries()),
      shutdown: () => void this.stop("http-shutdown"),
    };

    const result = await handleRoute(method, path, body, ctx);
    this.sendJson(res, result.status, result.body);
  }

  private handleSse(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ pid: process.pid, ts: Date.now() })}\n\n`);

    this.sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepalive);
        this.sseClients.delete(res);
      }
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepalive);
      this.sseClients.delete(res);
    });
  }

  private broadcastSse(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      const text = Buffer.concat(chunks).toString("utf-8");
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private printBanner(): void {
    const v = getVersion();
    const pidFile = getPidFilePath();
    const banner = [
      "",
      "  \x1b[38;5;75mYuanbao Lite Daemon\x1b[0m",
      `  \x1b[2m版本     ${v}\x1b[0m`,
      `  \x1b[2mPID      ${process.pid}\x1b[0m`,
      `  \x1b[2m监听     http://${this.host}:${this.port}\x1b[0m`,
      `  \x1b[2mPID文件  ${pidFile}\x1b[0m`,
      `  \x1b[2m健康检查 GET  /health\x1b[0m`,
      `  \x1b[2m事件流   GET  /events  (SSE)\x1b[0m`,
      `  \x1b[2m关闭     POST /shutdown  或  SIGINT/SIGTERM\x1b[0m`,
      "",
    ].join("\n");
    console.log(banner);
  }
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon(options);
  await daemon.start();
}

// Re-export for callers that just want to spawn a daemon process.
export function getDaemonEntryPath(): string {
  // dist/cli/index.js — this file's compiled output
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "index.js");
}
