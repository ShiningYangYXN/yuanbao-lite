/**
 * Command registry and dispatcher.
 *
 * Manages command registration, matching, and dispatch.
 * Inspired by the original openclaw-plugin-yuanbao command system
 * but fully independent without OpenClaw dependency.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { ChatMessage, YuanbaoMsgBodyElement } from "../types.js";
import type { YuanbaoBot } from "../index.js";
import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
  CommandSystemConfig,
  CommandCategory,
}
  from "./types.js";
import { generateColoredHelp } from "./help-text.js";
import {
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../business/sticker.js";
import {
  uploadToLitterbox,
  uploadAndFormatLink as tempfileFormatLink,
} from "../access/http/tempfile.js";

// ─── Defaults ───

const DEFAULT_PREFIX = "/";
const DEFAULT_HELP_HEADER = "🤖 Yuanbao Lite 命令列表";
const DEFAULT_HELP_FOOTER = `输入 /help <命令名> 查看详细用法`;

// ─── CommandSystem class ───

export class CommandSystem {
  private commands = new Map<string, CommandDefinition>();
  private aliasMap = new Map<string, string>(); // alias -> command name
  private config: Required<CommandSystemConfig>;
  private log: ModuleLog;
  /** Whether dmOnly restriction is temporarily lifted (set by /unsafe, expires after timeout) */
  private _unsafeMode = false;
  /** Timer for auto-expiring unsafe mode */
  private _unsafeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-command authorization: command names allowed in group chat even without unsafe mode */
  private _allowedCommands = new Set<string>();
  /** Commands that cannot be authorized via /unsafe allow */
  private static UNAUTHORIZABLE_COMMANDS = new Set(["unsafe", "trust", "config", "init", "daemon"]);

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
   */
  allowCommand(cmdName: string): { ok: boolean; reason?: string } {
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
    this._allowedCommands.add(normalized);
    this.log.info(`command /${normalized} authorized for group use`);
    return { ok: true };
  }

  /**
   * Remove per-command authorization.
   */
  disallowCommand(cmdName: string): boolean {
    const normalized = cmdName.toLowerCase().replace(/^\//, "");
    return this._allowedCommands.delete(normalized);
  }

  /**
   * Get all currently authorized commands.
   */
  getAllowedCommands(): string[] {
    return Array.from(this._allowedCommands);
  }

  /**
   * Check if a specific command is authorized for group use.
   */
  isCommandAllowed(cmdName: string): boolean {
    return this._allowedCommands.has(cmdName.toLowerCase());
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

    // Check mention requirement for groups
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
    // or the specific command is authorized via /unsafe allow)
    if (def.dmOnly && message.chatType === "group" && !this._unsafeMode && source !== "cli" && !this.isCommandAllowed(commandName)) {
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
          `⚠️ 此命令仅限私聊使用。\n受信用户可在群聊中发送 /unsafe on 开启危险模式（5分钟有效），开启后可在此群聊使用 dmOnly 命令。`,
        );
      } else {
        // Auto-include the user's own ID so they can forward it to the master
        await this.makeContext(bot, message, commandName, args, onReply, source).reply(
          `⚠️ 此命令仅限私聊使用。\n你的用户ID: ${message.fromUserId}\n如需在群聊中执行，请联系主人发送: /trust add ${message.fromUserId}\n加入信任列表后，用 /unsafe on 开启危险模式。`,
        );
      }
      return { handled: true };
    }

    // Check connected requirement (bypassed for CLI source — CLI may run config commands before bot connects)
    if (def.requireConnected && !bot.getState().connected && source !== "cli") {
      await this.makeContext(bot, message, commandName, args, onReply, source).reply(
        "⚠️ 机器人尚未连接，请稍后再试",
      );
      return { handled: true };
    }

    // Build context and execute
    const ctx = this.makeContext(bot, message, commandName, args, onReply, source);

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
    // /help [command]
    this.register({
      name: "help",
      aliases: ["h", "?", "帮助"],
      description: "显示命令帮助信息",
      usage: "/help [命令名]   (查看指定命令详细用法)",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length > 0) {
          // Show help for specific command
          const cmdName = ctx.args[0];
          const def = this.get(cmdName);
          if (!def) {
            await ctx.reply(`未知命令: ${cmdName}\n输入 /help 查看所有命令`);
            return;
          }
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
          return;
        }

        // Show all commands — auto-generated colored help
        const visible = this.getAll().filter(c => !c.hidden);
        if (visible.length === 0) {
          await ctx.reply("暂无可用命令");
          return;
        }

        // Generate colored help from command definitions
        const helpText = generateColoredHelp(visible, {
          prefix: this.config.prefix,
          footer: this.config.helpFooter,
        });
        await ctx.reply(helpText);
      },
    });

    // /status
    this.register({
      name: "status",
      aliases: ["state", "状态"],
      description: "查看机器人连接状态和账号信息",
      usage: "/status   (显示连接状态、Bot ID、名称等)",
      category: "misc" as CommandCategory,
      requireConnected: false,
      handler: async (ctx) => {
        const state = ctx.bot.getState();
        const account = ctx.bot.getAccount();
        const lines = [
          "📊 机器人状态",
          `  连接: ${state.connected ? "✅ 已连接" : "❌ 未连接"}`,
          `  状态: ${state.status}`,
        ];
        if (state.connectId) lines.push(`  连接ID: ${state.connectId}`);
        if (state.botId) lines.push(`  Bot ID: ${state.botId}`);
        if (state.lastConnectedAt) {
          lines.push(`  上次连接: ${new Date(state.lastConnectedAt).toLocaleString("zh-CN")}`);
        }
        if (state.lastError) lines.push(`  最近错误: ${state.lastError}`);
        if (account.name) lines.push(`  名称: ${account.name}`);
        await ctx.reply(lines.join("\n"));
      },
    });

    // /echo <text>
    this.register({
      name: "echo",
      aliases: ["say", "重复"],
      description: "回显消息文本",
      usage: "/echo <文本内容>   (原样返回输入文本)",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /echo <文本内容>");
          return;
        }
        await ctx.reply(ctx.args.join(" "));
      },
    });

    // /calc <expression> — quick math evaluation
    this.register({
      name: "calc",
      aliases: ["计算", "calc"],
      description: "快速计算数学表达式",
      usage: "/calc <表达式>   例: /calc 2+3*4, /calc sqrt(16), /calc 100/7",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /calc <表达式>\n支持: + - * / % ** sqrt() sin() cos() log() 等");
          return;
        }
        const expr = ctx.args.join(" ");
        // Whitelist safe characters only
        if (!/^[\d\s+\-*/%.()a-z,]+$/i.test(expr)) {
          await ctx.reply("❌ 表达式包含非法字符");
          return;
        }
        try {
          // Provide common math functions
          const sandbox = {
            sqrt: Math.sqrt,
            sin: Math.sin, cos: Math.cos, tan: Math.tan,
            asin: Math.asin, acos: Math.acos, atan: Math.atan,
            log: Math.log, log2: Math.log2, log10: Math.log10,
            exp: Math.exp, pow: Math.pow, abs: Math.abs,
            floor: Math.floor, ceil: Math.ceil, round: Math.round,
            max: Math.max, min: Math.min,
            PI: Math.PI, E: Math.E,
          };
          const fn = new Function(...Object.keys(sandbox), `"use strict"; return (${expr});`);
          const result = fn(...Object.values(sandbox));
          if (typeof result === "number") {
            const formatted = Number.isFinite(result)
              ? (Number.isInteger(result) ? String(result) : result.toFixed(10).replace(/\.?0+$/, ""))
              : String(result);
            await ctx.reply(`🧮 ${expr} = ${formatted}`);
          } else {
            await ctx.reply(`🧮 ${expr} = ${String(result)}`);
          }
        } catch (err) {
          await ctx.reply(`❌ 计算错误: ${(err as Error).message}`);
        }
      },
    });

    // /time [timezone] — show current time
    this.register({
      name: "time",
      aliases: ["时间", "now", "当前时间"],
      description: "显示当前时间（支持时区）",
      usage: "/time [时区]   例: /time, /time Asia/Tokyo, /time America/New_York",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        const tz = ctx.args[0] || "Asia/Shanghai";
        try {
          const now = new Date();
          const formatter = new Intl.DateTimeFormat("zh-CN", {
            timeZone: tz,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
          });
          await ctx.reply(`🕐 ${tz}:\n${formatter.format(now)}`);
        } catch {
          await ctx.reply(`❌ 无效时区: ${tz}\n示例: Asia/Shanghai, Asia/Tokyo, America/New_York, Europe/London`);
        }
      },
    });

    // /remind — persistent one-shot reminders (dmOnly, unlimited time, target support)
    this.register({
      name: "remind",
      aliases: ["提醒", "timer"],
      description: "设置定时提醒（支持任意时长、时间点、目标，持久化）",
      usage: "/remind <时间> <消息> [--to <目标ID>] [--group]\n/remind list|cancel <ID>",
      category: "misc" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const reminders = await import("../business/reminders.js");
        const { addReminder, removeReminder, listReminders, parseTimeString, startAllJobs } = reminders;
        type SendFunction = (targetId: string, message: string, isGroup: boolean) => Promise<void>;
        const subCmd = ctx.args[0]?.toLowerCase();

        if (subCmd === "list") {
          const jobs = listReminders(ctx.message.fromUserId);
          if (jobs.length === 0) {
            await ctx.reply("暂无提醒");
            return;
          }
          const lines = jobs.map(j => {
            const time = new Date(j.fireAt).toLocaleString("zh-CN");
            const target = j.isGroup ? `群${j.targetId}` : j.targetId ?? j.userId;
            return `  ${j.id}: ${time} → ${target} — "${j.message}"`;
          });
          await ctx.reply(`📋 提醒列表 (${jobs.length}):\n${lines.join("\n")}`);
          return;
        }

        if (subCmd === "cancel" && ctx.args[1]) {
          const ok = removeReminder(ctx.args[1]);
          await ctx.reply(ok ? `✅ 已取消提醒 ${ctx.args[1]}` : `未找到提醒: ${ctx.args[1]}`);
          return;
        }

        if (ctx.args.length < 2) {
          await ctx.reply(
            "用法: /remind <时间> <消息> [--to <目标ID>] [--group]\n" +
            "时间格式:\n" +
            "  相对: 30s, 5m, 2h, 1d, 1w, 1mo, 1y\n" +
            "  组合: 1d2h3m\n" +
            "  时间点: 14:30\n" +
            "  完整: 2026-06-18 14:30\n" +
            "目标: --to <用户ID/群号> (默认当前会话), --group (发到群)\n\n" +
            "管理: /remind list | /remind cancel <ID>",
          );
          return;
        }

        const timeStr = ctx.args[0];
        // Parse --to and --group flags
        const remaining = ctx.args.slice(1);
        let targetId: string | undefined;
        let isGroup = false;
        const msgParts: string[] = [];
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i] === "--to" && remaining[i + 1]) {
            targetId = remaining[i + 1];
            i++;
          } else if (remaining[i] === "--group") {
            isGroup = true;
          } else {
            msgParts.push(remaining[i]);
          }
        }
        const message = msgParts.join(" ");
        if (!message) {
          await ctx.reply("❌ 消息内容不能为空");
          return;
        }

        const parsed = parseTimeString(timeStr);
        if (parsed.error) {
          await ctx.reply(`❌ ${parsed.error}`);
          return;
        }

        // Default target: current chat
        if (!targetId) {
          targetId = ctx.isGroup ? (ctx.groupCode ?? ctx.message.fromUserId) : ctx.message.fromUserId;
          isGroup = ctx.isGroup;
        }

        const id = addReminder({
          type: "remind",
          userId: ctx.message.fromUserId,
          message,
          fireAt: parsed.fireAt,
          intervalMs: 0,
          targetId,
          isGroup,
        });

        // Schedule the timer
        const sendFn: SendFunction = async (tid, msg, grp) => {
          if (grp) await ctx.bot.sendGroupMessage(tid, msg);
          else await ctx.bot.sendDirectMessage(tid, msg);
        };
        startAllJobs(sendFn);

        await ctx.reply(
          `⏰ 提醒已设置 [${id}]:\n` +
          `  消息: "${message}"\n` +
          `  触发: ${new Date(parsed.fireAt).toLocaleString("zh-CN")}\n` +
          `  目标: ${isGroup ? "群" : "私聊"} ${targetId}\n` +
          `  (距现在 ${Math.round(parsed.delayMs / 1000)} 秒)\n` +
          `取消: /remind cancel ${id}`,
        );
      },
    });

    // /cron — persistent recurring scheduled messages (dmOnly, target support)
    this.register({
      name: "cron",
      aliases: ["定时任务", "周期提醒"],
      description: "设置周期性定时任务（cron表达式，持久化，可指定目标）",
      usage: "/cron <cron表达式> <消息> [--to <目标ID>] [--group]\n/cron list|cancel <ID>",
      category: "misc" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const reminders = await import("../business/reminders.js");
        const { addReminder, removeReminder, listReminders, parseCronExpression, startAllJobs } = reminders;
        type SendFunction = (targetId: string, message: string, isGroup: boolean) => Promise<void>;
        const subCmd = ctx.args[0]?.toLowerCase();

        if (subCmd === "list") {
          const jobs = listReminders(ctx.message.fromUserId).filter(j => j.type === "cron");
          if (jobs.length === 0) {
            await ctx.reply("暂无定时任务");
            return;
          }
          const lines = jobs.map(j => {
            const next = new Date(j.fireAt).toLocaleString("zh-CN");
            const target = j.isGroup ? `群${j.targetId}` : j.targetId ?? j.userId;
            return `  ${j.id}: ${j.cronExpr} → ${target} 下次: ${next}\n    "${j.message}"`;
          });
          await ctx.reply(`📋 定时任务 (${jobs.length}):\n${lines.join("\n")}`);
          return;
        }

        if (subCmd === "cancel" && ctx.args[1]) {
          const ok = removeReminder(ctx.args[1]);
          await ctx.reply(ok ? `✅ 已取消定时任务 ${ctx.args[1]}` : `未找到: ${ctx.args[1]}`);
          return;
        }

        if (ctx.args.length < 6) {
          await ctx.reply(
            "用法: /cron <cron表达式> <消息> [--to <目标ID>] [--group]\n" +
            "cron表达式: 分 时 日 月 周 (5个字段)\n" +
            "  * — 任意值\n" +
            "  star/N — 每N个单位\n" +
            "  N-M — 范围\n" +
            "  N,M — 列表\n\n" +
            "示例:\n" +
            "  /cron 30 9 * * 1-5 早安\n" +
            "  /cron 0 */2 * * * 每2小时喝水 --to 765035413 --group\n\n" +
            "管理: /cron list | /cron cancel <ID>",
          );
          return;
        }

        const cronExpr = ctx.args.slice(0, 5).join(" ");
        // Parse --to and --group flags from remaining args
        const remaining = ctx.args.slice(5);
        let targetId: string | undefined;
        let isGroup = false;
        const msgParts: string[] = [];
        for (let i = 0; i < remaining.length; i++) {
          if (remaining[i] === "--to" && remaining[i + 1]) {
            targetId = remaining[i + 1];
            i++;
          } else if (remaining[i] === "--group") {
            isGroup = true;
          } else {
            msgParts.push(remaining[i]);
          }
        }
        const message = msgParts.join(" ");
        if (!message) {
          await ctx.reply("❌ 消息内容不能为空");
          return;
        }

        const parsed = parseCronExpression(cronExpr);
        if (parsed.error) {
          await ctx.reply(`❌ ${parsed.error}`);
          return;
        }

        const nextFire = parsed.getNextFire(Date.now());
        if (nextFire === 0) {
          await ctx.reply("❌ 无法计算下次触发时间");
          return;
        }

        // Default target: current chat
        if (!targetId) {
          targetId = ctx.isGroup ? (ctx.groupCode ?? ctx.message.fromUserId) : ctx.message.fromUserId;
          isGroup = ctx.isGroup;
        }

        const id = addReminder({
          type: "cron",
          userId: ctx.message.fromUserId,
          message,
          fireAt: nextFire,
          intervalMs: 0,
          cronExpr,
          targetId,
          isGroup,
        });

        // Restart scheduler to pick up the new job
        const sendFn: SendFunction = async (tid, msg, grp) => {
          if (grp) await ctx.bot.sendGroupMessage(tid, msg);
          else await ctx.bot.sendDirectMessage(tid, msg);
        };
        startAllJobs(sendFn);

        await ctx.reply(
          `🔄 定时任务已设置 [${id}]:\n` +
          `  表达式: ${cronExpr}\n` +
          `  消息: "${message}"\n` +
          `  目标: ${isGroup ? "群" : "私聊"} ${targetId}\n` +
          `  下次触发: ${new Date(nextFire).toLocaleString("zh-CN")}\n` +
          `取消: /cron cancel ${id}`,
        );
      },
    });

    // /ip <address> — IP address lookup (multi-provider concurrent, IPv4+IPv6)
    this.register({
      name: "ip",
      aliases: ["ip查询"],
      description: "查询 IP 地址的地理位置信息（多服务商并发，支持 IPv4/IPv6）",
      usage: "/ip <IP地址>   例: /ip 8.8.8.8, /ip 2001:4860:4860::8888",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /ip <IP地址> (支持 IPv4 和 IPv6)");
          return;
        }
        const ip = ctx.args[0];
        // Validate IPv4 or IPv6
        const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
        const isIPv6 = /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");
        if (!isIPv4 && !isIPv6) {
          await ctx.reply("❌ 无效 IP 地址 (支持 IPv4 如 8.8.8.8 或 IPv6 如 2001:4860:4860::8888)");
          return;
        }

        type IpResult = {
          provider: string;
          country?: string;
          region?: string;
          city?: string;
          org?: string;
          as?: string;
          timezone?: string;
          latitude?: number | string;
          longitude?: number | string;
          error?: string;
        };

        const providers: Array<() => Promise<IpResult>> = [
          // ip-api.com (supports IPv6, no API key, 45 req/min)
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city,isp,as,timezone,lat,lon`, { signal: controller.signal });
              clearTimeout(timer);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const d = await resp.json() as Record<string, unknown>;
              if (d.status === "fail") throw new Error(String(d.message ?? "fail"));
              return {
                provider: "ip-api.com",
                country: String(d.country ?? ""),
                region: String(d.regionName ?? ""),
                city: String(d.city ?? ""),
                org: String(d.isp ?? ""),
                as: String(d.as ?? ""),
                timezone: String(d.timezone ?? ""),
                latitude: d.lat as number,
                longitude: d.lon as number,
              };
            } catch (err) {
              clearTimeout(timer);
              return { provider: "ip-api.com", error: (err as Error).message };
            }
          },
          // ipapi.co (supports IPv6)
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const resp = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: controller.signal });
              clearTimeout(timer);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const d = await resp.json() as Record<string, unknown>;
              if (d.error) throw new Error(String(d.reason ?? d.error));
              return {
                provider: "ipapi.co",
                country: String(d.country_name ?? ""),
                region: String(d.region ?? ""),
                city: String(d.city ?? ""),
                org: String(d.org ?? ""),
                as: String(d.asn ?? ""),
                timezone: String(d.timezone ?? ""),
                latitude: d.latitude as number,
                longitude: d.longitude as number,
              };
            } catch (err) {
              clearTimeout(timer);
              return { provider: "ipapi.co", error: (err as Error).message };
            }
          },
          // ipinfo.io (supports IPv6)
          async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
              const resp = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { signal: controller.signal });
              clearTimeout(timer);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const d = await resp.json() as Record<string, unknown>;
              if (d.error) throw new Error(String(d.error));
              const [lat, lon] = typeof d.loc === "string" ? d.loc.split(",") : ["", ""];
              return {
                provider: "ipinfo.io",
                country: String(d.country ?? ""),
                region: String(d.region ?? ""),
                city: String(d.city ?? ""),
                org: String(d.org ?? ""),
                as: "",
                timezone: String(d.timezone ?? ""),
                latitude: lat,
                longitude: lon,
              };
            } catch (err) {
              clearTimeout(timer);
              return { provider: "ipinfo.io", error: (err as Error).message };
            }
          },
        ];

        const results = await Promise.all(providers.map(p => p()));
        const success = results.find(r => !r.error);

        if (!success) {
          const errs = results.map(r => `${r.provider}: ${r.error}`).join("; ");
          await ctx.reply(`❌ 所有服务商查询失败:\n  ${errs}`);
          return;
        }

        const lines = [
          `🌐 IP: ${ip} (${isIPv6 ? "IPv6" : "IPv4"})  数据源: ${success.provider}`,
          `  位置: ${success.country ?? "?"} ${success.region ?? ""} ${success.city ?? ""}`.trim(),
          `  运营商: ${success.org || "(未知)"}`,
          ...(success.as ? [`  AS: ${success.as}`] : []),
          `  时区: ${success.timezone || "(未知)"}`,
          `  经纬度: ${success.latitude ?? "?"}, ${success.longitude ?? "?"}`,
        ];
        await ctx.reply(lines.join("\n"));
      },
    });

    // /whois <domain> — whois lookup
    this.register({
      name: "whois",
      aliases: ["域名查询"],
      description: "查询域名 whois 信息",
      usage: "/whois <域名>   例: /whois example.com",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /whois <域名>");
          return;
        }
        const domain = ctx.args[0].toLowerCase();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
          await ctx.reply("❌ 无效域名");
          return;
        }
        try {
          // Use RDAP (Registration Data Access Protocol) — modern whois
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const resp = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
            signal: controller.signal,
            headers: { Accept: "application/rdap+json" },
          });
          clearTimeout(timer);

          if (!resp.ok) {
            if (resp.status === 404) {
              await ctx.reply(`❌ 域名 ${domain} 未找到 whois 记录`);
              return;
            }
            throw new Error(`HTTP ${resp.status}`);
          }

          const data = await resp.json() as Record<string, unknown>;
          const events = (data.events ?? []) as Array<{ eventAction: string; eventDate: string }>;
          const status = (data.status ?? []) as string[];
          const entities = (data.entities ?? []) as Array<{ roles?: string[]; vcardArray?: unknown[] }>;

          // Extract registrar
          let registrar = "(未知)";
          for (const e of entities) {
            if (e.roles?.includes("registrar")) {
              const vcard = e.vcardArray?.[1] as Array<unknown>[] | undefined;
              if (vcard) {
                for (const item of vcard) {
                  if (Array.isArray(item) && item[0] === "fn" && typeof item[3] === "string") {
                    registrar = item[3];
                    break;
                  }
                }
              }
            }
          }

          const registration = events.find(e => e.eventAction === "registration");
          const expiration = events.find(e => e.eventAction === "expiration");
          const lastChanged = events.find(e => e.eventAction === "last changed");

          const lines = [
            `📋 WHOIS: ${domain}`,
            `  注册商: ${registrar}`,
            ...(registration ? [`  注册时间: ${new Date(registration.eventDate).toLocaleString("zh-CN")}`] : []),
            ...(expiration ? [`  到期时间: ${new Date(expiration.eventDate).toLocaleString("zh-CN")}`] : []),
            ...(lastChanged ? [`  最后更新: ${new Date(lastChanged.eventDate).toLocaleString("zh-CN")}`] : []),
            ...(status.length > 0 ? [`  状态: ${status.slice(0, 3).join(", ")}${status.length > 3 ? ` (+${status.length - 3})` : ""}`] : []),
          ];
          await ctx.reply(lines.join("\n"));
        } catch (err) {
          await ctx.reply(`❌ WHOIS 查询失败: ${(err as Error).message}`);
        }
      },
    });

    // /whoami — show sender's own info
    this.register({
      name: "whoami",
      aliases: ["我是谁", "我的信息"],
      description: "查看当前发送者的信息（用户ID、昵称、聊天类型等）",
      usage: "/whoami",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        const msg = ctx.message;
        let trusted = false;
        try {
          const { isTrusted } = await import("../business/trust.js");
          trusted = isTrusted(msg.fromUserId);
        } catch { /* ignore */ }

        const lines = [
          `👤 你的信息:`,
          `  用户ID: ${msg.fromUserId}`,
          `  昵称: ${msg.fromNickname || "(未知)"}`,
          `  聊天类型: ${msg.chatType === "group" ? "群聊" : "私聊"}`,
          ...(msg.chatType === "group" ? [
            `  群号: ${msg.groupCode || "(未知)"}`,
            `  群名: ${msg.groupName || "(未知)"}`,
          ] : []),
          `  是否受信: ${trusted ? "✅ 是" : "❌ 否"}`,
          ...(trusted ? [`  (可使用 /unsafe on 开启危险模式)`] : []),
        ];
        await ctx.reply(lines.join("\n"));
      },
    });

    // /myip — server IP info (dmOnly, dual-stack, AS + region)
    this.register({
      name: "myip",
      aliases: ["服务器ip", "serverip"],
      description: "查看服务器 IP 信息（双栈，含 AS 和地区）",
      usage: "/myip",
      category: "system" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        try {
          // Fetch both IPv4 and IPv6 concurrently
          const [ipv4Result, ipv6Result] = await Promise.allSettled([
            fetch("https://api.ipify.org?format=json").then(r => r.json() as Promise<{ ip: string }>),
            fetch("https://api64.ipify.org?format=json").then(r => r.json() as Promise<{ ip: string }>),
          ]);

          const lines = ["🖥️ 服务器 IP 信息:"];

          if (ipv4Result.status === "fulfilled") {
            const ip4 = ipv4Result.value.ip;
            lines.push(`  IPv4: ${ip4}`);
            // Try to get geo info
            try {
              const geoResp = await fetch(`http://ip-api.com/json/${ip4}?lang=zh-CN&fields=country,regionName,city,isp,as,timezone`, { signal: AbortSignal.timeout(5000) });
              if (geoResp.ok) {
                const geo = await geoResp.json() as Record<string, string>;
                lines.push(`    地区: ${geo.country ?? "?"} ${geo.regionName ?? ""} ${geo.city ?? ""}`.trim());
                lines.push(`    ISP: ${geo.isp || "(未知)"}`);
                lines.push(`    AS: ${geo.as || "(未知)"}`);
                lines.push(`    时区: ${geo.timezone || "(未知)"}`);
              }
            } catch { /* geo lookup optional */ }
          } else {
            lines.push("  IPv4: (获取失败)");
          }

          if (ipv6Result.status === "fulfilled") {
            const ip6 = ipv6Result.value.ip;
            const isV6 = ip6.includes(":");
            if (isV6) {
              lines.push(`  IPv6: ${ip6}`);
            } else {
              lines.push(`  IPv6: (无 IPv6 连接，回退到 IPv4)`);
            }
          } else {
            lines.push("  IPv6: (获取失败)");
          }

          // Also check local interfaces
          try {
            const { networkInterfaces } = await import("node:os");
            const nets = networkInterfaces();
            const localV4: string[] = [];
            const localV6: string[] = [];
            for (const [, addrs] of Object.entries(nets)) {
              if (!addrs) continue;
              for (const addr of addrs) {
                if (addr.family === "IPv4" && !addr.internal) localV4.push(addr.address);
                else if (addr.family === "IPv6" && !addr.internal) localV6.push(addr.address);
              }
            }
            if (localV4.length > 0 || localV6.length > 0) {
              lines.push("", "本地接口:");
              if (localV4.length > 0) lines.push(`  本地 IPv4: ${localV4.join(", ")}`);
              if (localV6.length > 0) lines.push(`  本地 IPv6: ${localV6.join(", ")}`);
            }
          } catch { /* ignore */ }

          await ctx.reply(lines.join("\n"));
        } catch (err) {
          await ctx.reply(`❌ 获取服务器 IP 失败: ${(err as Error).message}`);
        }
      },
    });

    // /term — interactive terminal (dmOnly, blocking, 5min timeout)
    // Enters an interactive shell session. Each subsequent non-slash message
    // is executed as a shell command. Output is sent back. /term exit to quit.
    this.register({
      name: "term",
      aliases: ["终端", "terminal", "shell-session"],
      description: "进入交互式终端（阻塞，5分钟无操作自动退出，仅私聊）",
      usage: "/term   (进入终端，发送命令直接执行，/term exit 退出)",
      category: "system" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args[0]?.toLowerCase() === "exit") {
          // Exit is handled by the wizard session mechanism
          const sessions = (this as unknown as { _termSessions?: Map<string, unknown> })._termSessions;
          if (sessions) {
            sessions.delete(ctx.message.fromUserId);
            await ctx.reply("🖥️ 终端已退出");
          }
          return;
        }

        // Start terminal session
        const sessions = (this as unknown as { _termSessions?: Map<string, { lastActivity: number; exitCode: number | null }> })._termSessions;
        if (!sessions) {
          await ctx.reply("❌ 终端会话管理不可用");
          return;
        }

        sessions.set(ctx.message.fromUserId, { lastActivity: Date.now(), exitCode: null });
        await ctx.reply(
          "🖥️ 交互式终端已启动\n\n" +
          "接下来的消息将作为 shell 命令执行。\n" +
          "发送 /term exit 退出终端。\n" +
          "5分钟无操作自动退出。\n\n" +
          "示例: ls -la, echo hello, whoami",
        );
      },
    });

    // Register terminal session handler (similar to wizard sessions)
    {
      const termSessions = new Map<string, { lastActivity: number; exitCode: number | null }>();
      (this as unknown as { _termSessions: Map<string, unknown> })._termSessions = termSessions;

      (this as unknown as { _handleTermInput: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean> })._handleTermInput =
        async (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>): Promise<boolean> => {
          const session = termSessions.get(userId);
          if (!session) return false;

          // Check 5-minute timeout
          if (Date.now() - session.lastActivity > 5 * 60 * 1000) {
            termSessions.delete(userId);
            await reply("⏰ 终端已超时（5分钟无操作），自动退出");
            return true;
          }

          session.lastActivity = Date.now();
          const cmd = text.trim();

          // Check for exit command
          if (cmd === "exit" || cmd === "quit" || cmd === "/term exit") {
            termSessions.delete(userId);
            const exitCode = session.exitCode;
            await reply(`🖥️ 终端已退出${exitCode !== null ? ` (最后退出码: ${exitCode})` : ""}`);
            return true;
          }

          // Execute shell command
          try {
            const { exec } = await import("node:child_process");
            const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
              exec(cmd, {
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
                cwd: process.env.HOME || process.cwd(),
              }, (err, stdout, stderr) => {
                resolve({
                  stdout: stdout?.toString() ?? "",
                  stderr: stderr?.toString() ?? "",
                  code: err ? 1 : 0,
                });
              });
            });

            session.exitCode = result.code;

            let output = "";
            if (result.stdout) output += result.stdout;
            if (result.stderr) output += (output ? "\n" : "") + result.stderr;
            if (!output) output = "(无输出)";

            // Truncate to 3000 chars
            if (output.length > 3000) {
              output = output.slice(0, 3000) + `\n... (截断，共 ${output.length} 字符)`;
            }

            await reply(`$ ${cmd}\n${output}\n[退出码: ${result.code}]`);
          } catch (err) {
            await reply(`$ ${cmd}\n❌ 执行失败: ${(err as Error).message}`);
          }

          return true;
        };
    }

    // /ping
    this.register({
      name: "ping",
      aliases: ["pong"],
      description: "测试机器人响应延迟",
      usage: "/ping   (返回pong和延迟时间)",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        const start = Date.now();
        await ctx.reply("🏓 pong!");
        const latency = Date.now() - start;
        this.log.info(`ping latency: ${latency}ms`);
      },
    });

    // /unsafe — temporarily allow dmOnly commands in group chat
    // /unsafe status is globally open; on/off require trust + dmOnly
    this.register({
      name: "unsafe",
      aliases: ["危险模式"],
      description: "临时允许群聊使用受限命令（需受信）",
      usage: "/unsafe [on|off|status] [分钟数]   (默认5分钟)",
      category: "system" as CommandCategory,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();

        // /unsafe status is globally open — no trust check, no dmOnly
        if (subCmd === "status") {
          if (this.isUnsafeMode()) {
            await ctx.reply("🔓 危险模式: 已开启（dmOnly命令可在群聊使用）");
          } else {
            await ctx.reply("🔒 危险模式: 已关闭（dmOnly命令仅限私聊）");
          }
          return;
        }

        // on/off require trust check
        let trusted: boolean;
        try {
          const { isTrusted } = await import("../business/trust.js");
          trusted = isTrusted(ctx.message.fromUserId);
        } catch {
          // trust module optional — default to allowing if module missing
          trusted = true;
        }

        if (!trusted) {
          await ctx.reply(
            `❌ 你不在信任列表中，无法开启危险模式。\n你的用户ID: ${ctx.message.fromUserId}\n请联系主人发送: /trust add ${ctx.message.fromUserId}`,
          );
          return;
        }

        const subCmd2 = ctx.args[0]?.toLowerCase();

        if (subCmd2 === "allow") {
          // /unsafe allow <command> — authorize a single command
          if (!ctx.args[1]) {
            const allowed = this.getAllowedCommands();
            await ctx.reply(
              `已授权命令: ${allowed.length > 0 ? allowed.map(c => `/${c}`).join(", ") : "(无)"}\n` +
              `用法: /unsafe allow <命令名> (授权单个命令在群聊使用)\n` +
              `/unsafe disallow <命令名> (取消授权)\n` +
              `不可授权: unsafe, trust, config, init, daemon`,
            );
            return;
          }
          const result = this.allowCommand(ctx.args[1]);
          await ctx.reply(result.ok
            ? `✅ 已授权 /${ctx.args[1]} 在群聊中使用`
            : `❌ ${result.reason}`,
          );
          return;
        }

        if (subCmd2 === "disallow" && ctx.args[1]) {
          const ok = this.disallowCommand(ctx.args[1]);
          await ctx.reply(ok ? `✅ 已取消授权 /${ctx.args[1]}` : `/${ctx.args[1]} 未被授权`);
          return;
        }

        if (!subCmd2 || subCmd2 === "on") {
          // Check for "forever" keyword
          if (ctx.args[1]?.toLowerCase() === "forever") {
            this.enableUnsafeMode(0); // 0 = forever
            await ctx.reply(
              `🔓 危险模式已永久开启\n` +
              `  效果: 所有dmOnly命令可在群聊中使用\n` +
              `  关闭: /unsafe off\n` +
              `⚠️ 请注意安全`,
            );
            return;
          }
          // Default: 5 minutes
          const minutes = parseInt(ctx.args[1], 10);
          const durationMs = (isNaN(minutes) || minutes <= 0) ? 5 * 60 * 1000 : minutes * 60 * 1000;
          this.enableUnsafeMode(durationMs);
          const mins = durationMs / 60000;
          await ctx.reply(
            `🔓 危险模式已开启\n` +
            `  有效期: ${mins}分钟\n` +
            `  效果: 所有dmOnly命令可在群聊中使用\n` +
            `  关闭: /unsafe off\n` +
            `⚠️ 请注意安全，用完及时关闭\n` +
            `永久开启: /unsafe on forever`,
          );
        } else if (subCmd2 === "off") {
          this.disableUnsafeMode();
          await ctx.reply("🔒 危险模式已关闭，dmOnly限制已恢复");
        } else {
          await ctx.reply(
            "用法: /unsafe [on|off|status|allow|disallow] [参数]\n" +
            "  /unsafe              — 开启5分钟\n" +
            "  /unsafe 10           — 开启10分钟\n" +
            "  /unsafe on forever   — 永久开启\n" +
            "  /unsafe off          — 关闭\n" +
            "  /unsafe status       — 查看状态\n" +
            "  /unsafe allow <命令> — 授权单个命令在群聊使用\n" +
            "  /unsafe disallow <命令> — 取消授权",
          );
        }
      },
    });

    // /trust — manage trusted users
    // /trust status is globally open; list/add/remove require dmOnly
    this.register({
      name: "trust",
      aliases: ["信任", "受信"],
      description: "管理受信用户列表（主人自动受信，不可移除）",
      usage: "/trust [list|add <ID> [昵称]|remove <ID>|status]",
      category: "system" as CommandCategory,
      handler: async (ctx) => {
        const { isTrusted, addTrust, removeTrust, listTrust, getMasterUserId } = await import("../business/trust.js");
        const subCmd = ctx.args[0]?.toLowerCase();
        const userId = ctx.message.fromUserId;

        // /trust status is globally open — anyone can check their own status
        if (subCmd === "status") {
          const trusted = isTrusted(userId);
          const master = getMasterUserId();
          await ctx.reply(
            `📊 信任状态:\n` +
            `  你的ID: ${userId}\n` +
            `  是否受信: ${trusted ? "是" : "否"}\n` +
            `  是否主人: ${userId === master ? "是" : "否"}\n` +
            `  主人ID: ${master ?? "(未设置)"}`,
          );
          return;
        }

        // list/add/remove require dmOnly (system management operations)
        if (ctx.message.chatType === "group") {
          await ctx.reply("⚠️ 此操作仅限私聊使用。请私聊机器人发送此命令。");
          return;
        }

        // Only trusted users can manage trust (master always can)
        if (!isTrusted(userId)) {
          await ctx.reply("❌ 你不在信任列表中，无法管理受信用户");
          return;
        }

        if (!subCmd || subCmd === "list") {
          const entries = listTrust();
          const master = getMasterUserId();
          if (entries.length === 0) {
            await ctx.reply("📋 信任列表为空");
            return;
          }
          const lines = entries.map(e =>
            `  ${e.isMaster || e.userId === master ? "👑" : "👤"} ${e.userId}` +
            `${e.nickname ? ` (${e.nickname})` : ""}` +
            `${e.isMaster ? " [主人]" : ""}` +
            `  受信于 ${new Date(e.trustedAt).toLocaleString("zh-CN")}`,
          );
          await ctx.reply(`📋 信任列表 (${entries.length} 人):\n${lines.join("\n")}`);
          return;
        }

        if (subCmd === "add") {
          if (ctx.args.length < 2) {
            await ctx.reply("用法: /trust add <ID> [昵称]");
            return;
          }
          const targetId = ctx.args[1];
          const nickname = ctx.args.slice(2).join(" ");
          const added = addTrust(targetId, nickname);
          await ctx.reply(added
            ? `✅ 已将 ${targetId}${nickname ? ` (${nickname})` : ""} 加入信任列表`
            : `${targetId} 已在信任列表中（昵称已更新）`,
          );
          return;
        }

        if (subCmd === "remove" || subCmd === "rm") {
          if (ctx.args.length < 2) {
            await ctx.reply("用法: /trust remove <ID>");
            return;
          }
          const targetId = ctx.args[1];
          const result = removeTrust(targetId);
          await ctx.reply(result.ok
            ? `✅ 已将 ${targetId} 移出信任列表`
            : `❌ ${result.reason}`,
          );
          return;
        }

        if (subCmd === "status") {
          const trusted = isTrusted(userId);
          const master = getMasterUserId();
          await ctx.reply(
            `📊 信任状态:\n` +
            `  你的ID: ${userId}\n` +
            `  是否受信: ${trusted ? "是" : "否"}\n` +
            `  是否主人: ${userId === master ? "是" : "否"}\n` +
            `  主人ID: ${master ?? "(未设置)"}`,
          );
          return;
        }

        await ctx.reply(
          "用法:\n" +
          "  /trust                    查看信任列表\n" +
          "  /trust list               同上\n" +
          "  /trust add <ID> [昵称]    添加受信用户\n" +
          "  /trust remove <ID>        移除受信用户（主人不可移除）\n" +
          "  /trust status             查看自己的信任状态",
        );
      },
    });

    // /version
    this.register({
      name: "version",
      aliases: ["v", "ver", "版本"],
      description: "查看版本信息",
      usage: "/version   (显示当前版本号)",
      category: "misc" as CommandCategory,
      handler: async (ctx) => {
        const { getVersion } = await import("../version.js");
        await ctx.reply(
          `📦 Yuanbao Lite v${getVersion()}\n轻量级独立腾讯元宝机器人客户端`,
        );
      },
    });

    // /uptime
    this.register({
      name: "uptime",
      aliases: ["运行时间"],
      description: "查看机器人运行时间",
      usage: "/uptime   (显示已运行时长)",
      category: "misc" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        const state = ctx.bot.getState();
        if (!state.lastConnectedAt) {
          await ctx.reply("暂无连接信息");
          return;
        }
        const uptimeMs = Date.now() - state.lastConnectedAt;
        const hours = Math.floor(uptimeMs / 3600000);
        const minutes = Math.floor((uptimeMs % 3600000) / 60000);
        const seconds = Math.floor((uptimeMs % 60000) / 1000);
        await ctx.reply(`⏱️ 运行时间: ${hours}h ${minutes}m ${seconds}s`);
      },
    });

    // /groupinfo [group_code] — also aliased as /info
    this.register({
      name: "groupinfo",
      aliases: ["gi", "info", "群信息"],
      description: "查询群组信息（群名、群主、成员数）",
      usage: "/groupinfo [群号]   (在群聊中可省略群号)",
      category: "group" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        const groupCode = ctx.args[0] || ctx.groupCode;
        if (!groupCode) {
          await ctx.reply("用法: /groupinfo <群号>");
          return;
        }
        try {
          const info = await ctx.bot.queryGroupInfo(groupCode);
          if (info.code === 0 && info.group_info) {
            const gi = info.group_info;
            const ownerDisplay = gi.group_owner_nickname
              ? `${gi.group_owner_nickname} (ID: ${gi.group_owner_user_id || "?"})`
              : gi.group_owner_user_id || "(未知)";
            await ctx.reply(`📋 群信息:\n  群号: ${groupCode}\n  群名: ${gi.group_name || "(未知)"}\n  👤 群主: ${ownerDisplay}\n  👥 成员数: ${gi.group_size || 0}`);
          } else {
            await ctx.reply(`📋 群信息: 查询成功但无详细数据 (code: ${info.code})`);
          }
        } catch (err) {
          await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
        }
      },
    });

    // /members [group_code] — group member list
    this.register({
      name: "members",
      aliases: ["成员", "群成员", "member"],
      description: "查看群成员（支持模糊搜索，默认50人，--all显示全部）",
      usage: "/members [--all] [群号]   (--all/-a 显示全部成员)",
      category: "group" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        const groupCode = ctx.args[0] || ctx.groupCode;
        if (!groupCode) {
          await ctx.reply("用法: /members <群号>");
          return;
        }
        try {
          const members = await ctx.bot.getGroupMemberList(groupCode);
          if (members.code === 0 && members.member_list && members.member_list.length > 0) {
            const maxMembers = ctx.showAll ? members.member_list.length : 50;
            const lines = members.member_list.slice(0, maxMembers).map(m => {
              const typeLabel = m.user_type === 1 ? "[人类]" : m.user_type === 2 ? "[元宝]" : m.user_type === 3 ? "[龙虾]" : "";
              const displayName = m.nick_name || m.user_id;
              return `  ${displayName} ${typeLabel}\n    ID: ${m.user_id}`;
            });
            const suffix = !ctx.showAll && members.member_list.length > 50 ? `\n  ... 及其他 ${members.member_list.length - 50} 人 (用 /members --all 查看全部)` : "";
            await ctx.reply(`👥 群成员 (${members.member_list.length}人):\n${lines.join("\n")}${suffix}`);
          } else {
            await ctx.reply(`👥 群成员: 群 ${groupCode} 暂无成员数据`);
          }
        } catch (err) {
          await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
        }
      },
    });

    // /alias — manage ID aliases (dmOnly: ID mapping is security-sensitive)
    this.register({
      name: "alias",
      aliases: ["别名"],
      description: "管理ID别名映射（为用户ID设置快捷名称）",
      usage: "/alias <add|remove|list|save|load|resolve> [参数]",
      category: "alias" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const store = ctx.bot.getAliasStore();

        switch (subCmd) {
          case "add": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /alias add <id> <alias> [昵称]");
              return;
            }
            const [, , id, alias, ...nickParts] = ctx.args;
            const nickname = nickParts.join(" ") || undefined;
            store.add(id, alias, nickname);
            await ctx.reply(`✅ 别名已添加: ${alias} -> ${id}${nickname ? ` (昵称: ${nickname})` : ""}`);
            break;
          }
          case "remove":
          case "rm":
          case "del": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /alias remove <别名|ID>");
              return;
            }
            const removed = store.remove(ctx.args[1]);
            await ctx.reply(removed ? `✅ 别名已删除` : `未找到别名: ${ctx.args[1]}`);
            break;
          }
          case "list":
          case "ls": {
            const all = store.getAll();
            if (all.length === 0) {
              await ctx.reply("暂无别名");
              return;
            }
            const lines = all.map(e => `  ${e.alias} -> ${e.id}${e.nickname ? ` (${e.nickname})` : ""}`);
            await ctx.reply(`📋 别名列表:\n${lines.join("\n")}`);
            break;
          }
          case "save": {
            const ok = store.save();
            await ctx.reply(ok ? "✅ 别名已保存" : "❌ 保存失败");
            break;
          }
          case "load": {
            const ok = store.load();
            await ctx.reply(ok ? "✅ 别名已加载" : "❌ 加载失败");
            break;
          }
          case "resolve": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /alias resolve <别名|ID>");
              return;
            }
            const resolved = store.resolve(ctx.args[1]);
            const nick = store.getNickname(ctx.args[1]);
            await ctx.reply(`解析结果: ${resolved}${nick ? ` (昵称: ${nick})` : ""}`);
            break;
          }
          default:
            await ctx.reply("用法: /alias <add|remove|list|save|load|resolve> [参数]");
        }
      },
    });

    // /history — view and search message history
    this.register({
      name: "history",
      aliases: ["hist", "历史"],
      description: "查看和搜索消息历史（search子命令默认20条，--all显示全部）",
      usage: "/history [search|stats|recent|user|group] [--all] [参数]   (search+--all/-a 显示全部)",
      category: "history" as CommandCategory,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const store = ctx.bot.getHistoryStore();

        // Lazily import formatHistoryList
        const { formatHistoryList } = await import("../business/history.js");
        const botId = ctx.bot.getAccount().botId;

        switch (subCmd) {
          case "search":
          case "find":
          case "搜索": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /history search <关键词> [数量]");
              return;
            }
            const keyword = ctx.args[1];
            const limit = parseInt(ctx.args[2] || "20", 10);
            const results = store.searchByKeyword(keyword, { searchNickname: true, limit });
            if (results.length === 0) {
              await ctx.reply(`未找到包含 "${keyword}" 的消息`);
              return;
            }
            const output = formatHistoryList(ctx.showAll ? results : results.slice(-20), { botId, colorize: false, title: `搜索结果 (${results.length}条)` });
            await ctx.reply(output);
            break;
          }
          case "stats":
          case "统计": {
            const stats = store.getStats();
            await ctx.reply(
              `📊 消息统计:\n` +
              `  总消息: ${stats.totalMessages}\n` +
              `  私聊: ${stats.directMessages}, 群聊: ${stats.groupMessages}\n` +
              `  独立用户: ${stats.uniqueUsers}, 独立群组: ${stats.uniqueGroups}\n` +
              `  时间范围: ${stats.oldestAt ? new Date(stats.oldestAt).toLocaleString("zh-CN") : "无"} ~ ${stats.newestAt ? new Date(stats.newestAt).toLocaleString("zh-CN") : "无"}`,
            );
            break;
          }
          case "recent":
          case "最近": {
            const count = parseInt(ctx.args[1] || "10", 10);
            const recent = store.getRecent(count);
            if (recent.length === 0) {
              await ctx.reply("暂无历史消息");
              return;
            }
            const output = formatHistoryList(recent, { botId, colorize: false, title: `最近消息` });
            await ctx.reply(output);
            break;
          }
          case "user": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /history user <用户ID> [数量]");
              return;
            }
            const userId = ctx.args[1];
            const limit = parseInt(ctx.args[2] || "20", 10);
            const msgs = store.getByUser(userId, limit);
            if (msgs.length === 0) {
              await ctx.reply(`未找到用户 ${userId} 的消息`);
              return;
            }
            const output = formatHistoryList(msgs, { botId, colorize: false, title: `用户 ${userId} 的消息` });
            await ctx.reply(output);
            break;
          }
          case "group": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /history group <群号> [数量]");
              return;
            }
            const groupCode = ctx.args[1];
            const limit = parseInt(ctx.args[2] || "20", 10);
            const msgs = store.getByGroup(groupCode, limit);
            if (msgs.length === 0) {
              await ctx.reply(`未找到群 ${groupCode} 的消息`);
              return;
            }
            const output = formatHistoryList(msgs, { botId, colorize: false, title: `群 ${groupCode} 的消息` });
            await ctx.reply(output);
            break;
          }
          default:
            await ctx.reply("用法: /history <search|stats|recent|user|group> [参数]");
        }
      },
    });

    // /search — search groups and members
    this.register({
      name: "search",
      aliases: ["搜索", "查找"],
      description: "搜索群组和群成员（模糊匹配）",
      usage: "/search <groups|members> <关键词> [群号]",
      category: "group" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();

        // Lazily create search engine
        const { SearchEngine } = await import("../business/search.js");
        const engine = new SearchEngine(ctx.bot);

        switch (subCmd) {
          case "groups":
          case "群":
          case "群组": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /search groups <关键词> [群号1,群号2,...]");
              return;
            }
            const query = ctx.args[1];
            const groupCodes = ctx.args[2]?.split(",");
            const results = await engine.searchGroups(query, groupCodes);
            if (results.length === 0) {
              await ctx.reply(`未找到匹配 "${query}" 的群组`);
              return;
            }
            const lines = results.map(r =>
              `  ${r.groupCode} — ${r.groupName} (${r.groupSize}人) [${r.matchType}]`,
            );
            await ctx.reply(`🔍 群组搜索结果:\n${lines.join("\n")}`);
            break;
          }
          case "members":
          case "member":
          case "成员": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /search members <关键词> [群号]");
              return;
            }
            const query = ctx.args[1];
            const groupCode = ctx.args[2] || ctx.groupCode;
            if (!groupCode) {
              await ctx.reply("请指定群号: /search members <关键词> <群号>");
              return;
            }
            const results = await engine.searchGroupMembers(groupCode, query);
            if (results.length === 0) {
              await ctx.reply(`未在群 ${groupCode} 中找到匹配 "${query}" 的成员`);
              return;
            }
            const lines = results.map(r => {
              const typeLabel = r.userType === 1 ? "[人类]" : r.userType === 2 ? "[元宝]" : r.userType === 3 ? "[龙虾]" : "";
              return `  ${r.userId} — ${r.nickName} ${typeLabel} [${r.matchType}]`;
            });
            await ctx.reply(`🔍 成员搜索结果 (${groupCode}):\n${lines.join("\n")}`);
            break;
          }
          default:
            await ctx.reply("用法: /search <groups|members> <关键词> [群号]");
        }
      },
    });

    // /batch — batch message sending (dmOnly: can be disruptive in groups)
    this.register({
      name: "batch",
      aliases: ["批量"],
      description: "批量发送消息（text/sticker/image/file，支持JS插值模板）",
      usage: "/batch <text|sticker|image|file> <目标> <数量> <间隔ms> <模板>\n/batch list | stop [id] | status [id]",
      category: "batch" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();

        // ─── Management sub-commands ───
        if (subCmd === "list") {
          const { getActiveBatchIds, getActiveBatch } = await import("../business/batch.js");
          const ids = getActiveBatchIds();
          if (ids.length === 0) {
            await ctx.reply("没有正在运行的批量任务");
            return;
          }
          const lines: string[] = ["📋 运行中的批量任务:"];
          for (const id of ids) {
            const b = getActiveBatch(id);
            if (!b) continue;
            const p = b.getProgress();
            lines.push(`  ${id}: ${p.sent}/${p.total} (失败 ${p.failed})${p.cancelled ? " [已取消]" : ""}`);
          }
          await ctx.reply(lines.join("\n"));
          return;
        }

        if (subCmd === "stop") {
          const { cancelBatch, getActiveBatchIds } = await import("../business/batch.js");
          const id = ctx.args[1] ?? getActiveBatchIds()[0];
          if (!id) {
            await ctx.reply("没有正在运行的批量任务");
            return;
          }
          const cancelled = cancelBatch(id);
          await ctx.reply(cancelled ? `✅ 批量任务 ${id} 已取消` : `未找到任务: ${id}`);
          return;
        }

        if (subCmd === "status") {
          const { getActiveBatch, getActiveBatchIds } = await import("../business/batch.js");
          const id = ctx.args[1] ?? getActiveBatchIds()[0];
          if (!id) {
            await ctx.reply("没有正在运行的批量任务");
            return;
          }
          const batch = getActiveBatch(id);
          if (!batch) {
            await ctx.reply(`未找到任务: ${id}`);
            return;
          }
          const p = batch.getProgress();
          const eta = p.estimatedRemaining ? ` (~${Math.ceil(p.estimatedRemaining / 1000)}s 剩余)` : "";
          await ctx.reply(
            `📊 批量任务 ${id}:\n` +
            `  进度: ${p.sent}/${p.total}${eta}\n` +
            `  失败: ${p.failed}\n` +
            `  运行中: ${p.running ? "是" : "否"}\n` +
            `  已取消: ${p.cancelled ? "是" : "否"}`,
          );
          return;
        }

        // ─── Batch-start sub-commands: text | sticker | image | file ───
        const validTypes = ["text", "sticker", "image", "file"];
        if (!validTypes.includes(subCmd ?? "")) {
          await ctx.reply(
            "用法:\n" +
            "  /batch text    <目标> <数量> <间隔ms> \"模板${i}\"\n" +
            "  /batch sticker <目标> <数量> <间隔ms> <stickerId模板>\n" +
            "  /batch image   <目标> <数量> <间隔ms> <文件路径模板>\n" +
            "  /batch file    <目标> <数量> <间隔ms> <文件路径模板>\n" +
            "  /batch list | stop [id] | status [id]\n" +
            "模板变量: ${i}(索引), ${n}(序号), ${total}(总数), ${timestamp}(时间戳)",
          );
          return;
        }

        if (ctx.args.length < 5) {
          await ctx.reply(`用法: /batch ${subCmd} <目标> <数量> <间隔ms> <模板>`);
          return;
        }
        const target = ctx.args[1];
        const count = parseInt(ctx.args[2], 10);
        const intervalMs = parseInt(ctx.args[3], 10);
        const template = ctx.args.slice(4).join(" ");

        if (isNaN(count) || count < 1 || count > 100) {
          await ctx.reply("数量范围: 1-100");
          return;
        }
        if (isNaN(intervalMs) || intervalMs < 500) {
          await ctx.reply("间隔最小 500ms");
          return;
        }

        // Determine isGroup based on target
        const isGroup = (() => {
          if (target.startsWith("g:")) return true;
          if (target.includes("@")) return false;
          const groupStore = ctx.bot.getGroupStore();
          if (groupStore && groupStore.get(target)) return true;
          if (/^\d{5,}$/.test(target)) return true;
          return false;
        })();
        const cleanTarget = target.startsWith("g:") ? target.slice(2) : target;

        // Generate a unique batch ID (so multiple batches can run concurrently)
        const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

        const { startBatch, cleanupBatch } = await import("../business/batch.js");
        const config: Record<string, unknown> = {
          type: subCmd,
          target: cleanTarget,
          isGroup,
          count,
          intervalMs,
          template,
        };
        if (subCmd === "sticker") config.stickerTemplate = template;
        if (subCmd === "image" || subCmd === "file") config.fileTemplate = template;

        const runner = startBatch(batchId, ctx.bot, config as never);

        await ctx.reply(`🔄 批量发送已启动 [${batchId}]: ${subCmd} ${count}条, 间隔${intervalMs}ms, 目标 ${cleanTarget}`);

        runner.run().then((result) => {
          cleanupBatch(batchId);
          ctx.reply(
            `✅ 批量任务 ${batchId} 完成: 成功 ${result.sent}/${result.total}, 失败 ${result.failed}, 耗时 ${result.durationMs}ms`,
          ).catch(() => { });
        }).catch((err) => {
          cleanupBatch(batchId);
          ctx.reply(`❌ 批量任务 ${batchId} 失败: ${(err as Error).message}`).catch(() => { });
        });
      },
    });

    // ─── Ported from CLI ───

    // /dm — send direct message (dmOnly: can send DMs on behalf of bot)
    this.register({
      name: "dm",
      aliases: ["私聊"],
      description: "发送私聊消息（支持别名解析）",
      usage: "/dm <用户ID或别名> <消息>",
      category: "chat" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length < 2) {
          await ctx.reply("用法: /dm <用户ID> <消息>");
          return;
        }
        const rawUserId = ctx.args[0];
        const userId = ctx.bot.getContactStore().resolve(rawUserId);
        const text = ctx.args.slice(1).join(" ");
        ctx.bot.getContactStore().touch(rawUserId);
        try {
          await ctx.bot.sendDirectMessage(userId, text);
          await ctx.reply(`✅ 已发送私聊消息给 ${rawUserId === userId ? userId : `${rawUserId} (${userId})`}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /group — send group message (dmOnly: can send group messages on behalf of bot)
    this.register({
      name: "group",
      aliases: ["群发"],
      description: "发送群聊消息",
      usage: "/group <群号> <消息>",
      category: "chat" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length < 2) {
          await ctx.reply("用法: /group <群号> <消息>");
          return;
        }
        const groupCode = ctx.args[0];
        const text = ctx.args.slice(1).join(" ");
        try {
          await ctx.bot.sendGroupMessage(groupCode, text);
          await ctx.reply(`✅ 已发送群聊消息到 ${groupCode}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /sticker — send sticker
    this.register({
      name: "sticker",
      aliases: ["贴纸"],
      description: "发送贴纸（使用 emoji_编号 格式）",
      usage: "/sticker <贴纸ID>   (用 /stickers 查看可用贴纸)",
      category: "sticker" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /sticker <贴纸ID>");
          return;
        }
        const stickerId = ctx.args[0];
        const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
        const isGroup = ctx.isGroup;
        try {
          await ctx.bot.sendSticker({ to, stickerId, isGroup });
          await ctx.reply(`✅ 贴纸已发送: ${stickerId}`);
        } catch (err) {
          await ctx.reply(`❌ 贴纸发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /mention /at — send with @mention
    // Unified with inline @[昵称](id) syntax: sendText already handles
    // parseMentions with nicknameResolver for @[昵称]() auto-matching in groups.
    this.register({
      name: "mention",
      aliases: ["at", "提及"],
      description: "发送含@提及的消息（支持 @[昵称](id) 内联语法）",
      usage: "/mention <目标> <消息>   消息中可用 @[昵称](id), @[](id), @[昵称]()",
      category: "chat" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        if (ctx.args.length < 2) {
          await ctx.reply("用法: /mention <目标> <消息>\n消息中可用 @语法:\n  @[昵称](id) — 用指定昵称@指定用户\n  @[](id) — 用默认昵称@指定用户\n  @[昵称]() — 群聊中按昵称自动匹配ID");
          return;
        }
        const target = ctx.args[0];
        const text = ctx.args.slice(1).join(" ");
        try {
          // sendText handles parseMentions internally, including nicknameResolver
          // for @[昵称]() auto-matching in group contexts
          await ctx.bot.sendText({
            to: target,
            text,
            isGroup: ctx.isGroup,
          });

          // Parse mentions from the original text for the confirmation message
          const { parseMentions } = await import("../business/mention.js");
          const nicknameResolver = (ctx.isGroup && target)
            ? async (nickname: string) => {
              const { SearchEngine } = await import("../business/search.js");
              const searchEngine = new SearchEngine(ctx.bot);
              const results = await searchEngine.searchGroupMembers(String(target), nickname);
              return results.filter(r => r.score >= 0.8).map(r => ({ userId: r.userId, nickname: r.nickName }));
            }
            : undefined;
          const parsed = await parseMentions(text, ctx.bot.getAliasStore(), nicknameResolver);
          if (parsed.mentions.length > 0) {
            const mentionNames = parsed.mentions.map(m => `@${m.displayName}(${m.userId})`).join(", ");
            await ctx.reply(`✅ 消息已发送，提及了: ${mentionNames}`);
          } else {
            await ctx.reply(`✅ 消息已发送到 ${target}`);
          }
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /atall — @everyone in a group (uses @[所有人]() syntax internally)
    this.register({
      name: "atall",
      aliases: ["所有人", "at-all", "@all"],
      description: "@所有人并发送消息（群聊专用）",
      usage: "/atall <群号> <消息>   或   /atall <消息>   (当前群聊)",
      category: "chat" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        let groupCode: string;
        let message: string;

        if (ctx.args.length < 1) {
          await ctx.reply("用法: /atall <群号> <消息>\n或: /atall <消息>  (当前群聊中)");
          return;
        }

        // If only one arg, treat as message and use current group (if in group context)
        if (ctx.args.length === 1) {
          if (!ctx.isGroup || !ctx.groupCode) {
            await ctx.reply("私聊中需要指定群号: /atall <群号> <消息>");
            return;
          }
          groupCode = ctx.groupCode;
          message = ctx.args[0];
        } else {
          // Check if first arg is a group code (all digits)
          const firstArg = ctx.args[0];
          if (/^\d{5,}$/.test(firstArg)) {
            groupCode = firstArg;
            message = ctx.args.slice(1).join(" ");
          } else {
            // First arg is not a group code — treat all as message, use current group
            if (!ctx.isGroup || !ctx.groupCode) {
              await ctx.reply("私聊中需要指定群号: /atall <群号> <消息>");
              return;
            }
            groupCode = ctx.groupCode;
            message = ctx.args.join(" ");
          }
        }

        if (!message.trim()) {
          await ctx.reply("消息内容不能为空");
          return;
        }

        // Use the @[所有人]() syntax which the mention parser will expand
        const fullMessage = `@[所有人]() ${message}`;

        try {
          await ctx.bot.sendText({
            to: groupCode,
            text: fullMessage,
            isGroup: true,
          });
          await ctx.reply(`✅ 已发送 @所有人 消息到群 ${groupCode}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /img — send image
    this.register({
      name: "img",
      aliases: ["图片", "发送图片"],
      description: "发送图片消息",
      usage: "/img <图片路径> [目标ID]   (目标默认为当前会话)",
      category: "media" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /img <图片路径> [目标ID]");
          return;
        }
        const filePath = ctx.args[0];
        const target = ctx.args[1] || (ctx.isGroup ? ctx.groupCode : ctx.message.fromUserId);
        if (!target) {
          await ctx.reply("❌ 请指定发送目标");
          return;
        }
        try {
          await ctx.bot.sendImage({
            to: target,
            filePath,
            isGroup: ctx.isGroup,
          });
          await ctx.reply(`✅ 图片已发送到 ${target}`);
        } catch (err) {
          await ctx.reply(`❌ 图片发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /file — send file
    this.register({
      name: "file",
      aliases: ["文件", "发送文件"],
      description: "发送文件消息",
      usage: "/file <文件路径> [目标ID]   (目标默认为当前会话)",
      category: "media" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /file <文件路径> [目标ID]");
          return;
        }
        const filePath = ctx.args[0];
        const target = ctx.args[1] || (ctx.isGroup ? ctx.groupCode : ctx.message.fromUserId);
        if (!target) {
          await ctx.reply("❌ 请指定发送目标");
          return;
        }
        try {
          await ctx.bot.sendFile({
            to: target,
            filePath,
            isGroup: ctx.isGroup,
          });
          await ctx.reply(`✅ 文件已发送到 ${target}`);
        } catch (err) {
          await ctx.reply(`❌ 文件发送失败: ${(err as Error).message}`);
        }
      },
    });

    // /upload — upload media (dmOnly: filesystem access)
    this.register({
      name: "upload",
      aliases: ["上传"],
      description: "上传文件到媒体服务器",
      usage: "/upload <文件路径>   (返回 uuid 和 url)",
      category: "media" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /upload <文件路径>");
          return;
        }
        const filePath = ctx.args[0];
        try {
          const result = await ctx.bot.uploadMedia(filePath);
          await ctx.reply(`✅ 上传成功: uuid=${result.uuid}, url=${result.url || "(pending)"}`);
        } catch (err) {
          await ctx.reply(`❌ 上传失败: ${(err as Error).message}`);
        }
      },
    });

    // /download — download media (dmOnly: filesystem access)
    this.register({
      name: "download",
      aliases: ["下载"],
      description: "下载媒体文件到本地",
      usage: "/download <URL> [文件名]",
      category: "media" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /download <URL> [文件名]");
          return;
        }
        const url = ctx.args[0];
        const fileName = ctx.args[1];
        try {
          const result = await ctx.bot.downloadMedia(url, undefined, fileName);
          await ctx.reply(`✅ 下载完成: ${result.filePath} (${result.fileSize} bytes)`);
        } catch (err) {
          await ctx.reply(`❌ 下载失败: ${(err as Error).message}`);
        }
      },
    });

    // /contacts /联系人 — contact management
    this.register({
      name: "contacts",
      aliases: ["联系人"],
      description: "联系人管理（增删改查、备注、标签、收藏）",
      usage: "/contacts <list|add|rm|rename|note|tag|fav|dm|search> [参数]",
      category: "contact" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const store = ctx.bot.getContactStore();

        switch (subCmd) {
          case "add": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /contacts add <ID> <名称> [标签]");
              return;
            }
            const id = ctx.args[1];
            const name = ctx.args[2];
            const tag = ctx.args.slice(3).join(" ") || undefined;
            store.add(id, name, tag);
            await ctx.reply(`✅ 联系人已添加: ${name} -> ${id.substring(0, 20)}...${tag ? ` [${tag}]` : ""}`);
            break;
          }
          case "remove":
          case "rm":
          case "del": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /contacts remove <名称|ID>");
              return;
            }
            const removed = store.remove(ctx.args[1]);
            await ctx.reply(removed ? "✅ 联系人已删除" : `未找到联系人: ${ctx.args[1]}`);
            break;
          }
          case "rename": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /contacts rename <名称|ID> <新名称>");
              return;
            }
            const ok = store.rename(ctx.args[1], ctx.args[2]);
            await ctx.reply(ok ? `✅ 联系人已重命名为: ${ctx.args[2]}` : `未找到联系人: ${ctx.args[1]}`);
            break;
          }
          case "note":
          case "备注": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /contacts note <名称|ID> <备注内容>");
              return;
            }
            if (!store.get(ctx.args[1])) {
              store.add(ctx.args[1], ctx.args[1]);
            }
            const ok = store.setNotes(ctx.args[1], ctx.args.slice(2).join(" "));
            await ctx.reply(ok ? "✅ 联系人备注已更新" : `❌ 设置备注失败: ${ctx.args[1]}`);
            break;
          }
          case "tag": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /contacts tag <名称|ID> <标签>");
              return;
            }
            const ok = store.setTag(ctx.args[1], ctx.args.slice(2).join(" "));
            await ctx.reply(ok ? "✅ 标签已更新" : `未找到联系人: ${ctx.args[1]}`);
            break;
          }
          case "fav":
          case "favorite":
          case "收藏": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /contacts fav <名称|ID>");
              return;
            }
            if (!store.get(ctx.args[1])) {
              store.add(ctx.args[1], ctx.args[1]);
            }
            const ok = store.toggleFavorite(ctx.args[1]);
            const entry = store.get(ctx.args[1]);
            await ctx.reply(ok ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}` : `未找到联系人: ${ctx.args[1]}`);
            break;
          }
          case "dm": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /contacts dm <名称|ID>");
              return;
            }
            const resolved = store.resolve(ctx.args[1]);
            store.touch(ctx.args[1]);
            await ctx.reply(`私聊目标: ${resolved} (使用 /dm 发送消息)`);
            break;
          }
          case "search":
          case "find": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /contacts search <关键词>");
              return;
            }
            const results = store.search(ctx.args.slice(1).join(" "));
            if (results.length === 0) {
              await ctx.reply("未找到匹配的联系人");
            } else {
              const lines = results.map(c => {
                const fav = c.favorite ? "⭐" : " ";
                return `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}`;
              });
              await ctx.reply(`📇 搜索结果:\n${lines.join("\n")}`);
            }
            break;
          }
          case "save": {
            const ok = store.save();
            await ctx.reply(ok ? "✅ 联系人已保存" : "❌ 保存失败");
            break;
          }
          case "list":
          case "ls":
          default: {
            const all = store.getAll("name");
            if (all.length === 0) {
              await ctx.reply("暂无联系人。使用 /contacts add <ID> <名称> 添加");
              return;
            }
            const lines = all.map(c => {
              const fav = c.favorite ? "⭐" : " ";
              return `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}`;
            });
            await ctx.reply(`📇 联系人列表:\n${lines.join("\n")}\n共 ${all.length} 个联系人`);
            break;
          }
        }
      },
    });

    // /groups /glist — group management
    this.register({
      name: "groups",
      aliases: ["glist"],
      description: "群聊管理（列表默认20条，--all显示全部）",
      usage: "/groups [--all] <list|add|rm|rename|note|tag|fav|join|search> [参数]   (--all/-a 显示全部)",
      category: "group" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const store = ctx.bot.getGroupStore();

        switch (subCmd) {
          case "add": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /groups add <群号> [名称] [标签]");
              return;
            }
            const groupCode = ctx.args[1];
            const name = ctx.args[2];
            const tag = ctx.args.slice(3).join(" ") || undefined;
            store.add(groupCode, name, tag);

            // Try to fetch group name from server if not provided
            if (!name) {
              try {
                const info = await ctx.bot.queryGroupInfo(groupCode);
                if (info.code === 0 && info.group_info?.group_name) {
                  store.setGroupName(groupCode, info.group_info.group_name);
                }
              } catch {
                // Ignore query errors
              }
            }

            const updatedEntry = store.get(groupCode);
            const displayName = updatedEntry?.name || updatedEntry?.groupName || groupCode;
            await ctx.reply(`✅ 群聊已收藏: ${displayName}${tag ? ` [${tag}]` : ""}`);
            break;
          }
          case "remove":
          case "rm":
          case "del": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /groups rm <群号>");
              return;
            }
            const removed = store.remove(ctx.args[1]);
            await ctx.reply(removed ? `✅ 群聊已从收藏移除: ${ctx.args[1]}` : `未找到群聊: ${ctx.args[1]}`);
            break;
          }
          case "rename": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /groups rename <群号> <新名称>");
              return;
            }
            const ok = store.rename(ctx.args[1], ctx.args.slice(2).join(" "));
            await ctx.reply(ok ? `✅ 群聊已重命名为: ${ctx.args.slice(2).join(" ")}` : `未找到群聊: ${ctx.args[1]}`);
            break;
          }
          case "note":
          case "备注": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /groups note <群号> <备注内容>");
              return;
            }
            if (!store.get(ctx.args[1])) {
              store.add(ctx.args[1]);
            }
            const ok = store.setNotes(ctx.args[1], ctx.args.slice(2).join(" "));
            await ctx.reply(ok ? "✅ 群聊备注已更新" : `❌ 设置备注失败: ${ctx.args[1]}`);
            break;
          }
          case "tag": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /groups tag <群号> <标签>");
              return;
            }
            if (!store.get(ctx.args[1])) {
              store.add(ctx.args[1]);
            }
            const ok = store.setTag(ctx.args[1], ctx.args.slice(2).join(" "));
            await ctx.reply(ok ? "✅ 群聊标签已更新" : `❌ 设置标签失败: ${ctx.args[1]}`);
            break;
          }
          case "fav":
          case "favorite":
          case "收藏": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /groups fav <群号>");
              return;
            }
            if (!store.get(ctx.args[1])) {
              store.add(ctx.args[1]);
            }
            const ok = store.toggleFavorite(ctx.args[1]);
            const entry = store.get(ctx.args[1]);
            await ctx.reply(ok ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}: ${ctx.args[1]}` : `未找到群聊: ${ctx.args[1]}`);
            break;
          }
          case "search":
          case "find": {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /groups search <关键词>");
              return;
            }
            const results = store.search(ctx.args.slice(1).join(" "));
            if (results.length === 0) {
              await ctx.reply("未找到匹配的群聊");
            } else {
              const lines = results.map(g => {
                const fav = g.favorite ? "⭐" : " ";
                const displayName = g.name || g.groupName || "未知";
                return `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}`;
              });
              await ctx.reply(`📋 群聊搜索结果:\n${lines.join("\n")}`);
            }
            break;
          }
          case "save": {
            const ok = store.save();
            await ctx.reply(ok ? "✅ 群聊已保存" : "❌ 保存失败");
            break;
          }
          case "list":
          case "ls":
          default: {
            const all = store.getAll("lastActive");
            if (all.length === 0) {
              await ctx.reply("暂无收藏群聊。使用 /groups add <群号> 添加");
              return;
            }
            // Try to resolve group names for entries that don't have one
            for (const g of all) {
              if (!g.name && !g.groupName) {
                try {
                  const info = await ctx.bot.queryGroupInfo(g.groupCode);
                  if (info.code === 0 && info.group_info?.group_name) {
                    store.setGroupName(g.groupCode, info.group_info.group_name);
                    g.groupName = info.group_info.group_name;
                  }
                } catch {
                  // Ignore query errors
                }
              }
            }
            const lines = all.map(g => {
              const fav = g.favorite ? "⭐" : " ";
              const displayName = g.name || g.groupName || "未知";
              return `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}`;
            });
            await ctx.reply(`📋 收藏群聊列表:\n${lines.join("\n")}\n共 ${all.length} 个群聊`);
            break;
          }
        }
      },
    });

    // /llm — LLM control (dmOnly: contains sensitive operations like apikey/baseurl)
    this.register({
      name: "llm",
      aliases: ["ai"],
      description: "LLM 接管控制（开启/关闭AI自动回复，配置模型参数）",
      usage: "/llm <on|off|status|chat|prompt|model|temp|history|clear|provider|apikey|baseurl|raw|im|group|merge|cooldown|iterate> [参数]",
      category: "llm" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const engine = ctx.bot.getLlmEngine();
        const subCmd = ctx.args[0]?.toLowerCase();
        const subArgs = ctx.args.slice(1);

        if (!subCmd) {
          // Show LLM status
          const autoReply = ctx.bot.isLlmAutoReply();
          if (engine) {
            const config = engine.getConfig();
            const lines = [
              "🤖 LLM 接管状态:",
              `  已启用: ${config.enabled ? "✅" : "❌"}`,
              `  自动回复: ${autoReply ? "🟢 已开启" : "⚪ 未开启"}`,
              `  SDK就绪: ${engine.isReady ? "✅" : "❌"}`,
              `  供应商: ${config.provider}`,
              `  模型: ${config.model || "(默认)"}`,
              `  温度: ${config.temperature}`,
              `  Markdown模式: ${config.markdownRawMode ? "原始(raw)" : "IM格式化"}`,
              `  群聊响应: ${config.enableInGroup ? "✅" : "❌"}`,
              `  私聊响应: ${config.enableInDirect ? "✅" : "❌"}`,
              `  群聊需@: ${config.requireMentionInGroup ? "✅" : "❌"}`,
              `  消息合并窗口: ${config.mergeWindowMs}ms`,
              `  响应冷却时间: ${config.cooldownMs}ms`,
              `  最大迭代轮数: ${config.maxIterate === 0 ? "无限" : config.maxIterate}`,
              `  活跃对话: ${engine.getConversationManager().size}`,
              `  配置持久化: ${engine.getPersistencePath() ? "✅" : "❌"}`,
            ];
            await ctx.reply(lines.join("\n"));
          } else {
            await ctx.reply("🤖 LLM 未配置。请设置 llmConfig 后重启");
          }
          return;
        }

        if (!engine) {
          await ctx.reply("❌ LLM 引擎未初始化");
          return;
        }

        switch (subCmd) {
          case "on": {
            engine.updateConfig({ enabled: true });
            ctx.bot.setLlmAutoReply(true);
            await ctx.reply("🤖 LLM 自动回复已开启");
            break;
          }
          case "off": {
            engine.updateConfig({ enabled: false });
            ctx.bot.setLlmAutoReply(false);
            await ctx.reply("🤖 LLM 自动回复已关闭");
            break;
          }
          case "billing":
          case "用量":
          case "账单": {
            const usage = engine.getUsage();
            if (usage.totalCalls === 0) {
              await ctx.reply("📊 暂无用量记录");
              return;
            }
            const lines = [
              `📊 LLM 用量统计:`,
              `  总调用: ${usage.totalCalls} 次`,
              `  总Token: ${usage.totalTokens}`,
              ``,
              `按供应商:`,
            ];
            for (const [name, stats] of Object.entries(usage.byProvider)) {
              lines.push(`  ${name}: ${stats.calls} 次, ${stats.tokens} tokens`);
            }
            // Show recent 5 records
            const recent = usage.records.slice(-5).reverse();
            if (recent.length > 0) {
              lines.push("", "最近调用:");
              for (const r of recent) {
                const time = new Date(r.timestamp).toLocaleString("zh-CN");
                lines.push(`  ${time} — ${r.provider}/${r.model}: ${r.totalTokens} tokens (${r.promptTokens}+${r.completionTokens})`);
              }
            }
            await ctx.reply(lines.join("\n"));
            return;
          }
          case "status": {
            const config = engine.getConfig();
            const pool = engine.getPoolStatus();
            const activeProvider = config.customProviders?.[pool.activeProvider];
            const lines = [
              `🤖 LLM 状态:`,
              `  启用: ${config.enabled ? "是" : "否"}`,
              `  自动回复: ${ctx.bot.isLlmAutoReply() ? "是" : "否"}`,
              `  就绪: ${engine.isReady ? "是" : "否"}`,
              `  活跃供应商: ${pool.activeProvider || "(未设置)"}`,
              ...(activeProvider ? [
                `  API格式: ${activeProvider.apiFormat}`,
                `  模型: ${activeProvider.model}`,
                `  端点: ${activeProvider.baseUrl}`,
              ] : []),
              `  密钥池: ${pool.keyPoolSize} 个 (${pool.keysInCooldown} 冷却中)`,
              `  供应商总数: ${pool.providerPoolSize} 个`,
              `  当前密钥索引: ${pool.activeKeyIndex}`,
              `  连续失败: ${pool.providerFailures}/${pool.maxFailuresBeforeSwitch}`,
            ];
            await ctx.reply(lines.join("\n"));
            break;
          }
          case "chat":
          case "ask":
          case "问": {
            if (subArgs.length === 0) {
              await ctx.reply("用法: /llm chat <消息>");
              return;
            }
            const prompt = subArgs.join(" ");
            try {
              const result = await engine.chat(prompt, "cmd:interactive");
              await ctx.reply(`🤖 回复:\n${result.processedText}`);
            } catch (err) {
              await ctx.reply(`❌ LLM调用失败: ${(err as Error).message}`);
            }
            break;
          }
          case "prompt":
          case "系统提示": {
            if (subArgs.length === 0) {
              const config = engine.getConfig();
              await ctx.reply(`当前系统提示词:\n${config.systemPrompt}`);
              return;
            }
            engine.updateConfig({ systemPrompt: subArgs.join(" ") });
            await ctx.reply(`✅ 系统提示词已更新`);
            break;
          }
          case "model":
          case "模型": {
            if (subArgs.length === 0) {
              const config = engine.getConfig();
              await ctx.reply(`当前模型: ${config.model || "(默认)"}`);
              return;
            }
            engine.updateConfig({ model: subArgs[0] });
            await ctx.reply(`✅ 模型已设为: ${subArgs[0]}`);
            break;
          }
          case "temp":
          case "温度": {
            if (subArgs.length === 0) {
              const config = engine.getConfig();
              await ctx.reply(`当前温度: ${config.temperature}`);
              return;
            }
            const temp = parseFloat(subArgs[0]);
            if (isNaN(temp) || temp < 0 || temp > 2) {
              await ctx.reply("温度范围: 0-2 (0=精确, 2=创意)");
              return;
            }
            engine.updateConfig({ temperature: temp });
            await ctx.reply(`✅ 温度已设为: ${temp}`);
            break;
          }
          case "history":
          case "历史": {
            const cm = engine.getConversationManager();
            const keys = Array.from(cm.keys);
            if (keys.length === 0) {
              await ctx.reply("暂无对话历史");
              return;
            }
            const lines = keys.map(key => {
              const history = cm.getHistory(key);
              const userMsgs = history.filter(h => h.role === "user").length;
              const botMsgs = history.filter(h => h.role === "assistant").length;
              return `  ${key}: ${userMsgs}条用户消息, ${botMsgs}条回复`;
            });
            await ctx.reply(`📜 对话历史 (${keys.length} 个对话):\n${lines.join("\n")}`);
            break;
          }
          case "clear":
          case "清除": {
            const cm = engine.getConversationManager();
            if (subArgs[0]) {
              cm.clearHistory(subArgs[0]);
              await ctx.reply(`✅ 已清除对话: ${subArgs[0]}`);
            } else {
              cm.clearAll();
              await ctx.reply("✅ 已清除所有对话历史");
            }
            break;
          }
          case "raw": {
            engine.updateConfig({ markdownRawMode: true });
            await ctx.reply("✅ 已切换为Markdown原始模式");
            break;
          }
          case "im": {
            engine.updateConfig({ markdownRawMode: false });
            await ctx.reply("✅ 已切换为IM格式化模式");
            break;
          }
          case "provider":
          case "供应商": {
            if (subArgs.length === 0) {
              const config = engine.getConfig();
              const names = Object.keys(config.customProviders ?? {});
              await ctx.reply(`当前供应商: ${config.provider || "(未设置)"}\n可用: ${names.join(", ") || "(无)"}`);
              return;
            }
            const config = engine.getConfig();
            const names = Object.keys(config.customProviders ?? {});
            if (!names.includes(subArgs[0])) {
              await ctx.reply(`无效供应商: ${subArgs[0]}\n可用: ${names.join(", ") || "(无)"}\n用 /llm customprovider add 添加自定义供应商`);
              return;
            }
            engine.updateConfig({ provider: subArgs[0] });
            await ctx.reply(`✅ 供应商已切换为: ${subArgs[0]}`);
            break;
          }
          case "apikey":
          case "密钥": {
            await ctx.reply("⚠️ API Key 管理已迁移到 customprovider 系统。\n用 /llm customprovider addkey <名称> <key> 添加密钥");
            break;
          }
          case "baseurl":
          case "基础url": {
            await ctx.reply("⚠️ Base URL 管理已迁移到 customprovider 系统。\n用 /llm customprovider add <名称> <apiFormat> <model> <baseUrl> 添加供应商");
            break;
          }
          case "keypool":
          case "密钥池": {
            await ctx.reply("⚠️ 密钥池已迁移到 customprovider 系统。\n用 /llm customprovider addkey/removekey 管理密钥");
            break;
          }
          case "providerpool":
          case "供应商池": {
            await ctx.reply("⚠️ 供应商池已迁移到 customprovider 系统。\n用 /llm customprovider list/add/remove 管理供应商");
            break;
          }
          case "customprovider":
          case "自定义供应商": {
            const config = engine.getConfig();
            const customProviders = { ...(config.customProviders ?? {}) };
            const action = subArgs[0];

            if (!action || action === "list") {
              const names = Object.keys(customProviders);
              if (names.length === 0) {
                await ctx.reply("自定义供应商列表为空\n用法: /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]");
                return;
              }
              const lines = names.map(name => {
                const p = customProviders[name];
                const keyCount = (p.apiKeys?.length ?? 0) || (p.apiKey ? 1 : 0);
                return `  ${name}: ${p.apiFormat} / ${p.model} / keys=${keyCount} / ${p.baseUrl}`;
              });
              await ctx.reply(`自定义供应商 (${names.length} 个):\n${lines.join("\n")}`);
              return;
            }

            if (action === "add") {
              // /llm customprovider add <name> <apiFormat> <model> <baseUrl> [apiKey]
              if (subArgs.length < 5) {
                const { API_FORMATS } = await import("../business/llm-takeover.js");
                const formats = API_FORMATS.map(f => `  ${f.value}: ${f.label}`).join("\n");
                await ctx.reply(`用法: /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]\n\nAPI格式:\n${formats}`);
                return;
              }
              const name = subArgs[1];
              const { API_FORMATS } = await import("../business/llm-takeover.js");
              const apiFormat = subArgs[2] as typeof API_FORMATS[number]["value"];
              const validFormats = API_FORMATS.map(f => f.value);
              if (!validFormats.includes(apiFormat)) {
                await ctx.reply(`❌ 无效 apiFormat: ${apiFormat}\n可选: ${validFormats.join(", ")}`);
                return;
              }
              const model = subArgs[3];
              const baseUrl = subArgs[4];
              const apiKey = subArgs[5] ?? ""; // apiKey can also be added later via addkey
              customProviders[name] = {
                apiFormat,
                model,
                baseUrl,
                apiKey,
                apiKeys: apiKey ? [apiKey] : [],
              };
              engine.updateConfig({ customProviders });
              // Auto-switch to new provider if none active
              if (!engine.getConfig().provider) {
                engine.updateConfig({ provider: name });
              }
              await ctx.reply(`✅ 自定义供应商 "${name}" 已添加 (${apiFormat})\n用 /llm customprovider addkey ${name} <key> 添加更多密钥`);
              return;
            }

            if (action === "remove") {
              if (!subArgs[1]) { await ctx.reply("用法: /llm customprovider remove <名称>"); return; }
              if (!customProviders[subArgs[1]]) { await ctx.reply(`未找到: ${subArgs[1]}`); return; }
              delete customProviders[subArgs[1]];
              engine.updateConfig({ customProviders });
              await ctx.reply(`✅ 已移除: ${subArgs[1]}`);
              return;
            }

            if (action === "addkey") {
              if (subArgs.length < 3) { await ctx.reply("用法: /llm customprovider addkey <名称> <key>"); return; }
              const name = subArgs[1];
              if (!customProviders[name]) { await ctx.reply(`未找到: ${name}`); return; }
              const pool = customProviders[name].apiKeys ?? [];
              if (!pool.includes(subArgs[2])) pool.push(subArgs[2]);
              customProviders[name].apiKeys = pool;
              if (!customProviders[name].apiKey) customProviders[name].apiKey = subArgs[2];
              engine.updateConfig({ customProviders });
              await ctx.reply(`✅ 密钥已添加到 "${name}" (共 ${pool.length} 个)`);
              return;
            }

            if (action === "removekey") {
              if (subArgs.length < 3) { await ctx.reply("用法: /llm customprovider removekey <名称> <索引>"); return; }
              const name = subArgs[1];
              if (!customProviders[name]) { await ctx.reply(`未找到: ${name}`); return; }
              const pool = customProviders[name].apiKeys ?? [];
              const idx = parseInt(subArgs[2], 10);
              if (isNaN(idx) || idx < 0 || idx >= pool.length) { await ctx.reply(`无效索引 (0-${pool.length - 1})`); return; }
              pool.splice(idx, 1);
              customProviders[name].apiKeys = pool;
              engine.updateConfig({ customProviders });
              await ctx.reply(`✅ 已移除 (剩 ${pool.length} 个)`);
              return;
            }

            if (action === "use") {
              if (!subArgs[1]) { await ctx.reply("用法: /llm customprovider use <名称>"); return; }
              if (!customProviders[subArgs[1]]) { await ctx.reply(`未找到: ${subArgs[1]}`); return; }
              engine.updateConfig({ provider: subArgs[1] });
              await ctx.reply(`✅ 已切换到: ${subArgs[1]}`);
              return;
            }

            await ctx.reply(
              "用法:\n" +
              "  /llm customprovider list                                    列出\n" +
              "  /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]  添加\n" +
              "  /llm customprovider remove <名称>                           移除\n" +
              "  /llm customprovider addkey <名称> <key>                     添加密钥\n" +
              "  /llm customprovider removekey <名称> <索引>                 移除密钥\n" +
              "  /llm customprovider use <名称>                              切换\n\n" +
              "apiFormat: openai-chat-completions | anthropic-messages | google-gemini-rest | aws-bedrock-converse | azure-openai",
            );
            return;
          }
          case "config":
          case "配置": {
            // Interactive LLM config wizard (blocking, like /init)
            // Delegates to the same wizard session mechanism as /init
            const llmWizardSessions = (this as unknown as { _llmWizardSessions?: Map<string, unknown> })._llmWizardSessions;
            if (!llmWizardSessions) {
              await ctx.reply("❌ LLM 配置向导不可用");
              return;
            }
            const userId = ctx.message.fromUserId;

            // Cancel
            if (subArgs[0]?.toLowerCase() === "cancel") {
              llmWizardSessions.delete(userId);
              await ctx.reply("✅ LLM 配置向导已取消");
              return;
            }

            // Start wizard
            llmWizardSessions.set(userId, {
              step: "apiFormat",
              startedAt: Date.now(),
            });

            await ctx.reply(
              `🤖 LLM 配置向导已启动（阻塞模式）\n\n` +
              `接下来的对话将被向导捕获。\n\n` +
              `请选择 API 格式 (发送编号或名称):\n` +
              `  1. openai-chat-completions (OpenAI/DeepSeek/Moonshot等)\n` +
              `  2. anthropic-messages (Claude)\n` +
              `  3. google-gemini-rest (Gemini)\n` +
              `  4. aws-bedrock-converse (Bedrock)\n` +
              `  5. azure-openai (Azure OpenAI)\n\n` +
              `随后需要提供: 供应商名称、模型名称、端点URL、API密钥\n` +
              `随时发送 /llm config cancel 取消`,
            );

            // Auto-cancel after 5 min
            setTimeout(() => {
              const session = llmWizardSessions.get(userId) as { startedAt: number } | undefined;
              if (session && Date.now() - session.startedAt > 5 * 60 * 1000) {
                llmWizardSessions.delete(userId);
              }
            }, 5 * 60 * 1000);
            return;
          }
          case "group":
          case "群聊": {
            if (subArgs[0] === "on") {
              engine.updateConfig({ enableInGroup: true });
              await ctx.reply("✅ LLM 群聊响应已开启");
            } else if (subArgs[0] === "off") {
              engine.updateConfig({ enableInGroup: false });
              await ctx.reply("✅ LLM 群聊响应已关闭");
            } else if (subArgs[0] === "mention") {
              const val = subArgs[1];
              if (val === "on" || val === "true") {
                engine.updateConfig({ requireMentionInGroup: true });
                await ctx.reply("✅ 群聊需@才回复");
              } else if (val === "off" || val === "false") {
                engine.updateConfig({ requireMentionInGroup: false });
                await ctx.reply("✅ 群聊无需@即可回复");
              }
            } else {
              await ctx.reply("用法: /llm group <on|off|mention> [on|off]");
            }
            break;
          }
          case "merge":
          case "合并": {
            const cfg = engine.getConfig();
            if (subArgs.length === 0) {
              await ctx.reply(`当前合并窗口: ${cfg.mergeWindowMs}ms (0=不等待，立即响应)`);
            } else {
              const ms = parseInt(subArgs[0], 10);
              if (isNaN(ms) || ms < 0) {
                await ctx.reply("用法: /llm merge <毫秒数> (0=不等待)");
              } else {
                engine.updateConfig({ mergeWindowMs: ms });
                await ctx.reply(`✅ 合并窗口已设为: ${ms}ms${ms === 0 ? " (立即响应)" : ""}`);
              }
            }
            break;
          }
          case "cooldown":
          case "冷却": {
            const cfg = engine.getConfig();
            if (subArgs.length === 0) {
              await ctx.reply(`当前冷却时间: ${cfg.cooldownMs}ms (0=无冷却)`);
            } else {
              const ms = parseInt(subArgs[0], 10);
              if (isNaN(ms) || ms < 0) {
                await ctx.reply("用法: /llm cooldown <毫秒数> (0=无冷却)");
              } else {
                engine.updateConfig({ cooldownMs: ms });
                await ctx.reply(`✅ 冷却时间已设为: ${ms}ms${ms === 0 ? " (无冷却)" : ""}`);
              }
            }
            break;
          }
          case "iterate":
          case "迭代": {
            const cfg = engine.getConfig();
            if (subArgs.length === 0) {
              await ctx.reply(`当前最大迭代轮数: ${cfg.maxIterate === 0 ? "无限" : cfg.maxIterate} (0=无限)`);
            } else {
              const n = parseInt(subArgs[0], 10);
              if (isNaN(n) || n < 0) {
                await ctx.reply("用法: /llm iterate <轮数> (0=无限)");
              } else {
                engine.updateConfig({ maxIterate: n });
                await ctx.reply(`✅ 最大迭代轮数已设为: ${n === 0 ? "无限" : n}`);
              }
            }
            break;
          }
          default:
            await ctx.reply(`未知LLM子命令: ${subCmd}。使用 /llm 查看状态`);
        }
      },
    });

    // /config — runtime configuration management (dmOnly: system operation)
    this.register({
      name: "config",
      aliases: ["配置"],
      description: "配置管理（查看/设置/导入/导出/档案）",
      usage: "/config [show | set <key> <value> | get <key> | profile list|switch|add|remove | export | import <json>]",
      category: "system" as CommandCategory,
      requireConnected: false,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();

        // Lazy-import the shared ConfigStore
        const { getGlobalConfigStore } = await import("../shared/config.js");
        const store = getGlobalConfigStore({ autoSave: true });

        switch (subCmd) {
          case undefined:
          case "show": {
            const active = store.getActiveProfileName();
            const pr = store.getActiveProfile();
            const lines = [
              "📋 当前配置:",
              `  档案: ${active}`,
              `  App Key: ${pr.appKey ? `***${pr.appKey.slice(-4)}` : "(未设置)"}`,
              `  App Secret: ${pr.appSecret ? "***" + pr.appSecret.slice(-4) : "(未设置)"}`,
              `  Token: ${pr.token ? "***" + pr.token.slice(-4) : "(未设置)"}`,
              `  API域名: ${pr.apiDomain || "(默认)"}`,
              `  WS地址: ${pr.wsUrl || "(默认)"}`,
              `  日志级别: ${pr.logLevel || "(默认)"}`,
              `  贴纸目录: ${pr.stickerDir || "(未设置)"}`,
              `  下载目录: ${pr.downloadDir || store.getGlobal("downloadDir") || "(默认)"}`,
              `  LLM供应商: ${pr.llmProvider || "(未设置)"}`,
              `  LLM模型: ${pr.llmModel || "(未设置)"}`,
              `  配置路径: ${store.getConfigDir()}`,
            ];
            await ctx.reply(lines.join("\n"));
            return;
          }

          case "get": {
            if (!ctx.args[1]) {
              await ctx.reply("用法: /config get <key>");
              return;
            }
            const key = ctx.args[1] as keyof import("../shared/config.js").CliProfile;
            const value = store.get(key);
            if (value === undefined) {
              await ctx.reply(`配置项 ${key} 未设置`);
            } else if (typeof value === "string" && (key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey")) {
              await ctx.reply(`${key} = ***${value.slice(-4)}`);
            } else {
              await ctx.reply(`${key} = ${String(value)}`);
            }
            return;
          }

          case "set": {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /config set <key> <value>");
              return;
            }
            const key = ctx.args[1] as keyof import("../shared/config.js").CliProfile;
            const value = ctx.args.slice(2).join(" ");
            const validKeys: Array<keyof import("../shared/config.js").CliProfile> = [
              "appKey", "appSecret", "token", "apiDomain", "wsUrl",
              "logLevel", "stickerDir", "downloadDir", "prompt",
              "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel",
              "llmSystemPrompt", "llmEnabled", "defaultTarget", "defaultChatMode",
            ];
            if (!validKeys.includes(key)) {
              await ctx.reply(`无效配置键: ${key}\n可选: ${validKeys.join(", ")}`);
              return;
            }
            store.set(key, value as never);
            await ctx.reply(`✅ 已设置 ${key} = ${key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey" ? "***" : value}`);
            return;
          }

          case "profile": {
            const profileSub = ctx.args[1]?.toLowerCase();
            if (profileSub === "list" || !profileSub) {
              const names = store.getProfileNames();
              const active = store.getActiveProfileName();
              if (names.length === 0) {
                await ctx.reply("暂无配置档案");
                return;
              }
              const lines = names.map(n => {
                const p = store.getProfile(n);
                const hasCreds = p && ((p.appKey && p.appSecret) || p.token);
                return `  ${n === active ? "→" : " "} ${n} ${hasCreds ? "✓" : "✗"}`;
              });
              await ctx.reply(`📋 配置档案:\n${lines.join("\n")}`);
              return;
            }
            if (profileSub === "switch" && ctx.args[2]) {
              if (store.switchProfile(ctx.args[2])) {
                await ctx.reply(`✅ 已切换到档案: ${ctx.args[2]}\n⚠️ 需要重启 daemon 让新档案生效`);
              } else {
                await ctx.reply(`❌ 档案不存在: ${ctx.args[2]}`);
              }
              return;
            }
            if (profileSub === "add" && ctx.args[2]) {
              store.createProfile(ctx.args[2], {});
              await ctx.reply(`✅ 已创建档案: ${ctx.args[2]}`);
              return;
            }
            if (profileSub === "remove" && ctx.args[2]) {
              if (store.deleteProfile(ctx.args[2])) {
                await ctx.reply(`✅ 已删除档案: ${ctx.args[2]}`);
              } else {
                await ctx.reply(`❌ 无法删除档案: ${ctx.args[2]} (可能不存在或为活跃档案)`);
              }
              return;
            }
            await ctx.reply("用法: /config profile list|switch <name>|add <name>|remove <name>");
            return;
          }

          case "export": {
            const data = store.getData();
            await ctx.reply(`📦 配置导出 (JSON):\n${JSON.stringify(data, null, 2)}`);
            return;
          }

          case "import": {
            if (!ctx.args[1]) {
              await ctx.reply("用法: /config import <json>");
              return;
            }
            try {
              const json = ctx.args.slice(1).join(" ");
              const parsed = JSON.parse(json) as import("../shared/config.js").CliConfigData;
              // Merge into existing config
              if (parsed.profiles) {
                for (const [name, profile] of Object.entries(parsed.profiles)) {
                  store.createProfile(name, profile);
                }
              }
              if (parsed.activeProfile && store.getProfile(parsed.activeProfile)) {
                store.switchProfile(parsed.activeProfile);
              }
              await ctx.reply("✅ 配置已导入");
            } catch (err) {
              await ctx.reply(`❌ 导入失败: ${(err as Error).message}`);
            }
            return;
          }

          default:
            await ctx.reply(
              "用法:\n" +
              "  /config                       显示当前配置\n" +
              "  /config show                  同上\n" +
              "  /config get <key>             查询单个配置项\n" +
              "  /config set <key> <value>     设置配置项\n" +
              "  /config profile list          列出所有档案\n" +
              "  /config profile switch <name> 切换档案\n" +
              "  /config profile add <name>    创建档案\n" +
              "  /config profile remove <name> 删除档案\n" +
              "  /config export                导出配置为 JSON\n" +
              "  /config import <json>         导入配置",
            );
        }
      },
    });

    // /init — interactive configuration wizard (dmOnly, blocks conversation)
    // Uses a per-user wizard session state machine. Once started, subsequent
    // non-slash messages from the user are captured as wizard input until
    // completion or cancellation.
    {
      // Per-user wizard session state
      type WizardSession = {
        step: "appkey" | "appsecret" | "token" | "done";
        authMethod: "appkey" | "token";
        appKey?: string;
        appSecret?: string;
        token?: string;
        startedAt: number;
      };
      const wizardSessions = new Map<string, WizardSession>();
      const WIZARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

      // Register a pre-dispatch hook: if user has an active wizard session,
      // capture non-slash messages as wizard input.
      // We do this by checking in the /init handler and exposing a helper
      // that handleDispatch can call. For simplicity, we use a module-level
      // Map that YuanbaoBot.handleDispatch can check.

      this.register({
        name: "init",
        aliases: ["初始化", "setup", "配置向导"],
        description: "交互式配置向导（阻塞对话，引导设置认证信息）",
        usage: "/init [appkey|appsecret|token <值>]   (无参数启动向导，/init cancel 取消)",
        category: "system" as CommandCategory,
        requireConnected: false,
        dmOnly: true,
        handler: async (ctx) => {
          const { getGlobalConfigStore } = await import("../shared/config.js");
          const store = getGlobalConfigStore({ autoSave: true });
          const active = store.getActiveProfileName();
          const userId = ctx.message.fromUserId;

          // Cancel sub-command
          if (ctx.args[0]?.toLowerCase() === "cancel") {
            wizardSessions.delete(userId);
            await ctx.reply("✅ 配置向导已取消");
            return;
          }

          // If args provided, treat as direct field-set (non-interactive)
          const field = ctx.args[0]?.toLowerCase();
          const value = ctx.args.slice(1).join(" ").trim();
          if (field && value && field !== "appkey" && field !== "appsecret" && field !== "token" && field !== "app-key" && field !== "app-secret") {
            await ctx.reply(`❌ 无效字段: ${field}\n支持: appkey, appsecret, token`);
            return;
          }
          if (field && value) {
            const validFields: Record<string, string> = {
              appkey: "appKey",
              "app-key": "appKey",
              appsecret: "appSecret",
              "app-secret": "appSecret",
              token: "token",
            };
            const configKey = validFields[field];
            if (configKey) {
              store.set(configKey as never, value as never);
              await ctx.reply(
                `✅ 已设置 ${configKey} = ***${value.slice(-4)}\n` +
                `档案: ${active}\n` +
                `配置完成。发送 /daemon restart (3次) 让新配置生效`,
              );
            }
            return;
          }

          // Start interactive wizard
          wizardSessions.set(userId, {
            step: "appkey",
            authMethod: "appkey",
            startedAt: Date.now(),
          });

          await ctx.reply(
            `🤖 配置向导已启动（阻塞模式）\n\n` +
            `接下来的对话将被向导捕获，直到完成或取消。\n\n` +
            `请选择认证方式:\n` +
            `  1️⃣ 发送 "appkey" 使用 AppKey + AppSecret\n` +
            `  2️⃣ 发送 "token" 使用 Token\n\n` +
            `随时发送 /init cancel 取消`,
          );

          // Set a timeout to auto-cancel
          setTimeout(() => {
            const session = wizardSessions.get(userId);
            if (session && Date.now() - session.startedAt > WIZARD_TIMEOUT_MS) {
              wizardSessions.delete(userId);
            }
          }, WIZARD_TIMEOUT_MS);
        },
      });

      // Register a handler that YuanbaoBot can call to check if a message
      // should be intercepted by the wizard. We attach it to the CommandSystem
      // instance so handleDispatch can query it.
      // (See YuanbaoBot.handleDispatch for the interception point.)
      (this as unknown as { _initWizardSessions: Map<string, unknown> })._initWizardSessions = wizardSessions;

      // The wizard step handler is invoked by handleDispatch when a user has
      // an active session. We register it as a method on the CommandSystem.
      (this as unknown as { _handleInitWizardInput: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean> })._handleInitWizardInput =
        async (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>): Promise<boolean> => {
          const session = wizardSessions.get(userId);
          if (!session) return false;

          // Check timeout
          if (Date.now() - session.startedAt > WIZARD_TIMEOUT_MS) {
            wizardSessions.delete(userId);
            await reply("⏰ 配置向导已超时（5分钟），请重新发送 /init");
            return true;
          }

          const { getGlobalConfigStore } = await import("../shared/config.js");
          const store = getGlobalConfigStore({ autoSave: true });

          // Step: choose auth method
          if (session.step === "appkey" && !session.appKey && text.toLowerCase() !== "token" && text.toLowerCase() !== "appkey") {
            // First message after wizard start — expect "appkey" or "token"
            if (text.toLowerCase() === "token") {
              session.authMethod = "token";
              session.step = "token";
              await reply("📝 请发送你的 Token (格式: appKey:appSecret 或预签名token):");
              return true;
            }
            // Treat any other input as starting with appkey
            session.authMethod = "appkey";
            session.appKey = text.trim();
            session.step = "appsecret";
            await reply(`✅ App Key 已接收: ***${text.trim().slice(-4)}\n📝 请发送你的 App Secret:`);
            return true;
          }

          if (session.step === "appkey" && (text.toLowerCase() === "appkey" || text.toLowerCase() === "1")) {
            session.step = "appsecret";
            await reply("📝 请发送你的 App Key:");
            return true;
          }

          if (session.step === "appkey" && (text.toLowerCase() === "token" || text.toLowerCase() === "2")) {
            session.authMethod = "token";
            session.step = "token";
            await reply("📝 请发送你的 Token:");
            return true;
          }

          // Step: collect appkey
          if (session.step === "appkey" && !session.appKey) {
            session.appKey = text.trim();
            session.step = "appsecret";
            await reply(`✅ App Key 已接收: ***${text.trim().slice(-4)}\n📝 请发送你的 App Secret:`);
            return true;
          }

          // Step: collect appsecret
          if (session.step === "appsecret") {
            session.appSecret = text.trim();
            session.step = "done";
            // Save
            store.set("appKey", session.appKey as never);
            store.set("appSecret", session.appSecret as never);
            wizardSessions.delete(userId);
            await reply(
              `✅ 配置完成!\n` +
              `  App Key: ***${(session.appKey ?? "").slice(-4)}\n` +
              `  App Secret: ***${(session.appSecret ?? "").slice(-4)}\n\n` +
              `发送 /daemon restart (3次) 让新配置生效`,
            );
            return true;
          }

          // Step: collect token
          if (session.step === "token") {
            session.token = text.trim();
            session.step = "done";
            store.set("token", session.token as never);
            wizardSessions.delete(userId);
            await reply(
              `✅ 配置完成!\n` +
              `  Token: ***${session.token.slice(-4)}\n\n` +
              `发送 /daemon restart (3次) 让新配置生效`,
            );
            return true;
          }

          return true; // session active but unknown step — swallow input
        };
    }

    // ─── LLM interactive config wizard (blocking, like /init) ───
    {
      type LlmWizardSession = {
        step: "apiFormat" | "name" | "model" | "baseUrl" | "apiKey" | "systemPrompt" | "done";
        apiFormat?: string;
        providerName?: string;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
        startedAt: number;
      };
      const llmWizardSessions = new Map<string, LlmWizardSession>();
      (this as unknown as { _llmWizardSessions: Map<string, unknown> })._llmWizardSessions = llmWizardSessions;

      (this as unknown as { _handleLlmWizardInput: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean> })._handleLlmWizardInput =
        async (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>): Promise<boolean> => {
          const session = llmWizardSessions.get(userId);
          if (!session) return false;

          if (Date.now() - session.startedAt > 5 * 60 * 1000) {
            llmWizardSessions.delete(userId);
            await reply("⏰ LLM 配置向导已超时（5分钟），请重新发送 /llm config");
            return true;
          }

          const engine = (bot as { getLlmEngine?: () => unknown }).getLlmEngine?.() as
            { updateConfig: (patch: Record<string, unknown>) => void; getConfig: () => Record<string, unknown> } | null;
          if (!engine) {
            llmWizardSessions.delete(userId);
            await reply("❌ LLM 引擎未初始化");
            return true;
          }

          const input = text.trim();

          // Step 1: Choose API format
          if (session.step === "apiFormat") {
            const { API_FORMATS } = await import("../business/llm-takeover.js");
            const formatMap: Record<string, string> = {};
            API_FORMATS.forEach((f, i) => {
              formatMap[String(i + 1)] = f.value;
              formatMap[f.value] = f.value;
              // Also support short forms
              if (f.value === "openai-chat-completions") { formatMap["openai"] = f.value; formatMap["1"] = f.value; }
              if (f.value === "anthropic-messages") { formatMap["anthropic"] = f.value; formatMap["claude"] = f.value; formatMap["2"] = f.value; }
              if (f.value === "google-gemini-rest") { formatMap["gemini"] = f.value; formatMap["google"] = f.value; formatMap["3"] = f.value; }
              if (f.value === "aws-bedrock-converse") { formatMap["bedrock"] = f.value; formatMap["aws"] = f.value; formatMap["4"] = f.value; }
              if (f.value === "azure-openai") { formatMap["azure"] = f.value; formatMap["5"] = f.value; }
            });
            const apiFormat = formatMap[input.toLowerCase()];
            if (!apiFormat) {
              await reply(`❌ 无效选择: ${input}\n请发送 1-5 或格式名称`);
              return true;
            }
            session.apiFormat = apiFormat;
            session.step = "name";
            await reply(`✅ API 格式: ${apiFormat}\n\n📝 请发送供应商名称 (如 my-openai, backup-claude):`);
            return true;
          }

          // Step 2: Provider name
          if (session.step === "name") {
            session.providerName = input;
            session.step = "model";
            await reply(`✅ 供应商名称: ${input}\n\n📝 请发送模型名称 (如 gpt-4o, claude-sonnet-4-20250514):`);
            return true;
          }

          // Step 3: Model name (required)
          if (session.step === "model") {
            session.model = input;
            session.step = "baseUrl";
            const { API_FORMATS } = await import("../business/llm-takeover.js");
            const fmt = API_FORMATS.find(f => f.value === session.apiFormat);
            const hint = fmt?.defaultEndpoint ? `\n(默认: ${fmt.defaultEndpoint})` : "";
            await reply(`✅ 模型: ${input}\n\n📝 请发送端点 URL (baseUrl):${hint}`);
            return true;
          }

          // Step 4: Base URL (required)
          if (session.step === "baseUrl") {
            session.baseUrl = input;
            session.step = "apiKey";
            await reply(`✅ 端点: ${input}\n\n📝 请发送 API Key:`);
            return true;
          }

          // Step 5: API Key (required)
          if (session.step === "apiKey") {
            session.apiKey = input;
            // Save the provider config
            const config = engine.getConfig() as { customProviders?: Record<string, unknown> };
            const customProviders = { ...(config.customProviders ?? {}) };
            customProviders[session.providerName!] = {
              apiFormat: session.apiFormat,
              model: session.model,
              baseUrl: session.baseUrl,
              apiKey: input,
              apiKeys: [input],
            };
            engine.updateConfig({ customProviders, provider: session.providerName });
            session.step = "systemPrompt";
            await reply(
              `✅ 供应商 "${session.providerName}" 已创建!\n` +
              `  API格式: ${session.apiFormat}\n` +
              `  模型: ${session.model}\n` +
              `  端点: ${session.baseUrl}\n` +
              `  密钥: ***${input.slice(-4)}\n\n` +
              `📝 请发送系统提示词 (或 skip 使用默认):`,
            );
            return true;
          }

          // Step 6: System prompt (optional)
          if (session.step === "systemPrompt") {
            if (input.toLowerCase() !== "skip" && input.toLowerCase() !== "done") {
              engine.updateConfig({ systemPrompt: input });
            }
            session.step = "done";
            llmWizardSessions.delete(userId);
            await reply(
              `✅ LLM 配置完成!\n` +
              `  供应商: ${session.providerName} (${session.apiFormat})\n` +
              `  模型: ${session.model}\n\n` +
              `发送 /llm on 开启自动回复\n` +
              `发送 /llm status 查看状态`,
            );
            return true;
          }

          return true;
        };
    }

    // /daemon — daemon management via IM (dmOnly, 3x confirmation within 1 min)
    // Tracks confirmation counts per-user. Must send the same sub-command 3 times
    // within 60 seconds for it to execute.
    {
      // Per-user confirmation tracking: key = `${userId}:${subCmd}`, value = { count, firstAt }
      const daemonConfirmations = new Map<string, { count: number; firstAt: number }>();
      const CONFIRM_WINDOW_MS = 60_000; // 1 minute
      const REQUIRED_CONFIRMATIONS = 3;

      this.register({
        name: "daemon",
        aliases: ["守护进程"],
        description: "daemon 进程管理（stop/reset/restart，需3次确认）",
        usage: "/daemon <stop|reset|restart|status>   (1分钟内发送3次才生效)",
        category: "system" as CommandCategory,
        requireConnected: false,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const userId = ctx.message.fromUserId;

          if (!subCmd || subCmd === "status") {
            // Status — no confirmation needed
            const { getDefaultClient } = await import("../cli/client/daemon-client.js");
            const client = getDefaultClient();
            const info = await client.ping();
            if (!info) {
              await ctx.reply("daemon 未在运行");
              return;
            }
            const bot = info.bot;
            const lines = [
              `📊 daemon 状态:`,
              `  PID: ${info.pid}`,
              `  版本: ${info.version}`,
              `  端口: ${info.port}`,
              `  运行: ${info.uptime}s`,
              `  Bot: ${bot?.connected ? "✓ 已连接" : "✗ 未连接"}`,
              ...(bot?.botId ? [`  Bot ID: ${bot.botId}`] : []),
            ];
            await ctx.reply(lines.join("\n"));
            return;
          }

          if (!["stop", "reset", "restart"].includes(subCmd)) {
            await ctx.reply("用法: /daemon <stop|reset|restart|status>\nstop/reset/restart 需要1分钟内发送3次确认");
            return;
          }

          // CLI source bypasses the 3x confirmation (CLI is pre-authorized)
          if (ctx.source === "cli") {
            const { getDefaultClient } = await import("../cli/client/daemon-client.js");
            const client = getDefaultClient();
            try {
              if (subCmd === "stop") {
                await client.shutdown();
                await ctx.reply(`✅ daemon 已停止 (CLI 直接执行)`);
              } else if (subCmd === "restart") {
                await client.shutdown();
                await new Promise(r => setTimeout(r, 2000));
                await client.ensureDaemon({});
                await ctx.reply(`✅ daemon 已重启 (CLI 直接执行)`);
              } else if (subCmd === "reset") {
                await client.shutdown();
                await new Promise(r => setTimeout(r, 2000));
                await client.ensureDaemon({});
                await ctx.reply(`✅ daemon 已重置 (CLI 直接执行，缓存已清除)`);
              }
            } catch (err) {
              await ctx.reply(`❌ daemon ${subCmd} 失败: ${(err as Error).message}`);
            }
            return;
          }

          // Confirmation tracking (chat source only)
          const key = `${userId}:${subCmd}`;
          const now = Date.now();
          const entry = daemonConfirmations.get(key);

          if (!entry || now - entry.firstAt > CONFIRM_WINDOW_MS) {
            // First confirmation (or window expired)
            daemonConfirmations.set(key, { count: 1, firstAt: now });
            await ctx.reply(
              `⚠️ 确认 ${subCmd} daemon (1/3)\n` +
              `请在 ${CONFIRM_WINDOW_MS / 1000}s 内再发送 ${REQUIRED_CONFIRMATIONS - 1} 次 /daemon ${subCmd} 以确认操作`,
            );
            return;
          }

          entry.count++;
          if (entry.count < REQUIRED_CONFIRMATIONS) {
            await ctx.reply(
              `⚠️ 确认 ${subCmd} daemon (${entry.count}/${REQUIRED_CONFIRMATIONS})\n` +
              `还需 ${REQUIRED_CONFIRMATIONS - entry.count} 次确认`,
            );
            return;
          }

          // Reached required confirmations — execute
          daemonConfirmations.delete(key);
          const { getDefaultClient } = await import("../cli/client/daemon-client.js");
          const client = getDefaultClient();

          try {
            if (subCmd === "stop") {
              await client.shutdown();
              await ctx.reply(`✅ daemon 已停止 (${REQUIRED_CONFIRMATIONS} 次确认完成)`);
            } else if (subCmd === "restart") {
              await client.shutdown();
              await new Promise(r => setTimeout(r, 2000)); // wait for daemon to die
              await client.ensureDaemon({});
              await ctx.reply(`✅ daemon 已重启 (${REQUIRED_CONFIRMATIONS} 次确认完成)`);
            } else if (subCmd === "reset") {
              // reset = stop + clear caches + restart
              await client.shutdown();
              await new Promise(r => setTimeout(r, 2000));
              // Clear sign-token cache via a fresh start (the daemon clears on boot)
              await client.ensureDaemon({});
              await ctx.reply(`✅ daemon 已重置 (${REQUIRED_CONFIRMATIONS} 次确认完成，缓存已清除)`);
            }
          } catch (err) {
            await ctx.reply(`❌ daemon ${subCmd} 失败: ${(err as Error).message}`);
          }
        },
      });
    }

    // /log — set log level (dmOnly: system-level operation)
    this.register({
      name: "log",
      aliases: ["日志"],
      description: "切换日志级别（持久化保存）",
      usage: "/log <debug|info|warn|error>",
      category: "system" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /log <debug|info|warn|error>");
          return;
        }
        const level = ctx.args[0] as "debug" | "info" | "warn" | "error";
        const validLevels = ["debug", "info", "warn", "error"];
        if (!validLevels.includes(level)) {
          await ctx.reply(`无效日志级别: ${level} (可选: ${validLevels.join("|")})`);
          return;
        }
        const { setLogLevel } = await import("../logger.js");
        setLogLevel(level);
        // Persist log level to config
        try {
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import("node:fs");
          const configDir = join(homedir(), ".yuanbao-lite");
          const configPath = join(configDir, "runtime-prefs.json");
          let prefs: Record<string, unknown> = {};
          if (existsSync(configPath)) {
            try { prefs = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* ignore */ }
          }
          prefs.logLevel = level;
          if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
          writeFileSync(configPath, JSON.stringify(prefs, null, 2), "utf-8");
        } catch { /* persist failure is non-critical */ }
        await ctx.reply(`日志级别已切换为: ${level}`);
      },
    });

    // ═══════════════════════════════════════════
    // Commands ported from CLI (v10.6.0)
    // ═══════════════════════════════════════════

    // /reply — quote reply to a message
    this.register({
      name: "reply",
      aliases: ["引用回复"],
      description: "引用回复指定消息（支持消息ID或尾号）",
      usage: "/reply <消息ID或#尾号> <回复内容>",
      category: "chat" as CommandCategory,
      requireConnected: true,
      handler: async (ctx) => {
        if (ctx.args.length < 2) {
          await ctx.reply("用法: /reply <消息ID或尾号> <回复内容>\n提示: 历史消息中的 #xxxxxxxx 即为消息ID尾号");
          return;
        }
        let msgId = ctx.args[0];
        const replyText = ctx.args.slice(1).join(" ");
        const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
        const isGroup = ctx.isGroup;

        // Strip leading # if present (user may copy the #xxxxxxxx format)
        if (msgId.startsWith("#")) {
          msgId = msgId.slice(1);
        }

        // Try to find the message by ID or short ID suffix
        const store = ctx.bot.getHistoryStore();

        // 1. Try exact match first
        const exactMatch = store.getById(msgId);
        if (exactMatch) {
          msgId = exactMatch.id!;
        } else {
          // 2. Short ID suffix match: search recent messages whose ID ends with this suffix
          //    This works for both short IDs (<=8 chars) and partial IDs
          const recentMsgs = store.getRecent(500);
          const candidates = recentMsgs.filter(m => m.id && String(m.id).endsWith(msgId));
          if (candidates.length === 1) {
            msgId = candidates[0].id!;
          } else if (candidates.length > 1) {
            // Multiple matches — show ambiguous results
            const lines = candidates.slice(0, 5).map(m => {
              const shortId = m.id!.length > 8 ? m.id!.slice(-8) : m.id!;
              const sender = m.fromNickname || m.fromUserId;
              const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
              return `  #${shortId} [${time}] ${sender}: ${(m.text || "").substring(0, 40)}`;
            });
            await ctx.reply(`⚠️ 消息尾号 ${msgId} 匹配到多条消息，请使用更长的ID:\n${lines.join("\n")}`);
            return;
          } else {
            // No match by endsWith — try String() conversion for numeric IDs
            const candidatesAlt = recentMsgs.filter(m => {
              if (!m.id) return false;
              const idStr = String(m.id);
              return idStr.endsWith(msgId) || idStr === msgId;
            });
            if (candidatesAlt.length === 1) {
              msgId = candidatesAlt[0].id!;
            } else if (candidatesAlt.length > 1) {
              const lines = candidatesAlt.slice(0, 5).map(m => {
                const shortId = m.id!.length > 8 ? m.id!.slice(-8) : m.id!;
                const sender = m.fromNickname || m.fromUserId;
                const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
                return `  #${shortId} [${time}] ${sender}: ${(m.text || "").substring(0, 40)}`;
              });
              await ctx.reply(`⚠️ 消息尾号 ${msgId} 匹配到多条消息，请使用更长的ID:\n${lines.join("\n")}`);
              return;
            } else {
              // No match found
              await ctx.reply(`❌ 未找到消息尾号为 ${msgId} 的消息，请检查ID是否正确`);
              return;
            }
          }
        }

        try {
          await ctx.bot.sendText({ to, text: replyText, isGroup, quoteMsgId: msgId });
          await ctx.reply(`✅ 已引用回复消息 #${msgId.length > 8 ? msgId.slice(-8) : msgId}`);
        } catch (err) {
          await ctx.reply(`❌ 引用回复失败: ${(err as Error).message}`);
        }
      },
    });

    // /shell /sh — run system command (dmOnly: security-sensitive)
    // --all/-a as the first arg means "no truncation" (/shell --all <cmd>)
    // --all/-a appearing later in the args is passed through to the command (/shell <cmd> --all)
    this.register({
      name: "shell",
      aliases: ["sh"],
      description: "运行系统命令（仅私聊，默认截断2000字符输出）",
      usage: "/shell [--all] <命令>   (--all/-a 放在命令前取消截断，命令中的 --all/-a 会原样传入)",
      category: "system" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply(
            "用法: /shell [--all] <命令>\n" +
            "例如: /shell ls -la /tmp          (输出截断至2000字符)\n" +
            "      /shell --all ls -la /tmp    (输出不截断)\n" +
            "      /shell ls --all              (--all 作为 ls 的参数原样传入)\n" +
            "提示: --all/-a 放在命令前 = 取消截断；放在命令后 = 原样传入"
          );
          return;
        }
        // ctx.args already has the leading --all/-a stripped by makeContext (when it was first arg)
        // and ctx.showAll is set accordingly. Any --all/-a in later positions is preserved in ctx.args.
        const cmd = ctx.args.join(" ");
        const { exec } = await import("node:child_process");
        try {
          const output = await new Promise<string>((resolve, reject) => {
            exec(cmd, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              if (err && !stdout && !stderr) {
                reject(err);
                return;
              }
              const parts: string[] = [];
              if (stdout) parts.push(stdout.trim());
              if (stderr) parts.push(`[stderr] ${stderr.trim()}`);
              resolve(parts.join("\n") || "(无输出)");
            });
          });
          // Truncate output if too long for IM (unless --all/-a was the first arg)
          const maxLen = ctx.showAll ? Infinity : 2000;
          const truncated = output.length > maxLen
            ? output.substring(0, maxLen) + `\n... (输出被截断，共 ${output.length} 字符，用 /shell --all ${cmd} 查看全部)`
            : output;
          await ctx.reply(`💻 $ ${cmd}\n${truncated}`);
        } catch (err) {
          await ctx.reply(`❌ 命令执行失败: ${(err as Error).message}`);
        }
      },
    });

    // /chat — send message to a target (dmOnly: can send messages on behalf of bot)
    this.register({
      name: "chat",
      aliases: ["聊天"],
      description: "向指定目标发送消息（私聊或群聊）",
      usage: "/chat <用户ID|group 群号> <消息>",
      category: "chat" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /chat <用户ID> <消息>\n      /chat group <群号> <消息>");
          return;
        }
        if (ctx.args[0] === "group" && ctx.args.length >= 3) {
          const groupCode = ctx.args[1];
          const text = ctx.args.slice(2).join(" ");
          try {
            await ctx.bot.sendGroupMessage(groupCode, text);
            await ctx.reply(`✅ 已发送群聊消息到 ${groupCode}`);
          } catch (err) {
            await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
          }
        } else if (ctx.args.length >= 2) {
          const userId = ctx.args[0];
          const text = ctx.args.slice(1).join(" ");
          try {
            await ctx.bot.sendDirectMessage(userId, text);
            await ctx.reply(`✅ 已发送私聊消息给 ${userId}`);
          } catch (err) {
            await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
          }
        } else {
          await ctx.reply("用法: /chat <用户ID> <消息>\n      /chat group <群号> <消息>");
        }
      },
    });

    // /join — add group to tracking and send greeting
    this.register({
      name: "join",
      aliases: ["加入"],
      description: "加入群聊会话并跟踪活动",
      usage: "/join <群号>",
      category: "group" as CommandCategory,
      requireConnected: true,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /join <群号>");
          return;
        }
        const groupCode = ctx.args[0];
        const store = ctx.bot.getGroupStore();
        if (!store.get(groupCode)) {
          store.add(groupCode);
        }
        try {
          const info = await ctx.bot.queryGroupInfo(groupCode);
          const groupName = info.group_info?.group_name || groupCode;
          store.trackActivity(groupCode, groupName);
          await ctx.reply(`✅ 已加入群聊: ${groupName} (${groupCode})`);
        } catch (err) {
          store.trackActivity(groupCode);
          await ctx.reply(`✅ 已加入群聊: ${groupCode} (信息获取失败)`);
        }
      },
    });

    // /switch — list/switch active conversations
    this.register({
      name: "switch",
      aliases: ["切换", "sw"],
      description: "查看/切换活跃群聊会话（默认20条，--all显示全部，编号切换）",
      usage: "/switch [--all] [编号]   (编号: 切换到对应群聊会话)",
      category: "group" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const store = ctx.bot.getGroupStore();
        const groups = store.getAll("lastActive");

        // If a numeric argument is provided, switch to that session
        const numArg = ctx.args.find(a => /^\d+$/.test(a));
        if (numArg) {
          const idx = parseInt(numArg, 10) - 1; // 1-based to 0-based
          if (idx < 0 || idx >= groups.length) {
            await ctx.reply(`无效编号: ${numArg} (范围 1-${groups.length})`);
            return;
          }
          const g = groups[idx];
          // In IM context, switching means... well, the bot itself doesn't have
          // a "current session" concept — this is mainly for CLI REPL use.
          // For IM, we just acknowledge the selection.
          await ctx.reply(`✅ 已选择会话 ${idx + 1}: ${g.groupCode} — ${g.name || g.groupName || "未知"}\n最近活跃: ${g.lastActiveAt ? new Date(g.lastActiveAt).toLocaleString("zh-CN") : "(无)"}`);
          return;
        }

        if (groups.length === 0) {
          await ctx.reply("暂无活跃群聊会话。使用 /join <群号> 加入群聊");
          return;
        }
        // Try to resolve group names for entries that don't have one
        for (const g of groups) {
          if (!g.name && !g.groupName) {
            try {
              const info = await ctx.bot.queryGroupInfo(g.groupCode);
              if (info.code === 0 && info.group_info?.group_name) {
                store.setGroupName(g.groupCode, info.group_info.group_name);
                g.groupName = info.group_info.group_name;
              }
            } catch {
              // Ignore query errors
            }
          }
        }
        const maxGroups = ctx.showAll ? groups.length : 20;
        const lines = groups.slice(0, maxGroups).map((g, i) => {
          const fav = g.favorite ? "⭐" : " ";
          const displayName = g.name || g.groupName || "未知";
          const time = g.lastActiveAt ? new Date(g.lastActiveAt).toLocaleString("zh-CN") : "";
          return `  ${fav} ${i + 1}. ${g.groupCode} — ${displayName}${time ? ` (${time})` : ""}`;
        });
        const suffix = !ctx.showAll && groups.length > 20 ? `\n  ... 及其他 ${groups.length - 20} 个 (用 /switch --all 查看全部)` : "";
        await ctx.reply(`📋 活跃群聊:\n${lines.join("\n")}${suffix}\n共 ${groups.length} 个群聊\n提示: /switch <编号> 切换到对应会话`);
      },
    });

    // /stickers — browse and search stickers
    this.register({
      name: "stickers",
      aliases: ["贴纸列表", "stickerlist"],
      description: "浏览和搜索贴纸（支持模糊搜索，默认30条，--all显示全部）",
      usage: "/stickers [--all] [search <关键词>|emojis|load <目录>]   (--all/-a 显示全部)",
      category: "sticker" as CommandCategory,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const subArgs = ctx.args.slice(1);

        if (subCmd === "search" && subArgs.length > 0) {
          const query = subArgs.join(" ");
          const results = searchStickers(query);
          if (results.length === 0) {
            await ctx.reply(`未找到匹配 "${query}" 的贴纸`);
          } else {
            const maxStickers = ctx.showAll ? results.length : 20;
            const lines = results.slice(0, maxStickers).map(s =>
              `  emoji_${s.stickerId} — ${s.name}${s.description ? ` (${s.description.split(/\s+/).slice(0, 3).join(" ")})` : ""}`
            );
            const suffix = !ctx.showAll && results.length > 20 ? `\n  ... 及其他 ${results.length - 20} 个 (用 /stickers search --all 查看全部)` : "";
            await ctx.reply(`🎨 搜索结果:\n${lines.join("\n")}${suffix}`);
          }
        } else if (subCmd === "load" && subArgs[0]) {
          try {
            const count = loadStickerPacksFromDir(resolve(subArgs[0]));
            await ctx.reply(`✅ 加载了 ${count} 个贴纸包`);
          } catch (err) {
            await ctx.reply(`❌ 加载贴纸包失败: ${(err as Error).message}`);
          }
        } else if (subCmd === "emojis") {
          const emojis = getBuiltinEmojis();
          const maxEmojis = ctx.showAll ? emojis.length : 30;
          const lines = emojis.slice(0, maxEmojis).map(e =>
            `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 3).join(" ")})` : ""}`
          );
          const suffix = !ctx.showAll && emojis.length > 30 ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers emojis --all 查看全部)` : "";
          await ctx.reply(`🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}`);
        } else {
          // Default: show builtin emojis list
          const emojis = getBuiltinEmojis();
          const maxEmojis = ctx.showAll ? emojis.length : 30;
          const lines = emojis.slice(0, maxEmojis).map(e =>
            `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 2).join(" ")})` : ""}`
          );
          const suffix = !ctx.showAll && emojis.length > 30 ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers --all 查看全部)` : "";
          const packs = getStickerPacks();
          let packInfo = "";
          if (packs.length > 0) {
            packInfo = `\n📦 已加载 ${packs.length} 个自定义贴纸包`;
          }
          await ctx.reply(`🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}${packInfo}\n💡 使用 /stickers search <关键词> 模糊搜索贴纸`);
        }
      },
    });

    // /tempfile — upload file to temporary hosting service
    this.register({
      name: "tempfile",
      aliases: ["临时文件", "tmpfile"],
      description: "上传文件到临时平台并发送链接（默认gofile，10天有效）",
      usage: "/tempfile <文件路径> [描述]\n/tempfile <gofile|tmpfiles|uguu|litterbox> <路径> [选项]",
      category: "media" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply(
            "用法: /tempfile <文件路径> [描述]\n" +
            "      /tempfile gofile <路径> [描述]\n" +
            "      /tempfile tmpfiles <路径> [描述]\n" +
            "      /tempfile uguu <路径> [描述]\n" +
            "      /tempfile litterbox <路径> [1h|12h|24h|72h] [描述]"
          );
          return;
        }

        const TEMPFILE_PROVIDERS = ["gofile", "tmpfiles", "uguu", "litterbox"];
        let provider: string | undefined;
        let filePath: string;
        let descParts: string[];

        if (TEMPFILE_PROVIDERS.includes(ctx.args[0])) {
          provider = ctx.args[0];
          if (ctx.args.length < 2) {
            await ctx.reply(`❌ 请指定文件路径: /tempfile ${provider} <路径> [选项]`);
            return;
          }
          filePath = resolve(ctx.args[1]);
          descParts = ctx.args.slice(2);
        } else {
          provider = undefined;
          filePath = resolve(ctx.args[0]);
          descParts = ctx.args.slice(1);
        }

        if (!existsSync(filePath)) {
          await ctx.reply(`❌ 文件不存在: ${filePath}`);
          return;
        }

        try {
          let expire: "1h" | "12h" | "24h" | "72h" | undefined;
          if (provider === "litterbox" && descParts.length > 0 && /^(1h|12h|24h|72h)$/.test(descParts[0])) {
            expire = descParts[0] as "1h" | "12h" | "24h" | "72h";
            descParts = descParts.slice(1);
          }

          const desc = descParts.join(" ") || undefined;
          await ctx.reply(`⏳ 正在上传到 ${provider || "gofile"}: ${filePath}...`);

          let shareText: string;
          if (provider === "litterbox" && expire) {
            const result = await uploadToLitterbox(filePath, expire);
            const sizeStr = result.fileSize > 1024 * 1024
              ? `${(result.fileSize / (1024 * 1024)).toFixed(1)}MB`
              : `${(result.fileSize / 1024).toFixed(0)}KB`;
            const expireStr = result.expireInfo ? ` [${result.expireInfo}]` : "";
            const link = result.directUrl || result.pageUrl;
            shareText = `文件分享${desc ? ` (${desc})` : ""}: ${result.fileName} [${sizeStr}]${expireStr}\n链接: ${link}`;
          } else {
            shareText = await tempfileFormatLink(filePath, desc, provider);
          }

          // Send to the conversation where the command was issued
          const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
          const isGroup = ctx.isGroup;
          await ctx.bot.sendText({ to, text: shareText, isGroup });
        } catch (err) {
          await ctx.reply(`❌ 临时文件上传失败: ${(err as Error).message}`);
        }
      },
    });

    // /hsearch — search message history
    this.register({
      name: "hsearch",
      aliases: ["搜索历史", "histsearch"],
      description: "搜索消息历史（默认15条结果+截断文本，--all显示全部+完整文本）",
      usage: "/hsearch [--all] <关键词>   (--all/-a 显示全部结果及完整文本)",
      category: "history" as CommandCategory,
      handler: async (ctx) => {
        if (ctx.args.length === 0) {
          await ctx.reply("用法: /hsearch <关键词>");
          return;
        }
        const keyword = ctx.args.join(" ");
        const store = ctx.bot.getHistoryStore();
        const results = store.search({ keyword }, 1, ctx.showAll ? 1000 : 20);
        if (results.total === 0) {
          await ctx.reply(`未找到包含 "${keyword}" 的历史消息`);
          return;
        }
        const maxResults = ctx.showAll ? results.messages.length : 15;
        const lines = results.messages.slice(0, maxResults).map(msg => {
          const time = new Date(msg.timestamp).toLocaleString("zh-CN");
          const sender = msg.fromNickname || msg.fromUserId;
          const shortId = msg.id ? (msg.id.length > 8 ? msg.id.slice(-8) : msg.id) : "?";
          const text = ctx.showAll ? msg.text : msg.text.substring(0, 50);
          return `  [${time}] ${sender}(${msg.fromUserId}) #${shortId}: ${text}`;
        });
        const suffix = !ctx.showAll && results.messages.length > 15 ? `\n  ... 及其他 ${results.messages.length - 15} 条 (用 /hsearch --all 查看全部)` : "";
        await ctx.reply(`🔍 历史搜索结果:\n${lines.join("\n")}${suffix}\n共 ${results.total} 条结果`);
      },
    });

    // /hclear — clear message history (dmOnly: destructive operation)
    this.register({
      name: "hclear",
      aliases: ["清除历史"],
      description: "清除消息历史（不可恢复）",
      usage: "/hclear",
      category: "history" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const store = ctx.bot.getHistoryStore();
        store.clear();
        await ctx.reply("✅ 消息历史已清除");
      },
    });

    // /account — multi-account management (dmOnly: sensitive operations)
    this.register({
      name: "account",
      aliases: ["账号", "acc"],
      description: "多账号管理（添加、切换、启停多个机器人账号）",
      usage: "/account <add|remove|list|switch|start|stop> [参数]",
      category: "multi-account" as CommandCategory,
      dmOnly: true,
      handler: async (ctx) => {
        const subCmd = ctx.args[0]?.toLowerCase();
        const subArgs = ctx.args.slice(1);

        switch (subCmd) {
          case "add": {
            if (subArgs.length < 3) {
              await ctx.reply("用法: /account add <ID> <appKey> <appSecret> [名称]");
              return;
            }
            const id = subArgs[0];
            const appKey = subArgs[1];
            const appSecret = subArgs[2];
            const name = subArgs[3];
            try {
              const manager = ctx.bot.getMultiAccountManager();
              manager.addAccount(id, { appKey, appSecret }, name);
              await ctx.reply(`✅ 账号已添加: ${id} (${name || "未命名"})`);
            } catch (err) {
              await ctx.reply(`❌ 添加账号失败: ${(err as Error).message}`);
            }
            break;
          }
          case "remove":
          case "rm": {
            if (subArgs.length < 1) {
              await ctx.reply("用法: /account remove <ID>");
              return;
            }
            try {
              const manager = ctx.bot.getMultiAccountManager();
              const removed = manager.removeAccount(subArgs[0]);
              await ctx.reply(removed ? `✅ 账号 ${subArgs[0]} 已移除` : `未找到账号: ${subArgs[0]}`);
            } catch (err) {
              await ctx.reply(`❌ 移除账号失败: ${(err as Error).message}`);
            }
            break;
          }
          case "list":
          case "ls": {
            try {
              const manager = ctx.bot.getMultiAccountManager();
              const accounts = manager.getAllAccounts();
              const activeId = manager.getActiveAccountId();
              if (accounts.length === 0) {
                await ctx.reply("暂无账号。使用 /account add 添加账号");
                return;
              }
              const lines = accounts.map(a => {
                const marker = a.id === activeId ? "→" : " ";
                const state = a.state.connected ? "✅" : "❌";
                return `  ${marker} ${a.id} — ${a.name || "未命名"} ${state} (${a.state.status})`;
              });
              await ctx.reply(`📋 账号列表:\n${lines.join("\n")}`);
            } catch (err) {
              await ctx.reply(`❌ 获取账号列表失败: ${(err as Error).message}`);
            }
            break;
          }
          case "switch": {
            if (subArgs.length < 1) {
              await ctx.reply("用法: /account switch <ID>");
              return;
            }
            try {
              const manager = ctx.bot.getMultiAccountManager();
              const switched = manager.switchAccount(subArgs[0]);
              if (switched) {
                const entry = manager.getAccount(subArgs[0]);
                await ctx.reply(`✅ 已切换到账号: ${subArgs[0]} (${entry?.name || "未命名"})`);
              } else {
                await ctx.reply(`未找到账号: ${subArgs[0]}`);
              }
            } catch (err) {
              await ctx.reply(`❌ 切换账号失败: ${(err as Error).message}`);
            }
            break;
          }
          case "start": {
            if (subArgs.length < 1) {
              await ctx.reply("用法: /account start <ID>");
              return;
            }
            try {
              const manager = ctx.bot.getMultiAccountManager();
              await manager.startAccount(subArgs[0]);
              await ctx.reply(`✅ 账号 ${subArgs[0]} 已启动`);
            } catch (err) {
              await ctx.reply(`❌ 启动账号失败: ${(err as Error).message}`);
            }
            break;
          }
          case "stop": {
            if (subArgs.length < 1) {
              await ctx.reply("用法: /account stop <ID>");
              return;
            }
            try {
              const manager = ctx.bot.getMultiAccountManager();
              manager.stopAccount(subArgs[0]);
              await ctx.reply(`✅ 已停止账号: ${subArgs[0]}`);
            } catch (err) {
              await ctx.reply(`❌ 停止账号失败: ${(err as Error).message}`);
            }
            break;
          }
          default:
            await ctx.reply("用法: /account <add|remove|list|switch|start|stop> [参数]");
        }
      },
    });
  }
}
