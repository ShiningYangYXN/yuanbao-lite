/**
 * Shell-style syntax highlighting for CLI input lines.
 *
 * Colors slash commands, flags, mentions, and strings in the committed
 * input line. Uses chalk (already a dependency) — no new libraries needed.
 *
 * This is applied to the FINAL committed line (after Enter), not in
 * real-time during editing. Real-time highlighting would require
 * intercepting every keypress and re-rendering, which conflicts with
 * readline's cursor management and breaks arrow keys / history.
 *
 * The committed-line approach is what fish/zsh also use as a fallback
 * when their real-time highlighter is unavailable.
 *
 * Highlighting rules:
 *   1. @mentions (@[nick](id), @nick, @all) → pink, highlighted everywhere
 *   2. Slash commands (/cmd) → cyan bold, highlighted everywhere
 *      - If the line starts with @, command highlighting starts from the
 *        first / after the @mention(s)
 *   3. Flags (--flag, -f) → magenta
 *   4. Quoted strings → green
 *   5. Numbers → yellow
 */

import chalk from "chalk";

/** Mention regex: @[nick](id), @[](id), @nick (bare), @all */
const MENTION_RE = /(@\[[^\]]*\]\([^)]*\)|@[][A-Za-z\u4e00-\u9fff]+)/g;

/** Command regex: /word */
const COMMAND_RE = /(\/\S+)/g;

/**
 * Highlight a committed input line.
 *
 * Rules:
 * - @mentions are always highlighted (pink) wherever they appear.
 * - /commands are always highlighted (cyan bold) wherever they appear.
 * - Within command args, flags/strings/numbers are also colored.
 * - If the line starts with @, the command portion (starting from the
 *   first / after the @mention) gets full command highlighting.
 */
export function highlightLine(line: string): string {
  if (!line) return line;

  // Check if the line contains any @mentions
  const hasMentions = MENTION_RE.test(line);
  // Reset lastIndex (regex is global)
  MENTION_RE.lastIndex = 0;

  // Check if the line contains any /commands
  const hasCommands = COMMAND_RE.test(line);
  COMMAND_RE.lastIndex = 0;

  // If no mentions and no commands, return as-is
  if (!hasMentions && !hasCommands && !line.startsWith("/")) {
    return line;
  }

  // Tokenize the line into segments, highlighting each token type.
  // We process the line in one pass, checking each space-separated token.
  const parts = line.split(/(\s+)/); // keep whitespace as tokens
  let inCommand = line.startsWith("/"); // are we in the command portion?

  const result = parts.map((part) => {
    // Whitespace — return as-is
    if (/^\s+$/.test(part) || part === "") {
      return part;
    }

    // Mention: @[nick](id) or @nick or @all
    if (/^@\[.*\]\(.*\)$/.test(part) || /^@[][A-Za-z\u4e00-\u9fff]+$/.test(part)) {
      return chalk.rgb(255, 140, 200)(part);
    }

    // If we're in the command portion and this token starts with /, it's a command
    if (inCommand && part.startsWith("/")) {
      // Check if it's a pure command (no args in this token)
      if (/^\/\S+$/.test(part)) {
        return chalk.cyan.bold(part);
      }
      // Token has a command prefix but also other content — highlight the /cmd part
      const cmdMatch = part.match(/^(\/\w+)/);
      if (cmdMatch) {
        const cmd = cmdMatch[1];
        const rest = part.slice(cmd.length);
        return chalk.cyan.bold(cmd) + highlightArgs(rest);
      }
    }

    // If this token starts with / and we're NOT yet in command mode,
    // switch to command mode (e.g. "@bot /help" → /help starts command)
    if (!inCommand && part.startsWith("/")) {
      inCommand = true;
      if (/^\/\S+$/.test(part)) {
        return chalk.cyan.bold(part);
      }
      const cmdMatch = part.match(/^(\/\w+)/);
      if (cmdMatch) {
        const cmd = cmdMatch[1];
        const rest = part.slice(cmd.length);
        return chalk.cyan.bold(cmd) + highlightArgs(rest);
      }
    }

    // In command mode, highlight flags/strings/numbers
    if (inCommand) {
      return highlightArgs(part);
    }

    // Not in command mode — return as-is (chat text)
    return part;
  });

  return result.join("");
}

/**
 * Highlight a single argument token (used within command mode).
 */
function highlightArgs(arg: string): string {
  // Flags: --flag or -f
  if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--"))) {
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
}
