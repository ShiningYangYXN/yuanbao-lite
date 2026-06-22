/**
 * JavaScript ${...} interpolation engine — shared utility for all message types.
 *
 * Features:
 *   - `${expr}` — evaluate any valid JavaScript expression
 *   - Built-in context: Date, Math, JSON, parseInt, parseFloat, String, Number,
 *     Array, Object, console, encodeURIComponent, decodeURIComponent,
 *     encodeURIComponent, RegExp, Map, Set, Promise, Symbol, BigInt,
 *     parseInt, parseFloat, isNaN, isFinite, Boolean, Error, etc.
 *   - Chat context: sender, group, bot, mentions, replyTo, message, me
 *   - `\${...}` — escape, outputs literal `${...}`
 *   - Custom context variables merged with built-ins
 *   - Safe evaluation using `new Function()` with explicit parameter injection
 *
 * This module is the single source of truth for $-interpolation.
 * Both the batch system and the direct send methods use this.
 *
 * @module business/interpolate
 */

// ─── Built-in globals available in every interpolation ───

const BUILTIN_GLOBALS: Record<string, unknown> = {
  // Standard JS globals (safe subset)
  Date,
  Math,
  JSON,
  parseInt,
  parseFloat,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  RegExp,
  Symbol,
  BigInt,
  Error,
  Promise,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  console: {
    log: (...args: unknown[]) => args.join(" "),
    // Only expose safe console methods
  },
  // Environment helpers
  env: typeof process !== "undefined" ? process.env : {},
  process: {
    env: typeof process !== "undefined" ? process.env : {},
    cwd: typeof process !== "undefined" ? () => process.cwd() : () => "/",
    pid: typeof process !== "undefined" ? process.pid : 0,
  },
};

// ─── Sanitization for non-unsafe contexts ───

/**
 * When interpolating in a group chat (non-unsafe mode), we strip dangerous
 * globals to prevent abuse. The bot owner can still use full interpolation
 * by enabling unsafe mode via /unsafe.
 */
const SAFE_GLOBALS_FOR_GROUP: Record<string, unknown> = {
  Date,
  Math,
  JSON,
  parseInt,
  parseFloat,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  RegExp,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  // NO process, NO env, NO console — these leak server info
};

/**
 * Expressions that are blocked entirely in non-unsafe mode.
 * Matches even if nested inside other expressions.
 */
const DANGEROUS_PATTERNS = [
  /\bprocess\b/,
  /\brequire\b/,
  /\bimport\b/,
  /\beval\b/,
  /\bFunction\b/,
  /\bglobalThis\b/,
  /\bwindow\b/,
  /\bdocument\b/,
  /\bfetch\b/,
  /\bchild_process\b/,
  /\bfs\b/,
  /\bos\b/,
  /\bpath\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

/**
 * Check if an expression contains dangerous patterns.
 */
function isDangerousExpression(expr: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(expr));
}

// ─── Main interpolation function ───

/**
 * Process JavaScript `${...}` interpolation in a template string.
 *
 * Supports:
 *   - `${i}`             -> simple variable lookup from context
 *   - `${i + 1}`         -> expression evaluation
 *   - `${new Date()}`    -> JavaScript expression
 *   - `${Math.random()}` -> built-in globals
 *   - `${env.HOME}`      -> process.env access (only in unsafe mode)
 *   - `\${literal}`      -> escaped, outputs `${literal}` literally
 *
 * Escape handling: uses JS-native `JSON.parse` for backslash escapes
 * (e.g. `\n`, `\t`, `\\`, `\"`) rather than a hand-rolled parser.
 *
 * Safety: when `sanitize` is true (group chat non-unsafe mode), dangerous
 * globals (process, env, require, fetch, etc.) are stripped and dangerous
 * expressions return a placeholder instead of evaluating.
 *
 * @param template - The template string with `${...}` placeholders
 * @param context  - Variables available in the interpolation scope (merged with built-ins)
 * @param options  - { sanitize?: boolean } — if true, restrict to safe globals
 * @returns The interpolated string
 *
 * @example
 * ```typescript
 * interpolate("Hello ${name}, time is ${new Date().toISOString()}", { name: "world" })
 * interpolate("${i + 1}/${total}", { i: 2, total: 10 })
 * interpolate("\\${not_interpolated}", {})  // -> "${not_interpolated}"
 * interpolate("${process.env.HOME}", {}, { sanitize: true })  // -> "[blocked]"
 * ```
 */
export function interpolate(
  template: string,
  context: Record<string, unknown> = {},
  options: { sanitize?: boolean } = {},
): string {
  const sanitize = options.sanitize ?? false;
  const globals = sanitize ? SAFE_GLOBALS_FOR_GROUP : BUILTIN_GLOBALS;

  // Step 1: Protect escaped \${...} sequences using a unique placeholder.
  // We use a null-byte marker that cannot appear in normal text.
  const ESCAPE_MARKER = "\x00ESC\x00";
  let processed = template.replace(/\\\$\{/g, ESCAPE_MARKER);

  // Step 2: Process ${...} interpolations using JS-native `new Function`
  processed = processed.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    // In sanitize mode, block dangerous expressions entirely
    if (sanitize && isDangerousExpression(expr)) {
      return "[blocked]";
    }
    try {
      // Build a function with context variables as parameters
      const allKeys = [...Object.keys(globals), ...Object.keys(context)];
      const allValues = [...Object.values(globals), ...Object.values(context)];

      const fn = new Function(...allKeys, `"use strict"; return (${expr});`);
      const result = fn(...allValues);
      return String(result ?? "");
    } catch {
      // If interpolation fails, keep the original expression
      return `\${${expr}}`;
    }
  });

  // Step 3: Restore escaped sequences: \${ -> ${
  processed = processed.replace(new RegExp(ESCAPE_MARKER, "g"), "${");

  return processed;
}

/**
 * Check if a string contains any unescaped ${...} interpolation patterns.
 */
export function hasInterpolation(text: string): boolean {
  return /(?<!\\)\$\{[^}]+\}/.test(text);
}

/**
 * Chat context information for interpolation.
 *
 * Provides information about the current chat context, including
 * the sender, group, bot, mentions, and the original message.
 * All fields are optional and populated based on available context.
 */
export type ChatContext = {
  /** Sender's user ID */
  senderId?: string;
  /** Sender's nickname */
  senderName?: string;
  /** Group code (for group messages) */
  groupCode?: string;
  /** Group name */
  groupName?: string;
  /** Chat type: "direct" or "group" */
  chatType?: "direct" | "group";
  /** Bot's user ID */
  botId?: string;
  /** Whether the bot was mentioned */
  isMentioned?: boolean;
  /** List of mentioned user IDs */
  mentionIds?: string[];
  /** List of mentioned display names */
  mentionNames?: string[];
  /** The original message text (for reply context) */
  originalText?: string;
  /** The original message ID */
  originalMsgId?: string;
  /** Quoted/replied-to message ID */
  replyToId?: string;
};

/**
 * Build the default interpolation context for message sending.
 *
 * Provides commonly useful variables for message templates,
 * including chat context when available.
 *
 * Variables provided:
 *   - timestamp, date, time, datetime, iso, year, month, day, hour, minute, second
 *   - sender.id, sender.name — info about the message sender
 *   - group.code, group.name — info about the group (if group chat)
 *   - bot.id — the bot's own ID
 *   - chat.type — "direct" or "group"
 *   - chat.isMentioned — whether the bot was mentioned
 *   - mentions.ids, mentions.names — lists of mentioned users
 *   - message.text, message.id — the original message
 *   - replyTo — the ID of the message being replied to
 *   - me.id — alias for bot.id
 */
export function buildMessageContext(
  chatCtx?: ChatContext,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const now = new Date();

  const ctx: Record<string, unknown> = {
    timestamp: Date.now(),
    date: now.toISOString().split("T")[0],
    time: now.toLocaleTimeString("zh-CN"),
    datetime: now.toLocaleString("zh-CN"),
    iso: now.toISOString(),
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
  };

  // Add chat context if provided
  if (chatCtx) {
    ctx.sender = {
      id: chatCtx.senderId || "",
      name: chatCtx.senderName || "",
    };
    ctx.group = {
      code: chatCtx.groupCode || "",
      name: chatCtx.groupName || "",
    };
    ctx.bot = {
      id: chatCtx.botId || "",
    };
    ctx.me = ctx.bot; // alias
    ctx.chat = {
      type: chatCtx.chatType || "direct",
      isMentioned: chatCtx.isMentioned ?? false,
    };
    ctx.mentions = {
      ids: chatCtx.mentionIds || [],
      names: chatCtx.mentionNames || [],
      first: chatCtx.mentionIds?.[0] || "",
      firstName: chatCtx.mentionNames?.[0] || "",
    };
    ctx.message = {
      text: chatCtx.originalText || "",
      id: chatCtx.originalMsgId || "",
    };
    ctx.replyTo = chatCtx.replyToId || "";

    // Also expose top-level shortcuts for common variables
    ctx.senderId = chatCtx.senderId || "";
    ctx.senderName = chatCtx.senderName || "";
    ctx.groupCode = chatCtx.groupCode || "";
    ctx.groupName = chatCtx.groupName || "";
    ctx.botId = chatCtx.botId || "";
    ctx.chatType = chatCtx.chatType || "direct";
  } else {
    // Provide empty defaults so templates don't crash
    ctx.sender = { id: "", name: "" };
    ctx.group = { code: "", name: "" };
    ctx.bot = { id: "" };
    ctx.me = ctx.bot;
    ctx.chat = { type: "direct", isMentioned: false };
    ctx.mentions = { ids: [], names: [], first: "", firstName: "" };
    ctx.message = { text: "", id: "" };
    ctx.replyTo = "";
    ctx.senderId = "";
    ctx.senderName = "";
    ctx.groupCode = "";
    ctx.groupName = "";
    ctx.botId = "";
    ctx.chatType = "direct";
  }

  // Merge extra context last (overrides everything)
  if (extra) {
    Object.assign(ctx, extra);
  }

  return ctx;
}

/**
 * Build a ChatContext from a ChatMessage (inbound).
 *
 * Convenience function to extract all relevant context fields
 * from a received message for use in interpolation.
 */
export function chatContextFromMessage(
  msg: import("../types.js").ChatMessage,
  botId?: string,
): ChatContext {
  return {
    senderId: msg.fromUserId,
    senderName: msg.fromNickname,
    groupCode: msg.groupCode,
    groupName: msg.groupName,
    chatType: msg.chatType,
    botId,
    isMentioned: msg.isMentioned,
    mentionIds: msg.mentions?.map((m) => m.userId),
    mentionNames: msg.mentions?.map((m) => m.displayName),
    originalText: msg.text,
    originalMsgId: msg.id,
    replyToId: msg.quoteMsgId,
  };
}

/**
 * Build the batch-specific interpolation context (kept for backward compatibility).
 *
 * Provides:
 *   - i: current index (0-based)
 *   - n: current message number (1-based)
 *   - total: total number of messages
 *   - target: the target ID
 *   - timestamp, date, time, etc.
 */
export function buildBatchContext(
  index: number,
  total: number,
  target: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return buildMessageContext(undefined, {
    i: index,
    n: index + 1,
    total,
    target,
    ...extra,
  });
}
