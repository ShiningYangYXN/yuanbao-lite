/**
 * CLI formatting utilities — colored tables and message rendering.
 *
 * Uses cli-table3 for tables, chalk for colors, marked-terminal for
 * Markdown→ANSI rendering.
 */

import chalk from "chalk";
import Table from "cli-table3";
import { marked } from "marked";
import markedTerminal from "marked-terminal";
import type { ChatMessage } from "../../types.js";

// Configure marked to use marked-terminal for ANSI rendering
marked.use(markedTerminal());

/**
 * Format data as a colored CLI table (cli-table3 + chalk).
 */
export function formatCliTable(headers: string[], rows: string[][]): string {
  const table = new Table({
    head: headers.map(h => chalk.bold.cyan(h)),
    style: { head: [], border: ["grey"], compact: false },
    chars: {
      "top": "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
      "bottom": "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
      "left": "│", "left-mid": "├", "mid": "─", "mid-mid": "┼",
      "right": "│", "right-mid": "┤", "middle": "│",
    },
  });
  for (const row of rows) {
    table.push(row.map(cell => colorizeCell(cell)));
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

/** Special user ID that gets green color */
const GREEN_USER_ID = "szUvRH8s4ekettawNjDREmAG4W7h+Lhb8Sy9tq/otZU=";

/**
 * Get colored user type label based on userId.
 * - Master (bot owner): purple
 * - Green user (special ID): green
 * - Bot (bot_ prefix): magenta
 * - Human: yellow (default)
 * - Lobster (userType 3): red
 */
export function userTypeLabel(userId: string, userType?: number, isMaster?: boolean): string {
  if (isMaster) return chalk.magenta("👑主人");
  if (userId === GREEN_USER_ID) return chalk.green("🟢特殊");
  if (userId.startsWith("bot_")) {
    if (userType === 3) return chalk.red("🦐龙虾");
    return chalk.magenta("🤖BOT");
  }
  return chalk.yellow("👤用户");
}

/**
 * Get colored nickname based on userId.
 */
export function coloredName(userId: string, nickname: string, userType?: number, isMaster?: boolean): string {
  if (isMaster) return chalk.magenta.bold(nickname);
  if (userId === GREEN_USER_ID) return chalk.green.bold(nickname);
  if (userId.startsWith("bot_")) {
    if (userType === 3) return chalk.red(nickname);
    return chalk.magenta(nickname);
  }
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
  return text.replace(/@\[([^\]]*)\]\(([^)]+)\)/g, (_match, nick, id) => {
    const nickStr = String(nick);
    const idStr = String(id);
    // Color the @ prefix and nick based on id
    if (idStr === GREEN_USER_ID) {
      return chalk.green.bold(`@${nickStr}`);
    }
    if (idStr.startsWith("bot_")) {
      return chalk.magenta(`@${nickStr}`);
    }
    return chalk.cyan(`@${nickStr}`);
  });
}

/**
 * Render Markdown text as ANSI for CLI display.
 * Uses marked-terminal for rendering, with @[]() mentions pre-colored.
 */
export function renderMarkdownAnsi(text: string): string {
  const colored = colorizeMentions(text);
  try {
    return marked.parse(colored) as string;
  } catch {
    return colored;
  }
}

/**
 * Format an inbound message for CLI display with user type colors.
 */
export function formatInboundMessage(
  msg: ChatMessage,
  isGroup: boolean,
  isMaster?: boolean,
): string {
  const time = formatTime(msg.timestamp);
  const name = msg.fromNickname || msg.fromUserId;
  const typeLabel = userTypeLabel(msg.fromUserId, undefined, isMaster);
  const coloredNick = coloredName(msg.fromUserId, name, undefined, isMaster);
  const scope = isGroup
    ? chalk.cyan(`@${msg.groupName || msg.groupCode || "?"}`)
    : chalk.dim("@DM");
  const mentionMark = msg.isMentioned ? chalk.yellow(" @") : "";
  const header = chalk.dim(`[${time}]`) + ` ${typeLabel} ${coloredNick} ${scope}${mentionMark}`;
  const body = `  ${msg.text || "(非文本)"}`;
  return `${header}\n${body}`;
}

/**
 * Format a bot outbound message for CLI display.
 */
export function formatOutboundMessage(text: string, to: string, isGroup: boolean): string {
  const time = formatTime(Date.now());
  const scope = isGroup ? chalk.cyan(`@${to}`) : chalk.dim("@DM");
  const header = chalk.dim(`[${time}]`) + ` ${chalk.magenta("📤BOT")} → ${scope}`;
  const body = `  ${text.substring(0, 200)}${text.length > 200 ? "..." : ""}`;
  return `${header}\n${body}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n < 10 ? `0${n}` : String(n);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
