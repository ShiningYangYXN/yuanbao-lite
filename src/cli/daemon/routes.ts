/**
 * Route handlers for the daemon HTTP server.
 *
 * Each route receives the parsed JSON body (for POST) and returns
 * `{ status, body }`. All handlers run inside try/catch via `handleRoute`.
 *
 * Bot-touching routes reuse the singleton `bot` held by the daemon.
 * `/command` is the key seam: it invokes `bot.getCommandSystem().dispatch()`
 * with an `onReply` that captures every reply line into an array —
 * this means the CLI shares the **exact same** command handlers as the
 * interactive REPL and the IM bot, with zero duplication.
 */

import type { YuanbaoBot } from "../../index.js";
import type { ChatMessage } from "../../types.js";
import type { CliProfile } from "../../shared/config.js";
import { getVersion } from "../../version.js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { getGlobalContactStore } from "../../business/contacts.js";
import { homedir } from "node:os";
import { join } from "node:path";

export type RouteContext = {
  bot: YuanbaoBot | null;
  profile: CliProfile;
  startedAt: number;
  pid: number;
  port: number;
  host: string;
  query: Record<string, string>;
  shutdown: () => void;
};

export type RouteResult = { status: number; body: unknown };

const DAEMON_PORT_DEFAULT = 9100;

export async function handleRoute(
  method: string,
  path: string,
  body: Record<string, unknown>,
  ctx: RouteContext,
): Promise<RouteResult> {
  switch (true) {
    case path === "/health" && method === "GET":
      return health(ctx);

    case path === "/status" && method === "GET":
      return status(ctx);

    case path === "/shutdown" && method === "POST":
      return shutdown(ctx);

    case path === "/send/dm" && method === "POST":
      return sendDm(ctx, body);

    case path === "/send/group" && method === "POST":
      return sendGroup(ctx, body);

    case path === "/upload" && method === "POST":
      return upload(ctx, body);

    case path === "/download" && method === "POST":
      return download(ctx, body);

    case path === "/command" && method === "POST":
      return runCommand(ctx, body);

    case path === "/wizard-input" && method === "POST":
      return wizardInput(ctx, body);

    case path === "/wizard-status" && method === "GET":
      return wizardStatus(ctx);

    case path === "/contacts" && method === "GET":
      return listContacts();

    case path === "/completions" && method === "GET":
      return completions(ctx);

    case path === "/commands" && method === "GET":
      return listCommands(ctx);

    case path === "/version" && method === "GET":
      return { status: 200, body: { ok: true, version: getVersion() } };

    default:
      return { status: 404, body: { ok: false, error: `not found: ${method} ${path}` } };
  }
}

// ─── Helpers ───

function requireBot(ctx: RouteContext): YuanbaoBot {
  if (!ctx.bot) throw new Error("bot not initialized");
  return ctx.bot;
}

function requireConnected(ctx: RouteContext): YuanbaoBot {
  const bot = requireBot(ctx);
  if (!bot.getState().connected) {
    throw new Error("bot not connected yet — try again in a moment");
  }
  return bot;
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`missing or invalid field: ${field}`);
  }
  return v;
}

// ─── Routes ───

function health(ctx: RouteContext): RouteResult {
  const bot = ctx.bot;
  const state = bot?.getState() ?? null;
  return {
    status: 200,
    body: {
      ok: true,
      pid: ctx.pid,
      version: getVersion(),
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
      port: ctx.port,
      host: ctx.host,
      bot: state,
    },
  };
}

function status(ctx: RouteContext): RouteResult {
  const bot = requireBot(ctx);
  const state = bot.getState();
  const account = bot.getAccount();
  // Strip sensitive fields
  const safeAccount = {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    apiDomain: account.apiDomain,
    botId: account.botId,
    wsGatewayUrl: account.wsGatewayUrl,
  };
  return {
    status: 200,
    body: {
      ok: true,
      state,
      account: safeAccount,
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
    },
  };
}

function shutdown(ctx: RouteContext): RouteResult {
  // Defer shutdown so we can respond first
  setImmediate(() => ctx.shutdown());
  return { status: 200, body: { ok: true, message: "shutting down" } };
}

async function sendDm(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  const bot = requireConnected(ctx);
  const userId = asString(body.userId, "userId");
  const message = asString(body.message, "message");
  await bot.sendDirectMessage(userId, message);
  return { status: 200, body: { ok: true, sent: { to: userId, length: message.length } } };
}

async function sendGroup(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  const bot = requireConnected(ctx);
  const groupCode = asString(body.groupCode, "groupCode");
  const message = asString(body.message, "message");
  await bot.sendGroupMessage(groupCode, message);
  return { status: 200, body: { ok: true, sent: { to: groupCode, length: message.length } } };
}

async function upload(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  const bot = requireConnected(ctx);
  const filePath = asString(body.filePath, "filePath");
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { status: 400, body: { ok: false, error: `file not found: ${resolved}` } };
  }
  const type = typeof body.type === "string" ? (body.type as "image" | "file" | "video" | "audio") : undefined;
  const result = await bot.uploadMedia(resolved, type);
  return {
    status: 200,
    body: {
      ok: true,
      uuid: result.uuid,
      url: result.url,
      fileSize: result.fileSize,
      mediaType: result.mediaType,
      fileName: result.fileName,
    },
  };
}

async function download(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  // Download doesn't strictly require bot connectivity (it's a plain HTTP fetch),
  // but we keep it daemon-side so the CLI is uniformly thin.
  const url = asString(body.url, "url");
  const dir = typeof body.dir === "string" ? body.dir : undefined;
  const fileName = typeof body.fileName === "string" ? body.fileName : undefined;

  // Lazy-import to avoid pulling in node:fs IO paths at module load
  const { downloadMedia } = await import("../../access/http/media.js");
  const result = await downloadMedia(url, dir, fileName);
  return {
    status: 200,
    body: {
      ok: true,
      filePath: result.filePath,
      fileSize: result.fileSize,
      mediaType: result.mediaType,
      fileName: result.fileName,
    },
  };
}

async function runCommand(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  const bot = requireBot(ctx);
  const text = asString(body.text, "text");
  const cmdSys = bot.getCommandSystem();
  if (!cmdSys) {
    return { status: 500, body: { ok: false, error: "command system disabled" } };
  }

  // If chatMode is dm/group, the dispatcher will see the synthetic message
  // as direct/group respectively — this lets /commands like /contacts work
  // consistently regardless of which mode the caller is in.
  const chatMode = (typeof body.chatMode === "string" ? body.chatMode : "direct") as "direct" | "group";
  const chatTarget = typeof body.chatTarget === "string" ? body.chatTarget : "cli";
  // Source: "cli" (from CLI) or "chat" (from IM). Affects coloring + dmOnly bypass.
  const source = (typeof body.source === "string" && body.source === "cli") ? "cli" : "chat";

  const syntheticMsg: ChatMessage = {
    id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fromUserId: "cli",
    fromNickname: "cli",
    chatType: chatMode,
    text,
    timestamp: Date.now(),
    ...(chatMode === "group" ? { groupCode: chatTarget, groupName: chatTarget } : {}),
  };

  const replies: string[] = [];
  const onReply = async (replyText: string): Promise<void> => {
    replies.push(replyText);
  };

  try {
    const result = await cmdSys.dispatchWithSource(bot, syntheticMsg, onReply, source);
    return {
      status: 200,
      body: {
        ok: true,
        handled: result.handled,
        replies,
        error: result.error?.message,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { ok: false, error: (err as Error).message, replies },
    };
  }
}

function listContacts(): RouteResult {
  const store = getGlobalContactStore({
    persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
    autoSave: true,
  });
  const all = store.getAll("name");
  return {
    status: 200,
    body: {
      ok: true,
      contacts: all.map((c) => ({
        id: c.id,
        name: c.name,
        tag: c.tag,
        favorite: c.favorite,
        notes: c.notes,
      })),
      total: all.length,
    },
  };
}

/**
 * Return raw contact/group/alias data for CLI Tab completion.
 * Saves a round-trip vs. parsing /command output.
 */
function completions(ctx: RouteContext): RouteResult {
  const bot = ctx.bot;
  const contacts = getGlobalContactStore({
    persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
    autoSave: true,
  }).getAll("name").map(c => ({ id: c.id, name: c.name, tag: c.tag }));

  const groups = bot
    ? bot.getGroupStore().getAll("lastActive").map(g => ({
        groupCode: g.groupCode,
        name: g.name ?? g.groupName ?? "",
        tag: g.tag,
      }))
    : [];

  const aliases = bot
    ? bot.getAliasStore().getAll().map(a => ({ alias: a.alias, id: a.id, nickname: a.nickname }))
    : [];

  const commands = bot?.getCommandSystem()?.getVisibleCommands().map(c => ({
    name: c.name,
    aliases: c.aliases ?? [],
    description: c.description,
  })) ?? [];

  return {
    status: 200,
    body: { ok: true, contacts, groups, aliases, commands },
  };
}

/**
 * Handle wizard input from CLI. Checks if user has an active /init or /llm config
 * wizard session and feeds the input to it.
 */
async function wizardInput(ctx: RouteContext, body: Record<string, unknown>): Promise<RouteResult> {
  const bot = requireBot(ctx);
  const cmdSys = bot.getCommandSystem();
  if (!cmdSys) {
    return { status: 500, body: { ok: false, error: "command system disabled" } };
  }
  const userId = typeof body.userId === "string" ? body.userId : "cli";
  const text = typeof body.text === "string" ? body.text : "";

  const cs = cmdSys as unknown as {
    _initWizardSessions?: Map<string, unknown>;
    _handleInitWizardInput?: (bot: unknown, uid: string, txt: string, reply: (t: string) => Promise<void>) => Promise<boolean>;
    _llmWizardSessions?: Map<string, unknown>;
    _handleLlmWizardInput?: (bot: unknown, uid: string, txt: string, reply: (t: string) => Promise<void>) => Promise<boolean>;
  };

  const replies: string[] = [];
  const replyFn = async (t: string): Promise<void> => { replies.push(t); };

  // Check /init wizard
  if (cs._initWizardSessions?.has(userId) && cs._handleInitWizardInput) {
    const handled = await cs._handleInitWizardInput(bot, userId, text, replyFn);
    return { status: 200, body: { ok: true, handled, replies, wizard: "init" } };
  }

  // Check /llm config wizard
  if (cs._llmWizardSessions?.has(userId) && cs._handleLlmWizardInput) {
    const handled = await cs._handleLlmWizardInput(bot, userId, text, replyFn);
    return { status: 200, body: { ok: true, handled, replies, wizard: "llm" } };
  }

  return { status: 200, body: { ok: true, handled: false, replies: [], wizard: null } };
}

/**
 * Check if a user has an active wizard session.
 */
function wizardStatus(ctx: RouteContext): RouteResult {
  const bot = requireBot(ctx);
  const cmdSys = bot.getCommandSystem();
  if (!cmdSys) {
    return { status: 500, body: { ok: false, error: "command system disabled" } };
  }
  const userId = ctx.query.userId ?? "cli";

  const cs = cmdSys as unknown as {
    _initWizardSessions?: Map<string, unknown>;
    _llmWizardSessions?: Map<string, unknown>;
  };

  const hasInit = cs._initWizardSessions?.has(userId) ?? false;
  const hasLlm = cs._llmWizardSessions?.has(userId) ?? false;

  return {
    status: 200,
    body: {
      ok: true,
      active: hasInit || hasLlm,
      wizard: hasInit ? "init" : hasLlm ? "llm" : null,
    },
  };
}

/**
 * List all registered commands for CLI dynamic command generation.
 * Returns name, aliases, description, usage, category, dmOnly, requireConnected.
 */
function listCommands(ctx: RouteContext): RouteResult {
  const bot = ctx.bot;
  const cmdSys = bot?.getCommandSystem();
  if (!cmdSys) {
    return { status: 500, body: { ok: false, error: "command system disabled" } };
  }
  const commands = cmdSys.getVisibleCommands().map(c => ({
    name: c.name,
    aliases: c.aliases ?? [],
    description: c.description,
    usage: c.usage ?? "",
    category: c.category ?? "misc",
    dmOnly: c.dmOnly ?? false,
    requireConnected: c.requireConnected ?? false,
    hidden: c.hidden ?? false,
  }));
  return { status: 200, body: { ok: true, commands } };
}

// Re-exported for client defaults
export { DAEMON_PORT_DEFAULT };
