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
 * Format an inbound message for CLI display.
 * Two-line layout (header + body).
 *
 * Format:
 *   私  昵称 👤 类型 · 11:45:14
 *       消息文本
 *
 *   群  群名 / 昵称 👤 类型 @我 · 11:45:14
 *       消息文本
 */
export function formatInboundMessage(
  msg: ChatMessage,
  isGroup: boolean,
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
  const mentionMark = msg.isMentioned ? chalk.yellow(" @我") : "";

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
  const isCommand = msg.text && msg.text.trim().startsWith("/");
  const commandMark = isCommand ? chalk.yellow(" ⚡ 命令") : "";

  let header: string;
  if (isGroup) {
    const group = chalk.cyan(msg.groupName || msg.groupCode || "?");
    header = `  ${chalk.green("群")}  ${group} ${chalk.dim("/")} ${nick}${typeLabel}${mentionMark}${commandMark}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
  } else {
    header = `  ${chalk.cyan("私")}  ${nick}${typeLabel}${commandMark}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
  }
  const body = `      ${msg.text || "(非文本)"}`;
  return `${header}\n${body}`;
}

/**
 * Format a bot outbound message for CLI display.
 * Resolves the target to a group name or user name (via the provided stores)
 * instead of showing a raw group code or user ID.
 *
 * Format:
 *   📤出站  →  群名/昵称 · 11:45:14
 *       消息文本
 *
 * @param text - Message text
 * @param to - Target (group code or user ID)
 * @param isGroup - Whether this is a group message
 * @param nameResolver - Optional resolver that returns a display name for the target
 */
export function formatOutboundMessage(
  text: string,
  to: string,
  isGroup: boolean,
  nameResolver?: (to: string, isGroup: boolean) => string | undefined,
): string {
  const time = chalk.dim(formatTime(Date.now()));
  // Try to resolve a friendly name; fall back to the raw target.
  const resolvedName = nameResolver?.(to, isGroup);
  const displayTarget = resolvedName ?? to;
  const scope = isGroup
    ? chalk.cyan(`群 ${displayTarget}`)
    : chalk.dim(`私聊 ${displayTarget}`);
  const header = `  ${chalk.magenta("📤 出站")}  ${chalk.dim("→")}  ${scope} ${chalk.dim("·")} ${time}`;
  const displayText =
    text.length > 500 ? text.substring(0, 500) + chalk.dim("...") : text;
  const body = `      ${displayText}`;
  return `${header}\n${body}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
