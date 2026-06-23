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
 *   1. @mentions: ONLY @[nick](id) syntax is valid (brackets and parens
 *      required, contents optional). Bare @nick is NOT highlighted.
 *      Color depends on user type:
 *        - Master (bot owner): magenta
 *        - Yuanbao (platform bot): green
 *        - Lobster (bot_ prefix): red
 *        - Trusted: yellow
 *        - Human: cyan
 *      If user type can't be determined (unknown ID), default pink.
 *   2. Slash commands (/cmd) → cyan bold, highlighted everywhere
 *      - If the line starts with @, command highlighting starts from the
 *        first / after the @mention(s)
 *   3. Flags (--flag, -f) → magenta
 *   4. Quoted strings → green
 *   5. Numbers → yellow
 */

import chalk from "chalk";

/** Yuanbao platform bot's user ID */
const YUANBAO_ID = "szUvRH8s4ekettawNjDREmAG4W7h+Lhb8Sy9tq/otZU=";

/**
 * Valid mention regex: @[nick](id)
 * - Brackets [] and parens () are REQUIRED
 * - Contents (nick and id) are OPTIONAL (can be empty)
 * - Examples: @[小明](12345), @[](12345), @[小明](), @[]()
 */
const MENTION_RE = /@\[[^\]]*\]\([^)]*\)/g;

/**
 * Get the highlight color for a mention based on the user ID.
 * Mirrors the color logic in cli-format.ts's coloredName().
 *
 * @param userId - The user ID extracted from @[nick](id)
 * @returns A chalk color function, or null if default should be used
 */
function getMentionColor(userId: string): ((s: string) => string) | null {
  if (!userId) return null;
  if (userId === YUANBAO_ID) return chalk.green.bold;
  if (userId.startsWith("bot_")) return chalk.red;
  // Master and Trusted require the trust store, which isn't available
  // client-side. We can't determine those types here, so we fall back
  // to the default pink for unknown IDs. The CLI display path
  // (formatInboundMessage) does have access to the trust store and
  // will apply the correct colors there.
  return null; // default pink
}

/**
 * Highlight a committed input line.
 *
 * Rules:
 * - Only @[nick](id) mentions are highlighted (bare @nick is NOT).
 * - Mention color depends on user type (see getMentionColor).
 * - /commands are always highlighted (cyan bold) wherever they appear.
 * - Within command args, flags/strings/numbers are also colored.
 * - If the line starts with @, the command portion (starting from the
 *   first / after the @mention) gets full command highlighting.
 */
export function highlightLine(line: string): string {
  if (!line) return line;

  // Check if the line contains any valid @mentions
  const hasMentions = MENTION_RE.test(line);
  MENTION_RE.lastIndex = 0;

  // Check if the line starts with / (command)
  const startsWithCommand = line.startsWith("/");

  // If no mentions and not a command, return as-is
  if (!hasMentions && !startsWithCommand) {
    return line;
  }

  // Tokenize the line into segments, highlighting each token type.
  // We process the line in one pass, checking each space-separated token.
  const parts = line.split(/(\s+)/); // keep whitespace as tokens
  let inCommand = startsWithCommand; // are we in the command portion?

  const result = parts.map((part) => {
    // Whitespace — return as-is
    if (/^\s+$/.test(part) || part === "") {
      return part;
    }

    // Valid mention: @[nick](id) — brackets and parens required
    const mentionMatch = part.match(/^@\[([^\]]*)\]\(([^)]*)\)$/);
    if (mentionMatch) {
      const nick = mentionMatch[1];
      const id = mentionMatch[2];
      const colorFn = getMentionColor(id);
      if (colorFn) {
        return colorFn(part);
      }
      // Default: pink for unknown user types
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
    // switch to command mode (e.g. "@[bot](id) /help" → /help starts command)
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
  if (
    arg.startsWith("--") ||
    (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--"))
  ) {
    return chalk.magenta(arg);
  }
  // Valid mention syntax @[nick](id)
  const mentionMatch = arg.match(/^@\[([^\]]*)\]\(([^)]*)\)$/);
  if (mentionMatch) {
    const id = mentionMatch[2];
    const colorFn = getMentionColor(id);
    if (colorFn) {
      return colorFn(arg);
    }
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
