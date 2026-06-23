/**
 * CLI formatting utilities — colored tables, Markdown→ANSI rendering,
 * and message display.
 *
 * Uses mature libraries:
 *   - cli-table3  — ANSI table rendering with box-drawing chars
 *   - chalk       — ANSI colors
 *   - marked      — Markdown parser (isolated instance, NOT the global one
 *                   used by core's llm-takeover.ts, so terminal rendering
 *                   options don't leak into IM text conversion)
 *   - marked-terminal — Markdown→ANSI renderer extension for marked
 */

import chalk from "chalk";
import Table from "cli-table3";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { ChatMessage } from "@yuanbao-lite/core/types";
import { getMasterUserId, isTrusted } from "@yuanbao-lite/core/business/trust";

// ─── Markdown → ANSI (isolated instance) ───

// CRITICAL: use `new Marked()` instead of the global `marked` singleton.
// The core package's llm-takeover.ts calls `marked.setOptions()` on the
// global instance to convert Markdown→plain text for IM. If we also call
// `marked.use(markedTerminal())` on the global, the terminal renderer
// would corrupt IM text output. An isolated instance keeps the two use
// cases cleanly separated.
//
// NOTE: `marked-terminal` exports `markedTerminal` as a NAMED export.
// The default export is the `Renderer` class — calling it without `new`
// crashes. This was a latent bug in the original code (never triggered
// because renderMarkdownAnsi was never called).
const cliMarked = new Marked();
cliMarked.use(markedTerminal());

/**
 * Render Markdown text as ANSI for CLI display.
 * Pre-colors @[nick](id) mentions so they survive Markdown parsing.
 */
export async function renderMarkdownAnsi(text: string): Promise<string> {
  const colored = colorizeMentions(text);
  try {
    return cliMarked.parse(colored, { async: false }) as string;
  } catch {
    return colored;
  }
}

// ─── ANSI table (cli-table3) ───

/**
 * Format data as a colored CLI table (cli-table3 + chalk).
 * Registered on the daemon's CommandSystem via setTableFormatter() so
 * that `outputMode: "ansi"` produces real ANSI tables instead of
 * falling back to Markdown tables.
 */
export function formatCliTable(headers: string[], rows: string[][]): string {
  const table = new Table({
    head: headers.map((h) => chalk.bold.cyan(h)),
    style: { head: [], border: ["grey"], compact: false },
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });
  for (const row of rows) {
    table.push(row.map((cell) => colorizeCell(cell)));
  }
  return table.toString();
}

function colorizeCell(cell: string): string {
  if (cell === "✅" || cell === "是") return chalk.green(cell);
  if (cell === "❌" || cell === "否") return chalk.red(cell);
  if (cell === "仅私聊") return chalk.yellow(cell);
  if (cell === "⭐") return chalk.yellow(cell);
  if (cell.startsWith("→")) return chalk.cyan(cell);
  return cell;
}

// ─── User type colors ───

/** Yuanbao's ID that gets green color */
const YUANBAO_ID = "szUvRH8s4ekettawNjDREmAG4W7h+Lhb8Sy9tq/otZU=";

/**
 * Get colored user type label based on userId.
 * - Master (bot owner): purple
 * - Yuanbao (platform bot): green
 * - Lobster (bot_ prefix): magenta
 * - Trusted User: yellow
 * - Human: cyan (default)
 */
export function userTypeLabel(userId: string): string {
  if (userId === getMasterUserId()) return chalk.magenta(" 👑 主人");
  if (userId === YUANBAO_ID) return chalk.green(" 🤖 元宝");
  if (userId.startsWith("bot_")) return chalk.red(" 🦞 龙虾");
  if (isTrusted(userId)) return chalk.yellow(" 🔑 受信任用户");
  return chalk.cyan(" 👤 普通用户");
}

/**
 * Get colored nickname based on userId.
 */
export function coloredName(userId: string, nickname: string): string {
  if (userId === getMasterUserId()) return chalk.magenta.bold(nickname);
  if (userId === YUANBAO_ID) return chalk.green.bold(nickname);
  if (userId.startsWith("bot_")) return chalk.red(nickname);
  return chalk.yellow(nickname);
}

// ─── Message rendering ───

/**
 * Pre-process @[]() mention syntax to add color before Markdown rendering.
 * Converts @[nick](id) to a colored inline code span so marked-terminal
 * doesn't strip it.
 *
 * Wraps coloredName() in try/catch — if the trust store isn't initialized
 * (e.g. during early daemon startup), falls back to a plain cyan mention
 * instead of crashing.
 */
function colorizeMentions(text: string): string {
  return text.replace(
    /@\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, nickname: string, userId: string) => {
      try {
        return chalk.cyan(`@${coloredName(userId, nickname)}`);
      } catch {
        return chalk.cyan(`@${nickname}`);
      }
    },
  );
}

/**
 * Format a message for CLI display.
 *
 * Unified for both inbound and outbound messages — the only difference is
 * the direction icon (📨 inbound vs 📤 outbound) and the sender (the remote
 * user for inbound, the bot itself for outbound).
 *
 * Format:
 *   📨  群名 / 昵称 👤 类型 @我 ⚡命令 · 11:45:14   (inbound)
 *       消息文本
 *
 *   📤  群名 / bot 👤 类型 · 11:45:14               (outbound)
 *       消息文本
 *
 * @param msg - The chat message (inbound from remote user, or outbound from bot)
 * @param isGroup - Whether this is a group message
 * @param direction - "inbound" or "outbound"
 */
export function formatMessage(
  msg: ChatMessage,
  isGroup: boolean,
  direction: "inbound" | "outbound" = "inbound",
): string {
  const time = chalk.dim(formatTime(msg.timestamp));
  const name = msg.fromNickname || msg.fromUserId;
  let typeLabel = "";
  let nick = name;
  try {
    typeLabel = userTypeLabel(msg.fromUserId);
    nick = coloredName(msg.fromUserId, name);
  } catch {
    // Trust store not initialized — use plain names
    nick = chalk.yellow(name);
  }

  // Direction icon
  const icon = direction === "outbound" ? chalk.magenta("📤") : "";
  const dirLabel = direction === "outbound" ? chalk.magenta("出站") : "";

  // Inbound-only marks (outbound messages don't have @mention or command tags)
  const mentionMark =
    direction === "inbound" && msg.isMentioned ? chalk.yellow(" @我") : "";

  const hasAttachment =
    msg.text &&
    (msg.text.includes("[image:") ||
      msg.text.includes("[file:") ||
      msg.text.includes("[video:") ||
      msg.text.includes("[voice:") ||
      msg.text.includes("[附件:"));
  const attachMark = hasAttachment ? chalk.blue(" 📎") : "";

  const hasContent = msg.text && msg.text.includes("[content:");
  const contentMark = hasContent ? chalk.cyan(" 📄") : "";

  // Detect inbound slash commands — show with a ⚡ 命令 tag (yellow),
  // placed AFTER the @mention tag so the order is: type · @我 · ⚡ 命令
  //
  // IMPORTANT: strip trigger tags (<<command>>...<<command>>, <<sticker>>...,
  // <<quote>>..., <<break>>) before checking for /. These tags are LLM
  // output markers, not commands — a message like "<<sticker>>狗头<<sticker>>"
  // should NOT be tagged as a command. The rule mirrors the dispatch logic
  // in llm-takeover.ts which strips these tags before processing.
  const cleanText = (msg.text ?? "")
    .replace(/<<command>>.*?<<command>>\.\.\.?/g, "")
    .replace(/<<sticker>>.*?<<sticker>>/g, "")
    .replace(/<<quote>>.*?<<quote>>/g, "")
    .replace(/<<break>>/g, "")
    .trim();
  const isCommand = direction === "inbound" && cleanText.startsWith("/");
  const commandMark = isCommand ? chalk.yellow(" ⚡ 命令") : "";

  let header: string;
  if (isGroup) {
    const group = chalk.cyan(msg.groupName || msg.groupCode || "?");
    if (direction === "outbound") {
      header = `  ${icon} ${dirLabel}  ${chalk.dim("→")}  ${group} ${chalk.dim("/")} ${nick} ${chalk.dim("·")} ${time}`;
    } else {
      header = `  ${chalk.green("群")}  ${group} ${chalk.dim("/")} ${nick}${typeLabel}${mentionMark}${commandMark}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
    }
  } else {
    if (direction === "outbound") {
      header = `  ${icon} ${dirLabel}  ${chalk.dim("→")}  ${chalk.dim("私聊")} ${nick} ${chalk.dim("·")} ${time}`;
    } else {
      header = `  ${chalk.cyan("私")}  ${nick}${typeLabel}${commandMark}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
    }
  }
  const body = `      ${msg.text || "(非文本)"}`;
  return `${header}\n${body}`;
}

/**
 * Format an inbound message for CLI display.
 * (Backward-compat wrapper around formatMessage.)
 */
export function formatInboundMessage(
  msg: ChatMessage,
  isGroup: boolean,
): string {
  return formatMessage(msg, isGroup, "inbound");
}

/**
 * Format a bot outbound message for CLI display.
 * (Backward-compat wrapper around formatMessage.)
 * Accepts a ChatMessage directly (unified with inbound), or the legacy
 * {text, to, isGroup} shape via the nameResolver overload.
 */
export function formatOutboundMessage(
  msgOrText: ChatMessage | string,
  to?: string,
  isGroup?: boolean,
  nameResolver?: (to: string, isGroup: boolean) => string | undefined,
): string {
  // If first arg is a ChatMessage, use the unified path
  if (typeof msgOrText === "object" && msgOrText !== null) {
    return formatMessage(msgOrText, msgOrText.chatType === "group", "outbound");
  }
  // Legacy {text, to, isGroup} shape — build a synthetic ChatMessage
  const text = msgOrText as string;
  const target = to ?? "";
  const group = isGroup ?? false;
  const resolvedName = nameResolver?.(target, group);
  const syntheticMsg: ChatMessage = {
    id: `bot-outbound-${Date.now()}`,
    fromUserId: "bot",
    fromNickname: resolvedName ?? target,
    chatType: group ? "group" : "direct",
    ...(group ? { groupCode: target, groupName: resolvedName } : {}),
    text,
    timestamp: Date.now(),
  };
  return formatMessage(syntheticMsg, group, "outbound");
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
