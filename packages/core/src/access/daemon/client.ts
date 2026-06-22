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
 *
 * Node-only: uses `node:child_process.spawn`, `node:url.fileURLToPath`,
 * and `node:path.dirname`/`join`. These are loaded via ESM dynamic import
 * guarded by `typeof process` checks, so the module is browser-bundleable
 * (browsers get a separate chunk that's never fetched).
 */

import { getNodeModules } from "../persistence/adapter.js";

export const DEFAULT_DAEMON_PORT = 8992;
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
   * Restart the daemon: spawn a fresh detached daemon process, then return.
   *
   * The fresh daemon's `acquirePidFile()` will SIGTERM the current daemon
   * (wait up to 3s, then SIGKILL). This is the ONLY safe way to restart —
   * calling shutdown() + ensureDaemon() from INSIDE a /command handler is
   * suicidal because the daemon kills itself before the handler can finish.
   *
   * This method:
   *   1. Spawns `node dist/cli/index.js daemon start` with detached:true, unref'd
   *   2. Polls /health until the NEW daemon responds (≤30s)
   *   3. Returns the new daemon's info
   *
   * The caller does NOT need to call shutdown() first — the new daemon
   * handles killing the old one via PID file contention.
   */
  async restart(): Promise<DaemonInfo> {
    // Spawn a fresh daemon — it will kill the old one via acquirePidFile()
    await this.spawnDaemon(this.port);
    // Wait for the new daemon to come up (it may take a few seconds to
    // SIGTERM the old one, release the port, and start listening)
    const ready = await this.waitForReady(DAEMON_READY_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonNotRunningError(new Error("daemon did not become ready within 30s after restart"));
    }
    return ready;
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
    // Node-only — uses node:child_process.spawn. Under browser, this
    // throws a clear error (no way to spawn a daemon process).
    const childProcess = getNodeModules().fs ? await import("node:child_process") : null;
    if (!childProcess) {
      throw new DaemonNotRunningError(
        new Error("spawnDaemon requires Node.js runtime (node:child_process) to start a daemon process"),
      );
    }
    const entry = getDaemonEntryPath();
    const args = ["daemon", "start", "--port", String(port)];
    const child = childProcess.spawn(process.execPath, [entry, ...args], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, YB_DAEMON_CHILD: "1" },
    });
    child.on("error", (err: Error) => {
      console.error(`[daemon-client] spawn error: ${err.message}`);
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
   *
   * `source` defaults to "cli" — tells the CommandSystem to apply CLI-appropriate
   * coloring and bypass dmOnly restrictions.
   */
  async runCommand(text: string, opts?: { chatMode?: "direct" | "group"; chatTarget?: string; source?: "cli" | "chat" }): Promise<CommandResult> {
    const { status, data } = await this.request<CommandResult>("POST", "/command", {
      text,
      chatMode: opts?.chatMode ?? "direct",
      chatTarget: opts?.chatTarget ?? "cli",
      source: opts?.source ?? "cli",
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

  // ─── Wizard support ───

  /**
   * Check if a wizard session is active for a user.
   */
  async wizardStatus(userId: string = "cli"): Promise<{ active: boolean; wizard: string | null }> {
    const { status, data } = await this.request<{ ok: boolean; active?: boolean; wizard?: string | null }>(
      "GET",
      `/wizard-status?userId=${encodeURIComponent(userId)}`,
    );
    if (status !== 200) return { active: false, wizard: null };
    return { active: data.active ?? false, wizard: data.wizard ?? null };
  }

  /**
   * Send input to an active wizard session.
   * Returns the wizard's reply text and whether it was handled.
   */
  async wizardInput(text: string, userId: string = "cli"): Promise<{
    handled: boolean;
    replies: string[];
    wizard: string | null;
  }> {
    const { status, data } = await this.request<{ ok: boolean; handled?: boolean; replies?: string[]; wizard?: string | null }>(
      "POST",
      "/wizard-input",
      { text, userId },
    );
    if (status !== 200) return { handled: false, replies: [], wizard: null };
    return {
      handled: data.handled ?? false,
      replies: data.replies ?? [],
      wizard: data.wizard ?? null,
    };
  }

  // ─── Completion data ───

  async fetchCommands(): Promise<Array<{
    name: string;
    aliases: string[];
    description: string;
    usage: string;
    category: string;
    dmOnly: boolean;
    requireConnected: boolean;
    hidden: boolean;
  }>> {
    const { status, data } = await this.request<{
      ok: boolean;
      commands?: Array<{
        name: string;
        aliases: string[];
        description: string;
        usage: string;
        category: string;
        dmOnly: boolean;
        requireConnected: boolean;
        hidden: boolean;
      }>;
      error?: string;
    }>("GET", "/commands");
    if (status !== 200 || !data.ok) {
      throw new Error(data.error ?? `commands failed: HTTP ${status}`);
    }
    return data.commands ?? [];
  }

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
  // The daemon entry is @yuanbao-lite/cli's dist/index.js.
  //
  // In the monorepo, this file lives in @yuanbao-lite/core at:
  //   packages/core/dist/access/daemon/client.js
  // and the CLI entry is at:
  //   packages/cli/dist/index.js
  //
  // We resolve the CLI entry by:
  //   1. Try `require.resolve("@yuanbao-lite/cli")` — works when the CLI
  //      package is installed (workspace or published).
  //   2. Fall back to a relative path walk from this file's location:
  //      packages/core/dist/access/daemon/ → ../../../../packages/cli/dist/index.js
  //   3. Fall back to `import.meta.url` + path manipulation.
  const { path } = getNodeModules();
  if (!path) {
    throw new Error(
      "getDaemonEntryPath requires Node.js runtime (node:path) to resolve the daemon entry path.",
    );
  }

  // Strategy 1: require.resolve — most reliable when package is installed
  try {
    // Use indirect require to avoid bundler issues
    const mod = (globalThis as { require?: NodeRequire }).require;
    if (mod) {
      return mod.resolve("@yuanbao-lite/cli");
    }
  } catch {
    // Fall through to strategy 2
  }

  // Strategy 2: relative path walk from this file
  // This file: packages/core/dist/access/daemon/client.js
  // Target:    packages/cli/dist/index.js
  // Walk up: daemon/ → access/ → dist/ → core/ → packages/
  // Then into: cli/dist/index.js
  const urlStr = import.meta.url;
  if (urlStr.startsWith("file://")) {
    let p = urlStr.slice("file://".length);
    if (process.platform === "win32" && p.startsWith("/")) {
      p = p.slice(1).replace(/\//g, "\\");
    }
    // p = .../packages/core/dist/access/daemon/client.js
    const here = path.dirname(p);  // .../packages/core/dist/access/daemon
    // Walk up 4 levels: daemon → access → dist → core → packages
    // Then into cli/dist/index.js
    const cliEntry = path.join(here, "..", "..", "..", "..", "cli", "dist", "index.js");
    return cliEntry;
  }

  throw new Error(
    `getDaemonEntryPath: cannot resolve CLI entry path. import.meta.url=${urlStr}`,
  );
}

// Singleton client (default port)
let defaultClient: DaemonClient | null = null;
export function getDefaultClient(port?: number, host?: string): DaemonClient {
  if (!defaultClient || (port !== undefined && port !== defaultClient.port) || (host !== undefined && host !== defaultClient.host)) {
    defaultClient = new DaemonClient(port ?? DEFAULT_DAEMON_PORT, host ?? DEFAULT_DAEMON_HOST);
  }
  return defaultClient;
}
