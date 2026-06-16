/**
 * Auto-generated colored help text for Yuanbao Lite.
 *
 * Builds formatted help output by scanning command definitions, grouping
 * them by category, and applying chalk coloring. This replaces the
 * static HELP_TEXT constant so commands added/removed/updated
 * automatically appear correctly in help output.
 *
 * @module commands/help-text
 */

import chalk from "chalk";
import type { CommandDefinition, CommandCategory } from "./types.js";

// ─── Category metadata ───

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  chat: "💬 聊天命令",
  media: "📎 媒体与文件",
  contact: "👥 联系人管理",
  group: "🏠 群聊管理",
  alias: "🏷️ 别名系统",
  history: "📜 消息历史",
  sticker: "🎭 贴纸浏览",
  batch: "📤 批量发送",
  system: "⚙️ 系统命令",
  "multi-account": "🔑 多账号管理",
  llm: "🤖 LLM 接管",
  misc: "ℹ️ 信息与控制",
};

const CATEGORY_ORDER: CommandCategory[] = [
  "chat",
  "media",
  "contact",
  "group",
  "alias",
  "history",
  "sticker",
  "batch",
  "system",
  "multi-account",
  "llm",
  "misc",
];

// ─── Colors ───

const CMD_NAME_COLOR = chalk.rgb(100, 200, 255).bold; // cyan-blue
const ALIAS_COLOR = chalk.dim.gray;
const DESC_COLOR = chalk.rgb(200, 210, 230);          // light gray
const CATEGORY_COLOR = chalk.rgb(160, 140, 255);       // soft purple
const USAGE_COLOR = chalk.rgb(120, 180, 120);          // green
const FOOTER_COLOR = chalk.dim;

// ─── CLI box helpers (pure ANSI strings, no width assumption) ───

const BOX = {
  topLeft: "╭",
  topRight: "╮",
  headerLeft: "├",
  headerRight: "┤",
  bodyLeft: "│",
  bodyRight: "│",
  footerLeft: "╰",
  footerRight: "╯",
  divider: "─",
  pad: " ",
};

function padRight(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + BOX.pad.repeat(width - text.length);
}

function coloredBox(lines: string[], width: number): string {
  if (width < 10) width = 80;
  const parts: string[] = [];

  // Top border
  parts.push(
    BOX.topLeft + BOX.divider.repeat(width - 2) + BOX.topRight,
  );

  for (const line of lines) {
    parts.push(BOX.bodyLeft + padRight(line, width - 2) + BOX.bodyRight);
  }

  // Bottom border
  parts.push(
    BOX.footerLeft + BOX.divider.repeat(width - 2) + BOX.footerRight,
  );

  return parts.join("\n");
}

// ─── Main generation ───

/**
 * Generate a colored help string from an array of command definitions.
 * Commands are grouped by category, sorted, and formatted with syntax highlighting.
 *
 * @param commands - The list of visible command definitions
 * @param options - Display options
 * @returns A chalk-colored string ready for console output or IM sending
 */
export function generateColoredHelp(
  commands: CommandDefinition[],
  options: {
    prefix?: string;
    footer?: string;
    version?: string;
    showUsage?: boolean;
    width?: number;
  } = {},
): string {
  const prefix = options.prefix ?? "/";
  const footer = options.footer ?? `输入 ${prefix}help <命令名> 查看详细用法`;

  // Group commands by category
  const groups = new Map<CommandCategory, CommandDefinition[]>();
  const uncategorized: CommandDefinition[] = [];

  for (const cmd of commands) {
    const cat = cmd.category ?? "misc";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(cmd);
  }

  // Sort commands within each group
  for (const cmds of groups.values()) {
    cmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  const maxW = options.width ?? 88;

  // ── Welcome header ──
  const versionLine = options.version
    ? `Yuanbao Lite 交互式客户端 v${options.version}`
    : "Yuanbao Lite 交互式客户端";
  const welcomeLines = [
    `${CATEGORY_COLOR.bold(versionLine)}`,
  ];
  const welcomeWidth = Math.max(padRight(welcomeLines[0], 0).length, 50);

  // General flags info
  const flagHint = `${FOOTER_COLOR("--all / -a  取消输出截断，显示全部结果")}`;
  welcomeLines.push(flagHint);
  const boxContentWidth = Math.min(Math.max(welcomeWidth, maxW), maxW);
  const welcomeBox = coloredBox(welcomeLines, boxContentWidth);

  // ── Per-category sections ──
  const bodyLines: string[] = [];

  for (const cat of CATEGORY_ORDER) {
    const cmds = groups.get(cat);
    if (!cmds || cmds.length === 0) continue;

    const catLabel = CATEGORY_LABELS[cat];
    if (!catLabel) continue;

    // Category header row:  │  📎 媒体与文件  │
    const catRow = `${CATEGORY_COLOR.bold(catLabel)}`;
    bodyLines.push(catRow);

    for (const cmd of cmds) {
      const cmdName = `${prefix}${cmd.name}`;
      const aliases = cmd.aliases?.length ? ` ${ALIAS_COLOR(`(${cmd.aliases.join(", ")})`)}` : "";
      const desc = `${DESC_COLOR(cmd.description)}`;

      // Format: /command [aliases] — description
      const line = `  ${CMD_NAME_COLOR(cmdName)}${aliases}  ${desc}`;
      bodyLines.push(line);

      // Optional usage
      if (options.showUsage && cmd.usage) {
        bodyLines.push(`    ${USAGE_COLOR(cmd.usage)}`);
      }
    }

    bodyLines.push(""); // blank line between sections
  }

  // ── Footer ──
  bodyLines.push(FOOTER_COLOR(footer));

  // Join body lines
  const body = bodyLines.join("\n");

  // Calculate box width from body
  const bodyLinesArr = body.split("\n");
  let measuredWidth = 50;
  for (const l of bodyLinesArr) {
    measuredWidth = Math.max(measuredWidth, l.length);
  }
  const finalWidth = Math.min(Math.max(measuredWidth + 4, 60), maxW);

  // Combine
  const paddedBody = bodyLinesArr.map(l => padRight(l, finalWidth - 2));
  return welcomeBox + "\n" + coloredBox(paddedBody, finalWidth);
}

/**
 * Generate a plain-text (monochrome) help string for environments without color support.
 */
export function generatePlainHelp(
  commands: CommandDefinition[],
  options: {
    prefix?: string;
    footer?: string;
    version?: string;
    showUsage?: boolean;
    width?: number;
  } = {},
): string {
  const prefix = options.prefix ?? "/";
  const footer = options.footer ?? `输入 ${prefix}help <命令名> 查看详细用法`;

  const groups = new Map<CommandCategory, CommandDefinition[]>();
  const uncategorized: CommandDefinition[] = [];

  for (const cmd of commands) {
    const cat = cmd.category ?? "misc";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(cmd);
  }

  for (const cmds of groups.values()) {
    cmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines: string[] = [];
  const versionStr = options.version ? `Yuanbao Lite v${options.version}` : "Yuanbao Lite";
  lines.push(versionStr);
  lines.push("");

  for (const cat of CATEGORY_ORDER) {
    const cmds = groups.get(cat);
    if (!cmds || cmds.length === 0) continue;

    lines.push(`[${CATEGORY_LABELS[cat] || cat}]`);
    for (const cmd of cmds) {
      const aliasStr = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
      lines.push(`  ${prefix}${cmd.name}${aliasStr} — ${cmd.description}`);
      if (options.showUsage && cmd.usage) {
        lines.push(`    ${cmd.usage}`);
      }
    }
    lines.push("");
  }

  lines.push(footer);
  return lines.join("\n");
}

/**
 * Generate colored detailed help for a single command.
 * Shows name, aliases, description, usage, and category.
 */
export function generateDetailedHelp(
  cmd: CommandDefinition,
  options: { prefix?: string; categoryLabels?: Record<string, string> } = {},
): string {
  const prefix = options.prefix ?? "/";
  const labels = options.categoryLabels ?? CATEGORY_LABELS;
  const cat = cmd.category ?? "misc";
  const catLabel = labels[cat] || cat;

  const parts: string[] = [];
  parts.push(CATEGORY_COLOR.bold(catLabel));
  parts.push("");
  parts.push(`${CMD_NAME_COLOR.bold(prefix)}${CMD_NAME_COLOR.bold(cmd.name)}`);
  if (cmd.aliases?.length) {
    parts.push(`${ALIAS_COLOR(`别名: ${cmd.aliases.join(", ")}`)}`);
  }
  parts.push(`${DESC_COLOR(`描述: ${cmd.description}`)}`);
  if (cmd.usage) {
    parts.push(`${USAGE_COLOR(`用法: ${cmd.usage}`)}`);
  }
  // Indicators
  const indicators: string[] = [];
  if (cmd.requireConnected) indicators.push(chalk.dim("🔗 需要连接"));
  if (cmd.dmOnly) indicators.push(chalk.dim("🔒 私聊专用"));
  if (indicators.length) parts.push(indicators.join("  "));

  return parts.join("\n");
}
