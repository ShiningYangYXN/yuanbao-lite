/**
 * Command registry and dispatcher.
 *
 * Manages command registration, matching, and dispatch.
 * Inspired by the original openclaw-plugin-yuanbao command system
 * but fully independent without OpenClaw dependency.
 *
 * Command handlers are split into src/commands/handlers/<category>/<command>.ts
 * (one file per command, organized by metadata category). This file contains
 * only the CommandSystem class (registration, matching, dispatch, unsafe/block
 * checks) and delegates handler registration to registerAll().
 */

import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { ChatMessage, YuanbaoMsgBodyElement } from "../types.js";
import type { YuanbaoBot } from "../index.js";
import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
  CommandSystemConfig,
}
  from "./types.js";

// Command handlers (split into src/commands/handlers/<category>/<command>.ts)
import { registerAll } from "./handlers/index.js";

// ─── Defaults ───

const DEFAULT_PREFIX = "/";
const DEFAULT_HELP_HEADER = "🤖 Yuanbao Lite 命令列表";
const DEFAULT_HELP_FOOTER = `输入 /help <命令名> 查看详细用法`;

// ─── CommandSystem class ───

export class CommandSystem {
  private commands = new Map<string, CommandDefinition>();
  private aliasMap = new Map<string, string>(); // alias -> command name
  /** Command system config — public so split handler files can access it. */
  config: Required<CommandSystemConfig>;
  /** Logger — public so split handler files can access it. */
  log: ModuleLog;
  /** Whether dmOnly restriction is temporarily lifted (set by /unsafe, expires after timeout) */
  private _unsafeMode = false;
  /** Timer for auto-expiring unsafe mode */
  private _unsafeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-command authorization with expiry: command name → { expiresAt (0=forever), timer } */
  private _allowedCommands = new Map<string, { expiresAt: number; timer: ReturnType<typeof setTimeout> | null }>();
  /** Commands that cannot be authorized via /unsafe allow — public so handlers can check. */
  static UNAUTHORIZABLE_COMMANDS = new Set(["unsafe", "trust", "block", "config", "init", "daemon"]);

  constructor(config?: CommandSystemConfig) {
    this.config = {
      prefix: config?.prefix ?? DEFAULT_PREFIX,
      caseSensitive: config?.caseSensitive ?? false,
      enableInGroup: config?.enableInGroup ?? true,
      enableInDirect: config?.enableInDirect ?? true,
      requireMentionInGroup: config?.requireMentionInGroup ?? true,
      helpHeader: config?.helpHeader ?? DEFAULT_HELP_HEADER,
      helpFooter: config?.helpFooter ?? DEFAULT_HELP_FOOTER,
      showUsage: config?.showUsage ?? true,
    };
    this.log = createLog("commands");

    // Register built-in commands
    this.registerBuiltinCommands();
  }

  /**
   * Enable unsafe mode — temporarily allows dmOnly commands in group chat.
   * @param durationMs - How long unsafe mode lasts (default: 5 minutes, 0 = forever)
   */
  enableUnsafeMode(durationMs = 5 * 60 * 1000): void {
    this._unsafeMode = true;
    if (this._unsafeTimer) clearTimeout(this._unsafeTimer);
    if (durationMs > 0) {
      this._unsafeTimer = setTimeout(() => {
        this._unsafeMode = false;
        this._unsafeTimer = null;
        this.log.info("unsafe mode expired, dmOnly restrictions restored");
      }, durationMs);
    }
    this.log.info(`unsafe mode enabled${durationMs > 0 ? ` for ${durationMs}ms` : " (forever)"}`);
  }

  /**
   * Disable unsafe mode — restores dmOnly restrictions.
   */
  disableUnsafeMode(): void {
    this._unsafeMode = false;
    if (this._unsafeTimer) {
      clearTimeout(this._unsafeTimer);
      this._unsafeTimer = null;
    }
    this.log.info("unsafe mode disabled, dmOnly restrictions restored");
  }

  /**
   * Check if unsafe mode is currently active.
   */
  isUnsafeMode(): boolean {
    return this._unsafeMode;
  }

  /**
   * Check if unsafe mode is permanent (no expiry timer).
   */
  isUnsafeForever(): boolean {
    return this._unsafeMode && this._unsafeTimer === null;
  }

  /**
   * Authorize a single command to bypass dmOnly in group chat.
   * Commands in UNAUTHORIZABLE_COMMANDS cannot be authorized.
   * Non-dmOnly commands are auto-skipped (no need to authorize).
   * @param durationMs - How long the authorization lasts (default: 5 minutes, 0 = forever)
   */
  allowCommand(cmdName: string, durationMs = 5 * 60 * 1000): { ok: boolean; reason?: string } {
    const normalized = cmdName.toLowerCase().replace(/^\//, "");
    if (CommandSystem.UNAUTHORIZABLE_COMMANDS.has(normalized)) {
      return { ok: false, reason: `命令 /${normalized} 不支持被授权` };
    }
    const def = this.get(normalized);
    if (!def) {
      return { ok: false, reason: `未知命令: /${normalized}` };
    }
    if (!def.dmOnly) {
      return { ok: false, reason: `命令 /${normalized} 不是受限命令，无需授权` };
    }
    // Clear existing timer if re-authorizing
    const existing = this._allowedCommands.get(normalized);
    if (existing?.timer) clearTimeout(existing.timer);

    const expiresAt = durationMs > 0 ? Date.now() + durationMs : 0; // 0 = forever
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (durationMs > 0) {
      timer = setTimeout(() => {
        this._allowedCommands.delete(normalized);
        this.log.info(`command /${normalized} authorization expired`);
      }, durationMs);
    }
    this._allowedCommands.set(normalized, { expiresAt, timer });
    this.log.info(`command /${normalized} authorized${durationMs > 0 ? ` for ${durationMs}ms` : " (forever)"}`);
    return { ok: true };
  }

  /**
   * Remove per-command authorization.
   * Non-dmOnly commands cannot be disallowed (they were never restricted).
   * Returns { ok, reason? } for clear feedback.
   */
  disallowCommand(cmdName: string): { ok: boolean; reason?: string } {
    const normalized = cmdName.toLowerCase().replace(/^\//, "");
    const def = this.get(normalized);
    if (!def) {
      return { ok: false, reason: `未知命令: /${normalized}` };
    }
    if (!def.dmOnly) {
      return { ok: false, reason: `命令 /${normalized} 不是受限命令，无法取消授权` };
    }
    const entry = this._allowedCommands.get(normalized);
    if (!entry) {
      return { ok: false, reason: `命令 /${normalized} 未被授权` };
    }
    if (entry.timer) clearTimeout(entry.timer);
    this._allowedCommands.delete(normalized);
    this.log.info(`command /${normalized} authorization revoked`);
    return { ok: true };
  }

  /**
   * Get all currently authorized commands with their expiry info.
   */
  getAllowedCommands(): Array<{ name: string; expiresAt: number; forever: boolean }> {
    const now = Date.now();
    return Array.from(this._allowedCommands.entries())
      .filter(([_, v]) => v.expiresAt === 0 || v.expiresAt > now)
      .map(([name, v]) => ({ name, expiresAt: v.expiresAt, forever: v.expiresAt === 0 }));
  }

  /**
   * Check if a specific command is authorized for group use.
   */
  isCommandAllowed(cmdName: string): boolean {
    const normalized = cmdName.toLowerCase();
    const entry = this._allowedCommands.get(normalized);
    if (!entry) return false;
    if (entry.expiresAt === 0) return true; // forever
    if (entry.expiresAt <= Date.now()) {
      // Expired — clean up
      if (entry.timer) clearTimeout(entry.timer);
      this._allowedCommands.delete(normalized);
      return false;
    }
    return true;
  }

  // ─── Registration ───

  /**
   * Register a command definition.
   *
   * If a command with the same name already exists, it will be overwritten.
   * Aliases are also registered for fast lookup.
   */
  register(def: CommandDefinition): void {
    const name = this.normalizeName(def.name);
    this.commands.set(name, { ...def, name });

    // Register aliases
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliasMap.set(this.normalizeName(alias), name);
      }
    }

    this.log.info(`registered command: ${name}${def.aliases?.length ? ` (aliases: ${def.aliases.join(", ")})` : ""}`);
  }

  /**
   * Unregister a command by name.
   */
  unregister(name: string): boolean {
    const normalName = this.normalizeName(name);
    const def = this.commands.get(normalName);
    if (!def) return false;

    // Remove aliases
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliasMap.delete(this.normalizeName(alias));
      }
    }

    this.commands.delete(normalName);
    this.log.info(`unregistered command: ${normalName}`);
    return true;
  }

  /**
   * Get all registered commands (including hidden ones).
   */
  getAll(): CommandDefinition[] {
    return [...this.commands.values()];
  }

  /**
   * Get all visible commands (excludes hidden commands).
   */
  getVisibleCommands(): CommandDefinition[] {
    return this.getAll().filter(c => !c.hidden);
  }

  /**
   * Get a command by name or alias.
   */
  get(name: string): CommandDefinition | undefined {
    const normalName = this.normalizeName(name);
    return this.commands.get(normalName) ?? this.commands.get(this.aliasMap.get(normalName) ?? "");
  }

  /**
   * Resolve a command name or alias (with optional leading /) to the
   * canonical command name. Returns undefined if not found.
   *
   * Examples:
   *   "shell"   → "shell"
   *   "/shell"  → "shell"
   *   "sh"      → "shell"  (alias)
   *   "/v"      → "version" (alias)
   *   "xyz"     → undefined (not found)
   */
  resolveCommandName(input: string): string | undefined {
    const stripped = input.replace(/^\//, "").trim();
    const normalName = this.normalizeName(stripped);
    if (this.commands.has(normalName)) return normalName;
    const aliasTarget = this.aliasMap.get(normalName);
    if (aliasTarget) return aliasTarget;
    return undefined;
  }

  // ─── Dispatch ───

  /**
   * Try to parse and dispatch a message as a command.
   *
   * Returns a CommandResult indicating whether the message was handled.
   * If the message does not start with the command prefix, returns { handled: false }.
   *
   * @param onReply - Optional callback to override reply behavior (e.g. for CLI).
   *   When provided, ctx.reply() and ctx.replyDirect() will call this instead
   *   of sending IM messages.
   */
  async dispatch(bot: YuanbaoBot, message: ChatMessage, onReply?: (text: string) => Promise<void>): Promise<CommandResult> {
    return this.dispatchWithSource(bot, message, onReply, "chat");
  }

  /**
   * Dispatch a command with an explicit source ("chat" or "cli").
   *
   * When source is "cli", the dmOnly and requireConnected checks are relaxed
   * (the CLI is already authorized), and command handlers can use ctx.source
   * to decide whether to apply ANSI coloring (chat = no color, cli = color).
   */
  async dispatchWithSource(
    bot: YuanbaoBot,
    message: ChatMessage,
    onReply?: (text: string) => Promise<void>,
    source: "chat" | "cli" = "chat",
  ): Promise<CommandResult> {
    // Check if commands are enabled for this chat type
    if (message.chatType === "group" && !this.config.enableInGroup) {
      return { handled: false };
    }
    if (message.chatType === "direct" && !this.config.enableInDirect) {
      return { handled: false };
    }

    // Check mention requirement for groups.
    // Per dispatch policy: in group chats, the bot ONLY responds when it is
    // explicitly @mentioned — this applies to BOTH plain text (LLM auto-reply,
    // handled by the engine's requireMentionInGroup) AND slash commands.
    // Rationale: in a busy group, allowing un-at'd slash commands would let
    // any member trigger bot actions (e.g. /send, /atall) without the bot
    // owner's intent. Requiring @mention makes the bot's activation explicit.
    // DM (chatType=direct) is unaffected — no @mention needed in private chat.
    if (message.chatType === "group" && this.config.requireMentionInGroup && !message.isMentioned) {
      return { handled: false };
    }

    // Parse command from message text
    const parsed = this.parseCommand(message.text);
    if (!parsed) {
      return { handled: false };
    }

    const { commandName, args } = parsed;

    // Look up command
    const normalName = this.normalizeName(commandName);
    const def = this.commands.get(normalName) ?? this.commands.get(this.aliasMap.get(normalName) ?? "");

    if (!def) {
      // Unknown command — send a hint to the user
      this.log.debug(`unknown command: ${commandName}`);
      const ctx = this.makeContext(bot, message, commandName, args, onReply, source);
      await ctx.reply(`❓ 未知命令: /${commandName}\n输入 /help 查看可用命令`);
      return { handled: true };
    }

    // ─── Block check (HIGHEST priority — overrides unsafe + trust) ───
    // Blocked users cannot execute commands. The block module supports
    // per-user, per-command, and wildcard ("*") blocks. This check runs
    // BEFORE the dmOnly check so blocked commands are denied even in DM.
    // CLI source bypasses block (CLI is pre-authorized).
    if (source !== "cli") {
      try {
        const { isBlockedFromCommand, isBlockedFrom } = await import("../business/block.js");
        // Check if the user is blocked from this specific command, OR from
        // all commands, OR from everything ("all" scope).
        if (isBlockedFromCommand(message.fromUserId, commandName) || isBlockedFrom(message.fromUserId, "all")) {
          const ctx = this.makeContext(bot, message, commandName, args, onReply, source);
          await ctx.reply(`🚫 你被封禁，无法使用 /${commandName}。如有疑问请联系主人。`);
          return { handled: true };
        }
        // Also check wildcard "*" blocks (apply to all users)
        if (isBlockedFromCommand("*", commandName) || isBlockedFrom("*", "all")) {
          const ctx = this.makeContext(bot, message, commandName, args, onReply, source);
          await ctx.reply(`🚫 此命令已被全局封禁，无法使用。`);
          return { handled: true };
        }
      } catch {
        // block module optional — proceed if not available
      }
    }

    // Check for --help/-h/-? flag BEFORE executing the command
    // For /shell and /sh: only check if the flag is the FIRST argument
    // (flags after the actual command are passed through to the shell)
    const isShellCmd = commandName === "shell" || commandName === "sh";
    let helpRequested = false;
    if (isShellCmd) {
      // For shell, only --help/-h/-? as the FIRST arg counts
      const firstArg = args[0];
      if (firstArg === "--help" || firstArg === "-h" || firstArg === "-?") {
        helpRequested = true;
      }
    } else {
      // For all other commands, check if any arg is --help/-h/-?
      // (these are stripped from args by makeContext if they match --all/-a pattern,
      // so we check the raw args here)
      helpRequested = args.some(a => a === "--help" || a === "-h" || a === "-?");
    }

    if (helpRequested) {
      const ctx = this.makeContext(bot, message, commandName, [], onReply, source);
      const lines = [
        `📖 命令: ${this.config.prefix}${def.name}`,
        `描述: ${def.description}`,
      ];
      if (def.usage) lines.push(`用法: ${def.usage}`);
      if (def.aliases?.length) lines.push(`别名: ${def.aliases.join(", ")}`);
      if (def.category) lines.push(`分类: ${def.category}`);
      const flags: string[] = [];
      if (def.dmOnly) flags.push("仅私聊");
      if (def.requireConnected) flags.push("需连接");
      if (def.hidden) flags.push("隐藏");
      if (flags.length > 0) lines.push(`标记: ${flags.join(", ")}`);
      await ctx.reply(lines.join("\n"));
      return { handled: true };
    }

    // Check dmOnly restriction (bypassed when unsafe mode is active, CLI source,
    // the specific command is authorized via /unsafe allow, OR the user has a
    // per-user command grant from /trust grant)
    if (def.dmOnly && message.chatType === "group" && !this._unsafeMode && source !== "cli" && !this.isCommandAllowed(commandName)) {
      // Check if the user has a per-user command grant (from /trust grant)
      let hasUserGrant = false;
      try {
        const { hasCommandGrant } = await import("../business/trust.js");
        hasUserGrant = hasCommandGrant(message.fromUserId, commandName);
      } catch {
        // trust module optional
      }
      if (hasUserGrant) {
        // User has a grant — proceed past the dmOnly check
      } else {
        // Check if the user is trusted — trusted users get a hint to enable /unsafe
        let isTrustedUser = false;
        try {
          const { isTrusted } = await import("../business/trust.js");
          isTrustedUser = isTrusted(message.fromUserId);
        } catch {
          // trust module optional
        }
        if (isTrustedUser) {
          await this.makeContext(bot, message, commandName, args, onReply, source).reply(
            `⚠️ 此命令仅限私聊使用。\n受信用户可：\n  /unsafe on [分钟] — 开启全局危险模式（默认5分钟）\n  /unsafe on forever — 永久开启\n  /unsafe allow /${commandName} [分钟|forever] — 全局授权此命令（默认5分钟）\n  /trust grant <你的ID> /${commandName} [分钟|forever] — 仅授权给你（需主人执行）\n查看状态: /unsafe status`,
          );
        } else {
          // Auto-include the user's own ID so they can forward it to the master
          await this.makeContext(bot, message, commandName, args, onReply, source).reply(
            `⚠️ 此命令仅限私聊使用。\n你的用户ID: ${message.fromUserId}\n如需在群聊中执行：\n  1. 联系主人发送: /trust add ${message.fromUserId}\n  2. 加入信任列表后，发送: /unsafe allow /${commandName}\n  或: /unsafe on 开启全局危险模式\n  或请主人执行: /trust grant ${message.fromUserId} /${commandName}`,
          );
        }
        return { handled: true };
      }
    }

    // Check connected requirement (bypassed for CLI source — CLI may run config commands before bot connects)
    if (def.requireConnected && !bot.getState().connected && source !== "cli") {
      await this.makeContext(bot, message, commandName, args, onReply, source).reply(
        "⚠️ 机器人尚未连接，请稍后再试",
      );
      return { handled: true };
    }

    // ─── Resolve @-references in args to user IDs ───
    // Allows users to reference other users by @mention syntax instead of
    // typing the full user ID. Supports:
    //   @[nick](id)  → id (extracted directly from the syntax)
    //   @nick        → looked up in message.mentions[] by displayName, or
    //                  in group member list if available
    //   @<botId>     → the bot ID itself (bare ID with @ prefix)
    // CLI source skips this (CLI args are pre-resolved).
    let resolvedArgs = args;
    if (source !== "cli" && args.length > 0) {
      resolvedArgs = await this.resolveAtReferences(args, message, bot);
    }

    // Build context and execute
    const ctx = this.makeContext(bot, message, commandName, resolvedArgs, onReply, source);

    try {
      this.log.info(`executing command: ${commandName} (args: ${args.join(" ")})`);
      await def.handler(ctx);
      return { handled: true };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`command "${commandName}" error: ${error.message}`);
      try {
        await ctx.reply(`❌ 命令执行失败: ${error.message}`);
      } catch {
        // Ignore reply errors
      }
      return { handled: true, error };
    }
  }

  // ─── @-reference resolution ───

  /**
   * Resolve @-references in command args to actual user IDs.
   *
   * Supports:
   *   @[nick](id)  → id (extracted directly from the mention syntax)
   *   @nick        → looked up in message.mentions[] by displayName, then
   *                  in group member list (if available)
   *   @<botId>     → the bare ID (anything starting with @ that looks like an ID)
   *
   * Args that don't start with @ are returned unchanged.
   * Args that start with @ but can't be resolved are returned unchanged (the
   * command handler will deal with the invalid ID).
   */
  private async resolveAtReferences(
    args: string[],
    message: ChatMessage,
    bot: YuanbaoBot,
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const arg of args) {
      const trimmed = arg.trim();
      if (!trimmed.startsWith("@")) {
        resolved.push(arg);
        continue;
      }

      // Pattern 1: @[nick](id) — extract id directly
      const fullMentionMatch = trimmed.match(/^@\[([^\]]*)\]\(([^)]+)\)$/);
      if (fullMentionMatch) {
        const id = fullMentionMatch[2];
        resolved.push(id);
        this.log.debug(`resolved @[nick](${id}) → ${id}`);
        continue;
      }

      // Pattern 2: @nick — look up in message.mentions[] by displayName
      const nick = trimmed.slice(1); // strip leading @
      if (nick && message.mentions) {
        // Try exact displayName match
        const mention = message.mentions.find(m => m.displayName === nick || m.userId === nick);
        if (mention) {
          resolved.push(mention.userId);
          this.log.debug(`resolved @${nick} → ${mention.userId} (from message.mentions)`);
          continue;
        }
        // Try case-insensitive match
        const mentionCI = message.mentions.find(m => m.displayName.toLowerCase() === nick.toLowerCase());
        if (mentionCI) {
          resolved.push(mentionCI.userId);
          this.log.debug(`resolved @${nick} → ${mentionCI.userId} (case-insensitive from message.mentions)`);
          continue;
        }
      }

      // Pattern 3: @<bareId> — if the arg after @ looks like an ID (contains
      // alphanumeric + underscore/hyphen, length > 5), treat it as a bare ID
      if (nick.length > 5 && /^[a-zA-Z0-9_-]+$/.test(nick)) {
        resolved.push(nick);
        this.log.debug(`resolved @${nick} → ${nick} (bare ID)`);
        continue;
      }

      // Pattern 4: @nick in group — try group member list lookup
      if (nick && message.chatType === "group" && message.groupCode) {
        try {
          const resp = await bot.getGroupMemberList(message.groupCode);
          const members = resp?.member_list ?? [];
          const member = members.find(m => m.nick_name === nick || m.user_id === nick);
          if (member) {
            resolved.push(member.user_id);
            this.log.debug(`resolved @${nick} → ${member.user_id} (from group members)`);
            continue;
          }
        } catch {
          // group member lookup failed — fall through
        }
      }

      // Could not resolve — return as-is (command handler will handle)
      resolved.push(arg);
    }
    return resolved;
  }

  // ─── Parsing ───

  /**
   * Parse a command from text.
   *
   * Returns null if the text does not start with the command prefix.
   */
  private parseCommand(text: string): { commandName: string; args: string[] } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith(this.config.prefix)) {
      return null;
    }

    // Remove prefix and split
    const withoutPrefix = trimmed.slice(this.config.prefix.length).trim();
    if (!withoutPrefix) {
      return null;
    }

    // Split by whitespace, respecting quoted strings
    const tokens = this.tokenize(withoutPrefix);
    if (tokens.length === 0) {
      return null;
    }

    return {
      commandName: tokens[0],
      args: tokens.slice(1),
    };
  }

  /**
   * Tokenize a string with full support for:
   * - Double-quoted strings with escape sequences: `"hello \"world\""`
   * - Single-quoted strings (literal, no escapes): `'hello world'`
   * - Backslash escapes outside quotes: `hello\ world`
   * - Common escape sequences: \n, \t, \r, \\, \", \'
   */
  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let i = 0;

    while (i < input.length) {
      const ch = input[i];

      // Skip unescaped whitespace (token separator)
      if (ch === " " || ch === "\t") {
        if (current) {
          tokens.push(current);
          current = "";
        }
        i++;
        continue;
      }

      // Double-quoted string — use JSON.parse for native JS escape parsing
      // Supports: \n \t \r \\ \" \/ \uXXXX \xXX (standard JS escapes)
      if (ch === '"') {
        // Find the matching closing quote, respecting escaped quotes
        let end = i + 1;
        while (end < input.length) {
          if (input[end] === "\\" && end + 1 < input.length) {
            end += 2; // skip escaped char
          } else if (input[end] === '"') {
            break;
          } else {
            end++;
          }
        }
        const quoted = input.slice(i, end + 1); // includes both quotes
        try {
          // JSON.parse handles all JS string escapes natively
          current += JSON.parse(quoted) as string;
        } catch {
          // Fallback: extract raw content if JSON.parse fails
          current += quoted.slice(1, -1);
        }
        i = end + 1;
        continue;
      }

      // Single-quoted string — convert to double-quoted for JSON.parse
      if (ch === "'") {
        let end = i + 1;
        while (end < input.length) {
          if (input[end] === "\\" && end + 1 < input.length) {
            end += 2;
          } else if (input[end] === "'") {
            break;
          } else {
            end++;
          }
        }
        const raw = input.slice(i + 1, end);
        // Convert single-quoted to JSON-parseable double-quoted string
        // Escape any existing double quotes and backslashes
        const jsonStr = '"' + raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        try {
          current += JSON.parse(jsonStr) as string;
        } catch {
          current += raw;
        }
        i = end + 1;
        continue;
      }

      // Backslash escape outside quotes — use JS native parsing
      if (ch === '\\' && i + 1 < input.length) {
        // Build a minimal quoted string and let JSON.parse handle the escape
        const escaped = input.slice(i, i + 2);
        try {
          current += JSON.parse(`"${escaped}"`) as string;
        } catch {
          // Unknown escape — keep literal backslash + char
          current += escaped;
        }
        i += 2;
        continue;
      }

      // Normal character
      current += ch;
      i++;
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  // ─── Context builder ───

  private makeContext(
    bot: YuanbaoBot,
    message: ChatMessage,
    command: string,
    args: string[],
    onReply?: (text: string) => Promise<void>,
    source: "chat" | "cli" = "chat",
  ): CommandContext {
    const isGroup = message.chatType === "group";
    const groupCode = message.groupCode;

    const reply = onReply ?? (async (text: string) => {
      if (isGroup && groupCode) {
        await bot.sendGroupMessage(groupCode, text);
      } else {
        await bot.sendDirectMessage(message.fromUserId, text);
      }
      // Inject the bot's reply into LLM context as an ASSISTANT message.
      // This is CRITICAL: we can't rely on the IM platform's CallbackAfterSendMsg
      // callback to capture the bot's output (some platforms don't send it, or
      // it arrives asynchronously). By injecting here, we guarantee the LLM
      // sees its own replies in the conversation history.
      // The conversation key matches what feedLlmContext uses:
      //   group → group:<groupCode>, DM → dm:<fromUserId>
      const engine = bot.getLlmEngine();
      if (engine) {
        const convKey = isGroup && groupCode
          ? `group:${groupCode}`
          : `dm:${message.fromUserId}`;
        try {
          const { formatChatMessageForContext } = await import("../business/llm-takeover.js");
          // Build a synthetic ChatMessage for the bot's reply
          const botMsg: ChatMessage = {
            id: `bot-reply-${Date.now()}`,
            fromUserId: bot.getAccount().botId || "bot",
            fromNickname: "bot",
            chatType: message.chatType,
            ...(isGroup && groupCode ? { groupCode, groupName: message.groupName } : {}),
            text,
            timestamp: Date.now(),
          };
          const formatted = formatChatMessageForContext(botMsg);
          engine.getConversationManager().addAssistantMessage(convKey, formatted);
        } catch {
          // context injection failure is non-critical
        }
      }
    });

    // replyDoc: escape @mention syntax in documentation/help text so
    // parseMentions() doesn't interpret literal @[昵称](id), @[所有人](),
    // @[](all) etc. as real mentions when sent to a group.
    // Also injects the reply into LLM context (same as reply).
    const replyDoc = onReply ?? (async (text: string) => {
      const { escapeMentionSyntax } = await import("../business/mention.js");
      const escaped = escapeMentionSyntax(text);
      if (isGroup && groupCode) {
        await bot.sendGroupMessage(groupCode, escaped);
      } else {
        await bot.sendDirectMessage(message.fromUserId, escaped);
      }
      // Inject into LLM context (same as reply, but with escaped text)
      const engine = bot.getLlmEngine();
      if (engine) {
        const convKey = isGroup && groupCode
          ? `group:${groupCode}`
          : `dm:${message.fromUserId}`;
        try {
          const { formatChatMessageForContext } = await import("../business/llm-takeover.js");
          const botMsg: ChatMessage = {
            id: `bot-reply-${Date.now()}`,
            fromUserId: bot.getAccount().botId || "bot",
            fromNickname: "bot",
            chatType: message.chatType,
            ...(isGroup && groupCode ? { groupCode, groupName: message.groupName } : {}),
            text: escaped,
            timestamp: Date.now(),
          };
          const formatted = formatChatMessageForContext(botMsg);
          engine.getConversationManager().addAssistantMessage(convKey, formatted);
        } catch {
          // context injection failure is non-critical
        }
      }
    });

    const replyRaw = async (msgBody: YuanbaoMsgBodyElement[]) => {
      if (isGroup && groupCode) {
        await bot.sendRawMessage({
          to: groupCode,
          msgBody,
          isGroup: true,
        });
      } else {
        await bot.sendRawMessage({
          to: message.fromUserId,
          msgBody,
          isGroup: false,
        });
      }
    };

    const replyDirect = onReply ?? (async (text: string) => {
      await bot.sendDirectMessage(message.fromUserId, text);
    });

    // Detect and strip --all/-a flag (disables truncation for long-output commands)
    // For /shell and /sh, do NOT strip --all/-a from args because they may be
    // part of the actual shell command. The /shell handler will detect the flag
    // only when it appears as the first argument (i.e. /shell --all <cmd>).
    const isShellCommand = command === "shell" || command === "sh";
    let showAll: boolean;
    let filteredArgs: string[];
    if (isShellCommand) {
      // Only treat --all/-a as the showAll flag if it's the FIRST argument
      // This allows: /shell --all <cmd> (no truncation)
      //         and: /shell <cmd> --all (passes --all to the actual command)
      const firstArg = args[0];
      showAll = firstArg === "--all" || firstArg === "-a";
      filteredArgs = showAll ? args.slice(1) : args;
    } else {
      showAll = args.includes("--all") || args.includes("-a");
      filteredArgs = args.filter(a => a !== "--all" && a !== "-a");
    }

    return {
      bot,
      message,
      command,
      args: filteredArgs,
      reply,
      replyDoc,
      replyRaw,
      replyDirect,
      isGroup,
      groupCode,
      showAll,
      source,
    };
  }

  // ─── Helpers ───

  private normalizeName(name: string): string {
    return this.config.caseSensitive ? name : name.toLowerCase();
  }

  // ─── Built-in commands ───

  private registerBuiltinCommands(): void {
    // All command handlers have been split into src/commands/handlers/<category>/<command>.ts
    // (one file per command, organized by metadata category). This method
    // delegates to registerAll() which calls each handler's register().
    //
    // To add/modify a command, edit its file in src/commands/handlers/.
    // To add a new command, create a new file and add it to handlers/index.ts.
    registerAll(this);
  }

}
