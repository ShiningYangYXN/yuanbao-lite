/**
 * Syntax highlighting for CLI input lines.
 *
 * Provides real-time coloring of:
 * - Command names (cyan)
 * - Sub-commands (yellow)
 * - File paths (green)
 * - @mentions (magenta)
 * - Quoted strings (dim)
 * - Flags/options (dim cyan)
 * - URLs (blue underline)
 *
 * @module cli/syntax-highlight
 */

import chalk from "chalk";

// ─── Command definitions for context-aware highlighting ───

const COMMANDS_WITH_SUBCOMMANDS: Record<string, string[]> = {
  "/contacts": ["add", "rm", "remove", "del", "rename", "note", "备注", "tag", "fav", "favorite", "收藏", "dm", "search", "find", "save", "list", "ls"],
  "/groups": ["add", "rm", "remove", "del", "rename", "note", "备注", "tag", "fav", "favorite", "收藏", "join", "search", "find", "save", "list", "ls"],
  "/alias": ["add", "remove", "rm", "del", "list", "ls", "save", "load", "resolve"],
  "/history": ["search", "find", "搜索", "stats", "统计", "recent", "最近", "user", "group"],
  "/search": ["groups", "群", "members", "member"],
  "/batch": ["text", "sticker", "image", "file", "stop", "status", "list"],
  "/account": ["add", "remove", "rm", "list", "ls", "switch", "start", "stop"],
  "/llm": ["on", "off", "status", "chat", "ask", "问", "prompt", "系统提示", "model", "模型", "temp", "温度", "history", "历史", "clear", "清除", "markdown", "md", "raw", "im", "provider", "供应商", "apikey", "密钥", "baseurl", "基础URL", "group", "群聊", "merge", "合并", "cooldown", "冷却", "iterate", "迭代", "keypool", "密钥池", "providerpool", "供应商池", "customprovider", "自定义供应商"],
  "/config": ["show", "get", "set", "profile", "export", "import"],
  "/init": ["appkey", "appsecret", "token", "cancel"],
  "/daemon": ["stop", "reset", "restart", "status"],
  "/trust": ["list", "add", "remove", "rm", "status"],
  "/stickers": ["search", "load", "emojis"],
  "/tempfile": ["gofile", "tmpfiles", "uguu", "litterbox"],
  "/unsafe": ["on", "off", "status"],
};

const _ALL_COMMANDS = [
  "/help", "/h", "/?", "/帮助",
  "/dm", "/私聊", "/group", "/群发",
  "/reply", "/引用回复", "/chat", "/聊天",
  "/upload", "/上传", "/download", "/下载",
  "/img", "/图片", "/发送图片", "/file", "/文件", "/发送文件",
  "/tempfile", "/临时文件", "/tmpfile",
  "/sticker", "/贴纸", "/stickers", "/贴纸列表", "/stickerlist",
  "/mention", "/at", "/提及",
  "/atall", "/所有人", "/at-all", "/@all",
  "/contacts", "/联系人", "/groups", "/glist",
  "/join", "/加入", "/switch", "/切换", "/sw",
  "/info", "/gi", "/groupinfo", "/群信息",
  "/members", "/member", "/成员", "/群成员",
  "/alias", "/别名",
  "/history", "/hist", "/历史",
  "/search", "/搜索", "/查找",
  "/batch", "/批量",
  "/account", "/账号", "/acc",
  "/llm", "/ai",
  "/config", "/配置",
  "/init", "/初始化", "/setup", "/配置向导",
  "/daemon", "/守护进程",
  "/trust", "/信任", "/受信",
  "/status", "/state", "/状态",
  "/log", "/日志",
  "/hsearch", "/搜索历史", "/histsearch",
  "/hclear", "/清除历史",
  "/shell", "/sh",
  "/version", "/v", "/ver", "/版本",
  "/uptime", "/运行时间",
  "/ping", "/pong",
  "/unsafe", "/危险模式",
  "/echo", "/say", "/重复",
  "/calc", "/计算",
  "/time", "/时间", "/now", "/当前时间",
  "/remind", "/提醒", "/timer",
  "/ip", "/ip查询",
  "/exit", "/quit", "/q",
];

// ─── Public API ───

/**
 * Apply syntax highlighting to a CLI input line.
 *
 * Returns the colored string suitable for terminal display.
 * The highlighting is purely visual — the original text is preserved for processing.
 */
export function highlightLine(input: string): string {
  if (!input.startsWith("/")) {
    // Not a command — check for @mentions in chat text
    return highlightChatText(input);
  }

  // Walk through the input character by character, splitting on whitespace boundaries
  // but preserving the whitespace in the output.
  const parts: string[] = [];
  let i = 0;

  while (i < input.length) {
    // Capture whitespace
    if (input[i] === " " || input[i] === "\t") {
      const start = i;
      while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
      parts.push(input.substring(start, i));
      continue;
    }

    // Capture quoted string
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      const start = i;
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) i++;
        i++;
      }
      i++; // closing quote
      parts.push(chalk.dim(input.substring(start, i)));
      continue;
    }

    // Capture unquoted token
    const start = i;
    while (i < input.length && input[i] !== " " && input[i] !== "\t" && input[i] !== '"' && input[i] !== "'") {
      i++;
    }
    const token = input.substring(start, i);

    // Colorize based on position (determine token index from parts count)
    const tokenIndex = parts.filter(p => !p.match(/^\s+$/)).length;
    const cmd = input.split(/\s+/)[0]?.toLowerCase() || "";
    parts.push(colorizeTokenInline(token, tokenIndex, cmd));
  }

  return parts.join("");
}

/**
 * Highlight chat text (non-command input).
 * Detects @mentions and URLs.
 */
export function highlightChatText(input: string): string {
  let result = "";
  let i = 0;

  while (i < input.length) {
    // @mention: @[name](id)
    if (input[i] === "@" && i + 1 < input.length && input[i + 1] === "[") {
      const mentionEnd = input.indexOf("]", i + 2);
      if (mentionEnd !== -1) {
        const parenStart = input.indexOf("(", mentionEnd);
        const parenEnd = parenStart !== -1 ? input.indexOf(")", parenStart) : -1;
        if (parenStart === mentionEnd + 1 && parenEnd !== -1) {
          // Full @[name](id) syntax
          const name = input.substring(i + 2, mentionEnd);
          const id = input.substring(parenStart + 1, parenEnd);
          result += chalk.magenta(`@[${name}](${id})`);
          i = parenEnd + 1;
          continue;
        }
      }
    }

    // URL detection
    if (input.substring(i, i + 8) === "https://" || input.substring(i, i + 7) === "http://") {
      const urlEnd = findUrlEnd(input, i);
      const url = input.substring(i, urlEnd);
      result += chalk.blue.underline(url);
      i = urlEnd;
      continue;
    }

    result += input[i];
    i++;
  }

  return result;
}

// ─── Inline colorizer ───

/**
 * Colorize a single token based on its position and the command context.
 */
function colorizeTokenInline(token: string, tokenIndex: number, cmd: string): string {
  // Index 0: the command itself
  if (tokenIndex === 0 && token.startsWith("/")) {
    return chalk.cyan.bold(token);
  }

  // Index 1: could be a sub-command
  if (tokenIndex === 1) {
    const subs = COMMANDS_WITH_SUBCOMMANDS[cmd];
    if (subs && subs.includes(token.toLowerCase())) {
      return chalk.yellow(token);
    }
  }

  // Flags (--option, -f)
  if (token.startsWith("--") || (token.startsWith("-") && token.length > 1 && !token.startsWith("/"))) {
    return chalk.cyan.dim(token);
  }

  // File paths
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("~/") || token.startsWith("../")) {
    return chalk.green(token);
  }

  // URLs
  if (token.startsWith("http://") || token.startsWith("https://")) {
    return chalk.blue.underline(token);
  }

  // @mentions
  if (token.startsWith("@[") || token.startsWith("@")) {
    return chalk.magenta(token);
  }

  // Numbers
  if (/^\d+$/.test(token)) {
    return chalk.dim.yellow(token);
  }

  // Context-aware: paths in certain command positions
  if (tokenIndex >= 2 && isPathPosition(cmd, tokenIndex)) {
    return chalk.green(token);
  }

  return token;
}

/**
 * Check if the given position in a command typically expects a file path.
 */
function isPathPosition(cmd: string, index: number): boolean {
  // /upload <path>, /img <path>, /file <path>, /tempfile [provider] <path>
  if (["/upload", "/img", "/file"].includes(cmd) && index === 1) return true;
  if (cmd === "/tempfile" && (index === 1 || index === 2)) return true;
  if (cmd === "/stickers" && index === 2) return true; // /stickers load <path>
  return false;
}

/**
 * Find the end of a URL in the input string.
 */
function findUrlEnd(input: string, start: number): number {
  let i = start;
  while (i < input.length && ![" ", "\t", '"', "'", ")", "]"].includes(input[i])) {
    i++;
  }
  return i;
}
