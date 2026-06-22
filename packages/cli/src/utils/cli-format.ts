/**
 * CLI formatting utilities — colored tables and message rendering.
 *
 * Uses cli-table3 for tables, chalk for colors, marked-terminal for
 * Markdown→ANSI rendering.
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { ChatMessage } from "@yuanbao-lite/core/types";
import { getMasterUserId, isTrusted } from "@yuanbao-lite/core/business/trust";

// Lazy-load marked + marked-terminal to avoid compatibility issues at import time
let _markedReady = false;
let _parse: ((text: string) => string) | null = null;
async function ensureMarked(): Promise<(text: string) => string> {
  if (!_markedReady) {
    const { marked } = await import("marked");
    const markedTerminal = (await import("marked-terminal")).default;
    marked.use(markedTerminal());
    _parse = (text: string) => marked.parse(text) as string;
    _markedReady = true;
  }
  return _parse!;
}

/**
 * Format data as a colored CLI table (cli-table3 + chalk).
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
 */
function colorizeMentions(text: string): string {
  // Replace @[nick](id) with colored version
  return text.replace(
    /@\[([^\]]*)\]\(([^)]+)\)/g,
    (_match, nickname, userId) => {
      return chalk.cyan(`@${coloredName(userId, nickname)}`);
    },
  );
}

/**
 * Render Markdown text as ANSI for CLI display.
 * Uses marked-terminal for rendering, with @[]() mentions pre-colored.
 */
export async function renderMarkdownAnsi(text: string): Promise<string> {
  const colored = colorizeMentions(text);
  try {
    const parse = await ensureMarked();
    return parse(colored) as string;
  } catch {
    return colored;
  }
}

/**
 * Format an inbound message for CLI display.
 * Two-line layout (header + body), inspired by the old format but with
 * more slots: type label, nickname, group/scope, mention mark, time, text.
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
  isMaster?: boolean,
): string {
  const time = chalk.dim(formatTime(msg.timestamp));
  const name = msg.fromNickname || msg.fromUserId;
  const typeLabel = userTypeLabel(msg.fromUserId);
  const nick = coloredName(msg.fromUserId, name);
  const mentionMark = msg.isMentioned ? chalk.yellow(" @我") : "";

  // Detect attachments in text
  const hasAttachment =
    msg.text &&
    (msg.text.includes("[image:") ||
      msg.text.includes("[file:") ||
      msg.text.includes("[video:") ||
      msg.text.includes("[voice:") ||
      msg.text.includes("[附件:"));
  const attachMark = hasAttachment ? chalk.blue(" 📎") : "";

  // Detect content references
  const hasContent = msg.text && msg.text.includes("[content:");
  const contentMark = hasContent ? chalk.cyan(" 📄") : "";

  let header: string;
  if (isGroup) {
    const group = chalk.cyan(msg.groupName || msg.groupCode || "?");
    header = `  ${chalk.green("群")}  ${group} ${chalk.dim("/")} ${nick}${typeLabel}${mentionMark}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
  } else {
    header = `  ${chalk.cyan("私")}  ${nick}${typeLabel}${attachMark}${contentMark} ${chalk.dim("·")} ${time}`;
  }
  const body = `      ${msg.text || "(非文本)"}`;
  return `${header}\n${body}`;
}

/**
 * Format a bot outbound message for CLI display.
 * Format:
 *   📤出站  →  群名/DM · 11:45:14
 *       消息文本
 */
export function formatOutboundMessage(
  text: string,
  to: string,
  isGroup: boolean,
): string {
  const time = chalk.dim(formatTime(Date.now()));
  const scope = isGroup ? chalk.cyan(`群${to}`) : chalk.dim(`私聊`);
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
