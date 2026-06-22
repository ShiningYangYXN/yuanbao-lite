/**
 * Shell-style syntax highlighting for CLI input lines.
 *
 * Colors slash commands, flags, and strings in the committed input line.
 * Uses chalk (already a dependency) — no new libraries needed.
 *
 * This is applied to the FINAL committed line (after Enter), not in
 * real-time during editing. Real-time highlighting would require
 * intercepting every keypress and re-rendering, which conflicts with
 * readline's cursor management and breaks arrow keys / history.
 *
 * The committed-line approach is what fish/zsh also use as a fallback
 * when their real-time highlighter is unavailable.
 */

import chalk from "chalk";

/**
 * Highlight a committed input line.
 *
 * - Lines starting with / → command highlighting (command name in cyan,
 *   flags in magenta, args in default)
 * - Lines NOT starting with / → chat text, no highlighting (returned as-is)
 */
export function highlightLine(line: string): string {
  if (!line) return line;
  if (!line.startsWith("/")) return line;

  // Split into command + args, preserving flag detection
  const parts = line.split(/\s+/);
  const cmd = parts[0]; // e.g. /search
  const rest = parts.slice(1);

  const coloredCmd = chalk.cyan.bold(cmd);
  if (rest.length === 0) return coloredCmd;

  const coloredArgs = rest.map((arg) => {
    if (arg.startsWith("--") || arg.startsWith("-")) {
      return chalk.magenta(arg);
    }
    // Mention syntax @[nick](id)
    if (/^@\[.*\]\(.*\)$/.test(arg)) {
      return chalk.rgb(255, 140, 200)(arg);
    }
    // Quoted strings
    if (
      (arg.startsWith('"') && arg.endsWith('"')) ||
      (arg.startsWith("'") && arg.endsWith("'"))
    ) {
      return chalk.green(arg);
    }
    // Numbers
    if (/^\d+$/.test(arg)) {
      return chalk.yellow(arg);
    }
    return arg;
  });

  return `${coloredCmd} ${coloredArgs.join(" ")}`;
}
