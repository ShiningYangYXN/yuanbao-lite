/**
 * Thin HTTP client for talking to the daemon.
 *
 * `ensureDaemon()` is the key entry point: every CLI mode (interactive,
 * non-interactive, daemon-start) calls it. It pings `/health`; if that
 * fails, it spawns a detached `yb-cli daemon start` child process and
 * polls until the daemon is ready (or times out).
 *
 * Once a daemon is alive, all higher-level helpers (`sendDm`, `sendGroup`,
 * `runCommand`, etc.) just POST to its HTTP routes.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DEFAULT_DAEMON_PORT = 9100;
export const DEFAULT_DAEMON_HOST = "127.0.0.1";
const DAEMON_READY_TIMEOUT_MS = 30_000;
const DAEMON_POLL_INTERVAL_MS = 250;

export type DaemonInfo = {
  pid: number;
  version: string;
  uptime: number;
  port: number;
  host: string;
  bot?: {
    status: string;
    connected: boolean;
    botId?: string;
  } | null;
};

export type CommandResult = {
  ok: boolean;
  handled: boolean;
  replies: string[];
  error?: string;
};

export class DaemonNotRunningError extends Error {
  constructor(public cause: Error) {
    super(`daemon is not running: ${cause.message}`);
    this.name = "DaemonNotRunningError";
  }
}

export class DaemonClient {
  constructor(
    public readonly port: number = DEFAULT_DAEMON_PORT,
    public readonly host: string = DEFAULT_DAEMON_HOST,
  ) {}

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  // ─── Low-level HTTP ───

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<{ status: number; data: T }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
      };
      if (body && method === "POST") {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data: data as T };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Health & lifecycle ───

  async ping(timeoutMs = 1500): Promise<DaemonInfo | null> {
    try {
      const { status, data } = await this.request<DaemonInfo & { ok?: boolean }>("GET", "/health", undefined, timeoutMs);
      if (status === 200 && (data as { ok?: boolean }).ok !== false) {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("POST", "/shutdown", {});
    } catch {
      // ignore — daemon may have exited already
    }
  }

  /**
   * Ensure a daemon is running. If `/health` already responds, return its info.
   * Otherwise spawn a detached daemon child process and poll until ready.
   *
   * Throws if the daemon fails to come up within 30s.
   */
  async ensureDaemon(opts?: { port?: number; spawnIfMissing?: boolean }): Promise<DaemonInfo> {
    const existing = await this.ping();
    if (existing) return existing;

    if (opts?.spawnIfMissing === false) {
      throw new DaemonNotRunningError(new Error("daemon not running and spawnIfMissing=false"));
    }

    await this.spawnDaemon(opts?.port ?? this.port);
    const ready = await this.waitForReady(DAEMON_READY_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonNotRunningError(new Error("daemon did not become ready within 30s"));
    }
    return ready;
  }

  private async spawnDaemon(port: number): Promise<void> {
    const entry = getDaemonEntryPath();
    const args = ["daemon", "start", "--port", String(port)];
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, YB_DAEMON_CHILD: "1" },
    });
    child.unref();
  }

  private async waitForReady(timeoutMs: number): Promise<DaemonInfo | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await this.ping(800);
      if (info) return info;
      await sleep(DAEMON_POLL_INTERVAL_MS);
    }
    return null;
  }

  // ─── Bot operations ───

  async sendDm(userId: string, message: string): Promise<void> {
    const { status, data } = await this.request<{ ok: boolean; error?: string }>("POST", "/send/dm", { userId, message });
    if (status !== 200 || !data.ok) {
      throw new Error(data.error ?? `send/dm failed: HTTP ${status}`);
    }
  }

  async sendGroup(groupCode: string, message: string): Promise<void> {
    const { status, data } = await this.request<{ ok: boolean; error?: string }>("POST", "/send/group", { groupCode, message });
    if (status !== 200 || !data.ok) {
      throw new Error(data.error ?? `send/group failed: HTTP ${status}`);
    }
  }

  async upload(filePath: string, type?: string): Promise<{
    uuid: string; url?: string; fileSize: number; mediaType: string; fileName: string;
  }> {
    const { status, data } = await this.request<{ ok: boolean; error?: string; uuid?: string; url?: string; fileSize?: number; mediaType?: string; fileName?: string }>(
      "POST",
      "/upload",
      { filePath, type },
      60_000,
    );
    if (status !== 200 || !data.ok || !data.uuid) {
      throw new Error(data.error ?? `upload failed: HTTP ${status}`);
    }
    return {
      uuid: data.uuid,
      url: data.url,
      fileSize: data.fileSize ?? 0,
      mediaType: data.mediaType ?? "file",
      fileName: data.fileName ?? "",
    };
  }

  async download(url: string, dir?: string, fileName?: string): Promise<{
    filePath: string; fileSize: number; mediaType: string; fileName: string;
  }> {
    const { status, data } = await this.request<{ ok: boolean; error?: string; filePath?: string; fileSize?: number; mediaType?: string; fileName?: string }>(
      "POST",
      "/download",
      { url, dir, fileName },
      60_000,
    );
    if (status !== 200 || !data.ok || !data.filePath) {
      throw new Error(data.error ?? `download failed: HTTP ${status}`);
    }
    return {
      filePath: data.filePath,
      fileSize: data.fileSize ?? 0,
      mediaType: data.mediaType ?? "file",
      fileName: data.fileName ?? "",
    };
  }

  /**
   * Run a slash-command through the daemon's CommandSystem.
   * Returns the array of reply strings the command produced.
   */
  async runCommand(text: string, opts?: { chatMode?: "direct" | "group"; chatTarget?: string }): Promise<CommandResult> {
    const { status, data } = await this.request<CommandResult>("POST", "/command", {
      text,
      chatMode: opts?.chatMode ?? "direct",
      chatTarget: opts?.chatTarget ?? "cli",
    });
    if (status !== 200) {
      throw new Error(`command failed: HTTP ${status}`);
    }
    return data;
  }

  // ─── SSE event stream ───

  /**
   * Subscribe to the daemon's SSE event stream.
   *
   * Calls `onEvent(name, data)` for each event. Returns an unsubscribe
   * function. The stream auto-reconnects once on transient errors.
   */
  subscribeSse(onEvent: (event: string, data: unknown) => void): () => void {
    let stopped = false;
    let controller: AbortController | null = null;

    const connect = async (): Promise<void> => {
      if (stopped) return;
      controller = new AbortController();
      try {
        const res = await fetch(`${this.baseUrl}/events`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE failed: HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE frames: blank line separates events
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);

            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
              }
              // lines starting with ":" are comments (keepalive) — ignore
            }
            if (dataLines.length > 0) {
              const raw = dataLines.join("\n");
              let parsed: unknown = raw;
              try {
                parsed = JSON.parse(raw);
              } catch {
                // keep as string
              }
              onEvent(eventName, parsed);
            }
          }
        }
      } catch {
        if (stopped) return;
        // Reconnect after a short delay (single retry — caller can subscribe again for more)
        await sleep(2000);
        if (!stopped) void connect();
      }
    };

    void connect();

    return () => {
      stopped = true;
      controller?.abort();
    };
  }

  // ─── Completion data ───

  async fetchCompletions(): Promise<{
    contacts: Array<{ id: string; name: string; tag?: string }>;
    groups: Array<{ groupCode: string; name: string; tag?: string }>;
    aliases: Array<{ alias: string; id: string; nickname?: string }>;
    commands: Array<{ name: string; aliases: string[]; description: string }>;
  }> {
    const { status, data } = await this.request<{
      ok: boolean;
      contacts?: Array<{ id: string; name: string; tag?: string }>;
      groups?: Array<{ groupCode: string; name: string; tag?: string }>;
      aliases?: Array<{ alias: string; id: string; nickname?: string }>;
      commands?: Array<{ name: string; aliases: string[]; description: string }>;
      error?: string;
    }>("GET", "/completions");
    if (status !== 200 || !data.ok) {
      throw new Error(data.error ?? `completions failed: HTTP ${status}`);
    }
    return {
      contacts: data.contacts ?? [],
      groups: data.groups ?? [],
      aliases: data.aliases ?? [],
      commands: data.commands ?? [],
    };
  }
}

// ─── Module-level helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getDaemonEntryPath(): string {
  // dist/cli/index.js — the daemon entry that boots Daemon
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "index.js");
}

// Singleton client (default port)
let defaultClient: DaemonClient | null = null;
export function getDefaultClient(port?: number, host?: string): DaemonClient {
  if (!defaultClient || (port !== undefined && port !== defaultClient.port) || (host !== undefined && host !== defaultClient.host)) {
    defaultClient = new DaemonClient(port ?? DEFAULT_DAEMON_PORT, host ?? DEFAULT_DAEMON_HOST);
  }
  return defaultClient;
}
