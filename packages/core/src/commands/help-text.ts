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
  info: "ℹ️ 信息与工具",
  system: "⚙️ 系统管理",
  chat: "💬 聊天与贴纸",
  group: "🏠 群聊管理",
  media: "📎 媒体与文件",
  history: "📜 消息历史",
  llm: "🤖 LLM 接管",
  utility: "🛠️ 实用工具",
};

const CATEGORY_ORDER: CommandCategory[] = [
  "info",
  "chat",
  "group",
  "media",
  "history",
  "llm",
  "system",
  "utility",
];

// ─── Colors ───

const CMD_NAME_COLOR = chalk.rgb(100, 200, 255).bold; // cyan-blue
const ALIAS_COLOR = chalk.dim.gray;
const DESC_COLOR = chalk.rgb(200, 210, 230); // light gray
const CATEGORY_COLOR = chalk.rgb(160, 140, 255); // soft purple
const USAGE_COLOR = chalk.rgb(120, 180, 120); // green
const FOOTER_COLOR = chalk.dim;

// ─── Main generation ───

/**
 * Calculate the display width of a string, accounting for CJK and other
 * wide characters that occupy 2 terminal columns.
 */
import stringWidth from "string-width";

/**
 * Pad a string to a target display width (ASCII spaces fill the gap).
 */
function padToDisplayWidth(str: string, target: number): string {
  const current = stringWidth(str);
  if (current >= target) return str;
  return str + " ".repeat(target - current);
}

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

  for (const cmd of commands) {
    const cat = cmd.category ?? "utility";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(cmd);
  }

  // Sort commands within each group
  for (const cmds of groups.values()) {
    cmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  const _maxW = options.width ?? 88;

  // ── Pass 1: compute max display width for each category's command lines ──
  const maxNameWidth = new Map<CommandCategory, number>();
  for (const cat of CATEGORY_ORDER) {
    const cmds = groups.get(cat);
    if (!cmds) continue;
    let max = 0;
    for (const cmd of cmds) {
      const cmdName = `${prefix}${cmd.name}`;
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
      const display = stringWidth(cmdName) + stringWidth(aliases) + 4; // 4 = "  " + gap
      if (display > max) max = display;
    }
    maxNameWidth.set(cat, max);
  }

  const lines: string[] = [];

  const versionLine = options.version
    ? `Yuanbao Lite 交互式客户端 v${options.version}`
    : "Yuanbao Lite 交互式客户端";
  lines.push(`${CATEGORY_COLOR.bold(versionLine)}`);

  const flagHint = `${FOOTER_COLOR("--all / -a  取消输出截断，显示全部结果")}`;
  lines.push(flagHint);
  lines.push("");

  // ── Per-category sections ──
  for (const cat of CATEGORY_ORDER) {
    const cmds = groups.get(cat);
    if (!cmds || cmds.length === 0) continue;

    const catLabel = CATEGORY_LABELS[cat];
    if (!catLabel) continue;

    // Category header
    const catRow = `${CATEGORY_COLOR.bold(catLabel)}`;
    lines.push(catRow);

    const cmdWidth = maxNameWidth.get(cat) ?? 0;

    for (const cmd of cmds) {
      const cmdName = `${prefix}${cmd.name}`;
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
      const desc = `${DESC_COLOR(cmd.description)}`;

      // Format: /command [aliases]  — description (columns aligned)
      const namePart = `${CMD_NAME_COLOR(cmdName)}${ALIAS_COLOR(aliases)}`;
      const paddedName = padToDisplayWidth(namePart, cmdWidth);
      const line = `  ${paddedName}  ${desc}`;
      lines.push(line);

      // Optional usage
      if (options.showUsage && cmd.usage) {
        lines.push(`    ${USAGE_COLOR(cmd.usage)}`);
      }
    }

    lines.push(""); // blank line between sections
  }

  // ── Footer ──
  lines.push(FOOTER_COLOR(footer));

  return lines.join("\n");
}
