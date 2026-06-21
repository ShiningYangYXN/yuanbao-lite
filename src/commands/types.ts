/**
 * Command system type definitions.
 *
 * Provides a standalone command registration and dispatch framework,
 * inspired by the original openclaw-plugin-yuanbao command system
 * but fully independent.
 */

import type { ChatMessage, YuanbaoMsgBodyElement } from "../types.js";
import type { YuanbaoBot } from "../index.js";

// ─── Command Context ───

export type CommandContext = {
  /** The bot instance that received the message */
  bot: YuanbaoBot;
  /** The original chat message that triggered the command */
  message: ChatMessage;
  /** Command name (without prefix) */
  command: string;
  /** Arguments after the command name (flags like --all/-a are stripped) */
  args: string[];
  /** Reply with text (auto-splits long messages) */
  reply: (text: string) => Promise<void>;
  /**
   * Reply with documentation/help text that contains literal @mention syntax.
   * Escapes @ → \@ so parseMentions() treats it as literal text rather than
   * trying to parse @[昵称](id), @[所有人](), @[](all) etc. as real mentions.
   */
  replyDoc: (text: string) => Promise<void>;
  /** Reply with a raw msg_body (for rich messages like stickers/images) */
  replyRaw: (msgBody: YuanbaoMsgBodyElement[]) => Promise<void>;
  /** Send a direct message to the sender */
  replyDirect: (text: string) => Promise<void>;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Group code if group message */
  groupCode?: string;
  /** Whether --all/-a flag was specified (disable truncation for long-output commands) */
  showAll: boolean;
  /** Output mode: "plain" (纯文本), "table" (Markdown表格), "ansi" (CLI彩色表格) */
  outputMode: "plain" | "table" | "ansi";
  /** Whether table output is requested (true when outputMode is "table" or "ansi") */
  useTable: boolean;
  /** Where the command was invoked from — affects coloring/output format */
  source: "chat" | "cli";
  /**
   * Format data as a table. Async because CLI mode uses dynamic import
   * for cli-table3 + chalk.
   * - "table" mode: Markdown table (markdown-table)
   * - "ansi" mode: Colored CLI table (cli-table3 + chalk)
   * - "plain" mode: not called (handler checks useTable first)
   */
  formatTable: (headers: string[], rows: string[][]) => Promise<string>;
  /**
   * Resolve a single @-reference arg to a user ID.
   *
   * Supports:
   *   @[nick](id)  → id (extracted directly from the syntax)
   *   @nick        → looked up in message.mentions[] by displayName, then
   *                  in group member list (if available)
   *   @<botId>     → the bare ID (anything starting with @ that looks like an ID)
   *
   * Args that don't start with @ are returned unchanged.
   * Args that start with @ but can't be resolved are returned unchanged.
   *
   * Handlers should call this explicitly on args that represent user IDs
   * (NOT on args that represent message text — those must preserve
   * @[nick](id) syntax for mention parsing).
   */
  resolveAtReference: (arg: string) => Promise<string>;
  /**
   * Resolve a target arg to { targetId, isGroup }.
   *
   * Resolution order:
   *   1. Try alias store — if alias resolves, use the resolved ID
   *      (alias can store metadata about whether it's a group or user)
   *   2. If not an alias, check if it's a 9-digit pure number → group
   *   3. Otherwise → direct message (user ID)
   *
   * This is for commands that take a target (group or user) as first arg:
   *   /mention <target> <msg>, /dm <target> <msg>, /group <target> <msg>, etc.
   */
  resolveTarget: (arg: string) => Promise<{ targetId: string; isGroup: boolean }>;
};

// ─── Command Definition ───

export type CommandCategory =
  | "info"
  | "system"
  | "chat"
  | "group"
  | "media"
  | "history"
  | "llm"
  | "utility";

export type CommandDefinition = {
  /** Command name (without prefix, e.g. "help") */
  name: string;
  /** Aliases for the command (e.g. ["h", "?"]) */
  aliases?: string[];
  /** Short description for help listing */
  description: string;
  /** Usage string (e.g. "/echo <text>") */
  usage?: string;
  /** Category for grouping in help output */
  category?: CommandCategory;
  /** Whether this command is hidden from help listing */
  hidden?: boolean;
  /** Whether this command requires the bot to be connected */
  requireConnected?: boolean;
  /** Whether this command can only be used in direct messages (not groups) */
  dmOnly?: boolean;
  /** The handler function */
  handler: (ctx: CommandContext) => Promise<void> | void;
};

// ─── Command Result ───

export type CommandResult = {
  /** Whether the command was handled */
  handled: boolean;
  /** Optional error if the command failed */
  error?: Error;
};

// ─── Command System Config ───

export type CommandSystemConfig = {
  /** Command prefix (default: "/") */
  prefix?: string;
  /** Whether commands are case-sensitive (default: false) */
  caseSensitive?: boolean;
  /** Whether to handle commands in group messages (default: true) */
  enableInGroup?: boolean;
  /** Whether to handle commands in direct messages (default: true) */
  enableInDirect?: boolean;
  /** Whether the bot must be @mentioned in groups to trigger commands (default: true) */
  requireMentionInGroup?: boolean;
  /** Custom help header text */
  helpHeader?: string;
  /** Custom help footer text */
  helpFooter?: string;
  /** Whether to include command usage lines in help output (default: false) */
  showUsage?: boolean;
};
