/**
 * Context-aware auto-completion for the interactive CLI.
 *
 * Provides completions for:
 * - Top-level commands and aliases (dynamically fetched from daemon registry)
 * - Sub-commands based on the parent command context
 * - File paths (local filesystem)
 * - Contact names and group codes
 * - Tempfile provider names
 * - LLM provider names
 * - Emoji/sticker names
 *
 * @module cli/auto-complete
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, basename, resolve } from "node:path";
import type { AliasStore } from "@yuanbao-lite/core/business/alias";
import type { ContactStore } from "@yuanbao-lite/core/business/contacts";
import type { GroupStore } from "@yuanbao-lite/core/business/groups";

// ─── Types ───

export type CompletionContext = {
  aliasStore?: AliasStore;
  contactStore?: ContactStore;
  groupStore?: GroupStore;
  /**
   * Commands fetched from the daemon's registry (dynamic).
   * When present, this REPLACES the hardcoded TOP_LEVEL_COMMANDS list so
   * that auto-complete always reflects the actually-registered commands.
   */
  commands?: Array<{
    name: string;
    aliases: string[];
    description: string;
    usage?: string;
  }>;
};

export type CompletionResult = {
  /** Matching completions */
  completions: string[];
  /** The portion of the line that would be replaced */
  replaceFrom: string;
};

// ─── Static fallback command list ───
// Used only when ctx.commands is not populated (e.g. daemon not yet connected).
// Once the daemon is reachable, refreshCompletions() in interactive.ts fetches
// the real command list and populates ctx.commands — at that point the static
// list is ignored.

const FALLBACK_TOP_LEVEL_COMMANDS: Array<{ cmd: string; aliases: string[] }> = [
  { cmd: "/help", aliases: ["/h", "/?", "/帮助"] },
  { cmd: "/reply", aliases: ["/引用回复"] },
  { cmd: "/chat", aliases: ["/聊天", "/dm", "/私聊", "/group", "/群发"] },
  { cmd: "/upload", aliases: ["/上传"] },
  { cmd: "/download", aliases: ["/下载"] },
  { cmd: "/img", aliases: ["/图片", "/发送图片"] },
  { cmd: "/file", aliases: ["/文件", "/发送文件"] },
  { cmd: "/sticker", aliases: ["/贴纸"] },
  { cmd: "/stickers", aliases: ["/贴纸列表", "/stickerlist"] },
  { cmd: "/contacts", aliases: ["/联系人"] },
  { cmd: "/groups", aliases: ["/glist"] },
  { cmd: "/info", aliases: ["/gi", "/groupinfo", "/群信息"] },
  { cmd: "/members", aliases: ["/member", "/成员", "/群成员"] },
  { cmd: "/alias", aliases: ["/别名"] },
  { cmd: "/history", aliases: ["/hist", "/历史"] },
  { cmd: "/search", aliases: ["/搜索", "/查找"] },
  { cmd: "/batch", aliases: ["/批量"] },
  { cmd: "/account", aliases: ["/账号", "/acc"] },
  { cmd: "/llm", aliases: ["/ai"] },
  { cmd: "/config", aliases: ["/配置"] },
  { cmd: "/init", aliases: ["/初始化", "/setup", "/配置向导"] },
  { cmd: "/daemon", aliases: ["/守护进程"] },
  { cmd: "/trust", aliases: ["/信任", "/受信"] },
  { cmd: "/status", aliases: ["/state", "/状态"] },
  { cmd: "/log", aliases: ["/日志"] },
  { cmd: "/shell", aliases: ["/sh"] },
  { cmd: "/version", aliases: ["/v", "/ver", "/版本"] },
  { cmd: "/uptime", aliases: ["/运行时间"] },
  { cmd: "/ping", aliases: ["/pong"] },
  { cmd: "/unsafe", aliases: ["/危险模式"] },
  { cmd: "/echo", aliases: ["/say", "/重复"] },
  { cmd: "/calc", aliases: ["/计算"] },
  { cmd: "/time", aliases: ["/时间", "/now", "/当前时间"] },
  { cmd: "/remind", aliases: ["/提醒", "/timer"] },
  { cmd: "/ip", aliases: ["/ip查询"] },
  { cmd: "/whois", aliases: ["/域名查询"] },
  { cmd: "/whoami", aliases: ["/我是谁", "/我的信息"] },
  { cmd: "/myip", aliases: ["/服务器ip", "/serverip"] },
  { cmd: "/cron", aliases: ["/定时任务", "/周期提醒"] },
  { cmd: "/term", aliases: ["/终端", "/terminal", "/shell-session"] },
  { cmd: "/exit", aliases: ["/quit", "/q"] },
];

/**
 * Build the top-level command list from ctx.commands (dynamic) or fall back
 * to the static list. Each entry is normalized to { cmd, aliases } where
 * cmd is the canonical "/name" and aliases are the alias strings (with "/"
 * prefix). The daemon returns aliases WITHOUT the "/" prefix, so we add it.
 */
function getTopLevelCommands(ctx?: CompletionContext): Array<{
  cmd: string;
  aliases: string[];
}> {
  if (ctx?.commands && ctx.commands.length > 0) {
    return ctx.commands.map((c) => ({
      cmd: `/${c.name}`,
      aliases: (c.aliases ?? []).map((a) => (a.startsWith("/") ? a : `/${a}`)),
    }));
  }
  return FALLBACK_TOP_LEVEL_COMMANDS;
}

const SUB_COMMANDS: Record<string, string[]> = {
  "/contacts": [
    "add",
    "rm",
    "remove",
    "del",
    "rename",
    "note",
    "备注",
    "tag",
    "fav",
    "favorite",
    "收藏",
    "dm",
    "search",
    "find",
    "save",
    "list",
    "ls",
  ],
  "/groups": [
    "add",
    "rm",
    "remove",
    "del",
    "rename",
    "note",
    "备注",
    "tag",
    "fav",
    "favorite",
    "收藏",
    "join",
    "search",
    "find",
    "save",
    "list",
    "ls",
  ],
  "/alias": [
    "add",
    "remove",
    "rm",
    "del",
    "list",
    "ls",
    "save",
    "load",
    "resolve",
  ],
  "/history": [
    "search",
    "find",
    "搜索",
    "stats",
    "统计",
    "recent",
    "最近",
    "user",
    "group",
  ],
  "/search": ["groups", "群", "群组", "members", "member", "成员", "history", "hist", "历史"],
  "/batch": ["text", "sticker", "image", "file", "stop", "status", "list"],
  "/account": ["add", "remove", "rm", "list", "ls", "switch", "start", "stop"],
  "/llm": [
    "on",
    "off",
    "status",
    "chat",
    "ask",
    "问",
    "prompt",
    "系统提示",
    "model",
    "模型",
    "temp",
    "温度",
    "history",
    "历史",
    "clear",
    "清除",
    "raw",
    "im",
    "provider",
    "供应商",
    "apikey",
    "密钥",
    "baseurl",
    "group",
    "群聊",
    "merge",
    "合并",
    "cooldown",
    "冷却",
    "iterate",
    "迭代",
    "keypool",
    "密钥池",
    "providerpool",
    "供应商池",
    "customprovider",
    "自定义供应商",
    "billing",
    "用量",
    "账单",
    "config",
    "配置",
  ],
  "/config": ["show", "get", "set", "profile", "export", "import"],
  "/init": ["appkey", "appsecret", "token", "cancel"],
  "/daemon": ["stop", "reset", "restart", "status"],
  "/trust": ["list", "add", "remove", "rm", "status"],
  "/stickers": ["search", "load", "emojis"],
  "/tempfile": ["gofile", "tmpfiles", "uguu", "litterbox"],
  "/chat": [],
  "/log": ["debug", "info", "warn", "error"],
  "/unsafe": ["on", "off", "status", "allow", "disallow", "forever"],
};

// Commands that support --all/-a flag for disabling truncation
const COMMANDS_WITH_SHOW_ALL = [
  "/members",
  "/groups",
  "/switch",
  "/stickers",
  "/search",
  "/history",
  "/shell",
];

const LLM_PROVIDERS = ["z-ai", "openai", "anthropic", "deepseek", "custom"];
const LITTERBOX_EXPIRES = ["1h", "12h", "24h", "72h"];

// ─── Main completion function ───

/**
 * Get completions for the given input line.
 *
 * @param line - The current input line
 * @param ctx  - Context stores for contact/group/alias completion
 * @returns Completion result with matching candidates
 */
export function getCompletions(
  line: string,
  ctx?: CompletionContext,
): CompletionResult {
  const trimmed = line.trimStart();
  const _leadingSpaces = line.length - trimmed.length;

  // Empty line — suggest all commands
  if (!trimmed) {
    return {
      completions: getTopLevelCommands(ctx).map((c) => c.cmd),
      replaceFrom: "",
    };
  }

  // Not starting with / — no completion for chat text (except @mentions)
  if (!trimmed.startsWith("/")) {
    return { completions: [], replaceFrom: "" };
  }

  // Split into parts
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  // ─── Completing the command itself ───
  if (parts.length === 1 && !trimmed.endsWith(" ")) {
    return completeCommand(cmd, ctx);
  }

  // ─── Completing sub-commands or arguments ───
  const currentPart = parts[parts.length - 1];
  const isTypingNewArg = trimmed.endsWith(" ");

  // Get the context of what we're completing
  if (parts.length === 2 || (parts.length === 1 && trimmed.endsWith(" "))) {
    // Completing first argument (sub-command or first param)
    return completeFirstArg(cmd, isTypingNewArg ? "" : currentPart, ctx);
  }

  // Completing later arguments
  return completeLaterArg(cmd, parts, isTypingNewArg ? "" : currentPart, ctx);
}

// ─── Command completion ───

function completeCommand(partial: string, ctx?: CompletionContext): CompletionResult {
  const matches: string[] = [];

  for (const entry of getTopLevelCommands(ctx)) {
    if (entry.cmd.startsWith(partial)) {
      matches.push(entry.cmd);
    }
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        if (alias.startsWith(partial)) {
          matches.push(alias);
        }
      }
    }
  }

  return {
    completions: [...new Set(matches)].sort(),
    replaceFrom: partial,
  };
}

// ─── First argument completion ───

function completeFirstArg(
  cmd: string,
  partial: string,
  ctx?: CompletionContext,
): CompletionResult {
  // Suggest --all/-a for commands that support it
  if (COMMANDS_WITH_SHOW_ALL.includes(cmd)) {
    const flagMatches: string[] = [];
    if ("--all".startsWith(partial)) flagMatches.push("--all");
    if ("-a".startsWith(partial)) flagMatches.push("-a");
    if (flagMatches.length > 0 && partial.startsWith("-")) {
      return { completions: flagMatches, replaceFrom: partial };
    }
  }

  const subs = SUB_COMMANDS[cmd];
  if (subs) {
    // This command has sub-commands
    const matches = subs.filter((s) => s.startsWith(partial.toLowerCase()));
    // Also include --all/-a if the command supports it and partial doesn't start with -
    if (COMMANDS_WITH_SHOW_ALL.includes(cmd) && !partial.startsWith("-")) {
      if ("--all".startsWith(partial.toLowerCase())) matches.push("--all");
      if ("-a".startsWith(partial.toLowerCase())) matches.push("-a");
    }
    if (matches.length > 0) {
      return { completions: matches, replaceFrom: partial };
    }
  }

  // For commands with --all support but no sub-commands (like /shell), suggest --all/-a
  if (COMMANDS_WITH_SHOW_ALL.includes(cmd) && !subs) {
    const flagMatches: string[] = [];
    if ("--all".startsWith(partial)) flagMatches.push("--all");
    if ("-a".startsWith(partial)) flagMatches.push("-a");
    if (flagMatches.length > 0) {
      return { completions: flagMatches, replaceFrom: partial };
    }
  }

  // Command-specific first arg completions
  switch (cmd) {
    case "/tempfile": {
      // Could be a provider name or a file path
      const providerMatches = [
        "gofile",
        "tmpfiles",
        "uguu",
        "litterbox",
      ].filter((p) => p.startsWith(partial));
      const pathMatches = completeFilePath(partial);
      return {
        completions: [...providerMatches, ...pathMatches],
        replaceFrom: partial,
      };
    }

    case "/chat": {
      // /chat accepts both user IDs (DM) and group codes (9-digit).
      // Offer both contact/alias matches and group-code matches.
      const contactMatches = completeContactOrAlias(partial, ctx);
      const groupMatches = completeGroupCode(partial, ctx);
      return {
        completions: [
          ...contactMatches.completions,
          ...groupMatches.completions,
        ],
        replaceFrom: partial,
      };
    }

    case "/groups": {
      // For groups add/fav/note etc., complete with group codes
      if (subs && !subs.includes(partial)) {
        return completeGroupCode(partial, ctx);
      }
      break;
    }

    case "/upload":
    case "/img":
    case "/file":
    case "/stickers": {
      // Complete with file paths
      return { completions: completeFilePath(partial), replaceFrom: partial };
    }

    case "/llm": {
      const matches =
        SUB_COMMANDS["/llm"]?.filter((s) =>
          s.startsWith(partial.toLowerCase()),
        ) || [];
      return { completions: matches, replaceFrom: partial };
    }

    case "/log": {
      const levels = ["debug", "info", "warn", "error"].filter((l) =>
        l.startsWith(partial.toLowerCase()),
      );
      return { completions: levels, replaceFrom: partial };
    }
  }

  return { completions: [], replaceFrom: partial };
}

// ─── Later argument completion ───

function completeLaterArg(
  cmd: string,
  parts: string[],
  partial: string,
  ctx?: CompletionContext,
): CompletionResult {
  const subCmd = parts[1]?.toLowerCase();

  switch (cmd) {
    case "/tempfile": {
      // /tempfile <provider> <path> [options]
      const isFirstArgProvider = [
        "gofile",
        "tmpfiles",
        "uguu",
        "litterbox",
      ].includes(parts[1]?.toLowerCase());
      if (isFirstArgProvider) {
        if (parts.length === 2 || (parts.length === 3 && !partial)) {
          // Complete file path
          return {
            completions: completeFilePath(partial),
            replaceFrom: partial,
          };
        }
        if (parts[1]?.toLowerCase() === "litterbox" && parts.length === 3) {
          // Complete expire time
          const matches = LITTERBOX_EXPIRES.filter((e) =>
            e.startsWith(partial),
          );
          if (matches.length > 0) {
            return { completions: matches, replaceFrom: partial };
          }
        }
      } else {
        // /tempfile <path> [desc] — path was already the first arg
        if (parts.length === 2 || (parts.length === 2 && !partial)) {
          return {
            completions: completeFilePath(partial),
            replaceFrom: partial,
          };
        }
      }
      break;
    }

    case "/chat": {
      // After the target, it's just message text — no completion
      break;
    }

    case "/contacts": {
      // /contacts <subcmd> <name|ID> ...
      if (
        [
          "note",
          "tag",
          "fav",
          "rename",
          "dm",
          "search",
          "rm",
          "remove",
          "del",
        ].includes(subCmd)
      ) {
        if (parts.length === 2 || (parts.length === 3 && !partial)) {
          return completeContactOrAlias(partial, ctx);
        }
      }
      break;
    }

    case "/groups": {
      // /groups <subcmd> <groupCode> ...
      if (
        [
          "note",
          "tag",
          "fav",
          "rename",
          "join",
          "search",
          "rm",
          "remove",
          "del",
        ].includes(subCmd)
      ) {
        if (parts.length === 2 || (parts.length === 3 && !partial)) {
          return completeGroupCode(partial, ctx);
        }
      }
      break;
    }

    case "/llm": {
      if (subCmd === "provider") {
        const matches = LLM_PROVIDERS.filter((p) =>
          p.startsWith(partial.toLowerCase()),
        );
        return { completions: matches, replaceFrom: partial };
      }
      break;
    }

    case "/upload":
    case "/img":
    case "/file": {
      // Second arg might be target or another path
      if (parts.length === 2 || (parts.length === 3 && !partial)) {
        return { completions: completeFilePath(partial), replaceFrom: partial };
      }
      break;
    }
  }

  // Default: try file path completion for any argument that looks like a path
  if (
    partial.startsWith("/") ||
    partial.startsWith("./") ||
    partial.startsWith("~/") ||
    partial.startsWith("../")
  ) {
    return { completions: completeFilePath(partial), replaceFrom: partial };
  }

  return { completions: [], replaceFrom: partial };
}

// ─── File path completion ───

function completeFilePath(partial: string): string[] {
  if (!partial) {
    // Suggest current directory entries
    return listDirEntries(".");
  }

  let dirPath: string;
  let prefix: string;

  // Expand ~ to home directory
  const expanded = partial.replace(/^~/, process.env.HOME || "~");

  try {
    const stat = statSync(expanded);
    if (stat.isDirectory()) {
      dirPath = expanded;
      prefix = "";
    } else {
      dirPath = dirname(expanded);
      prefix = basename(expanded);
    }
  } catch {
    dirPath = dirname(expanded);
    prefix = basename(expanded);
  }

  const entries = listDirEntries(dirPath);
  if (!prefix) return entries.map((e) => completePath(dirPath, e, partial));

  return entries
    .filter((e) => e.startsWith(prefix))
    .map((e) => completePath(dirPath, e, partial));
}

function listDirEntries(dirPath: string): string[] {
  try {
    if (!existsSync(dirPath)) return [];
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function completePath(dir: string, entry: string, original: string): string {
  try {
    const fullPath = resolve(dir, entry);
    const isDir = statSync(fullPath).isDirectory();
    // Preserve the original prefix format (~/, ./, etc.)
    if (original.startsWith("~/")) {
      return `~/${resolve(dir, entry).replace(process.env.HOME + "/", "")}${isDir ? "/" : ""}`;
    }
    if (original.startsWith("./")) {
      return `./${entry}${isDir ? "/" : ""}`;
    }
    return entry + (isDir ? "/" : "");
  } catch {
    return entry;
  }
}

// ─── Contact/Alias completion ───

function completeContactOrAlias(
  partial: string,
  ctx?: CompletionContext,
): CompletionResult {
  const completions: string[] = [];

  // Add contact names
  if (ctx?.contactStore) {
    const contacts = ctx.contactStore.getAll("name");
    for (const c of contacts) {
      if (c.name.toLowerCase().startsWith(partial.toLowerCase())) {
        completions.push(c.name);
      }
    }
  }

  // Add alias names
  if (ctx?.aliasStore) {
    const aliases = ctx.aliasStore.getAll();
    for (const a of aliases) {
      if (a.alias.toLowerCase().startsWith(partial.toLowerCase())) {
        completions.push(a.alias);
      }
    }
  }

  return { completions: [...new Set(completions)], replaceFrom: partial };
}

// ─── Group code completion ───

function completeGroupCode(
  partial: string,
  ctx?: CompletionContext,
): CompletionResult {
  const completions: string[] = [];

  if (ctx?.groupStore) {
    const groups = ctx.groupStore.getAll("lastActive");
    for (const g of groups) {
      if (g.groupCode.startsWith(partial)) {
        completions.push(g.groupCode);
      }
      // Also match by name
      const name = g.name || g.groupName || "";
      if (name.toLowerCase().startsWith(partial.toLowerCase())) {
        completions.push(g.groupCode);
      }
    }
  }

  return { completions: [...new Set(completions)], replaceFrom: partial };
}
