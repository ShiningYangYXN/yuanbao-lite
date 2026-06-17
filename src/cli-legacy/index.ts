#!/usr/bin/env node
/**
 * Interactive command-line client for Yuanbao Lite.
 *
 * Provides a REPL-style interactive terminal interface for
 * chatting through the Yuanbao bot, sending commands, managing
 * stickers, uploading/downloading media files, and interacting
 * with the LLM takeover engine.
 *
 * v8.0 enhancements:
 * - GroupStore: persistent group bookmarks, favorites, notes/remarks
 * - Contact notes/remarks support
 * - Enhanced /groups command with add/rm/rename/note/tag/fav sub-commands
 * - Enhanced /contacts command with note/fav sub-commands
 *
 * Usage:
 *   npx yb-cli                                   # interactive mode (default)
 *   npx yb-cli interactive                        # explicit interactive mode
 *   npx yb-cli send dm <id> <msg>                 # non-interactive
 *   npx yb-cli config init                        # guided setup
 */

import { createInterface, Interface as ReadlineInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { YuanbaoBot } from "../index.js";
import { CommandSystem } from "../commands/registry.js";
import { getVersion } from "../version.js";
import type { ChatMessage, BotState } from "../types.js";
import { RichHistory } from "./rich-history.js";
import { highlightChatText, highlightLine } from "./syntax-highlight.js";
import { getCompletions, type CompletionContext } from "./auto-complete.js";
import {
  detectSticker,
  getSticker,
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  prepareStickerMsgBody,
  getBuiltinEmojis,
} from "../business/sticker.js";
import {
  uploadMedia,
  downloadMedia,
  extractMediaInfo,
  downloadAllMedia,
} from "../access/http/media.js";
import {
  uploadToGoFile,
  uploadAndFormatLink as gofileFormatLink,
} from "../access/http/gofile.js";
import {
  uploadToTempFile,
  uploadAndFormatLink as tempfileFormatLink,
  uploadToLitterbox,
} from "../access/http/tempfile.js";
import {
  LlmTakeoverEngine,
  ConversationManager,
  markdownToImText,
  createLlmTakeover,
} from "../business/llm-takeover.js";
import type {
  LlmTakeoverConfig,
  TakeoverResult,
  LlmProviderType,
} from "../business/llm-takeover.js";
import { AliasStore, getGlobalAliasStore } from "../business/alias.js";
import type { AliasEntry } from "../business/alias.js";
import { ContactStore } from "../business/contacts.js";
import type { ContactEntry } from "../business/contacts.js";
import { GroupStore } from "../business/groups.js";
import type { GroupEntry } from "../business/groups.js";
import { parseMentions, buildMentionMsgBody } from "../business/mention.js";
import type { ParsedMentions } from "../business/mention.js";
import {
  MessageHistoryStore,
  getGlobalHistoryStore,
  formatHistoryMessage,
  formatHistoryList,
} from "../business/history.js";
import type {
  HistoryFilter,
  HistoryFormatOptions,
} from "../business/history.js";
import {
  BatchRunner,
  startBatch,
  cancelBatch,
  cleanupBatch,
  getActiveBatch,
  interpolateTemplate,
} from "../business/batch.js";
import type { BatchConfig } from "../business/batch.js";
import { MultiAccountManager } from "../business/multi-account.js";
import type { AccountEntry } from "../business/multi-account.js";
import { SearchEngine } from "../business/search.js";
import { createLog, setLogLevel } from "../logger.js";
import { ConfigStore, getGlobalConfigStore, normalizeDir } from "./config.js";
import {
  generateColoredHelp,
  generatePlainHelp,
} from "../commands/help-text.js";
import { buildProgram } from "./non-interactive.js";

// ─── Types ───

export type CliConfig = {
  appKey?: string;
  appSecret?: string;
  token?: string;
  apiDomain?: string;
  wsUrl?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  stickerDir?: string;
  downloadDir?: string;
  prompt?: string;
  /** LLM takeover configuration */
  llm?: LlmTakeoverConfig;
  /** LLM provider type (default: "z-ai") */
  llmProvider?: LlmProviderType;
  /** LLM API key */
  llmApiKey?: string;
  /** LLM base URL */
  llmBaseUrl?: string;
};

// ─── Group Session ───

type GroupSession = {
  groupCode: string;
  groupName?: string;
  memberCount?: number;
  lastActiveAt?: number;
  unreadCount: number;
};

// ─── Constants ───

const DEFAULT_PROMPT = "yuanbao> ";

// ─── Interactive Client ───

export class InteractiveCli {
  private bot: YuanbaoBot;
  private commands: CommandSystem;
  private rl: ReadlineInterface | null = null;
  private config: CliConfig;
  private log = createLog("cli");

  // Chat mode state
  private chatMode: "none" | "dm" | "group" = "none";
  private chatTarget = "";

  // Group session tracking
  private groupSessions = new Map<string, GroupSession>();

  // Group store (persistent)
  private groupStore: GroupStore;

  // Download directory
  private downloadDir: string;

  // LLM takeover engine
  private llmEngine: LlmTakeoverEngine;

  // LLM auto-respond state
  private llmAutoRespond = true;

  // Multi-account manager
  private multiAccount: MultiAccountManager | null = null;

  // Search engine
  private searchEngine: SearchEngine | null = null;

  // Rich history (persistent, deduped)
  private richHistory: RichHistory;

  // Multi-line editing buffer
  private multilineBuffer = "";
  private isInMultiline = false;

  // Completion context
  private completionCtx: CompletionContext = {};

  constructor(config: CliConfig = {}) {
    // If no credentials provided, load from ConfigStore
    if (!config.appKey && !config.token && !config.appSecret) {
      const store = getGlobalConfigStore({ autoSave: true });
      const profile = store.getActiveProfile();
      if (profile.appKey) config.appKey = profile.appKey;
      if (profile.appSecret) config.appSecret = profile.appSecret;
      if (profile.token) config.token = profile.token;
      if (profile.apiDomain && !config.apiDomain)
        config.apiDomain = profile.apiDomain;
      if (profile.wsUrl && !config.wsUrl) config.wsUrl = profile.wsUrl;
      if (profile.logLevel && !config.logLevel)
        config.logLevel = profile.logLevel;
      if (profile.stickerDir && !config.stickerDir)
        config.stickerDir = profile.stickerDir;
      if (profile.downloadDir && !config.downloadDir)
        config.downloadDir = profile.downloadDir;
      if (profile.llmProvider && !config.llmProvider)
        config.llmProvider = profile.llmProvider;
      if (profile.llmApiKey && !config.llmApiKey)
        config.llmApiKey = profile.llmApiKey;
      if (profile.llmBaseUrl && !config.llmBaseUrl)
        config.llmBaseUrl = profile.llmBaseUrl;
    }

    this.config = config;
    this.downloadDir = config.downloadDir || join(process.cwd(), "downloads");

    // Merge CLI-level LLM config into LLM config
    const llmConfig: LlmTakeoverConfig = {
      ...config.llm,
      ...(config.llmProvider ? { provider: config.llmProvider } : {}),
      ...(config.llmApiKey ? { apiKey: config.llmApiKey } : {}),
      ...(config.llmBaseUrl ? { baseUrl: config.llmBaseUrl } : {}),
    };

    // Build bot config
    const botConfig: Record<string, unknown> = {
      appKey: config.appKey,
      appSecret: config.appSecret,
      token: config.token,
      apiDomain: config.apiDomain,
      wsUrl: config.wsUrl,
      logLevel: config.logLevel || "info",
      llmConfig: llmConfig,
      llmAutoReply: true,
    };

    this.bot = new YuanbaoBot(botConfig);
    this.commands =
      this.bot.getCommandSystem() || new CommandSystem({ prefix: "/" });

    // Initialize group store reference
    this.groupStore = this.bot.getGroupStore();

    // Initialize LLM engine (llmConfig is already built above for botConfig)
    this.llmEngine = createLlmTakeover(llmConfig);

    // Also store it on the bot so CommandSystem /llm works
    this.bot.setLlmEngine(this.llmEngine);

    // Auto-enable LLM if config provides provider settings
    if (llmConfig.provider || llmConfig.apiKey) {
      this.llmAutoRespond = true;
      this.bot.setLlmAutoReply(true);
    }

    // Load sticker packs if directory specified
    if (config.stickerDir && existsSync(config.stickerDir)) {
      loadStickerPacksFromDir(config.stickerDir);
    }

    // Initialize rich history
    this.richHistory = new RichHistory();

    this.setupBotHandlers();
  }

  // ─── Public API ───

  /**
   * Start the interactive CLI.
   */
  async start(): Promise<void> {
    this.printWelcome();

    // Create readline interface with persistent history
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.getColoredPrompt(),
      historySize: 0, // Disable built-in history — we use RichHistory instead
      completer: this.enhancedCompleter.bind(this),
      terminal: true,
    });

    // Set up key handling for history navigation
    this.setupHistoryNavigation();

    this.rl.on("line", (line) => this.handleLine(line));
    this.rl.on("close", () => this.handleExit());

    // Start bot in background
    this.bot.start().catch((err) => {
      this.log.error(`bot error: ${err.message}`);
    });

    this.rl.prompt();
  }

  /**
   * Stop the interactive CLI.
   */
  stop(): void {
    this.bot.stop();
    this.rl?.close();
  }

  // ─── Bot event handlers ───

  private setupBotHandlers(): void {
    this.bot.on("ready", () => {
      this.printSystem("✅ 机器人已连接");
      this.refreshPrompt();
    });

    this.bot.on("stateChange", (state: BotState) => {
      if (state.status === "reconnecting") {
        this.printSystem("🔄 正在重连...");
      } else if (state.status === "disconnected" && !state.connected) {
        this.printSystem("❌ 连接已断开");
      }
    });

    this.bot.on("error", (err: Error) => {
      this.printSystem(`❌ 错误: ${err.message}`);
    });

    this.bot.on("directMessage", (msg: ChatMessage) => {
      // Show in current chat or as notification
      if (this.chatMode === "dm" && this.chatTarget === msg.fromUserId) {
        this.printMessage(
          msg.fromNickname || msg.fromUserId,
          msg.text,
          "dm-in",
        );
      } else {
        this.printNotification(
          `[私聊] ${msg.fromNickname || msg.fromUserId}: ${msg.text}`,
        );
      }

      // Check for sticker
      if (msg.rawBody) {
        const sticker = detectSticker(msg.rawBody);
        if (sticker) {
          this.printSystem(
            `  🎨 贴纸: [${sticker.type}] ${sticker.name}${sticker.source ? ` (${sticker.source.substring(0, 60)}...)` : ""}`,
          );
        }
      }

      // LLM auto-respond is handled by the bot's tryLlmAutoReply()
      // No need to call it here — avoids double-reply
    });

    this.bot.on("groupMessage", (msg: ChatMessage) => {
      const prefix = `[${msg.groupName || msg.groupCode}] ${msg.fromNickname || msg.fromUserId}`;

      // Update group session
      this.trackGroupMessage(msg);

      if (this.chatMode === "group" && this.chatTarget === msg.groupCode) {
        this.printMessage(prefix, msg.text, "group-in");
      } else {
        this.printNotification(`${prefix}: ${msg.text}`);
        // Track unread for non-active groups
        if (msg.groupCode) {
          const session = this.groupSessions.get(msg.groupCode);
          if (session) {
            session.unreadCount++;
          }
        }
      }

      // Check for sticker
      if (msg.rawBody) {
        const sticker = detectSticker(msg.rawBody);
        if (sticker) {
          this.printSystem(`  🎨 贴纸: [${sticker.type}] ${sticker.name}`);
        }
      }

      // LLM auto-respond is handled by the bot's tryLlmAutoReply()
      // No need to call it here — avoids double-reply
    });
  }

  // ─── Group session tracking ───

  private trackGroupMessage(msg: ChatMessage): void {
    if (!msg.groupCode) return;

    // Track in both session map and persistent group store
    const existing = this.groupSessions.get(msg.groupCode);
    if (existing) {
      existing.lastActiveAt = Date.now();
      if (msg.groupName) existing.groupName = msg.groupName;
    } else {
      this.groupSessions.set(msg.groupCode, {
        groupCode: msg.groupCode,
        groupName: msg.groupName,
        lastActiveAt: Date.now(),
        unreadCount: 0,
      });
    }

    // Also track in persistent GroupStore
    this.groupStore.trackActivity(msg.groupCode, msg.groupName);
  }

  // ─── LLM auto-respond ───

  private async handleLlmAutoRespond(msg: ChatMessage): Promise<void> {
    try {
      const result = await this.llmEngine.handleMessage(this.bot, msg);
      if (result.handled && result.response) {
        this.printSystem(
          `🤖 LLM已回复: ${result.response.processedText.substring(0, 60)}... (${result.response.chunkCount}段)`,
        );
      }
    } catch (err) {
      this.printSystem(`❌ LLM回复失败: ${(err as Error).message}`);
    }
  }

  // ─── Input handling ───

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();

    // ─── Multi-line editing: backslash continuation ───
    if (this.isInMultiline) {
      if (trimmed === "") {
        // Empty line ends multiline mode
        const fullLine = this.multilineBuffer;
        this.multilineBuffer = "";
        this.isInMultiline = false;
        this.refreshPrompt();
        await this.processLine(fullLine);
        return;
      }
      // Append to buffer
      this.multilineBuffer += "\n" + trimmed;
      return;
    }

    // Check for line continuation (ends with \)
    if (trimmed.endsWith("\\") && !trimmed.endsWith("\\\\")) {
      this.isInMultiline = true;
      this.multilineBuffer = trimmed.slice(0, -1); // Remove trailing backslash
      this.refreshPrompt();
      return;
    }

    await this.processLine(trimmed);
  }

  /**
   * Process a complete input line (after multi-line assembly).
   */
  private async processLine(trimmed: string): Promise<void> {
    if (!trimmed) {
      this.rl?.prompt();
      return;
    }

    // Add to history
    this.addHistory(trimmed);

    // Echo the command with syntax highlighting (only for commands)
    if (trimmed.startsWith("/")) {
      const highlighted = highlightLine(trimmed);
      console.log(chalk.dim("→") + " " + highlighted);
    }

    // If in chat mode and not a command, send as message
    if (!trimmed.startsWith("/") && this.chatMode !== "none") {
      await this.sendChatMessage(trimmed);
      // sendChatMessage already calls rl.prompt() via printMessage
      return;
    }

    // Parse and execute CLI command using robust tokenizer
    const parts = this.tokenizeCliInput(trimmed);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (cmd) {
        // ─── Help (CLI shows categorized command list) ───
        case "/help":
        case "/h":
        case "/?": {
          if (args.length === 0) {
            // Brief help: categorized command list from CommandSystem
            process.stdout.write("\n");
            const visible = this.commands.getVisibleCommands();
            if (visible.length === 0) {
              this.printSystem("暂无可用命令");
            } else {
              console.log(generateColoredHelp(visible, {
                prefix: this.commands["config"]?.prefix ?? "/",
                footer: this.commands["config"]?.helpFooter,
              }));
              this.rl?.prompt();
            }
          } else {
            // Detailed help: delegate to CommandSystem dispatch
            const detailInput = `/${args.join(" ")}`;
            const chatMsg: ChatMessage = {
              id: "cli",
              fromUserId: "cli",
              chatType: "direct",
              text: detailInput,
              timestamp: Date.now(),
            };
            const cliReply = async (text: string) => {
              console.log(`\n${text}\n`);
              this.rl?.prompt();
            };
            await this.commands.dispatch(this.bot, chatMsg, cliReply);
          }
          break;
        }

        // ─── Chat mode (CLI-specific: manages REPL prompt) ───
        case "/chat": {
          if (args.length === 0) {
            this.chatMode = "none";
            this.chatTarget = "";
            this.printSystem("已退出聊天模式");
          } else if (args[0] === "group" && args[1]) {
            this.chatMode = "group";
            this.chatTarget = args[1];
            if (!this.groupSessions.has(args[1])) {
              this.groupSessions.set(args[1], {
                groupCode: args[1],
                lastActiveAt: Date.now(),
                unreadCount: 0,
              });
            }
            this.printSystem(
              `进入群聊模式: ${this.chatTarget} (直接输入文字发送, /chat 退出)`,
            );
          } else {
            this.chatMode = "dm";
            this.chatTarget = args[0];
            this.printSystem(
              `进入私聊模式: ${this.chatTarget} (直接输入文字发送, /chat 退出)`,
            );
          }
          this.refreshPrompt();
          break;
        }

        // ─── Join group chat (CLI-specific: sets chat mode + session) ───
        case "/join": {
          if (args.length === 0) {
            this.printSystem("用法: /join <群号>");
            break;
          }
          const joinCode = args[0];
          this.chatMode = "group";
          this.chatTarget = joinCode;
          if (!this.groupSessions.has(joinCode)) {
            this.groupSessions.set(joinCode, {
              groupCode: joinCode,
              lastActiveAt: Date.now(),
              unreadCount: 0,
            });
          }
          this.groupSessions.get(joinCode)!.unreadCount = 0;
          // Also delegate to global command to add to group store
          const chatMsg: ChatMessage = {
            id: "cli",
            fromUserId: "cli",
            chatType: "direct",
            text: trimmed,
            timestamp: Date.now(),
          };
          const cliReply = async (text: string) => {
            console.log(`\n${text}\n`);
          };
          await this.commands.dispatch(this.bot, chatMsg, cliReply);
          this.printSystem(`加入群聊: ${joinCode} (直接输入文字发送)`);
          break;
        }

        // ─── Switch session (CLI-specific: switches chat mode) ───
        case "/switch": {
          if (args.length === 0) {
            this.printSystem("用法: /switch <编号> (用 /groups 查看编号)");
            break;
          }
          const idx = parseInt(args[0], 10) - 1;
          const groupList = [...this.groupSessions.values()];
          if (idx < 0 || idx >= groupList.length) {
            this.printSystem(
              `无效编号: ${args[0]} (共 ${groupList.length} 个群组)`,
            );
            break;
          }
          const target = groupList[idx];
          this.chatMode = "group";
          this.chatTarget = target.groupCode;
          target.unreadCount = 0;
          this.printSystem(
            `切换到群聊: ${target.groupName || target.groupCode}`,
          );
          this.refreshPrompt();
          break;
        }

        // ─── Exit (CLI-only) ───
        case "/exit":
        case "/quit":
        case "/q":
          this.handleExit();
          return;

        // ─── All other commands: delegate to global CommandSystem ───
        default: {
          const chatMsg: ChatMessage = {
            id: "cli",
            fromUserId: "cli",
            chatType: "direct",
            text: trimmed,
            timestamp: Date.now(),
          };
          // Use onReply to print command output to terminal instead of sending IM
          const cliReply = async (text: string) => {
            console.log(`\n${text}\n`);
            this.rl?.prompt();
          };
          const result = await this.commands.dispatch(
            this.bot,
            chatMsg,
            cliReply,
          );
          if (!result.handled) {
            this.printSystem(`未知命令: ${cmd}。输入 /help 查看帮助`);
          }
          // Prompt already shown by cliReply or printSystem above
          break;
        }
      }
    } catch (err) {
      this.printSystem(`❌ 命令执行失败: ${(err as Error).message}`);
    }
  }

  // ─── Group list handler ───

  private async handleGroupsList(): Promise<void> {
    // Merge session data and persistent store data
    const groups = [...this.groupSessions.values()];

    if (groups.length === 0 && this.groupStore.size === 0) {
      this.printSystem(
        "暂无群组会话。发送 /join <群号> 加入群聊，或 /groups add <群号> 添加收藏",
      );
      return;
    }

    // Also include groups from the store that aren't in sessions
    const allGroupCodes = new Set(groups.map((g) => g.groupCode));
    const storeGroups = this.groupStore.getAll("lastActive");
    for (const g of storeGroups) {
      if (!allGroupCodes.has(g.groupCode)) {
        groups.push({
          groupCode: g.groupCode,
          groupName: g.name || g.groupName,
          memberCount: g.memberCount,
          lastActiveAt: g.lastActiveAt,
          unreadCount: 0,
        });
        allGroupCodes.add(g.groupCode);
      }
    }

    // Sort by last active time (most recent first)
    groups.sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));

    this.printSystem("\n📋 群组列表:");
    this.printSystem(
      "  编号  群号               名称/备注           未读  收藏  最后活跃",
    );
    this.printSystem(
      "  ──── ────────────────── ────────────────── ──── ──── ──────────",
    );

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const active =
        this.chatMode === "group" && this.chatTarget === g.groupCode;
      const marker = active ? "→" : " ";
      const storeEntry = this.groupStore.get(g.groupCode);
      const displayName = storeEntry?.name || g.groupName || "未知";
      const name = displayName.padEnd(18).substring(0, 18);
      const code = g.groupCode.padEnd(18).substring(0, 18);
      const unread = String(g.unreadCount).padStart(4);
      const favIcon = storeEntry?.favorite ? "⭐" : "  ";
      const lastActive = g.lastActiveAt
        ? new Date(g.lastActiveAt).toLocaleTimeString("zh-CN")
        : "未知";

      this.printSystem(
        `  ${marker}${String(i + 1).padStart(2)}  ${code} ${name} ${unread} ${favIcon} ${lastActive}`,
      );
      if (storeEntry?.notes) {
        this.printSystem(`      备注: ${storeEntry.notes.substring(0, 60)}`);
      }
    }

    this.printSystem("\n  使用 /switch <编号> 快速切换群组");
    this.printSystem("  使用 /groups add <群号> 添加收藏");
    this.printSystem("  使用 /groups fav <群号> 切换收藏状态\n");
  }

  // ─── Alias command handler ───

  private async handleAliasCommand(args: string[]): Promise<void> {
    const store = this.bot.getAliasStore();
    const subCmd = args[0]?.toLowerCase();

    switch (subCmd) {
      case "add": {
        if (args.length < 3) {
          this.printSystem("用法: /alias add <ID> <别名> [昵称]");
          return;
        }
        const id = args[1];
        const alias = args[2];
        const nickname = args.slice(3).join(" ") || undefined;
        store.add(id, alias, nickname);
        this.printSystem(
          `✅ 别名已添加: ${alias} -> ${id}${nickname ? ` (昵称: ${nickname})` : ""}`,
        );
        break;
      }
      case "remove":
      case "rm":
      case "del": {
        if (args.length < 2) {
          this.printSystem("用法: /alias remove <别名|ID>");
          return;
        }
        const removed = store.remove(args[1]);
        this.printSystem(removed ? "✅ 别名已删除" : `未找到别名: ${args[1]}`);
        break;
      }
      case "list":
      case "ls": {
        const all = store.getAll();
        if (all.length === 0) {
          this.printSystem("暂无别名");
          return;
        }
        this.printSystem("\n📋 别名列表:");
        for (const e of all) {
          this.printSystem(
            `  ${e.alias} -> ${e.id}${e.nickname ? ` (${e.nickname})` : ""}`,
          );
        }
        break;
      }
      case "save": {
        const ok = store.save();
        this.printSystem(ok ? "✅ 别名已保存" : "❌ 保存失败");
        break;
      }
      case "load": {
        const ok = store.load();
        this.printSystem(ok ? "✅ 别名已加载" : "❌ 加载失败");
        break;
      }
      case "resolve": {
        if (args.length < 2) {
          this.printSystem("用法: /alias resolve <别名|ID>");
          return;
        }
        const resolved = store.resolve(args[1]);
        const nick = store.getNickname(args[1]);
        this.printSystem(
          `解析结果: ${resolved}${nick ? ` (昵称: ${nick})` : ""}`,
        );
        break;
      }
      default:
        this.printSystem(
          "用法: /alias <add|remove|list|save|load|resolve> [参数]",
        );
    }
  }

  // ─── Groups command handler (sub-commands for persistent store) ───

  private async handleGroupsCommand(args: string[]): Promise<void> {
    const store = this.groupStore;
    const subCmd = args[0]?.toLowerCase();

    switch (subCmd) {
      case "add": {
        if (args.length < 2) {
          this.printSystem("用法: /groups add <群号> [名称] [标签]");
          return;
        }
        const groupCode = args[1];
        const name = args[2];
        const tag = args.slice(3).join(" ") || undefined;
        const entry = store.add(groupCode, name, tag);
        this.printSystem(
          `✅ 群聊已收藏: ${groupCode}${entry.name ? ` (${entry.name})` : ""}${tag ? ` [${tag}]` : ""}`,
        );
        // Also create a session if not exists
        if (!this.groupSessions.has(groupCode)) {
          this.groupSessions.set(groupCode, {
            groupCode,
            groupName: name,
            lastActiveAt: Date.now(),
            unreadCount: 0,
          });
        }
        break;
      }
      case "remove":
      case "rm":
      case "del": {
        if (args.length < 2) {
          this.printSystem("用法: /groups rm <群号>");
          return;
        }
        const removed = store.remove(args[1]);
        this.printSystem(
          removed
            ? `✅ 群聊已从收藏移除: ${args[1]}`
            : `未找到群聊: ${args[1]}`,
        );
        break;
      }
      case "rename": {
        if (args.length < 3) {
          this.printSystem("用法: /groups rename <群号> <新名称>");
          return;
        }
        const ok = store.rename(args[1], args.slice(2).join(" "));
        this.printSystem(
          ok
            ? `✅ 群聊已重命名为: ${args.slice(2).join(" ")}`
            : `未找到群聊: ${args[1]}`,
        );
        break;
      }
      case "note":
      case "备注": {
        if (args.length < 3) {
          this.printSystem("用法: /groups note <群号> <备注内容>");
          return;
        }
        // Auto-add group if not exists
        if (!store.get(args[1])) {
          store.add(args[1]);
        }
        const ok = store.setNotes(args[1], args.slice(2).join(" "));
        this.printSystem(
          ok ? "✅ 群聊备注已更新" : `❌ 设置备注失败: ${args[1]}`,
        );
        break;
      }
      case "tag": {
        if (args.length < 3) {
          this.printSystem("用法: /groups tag <群号> <标签>");
          return;
        }
        if (!store.get(args[1])) {
          store.add(args[1]);
        }
        const ok = store.setTag(args[1], args.slice(2).join(" "));
        this.printSystem(
          ok ? "✅ 群聊标签已更新" : `❌ 设置标签失败: ${args[1]}`,
        );
        break;
      }
      case "fav":
      case "favorite":
      case "收藏": {
        if (args.length < 2) {
          this.printSystem("用法: /groups fav <群号>");
          return;
        }
        if (!store.get(args[1])) {
          store.add(args[1]);
        }
        const ok = store.toggleFavorite(args[1]);
        const entry = store.get(args[1]);
        this.printSystem(
          ok
            ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}: ${args[1]}`
            : `未找到群聊: ${args[1]}`,
        );
        break;
      }
      case "join": {
        if (args.length < 2) {
          this.printSystem("用法: /groups join <群号>");
          return;
        }
        const groupCode = args[1];
        this.chatMode = "group";
        this.chatTarget = groupCode;
        if (!this.groupSessions.has(groupCode)) {
          this.groupSessions.set(groupCode, {
            groupCode,
            lastActiveAt: Date.now(),
            unreadCount: 0,
          });
        }
        this.groupSessions.get(groupCode)!.unreadCount = 0;
        store.touch(groupCode);
        this.printSystem(`加入群聊: ${groupCode} (直接输入文字发送)`);
        this.refreshPrompt();
        break;
      }
      case "search":
      case "find": {
        if (args.length < 2) {
          this.printSystem("用法: /groups search <关键词>");
          return;
        }
        const results = store.search(args.slice(1).join(" "));
        if (results.length === 0) {
          this.printSystem("未找到匹配的群聊");
        } else {
          this.printSystem("\n📋 群聊搜索结果:");
          for (const g of results) {
            const fav = g.favorite ? "⭐" : " ";
            const displayName = g.name || g.groupName || "未知";
            this.printSystem(
              `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}${g.notes ? ` (备注: ${g.notes.substring(0, 40)})` : ""}`,
            );
          }
          console.log();
        }
        break;
      }
      case "save": {
        const ok = store.save();
        this.printSystem(ok ? "✅ 群聊已保存" : "❌ 保存失败");
        break;
      }
      case "list":
      case "ls": {
        const all = store.getAll("lastActive");
        if (all.length === 0) {
          this.printSystem("暂无收藏群聊。使用 /groups add <群号> 添加");
          return;
        }
        this.printSystem("\n📋 收藏群聊列表:");
        for (const g of all) {
          const fav = g.favorite ? "⭐" : " ";
          const displayName = g.name || g.groupName || "未知";
          const lastActive = g.lastActiveAt
            ? ` (${new Date(g.lastActiveAt).toLocaleDateString("zh-CN")})`
            : "";
          this.printSystem(
            `  ${fav} ${chalk.bold(g.groupCode)} — ${displayName}${g.tag ? chalk.cyan(` [${g.tag}]`) : ""}${lastActive}`,
          );
          if (g.notes) {
            console.log(`     备注: ${chalk.dim(g.notes.substring(0, 60))}`);
          }
        }
        this.printSystem(chalk.dim(`\n  共 ${all.length} 个群聊`));
        break;
      }
      default:
        this.printSystem(
          "用法: /groups <add|rm|rename|note|tag|fav|join|search|save|list> [参数]",
        );
    }
  }

  // ─── Contacts command handler ───

  private async handleContactsCommand(args: string[]): Promise<void> {
    const store = this.bot.getContactStore();
    const subCmd = args[0]?.toLowerCase();

    switch (subCmd) {
      case "add": {
        if (args.length < 3) {
          this.printSystem("用法: /contacts add <ID> <名称> [标签]");
          return;
        }
        const id = args[1];
        const name = args[2];
        const tag = args.slice(3).join(" ") || undefined;
        store.add(id, name, tag);
        this.printSystem(
          `✅ 联系人已添加: ${name} -> ${id.substring(0, 20)}...${tag ? ` [${tag}]` : ""}`,
        );
        break;
      }
      case "remove":
      case "rm":
      case "del": {
        if (args.length < 2) {
          this.printSystem("用法: /contacts remove <名称|ID>");
          return;
        }
        const removed = store.remove(args[1]);
        this.printSystem(
          removed ? "✅ 联系人已删除" : `未找到联系人: ${args[1]}`,
        );
        break;
      }
      case "rename": {
        if (args.length < 3) {
          this.printSystem("用法: /contacts rename <名称|ID> <新名称>");
          return;
        }
        const ok = store.rename(args[1], args[2]);
        this.printSystem(
          ok ? `✅ 联系人已重命名为: ${args[2]}` : `未找到联系人: ${args[1]}`,
        );
        break;
      }
      case "note":
      case "备注": {
        if (args.length < 3) {
          this.printSystem("用法: /contacts note <名称|ID> <备注内容>");
          return;
        }
        // Auto-add contact if not exists
        if (!store.get(args[1])) {
          store.add(args[1], args[1]);
        }
        const ok = store.setNotes(args[1], args.slice(2).join(" "));
        this.printSystem(
          ok ? "✅ 联系人备注已更新" : `❌ 设置备注失败: ${args[1]}`,
        );
        break;
      }
      case "tag": {
        if (args.length < 3) {
          this.printSystem("用法: /contacts tag <名称|ID> <标签>");
          return;
        }
        const ok = store.setTag(args[1], args.slice(2).join(" "));
        this.printSystem(ok ? "✅ 标签已更新" : `未找到联系人: ${args[1]}`);
        break;
      }
      case "dm": {
        if (args.length < 2) {
          this.printSystem("用法: /contacts dm <名称|ID>");
          return;
        }
        const resolved = store.resolve(args[1]);
        if (resolved === args[1] && !store.get(args[1])) {
          this.printSystem(`未找到联系人: ${args[1]} (将直接使用此ID)`);
        } else {
          const entry = store.get(args[1]);
          this.printSystem(`切换到私聊: ${entry?.name || resolved}`);
          store.touch(args[1]);
        }
        this.chatMode = "dm";
        this.chatTarget = resolved;
        this.refreshPrompt();
        break;
      }
      case "search":
      case "find": {
        if (args.length < 2) {
          this.printSystem("用法: /contacts search <关键词>");
          return;
        }
        const results = store.search(args.slice(1).join(" "));
        if (results.length === 0) {
          this.printSystem("未找到匹配的联系人");
        } else {
          console.log("\n📇 搜索结果:");
          for (const c of results) {
            const fav = c.favorite ? "⭐" : " ";
            console.log(
              `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}${c.notes ? ` (备注: ${c.notes.substring(0, 40)})` : ""}`,
            );
          }
          console.log();
        }
        break;
      }
      case "fav":
      case "favorite":
      case "收藏": {
        if (args.length < 2) {
          this.printSystem("用法: /contacts fav <名称|ID>");
          return;
        }
        if (!store.get(args[1])) {
          store.add(args[1], args[1]);
        }
        const ok = store.toggleFavorite(args[1]);
        const entry = store.get(args[1]);
        this.printSystem(
          ok
            ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}`
            : `未找到联系人: ${args[1]}`,
        );
        break;
      }
      case "save": {
        const ok = store.save();
        this.printSystem(ok ? "✅ 联系人已保存" : "❌ 保存失败");
        break;
      }
      case "list":
      case "ls":
      default: {
        const all = store.getAll("name");
        if (all.length === 0) {
          this.printSystem("暂无联系人。使用 /contacts add <ID> <名称> 添加");
          return;
        }
        console.log("\n📇 联系人列表:");
        for (const c of all) {
          const fav = c.favorite ? "⭐" : " ";
          const lastUsed = c.lastUsedAt
            ? ` (上次: ${new Date(c.lastUsedAt).toLocaleDateString("zh-CN")})`
            : "";
          console.log(
            `  ${fav} ${chalk.bold(c.name)} -> ${chalk.dim(c.id.substring(0, 30))}${c.tag ? chalk.cyan(` [${c.tag}]`) : ""}${c.notes ? chalk.yellow(` 备注:${c.notes.substring(0, 30)}`) : ""}${lastUsed}`,
          );
        }
        console.log(chalk.dim(`\n  共 ${all.length} 个联系人`));
        console.log();
        break;
      }
    }
  }

  // ─── History command handler ───

  private async handleHistoryCommand(args: string[]): Promise<void> {
    const store = this.bot.getHistoryStore();
    const subCmd = args[0]?.toLowerCase();
    const botId = this.bot.getAccount().botId;
    const formatOpts: HistoryFormatOptions = { botId, colorize: true };

    switch (subCmd) {
      case "search":
      case "find": {
        if (args.length < 2) {
          this.printSystem("用法: /history search <关键词> [数量]");
          return;
        }
        const keyword = args[1];
        const limit = parseInt(args[2] || "20", 10);
        const results = store.searchByKeyword(keyword, {
          searchNickname: true,
          limit,
        });
        if (results.length === 0) {
          this.printSystem(`未找到包含 "${keyword}" 的消息`);
          return;
        }
        console.log(
          "\n" +
          formatHistoryList(results.slice(-20), {
            ...formatOpts,
            title: `搜索结果 (${results.length}条)`,
          }),
        );
        console.log();
        break;
      }
      case "stats": {
        const stats = store.getStats();
        console.log(`\n📊 消息统计:`);
        console.log(`  总消息: ${stats.totalMessages}`);
        console.log(
          `  私聊: ${stats.directMessages}, 群聊: ${stats.groupMessages}`,
        );
        console.log(
          `  独立用户: ${stats.uniqueUsers}, 独立群组: ${stats.uniqueGroups}`,
        );
        if (stats.oldestAt)
          console.log(
            `  最早: ${new Date(stats.oldestAt).toLocaleString("zh-CN")}`,
          );
        if (stats.newestAt)
          console.log(
            `  最新: ${new Date(stats.newestAt).toLocaleString("zh-CN")}`,
          );
        console.log();
        break;
      }
      case "recent": {
        const count = parseInt(args[1] || "10", 10);
        const recent = store.getRecent(count);
        if (recent.length === 0) {
          this.printSystem("暂无历史消息");
          return;
        }
        console.log(
          "\n" +
          formatHistoryList(recent, { ...formatOpts, title: `最近消息` }),
        );
        console.log();
        break;
      }
      case "user": {
        if (args.length < 2) {
          this.printSystem("用法: /history user <用户ID> [数量]");
          return;
        }
        const userId = args[1];
        const limit = parseInt(args[2] || "20", 10);
        const msgs = store.getByUser(userId, limit);
        if (msgs.length === 0) {
          this.printSystem(`未找到用户 ${userId} 的消息`);
          return;
        }
        console.log(
          "\n" +
          formatHistoryList(msgs, {
            ...formatOpts,
            title: `用户 ${userId} 的消息`,
          }),
        );
        console.log();
        break;
      }
      case "group": {
        if (args.length < 2) {
          this.printSystem("用法: /history group <群号> [数量]");
          return;
        }
        const groupCode = args[1];
        const limit = parseInt(args[2] || "20", 10);
        const msgs = store.getByGroup(groupCode, limit);
        if (msgs.length === 0) {
          this.printSystem(`未找到群 ${groupCode} 的消息`);
          return;
        }
        console.log(
          "\n" +
          formatHistoryList(msgs, {
            ...formatOpts,
            title: `群 ${groupCode} 的消息`,
          }),
        );
        console.log();
        break;
      }
      default:
        this.printSystem(
          "用法: /history <search|stats|recent|user|group> [参数]",
        );
    }
  }

  // ─── Search command handler ───

  private async handleSearchCommand(args: string[]): Promise<void> {
    const subCmd = args[0]?.toLowerCase();

    if (!this.searchEngine) {
      this.searchEngine = new SearchEngine(this.bot);
    }

    switch (subCmd) {
      case "groups":
      case "群": {
        if (args.length < 2) {
          this.printSystem("用法: /search groups <关键词> [群号1,群号2,...]");
          return;
        }
        const query = args[1];
        const groupCodes = args[2]?.split(",");
        try {
          const results = await this.searchEngine.searchGroups(
            query,
            groupCodes,
          );
          if (results.length === 0) {
            this.printSystem(`未找到匹配 "${query}" 的群组`);
            return;
          }
          console.log(`\n🔍 群组搜索结果:`);
          for (const r of results) {
            console.log(
              `  ${r.groupCode} — ${r.groupName} (${r.groupSize}人) [${r.matchType}]`,
            );
          }
          console.log();
        } catch (err) {
          this.printSystem(`❌ 搜索失败: ${(err as Error).message}`);
        }
        break;
      }
      case "members":
      case "member": {
        if (args.length < 2) {
          this.printSystem("用法: /search members <关键词> [群号]");
          return;
        }
        const query = args[1];
        const groupCode =
          args[2] || (this.chatMode === "group" ? this.chatTarget : undefined);
        if (!groupCode) {
          this.printSystem("请指定群号: /search members <关键词> <群号>");
          return;
        }
        try {
          const results = await this.searchEngine.searchGroupMembers(
            groupCode,
            query,
          );
          if (results.length === 0) {
            this.printSystem(
              `未在群 ${groupCode} 中找到匹配 "${query}" 的成员`,
            );
            return;
          }
          console.log(`\n🔍 成员搜索结果 (${groupCode}):`);
          for (const r of results) {
            const typeLabel =
              r.userType === 1
                ? "[人类]"
                : r.userType === 2
                  ? "[元宝]"
                  : r.userType === 3
                    ? "[龙虾]"
                    : "";
            console.log(
              `  ${r.userId} — ${r.nickName} ${typeLabel} [${r.matchType}]`,
            );
          }
          console.log();
        } catch (err) {
          this.printSystem(`❌ 搜索失败: ${(err as Error).message}`);
        }
        break;
      }
      default:
        this.printSystem("用法: /search <groups|members> <关键词> [群号]");
    }
  }

  // ─── Batch command handler ───

  private async handleBatchCommand(args: string[]): Promise<void> {
    const subCmd = args[0]?.toLowerCase();

    switch (subCmd) {
      case "text": {
        if (args.length < 5) {
          this.printSystem("用法: /batch text <目标> <数量> <间隔ms> <模板>");
          this.printSystem(
            "模板支持 ${i}(索引), ${n}(序号), ${total}(总数), ${timestamp}",
          );
          this.printSystem("使用 \\${...} 转义插值");
          return;
        }
        const target = args[1];
        const count = parseInt(args[2], 10);
        const intervalMs = parseInt(args[3], 10);
        const template = args.slice(4).join(" ");

        if (isNaN(count) || count < 1 || count > 100) {
          this.printSystem("数量范围: 1-100");
          return;
        }
        if (isNaN(intervalMs) || intervalMs < 500) {
          this.printSystem("间隔最小500ms");
          return;
        }

        // Determine isGroup based on target, not chatMode.
        // All-digit targets of 5+ digits are likely group codes.
        const isGroup = (() => {
          if (target.startsWith("g:")) return true;
          if (target.includes("@")) return false;
          const groupStore = this.bot.getGroupStore();
          if (groupStore && groupStore.get(target)) return true;
          if (/^\d{5,}$/.test(target)) return true;
          return this.chatMode === "group";
        })();
        const runner = startBatch("cli-batch", this.bot, {
          type: "text",
          target,
          isGroup,
          count,
          intervalMs,
          template,
        });

        this.printSystem(
          `🔄 批量发送已启动: ${count}条, 间隔${intervalMs}ms, 目标${target}`,
        );

        // Run the batch — startBatch() only registers, caller must run()
        runner
          .run()
          .then((result) => {
            cleanupBatch("cli-batch");
            this.printSystem(
              `✅ 批量发送完成: 成功${result.sent}条, 失败${result.failed}条, 耗时${result.durationMs}ms`,
            );
          })
          .catch((err) => {
            cleanupBatch("cli-batch");
            this.printSystem(`❌ 批量发送失败: ${(err as Error).message}`);
          });
        break;
      }
      case "stop": {
        const cancelled = cancelBatch("cli-batch");
        this.printSystem(
          cancelled ? "✅ 批量发送已取消" : "没有正在运行的批量任务",
        );
        break;
      }
      case "status": {
        const batch = getActiveBatch("cli-batch");
        if (!batch) {
          this.printSystem("没有正在运行的批量任务");
          return;
        }
        const progress = batch.getProgress();
        console.log(`\n📊 批量任务状态:`);
        console.log(`  进度: ${progress.sent}/${progress.total}`);
        console.log(`  失败: ${progress.failed}`);
        console.log(`  运行中: ${progress.running}`);
        console.log();
        break;
      }
      default:
        this.printSystem("用法: /batch <text|stop|status> [参数]");
    }
  }

  // ─── Account management handler ───

  private async handleAccountCommand(args: string[]): Promise<void> {
    const subCmd = args[0]?.toLowerCase();

    switch (subCmd) {
      case "add": {
        if (args.length < 4) {
          this.printSystem(
            "用法: /account add <ID> <appKey> <appSecret> [名称]",
          );
          return;
        }
        const id = args[1];
        const appKey = args[2];
        const appSecret = args[3];
        const name = args[4];

        if (!this.multiAccount) {
          this.multiAccount = new MultiAccountManager();
          // Add the current bot as the first account
          this.multiAccount.addAccount(
            "default",
            {
              appKey: this.config.appKey,
              appSecret: this.config.appSecret,
              token: this.config.token,
            },
            "默认账号",
          );
        }

        try {
          const entry = this.multiAccount.addAccount(
            id,
            { appKey, appSecret },
            name,
          );
          this.printSystem(`✅ 账号已添加: ${id} (${name || "未命名"})`);
        } catch (err) {
          this.printSystem(`❌ 添加账号失败: ${(err as Error).message}`);
        }
        break;
      }
      case "remove":
      case "rm": {
        if (args.length < 2) {
          this.printSystem("用法: /account remove <ID>");
          return;
        }
        if (!this.multiAccount) {
          this.printSystem("未初始化多账号管理");
          return;
        }
        const removed = this.multiAccount.removeAccount(args[1]);
        this.printSystem(
          removed ? `✅ 账号 ${args[1]} 已移除` : `未找到账号: ${args[1]}`,
        );
        break;
      }
      case "list":
      case "ls": {
        if (!this.multiAccount) {
          this.printSystem("仅当前单账号运行。使用 /account add 添加更多账号");
          return;
        }
        const accounts = this.multiAccount.getAllAccounts();
        const activeId = this.multiAccount.getActiveAccountId();
        console.log(`\n📋 账号列表:`);
        for (const a of accounts) {
          const marker = a.id === activeId ? "→" : " ";
          const state = a.state.connected ? "✅" : "❌";
          console.log(
            `  ${marker} ${a.id} — ${a.name || "未命名"} ${state} (${a.state.status})`,
          );
        }
        console.log();
        break;
      }
      case "switch": {
        if (args.length < 2) {
          this.printSystem("用法: /account switch <ID>");
          return;
        }
        if (!this.multiAccount) {
          this.printSystem("未初始化多账号管理");
          return;
        }
        const switched = this.multiAccount.switchAccount(args[1]);
        if (switched) {
          const entry = this.multiAccount.getAccount(args[1]);
          this.printSystem(
            `✅ 已切换到账号: ${args[1]} (${entry?.name || "未命名"})`,
          );
        } else {
          this.printSystem(`未找到账号: ${args[1]}`);
        }
        break;
      }
      case "start": {
        if (args.length < 2) {
          this.printSystem("用法: /account start <ID>");
          return;
        }
        if (!this.multiAccount) {
          this.printSystem("未初始化多账号管理");
          return;
        }
        try {
          this.printSystem(`正在启动账号 ${args[1]}...`);
          await this.multiAccount.startAccount(args[1]);
        } catch (err) {
          this.printSystem(`❌ 启动账号失败: ${(err as Error).message}`);
        }
        break;
      }
      case "stop": {
        if (args.length < 2) {
          this.printSystem("用法: /account stop <ID>");
          return;
        }
        if (!this.multiAccount) {
          this.printSystem("未初始化多账号管理");
          return;
        }
        this.multiAccount.stopAccount(args[1]);
        this.printSystem(`✅ 已停止账号: ${args[1]}`);
        break;
      }
      default:
        this.printSystem(
          "用法: /account <add|remove|list|switch|start|stop> [参数]",
        );
    }
  }

  // ─── LLM command handler ───

  private async handleLlmCommand(args: string[]): Promise<void> {
    if (args.length === 0) {
      // Show LLM status
      const config = this.llmEngine.getConfig();
      console.log("\n🤖 LLM 接管状态:");
      console.log(`  已启用: ${config.enabled ? "✅" : "❌"}`);
      console.log(
        `  自动回复: ${this.llmAutoRespond ? "🟢 已开启" : "⚪ 未开启"}`,
      );
      console.log(`  SDK就绪: ${this.llmEngine.isReady ? "✅" : "❌"}`);
      console.log(`  供应商: ${config.provider}`);
      console.log(`  模型: ${config.model || "(默认)"}`);
      console.log(`  温度: ${config.temperature}`);
      console.log(`  最大tokens: ${config.maxTokens}`);
      console.log(
        `  Markdown模式: ${config.markdownRawMode ? "原始(raw)" : "IM格式化"}`,
      );
      console.log(
        `  API密钥: ${config.apiKey ? "***" + config.apiKey.slice(-4) : "(未设置)"}`,
      );
      console.log(`  基础URL: ${config.baseUrl || "(默认)"}`);
      console.log(`  群聊响应: ${config.enableInGroup ? "✅" : "❌"}`);
      console.log(`  私聊响应: ${config.enableInDirect ? "✅" : "❌"}`);
      console.log(`  群聊需@: ${config.requireMentionInGroup ? "✅" : "❌"}`);
      console.log(
        `  活跃对话: ${this.llmEngine.getConversationManager().size}`,
      );
      console.log(`  系统提示词: ${config.systemPrompt.substring(0, 80)}...`);
      console.log();
      return;
    }

    const subCmd = args[0].toLowerCase();
    const subArgs = args.slice(1);

    switch (subCmd) {
      case "on": {
        this.llmEngine.updateConfig({ enabled: true });
        this.llmAutoRespond = true;
        this.printSystem("🤖 LLM 自动回复已开启 (机器人将自动回复消息)");
        break;
      }

      case "off": {
        this.llmAutoRespond = false;
        this.printSystem("🤖 LLM 自动回复已关闭");
        break;
      }

      case "status": {
        const config = this.llmEngine.getConfig();
        console.log(
          `\n🤖 LLM 状态: enabled=${config.enabled}, auto=${this.llmAutoRespond}, ready=${this.llmEngine.isReady}\n`,
        );
        break;
      }

      case "chat":
      case "ask":
      case "问": {
        if (subArgs.length === 0) {
          this.printSystem("用法: /llm chat <消息>");
          break;
        }
        const prompt = subArgs.join(" ");
        try {
          this.printSystem("🤖 思考中...");
          const result = await this.llmEngine.chat(prompt, "cli:interactive");
          console.log(`\n🤖 回复:`);
          console.log(result.processedText);
          console.log();
        } catch (err) {
          this.printSystem(`❌ LLM调用失败: ${(err as Error).message}`);
        }
        break;
      }

      case "prompt":
      case "系统提示": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          console.log(`\n当前系统提示词:\n${config.systemPrompt}\n`);
          break;
        }
        const newPrompt = subArgs.join(" ");
        this.llmEngine.updateConfig({ systemPrompt: newPrompt });
        this.printSystem(`✅ 系统提示词已更新 (${newPrompt.length} 字符)`);
        break;
      }

      case "model":
      case "模型": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          this.printSystem(`当前模型: ${config.model || "(默认)"}`);
          break;
        }
        this.llmEngine.updateConfig({ model: subArgs[0] });
        this.printSystem(`✅ 模型已设为: ${subArgs[0]}`);
        break;
      }

      case "temp":
      case "温度": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          this.printSystem(`当前温度: ${config.temperature}`);
          break;
        }
        const temp = parseFloat(subArgs[0]);
        if (isNaN(temp) || temp < 0 || temp > 2) {
          this.printSystem("温度范围: 0-2 (0=精确, 2=创意)");
          break;
        }
        this.llmEngine.updateConfig({ temperature: temp });
        this.printSystem(`✅ 温度已设为: ${temp}`);
        break;
      }

      case "history":
      case "历史": {
        const cm = this.llmEngine.getConversationManager();
        const keys = cm.keys;
        if (keys.length === 0) {
          this.printSystem("暂无对话历史");
          break;
        }
        console.log(`\n📜 对话历史 (${keys.length} 个对话):`);
        for (const key of keys) {
          const history = cm.getHistory(key);
          const userMsgs = history.filter((h) => h.role === "user").length;
          const botMsgs = history.filter((h) => h.role === "assistant").length;
          console.log(`  ${key}: ${userMsgs}条用户消息, ${botMsgs}条回复`);
        }
        // Show detail for a specific conversation
        if (subArgs[0]) {
          const detailKey = subArgs[0];
          const history = cm.getHistory(detailKey);
          if (history.length > 0) {
            console.log(`\n  详细历史 (${detailKey}):`);
            for (const entry of history.slice(-10)) {
              const role =
                entry.role === "user"
                  ? "👤"
                  : entry.role === "assistant"
                    ? "🤖"
                    : "⚙️";
              console.log(`  ${role} ${entry.content.substring(0, 80)}`);
            }
          }
        }
        console.log();
        break;
      }

      case "clear":
      case "清除": {
        const cm = this.llmEngine.getConversationManager();
        if (subArgs[0]) {
          cm.clearHistory(subArgs[0]);
          this.printSystem(`✅ 已清除对话: ${subArgs[0]}`);
        } else {
          cm.clearAll();
          this.printSystem("✅ 已清除所有对话历史");
        }
        break;
      }

      case "markdown":
      case "md": {
        if (subArgs.length === 0) {
          this.printSystem(
            "用法: /llm markdown <markdown文本> (测试Markdown解析)",
          );
          break;
        }
        const mdText = subArgs.join(" ");
        const result = markdownToImText(mdText);
        console.log("\n📝 Markdown解析结果:");
        console.log(result);
        console.log();
        break;
      }

      case "raw": {
        this.llmEngine.updateConfig({ markdownRawMode: true });
        this.printSystem(
          "✅ 已切换为Markdown原始模式 (LLM回复将保留原始Markdown格式)",
        );
        break;
      }

      case "im": {
        this.llmEngine.updateConfig({ markdownRawMode: false });
        this.printSystem("✅ 已切换为IM格式化模式 (LLM回复将转换为IM友好格式)");
        break;
      }

      case "provider":
      case "供应商": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          this.printSystem(
            `当前供应商: ${config.provider} (可选: z-ai|openai|anthropic|deepseek|custom)`,
          );
          break;
        }
        const providerName = subArgs[0].toLowerCase();
        const validProviders: LlmProviderType[] = [
          "z-ai",
          "openai",
          "anthropic",
          "deepseek",
          "custom",
        ];
        if (!validProviders.includes(providerName as LlmProviderType)) {
          this.printSystem(
            `无效供应商: ${providerName} (可选: ${validProviders.join("|")})`,
          );
          break;
        }
        try {
          this.llmEngine.updateConfig({
            provider: providerName as LlmProviderType,
          });
          this.printSystem(`✅ 供应商已切换为: ${providerName}`);
        } catch (err) {
          this.printSystem(`❌ 切换供应商失败: ${(err as Error).message}`);
        }
        break;
      }

      case "apikey":
      case "密钥": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          this.printSystem(
            `当前API密钥: ${config.apiKey ? "***" + config.apiKey.slice(-4) : "(未设置)"}`,
          );
          break;
        }
        this.llmEngine.updateConfig({ apiKey: subArgs[0] });
        this.printSystem("✅ API密钥已更新");
        break;
      }

      case "baseurl":
      case "基础URL": {
        if (subArgs.length === 0) {
          const config = this.llmEngine.getConfig();
          this.printSystem(`当前基础URL: ${config.baseUrl || "(默认)"}`);
          break;
        }
        this.llmEngine.updateConfig({ baseUrl: subArgs[0] });
        this.printSystem(`✅ 基础URL已设为: ${subArgs[0]}`);
        break;
      }

      case "group":
      case "群聊": {
        if (subArgs[0] === "on") {
          this.llmEngine.updateConfig({ enableInGroup: true });
          this.printSystem("✅ LLM 群聊响应已开启");
        } else if (subArgs[0] === "off") {
          this.llmEngine.updateConfig({ enableInGroup: false });
          this.printSystem("✅ LLM 群聊响应已关闭");
        } else if (subArgs[0] === "mention") {
          const val = subArgs[1];
          if (val === "on" || val === "true") {
            this.llmEngine.updateConfig({ requireMentionInGroup: true });
            this.printSystem("✅ 群聊需@才回复");
          } else if (val === "off" || val === "false") {
            this.llmEngine.updateConfig({ requireMentionInGroup: false });
            this.printSystem("✅ 群聊无需@即可回复");
          }
        }
        break;
      }

      default:
        this.printSystem(`未知LLM子命令: ${subCmd}。使用 /llm 查看状态`);
        break;
    }
  }

  // ─── Chat message sending ───

  private async sendChatMessage(text: string): Promise<void> {
    try {
      if (this.chatMode === "dm") {
        await this.bot.sendDirectMessage(this.chatTarget, text);
        this.printMessage("我", text, "dm-out");
      } else if (this.chatMode === "group") {
        await this.bot.sendGroupMessage(this.chatTarget, text);
        this.printMessage("我", text, "group-out");
        // Track sent message in session
        const session = this.groupSessions.get(this.chatTarget);
        if (session) {
          session.lastActiveAt = Date.now();
        }
      }
    } catch (err) {
      this.printSystem(`发送失败: ${(err as Error).message}`);
    }
  }

  // ─── Output helpers (prompt always stays on the last line) ───

  /**
   * Write a line of output. Uses \n to ensure the prompt (via rl.prompt())
   * is always on the last line of the terminal.
   */
  private outputLine(content: string): void {
    // Write newline then content so readline's cursor stays at the bottom
    process.stdout.write("\n" + content + "\n");
  }

  private printMessage(sender: string, text: string, direction: string): void {
    const timestamp = new Date().toLocaleTimeString("zh-CN");
    const arrow = direction.endsWith("out")
      ? chalk.cyan("→")
      : chalk.green("←");
    this.outputLine(
      `${arrow} [${chalk.dim(timestamp)}] ${chalk.bold(sender)}: ${text}`,
    );
    this.rl?.prompt();
  }

  private printSystem(msg: string): void {
    this.outputLine(`${chalk.blue("💡")} ${msg}`);
    this.rl?.prompt();
  }

  private printNotification(msg: string): void {
    const timestamp = new Date().toLocaleTimeString("zh-CN");
    this.outputLine(`${chalk.yellow("📩")} [${chalk.dim(timestamp)}] ${msg}`);
    this.rl?.prompt();
  }

  /**
   * Get the raw (un-colored) prompt string.
   */
  private getPrompt(): string {
    if (this.isInMultiline) {
      return "... ";
    }
    if (this.chatMode === "dm") {
      return `[DM:${this.chatTarget}] > `;
    }
    if (this.chatMode === "group") {
      const session = this.groupSessions.get(this.chatTarget);
      const name = session?.groupName || this.chatTarget;
      return `[Group:${name}] > `;
    }
    return this.config.prompt || DEFAULT_PROMPT;
  }

  /**
   * Get the colored prompt string.
   */
  private getColoredPrompt(): string {
    if (this.isInMultiline) {
      return chalk.dim("... ");
    }
    if (this.chatMode === "dm") {
      return `${chalk.magenta("[DM")}:${chalk.magenta.bold(this.chatTarget)}${chalk.magenta("]")} ${chalk.cyan("> ")}`;
    }
    if (this.chatMode === "group") {
      const session = this.groupSessions.get(this.chatTarget);
      const name = session?.groupName || this.chatTarget;
      return `${chalk.green("[Group")}:${chalk.green.bold(name)}${chalk.green("]")} ${chalk.cyan("> ")}`;
    }
    return chalk.cyan(this.config.prompt || DEFAULT_PROMPT);
  }

  private refreshPrompt(): void {
    if (this.rl) {
      this.rl.setPrompt(this.getColoredPrompt());
      this.rl.prompt(true);
    }
  }

  // ─── Tab completion (enhanced) ───

  /**
   * Enhanced context-aware tab completion.
   */
  private enhancedCompleter(line: string): [string[], string] {
    // Update completion context with current stores
    this.completionCtx = {
      aliasStore: this.bot.getAliasStore(),
      contactStore: this.bot.getContactStore(),
      groupStore: this.groupStore,
    };

    const result = getCompletions(line, this.completionCtx);

    if (result.completions.length === 0) {
      // Fallback: basic command list
      const commands = [
        "/help",
        "/dm",
        "/group",
        "/reply",
        "/chat",
        "/upload",
        "/download",
        "/img",
        "/file",
        "/tempfile",
        "/sticker",
        "/stickers",
        "/status",
        "/log",
        "/exit",
        "/contacts",
        "/groups",
        "/join",
        "/switch",
        "/info",
        "/members",
        "/mention",
        "/at",
        "/alias",
        "/history",
        "/search",
        "/batch",
        "/account",
        "/llm",
        "/hsearch",
        "/hclear",
      ];
      const hits = commands.filter((c) => c.startsWith(line));
      return [hits.length ? hits : commands, line];
    }

    // Replace the partial portion with the completion
    const replaceFrom = result.replaceFrom;
    return [result.completions, replaceFrom];
  }

  /**
   * Legacy basic completer (kept as fallback).
   */
  private completer(line: string): [string[], string] {
    return this.enhancedCompleter(line);
  }

  // ─── Robust tokenizer for CLI input ───

  /**
   * Tokenize CLI input with full support for:
   * - Double-quoted strings with escape sequences
   * - Single-quoted strings (literal, no escapes)
   * - Backslash escapes outside quotes
   * - Common escape sequences: \n, \t, \r, \\, \", \'
   */
  private tokenizeCliInput(input: string): string[] {
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

      // Double-quoted string
      if (ch === '"') {
        i++; // skip opening quote
        while (i < input.length && input[i] !== '"') {
          if (input[i] === "\\" && i + 1 < input.length) {
            current += this.processEscape(input[i + 1]);
            i += 2;
          } else {
            current += input[i];
            i++;
          }
        }
        i++; // skip closing quote
        continue;
      }

      // Single-quoted string (no escape processing, literal)
      if (ch === "'") {
        i++; // skip opening quote
        while (i < input.length && input[i] !== "'") {
          current += input[i];
          i++;
        }
        i++; // skip closing quote
        continue;
      }

      // Backslash escape outside quotes
      if (ch === "\\" && i + 1 < input.length) {
        current += this.processEscape(input[i + 1]);
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

  /**
   * Process a single escape character after backslash.
   */
  private processEscape(ch: string): string {
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      case " ":
        return " ";
      default:
        return eval(`\${ch}`); // unknown escape, eval directly
    }
  }

  // ─── Welcome banner ───

  private printWelcome(): void {
    const version = getVersion();
    const historySize = this.richHistory.size;

    console.log("");
    console.log(
      chalk.cyan(
        "╔══════════════════════════════════════════════════════════════╗",
      ),
    );
    console.log(
      chalk.cyan("║") +
      chalk.bold.white(
        `         🤖 Yuanbao Lite 交互式客户端 v${version}                  `,
      ) +
      chalk.cyan("║"),
    );
    console.log(
      chalk.cyan(
        "╠══════════════════════════════════════════════════════════════╣",
      ),
    );
    console.log(
      chalk.cyan("║") +
      chalk.dim(
        "  输入 /help 查看可用命令  |  Tab 补全  |  ↑↓ 历史记录       ",
      ) +
      chalk.cyan("║"),
    );
    console.log(
      chalk.cyan("║") +
      chalk.dim(
        "  \\ 续行  |  @[昵称](ID) 或 @[昵称]() @提及  |  Ctrl+C /exit  ",
      ) +
      chalk.cyan("║"),
    );
    if (historySize > 0) {
      console.log(
        chalk.cyan("║") +
        chalk.dim(
          `  历史记录: ${historySize} 条 (${join(homedir(), ".yuanbao-lite", "history")})`,
        ) +
        chalk.cyan("║"),
      );
    }
    console.log(
      chalk.cyan(
        "╚══════════════════════════════════════════════════════════════╝",
      ),
    );
    console.log("");
  }

  // ─── History navigation (up/down arrows) ───

  private setupHistoryNavigation(): void {
    // Note: Node.js readline already handles up/down for built-in history.
    // Since we disabled built-in history (historySize: 0), we need to
    // manually intercept keypress events for our RichHistory.
    if (!this.rl) return;

    // We'll hook into the readline's keypress processing.
    // The readline interface already listens for keypress on stdin.
    // We add our own listener that runs before readline's processing.
    const origLineHandler = this.rl as unknown as Record<string, unknown>;

    // Access the internal _processLine or similar is not reliable.
    // Instead, we use a simpler approach: override the history lookup.
    // Since we set historySize: 0, the built-in history is empty.
    // We'll populate the readline's history array directly from our RichHistory.
    this.syncHistoryToReadline();
  }

  /**
   * Sync the RichHistory entries into the readline's internal history array.
   * This enables the built-in up/down arrow navigation with our persistent history.
   */
  private syncHistoryToReadline(): void {
    if (!this.rl) return;

    // Access readline's internal history array
    const rlInternal = this.rl as unknown as { history: string[] };
    if (rlInternal.history) {
      // Replace readline's history with our persisted entries
      rlInternal.history = this.richHistory.getAll().slice(-500); // readline handles its own size limit
    }
  }

  /**
   * Add a line to the rich history and sync to readline.
   */
  private addHistory(line: string): void {
    this.richHistory.add(line);
    this.syncHistoryToReadline();
  }

  /**
   * Search history (Ctrl+R style).
   * Shows matching entries for the user to pick.
   */
  private searchHistory(query: string): void {
    const results = this.richHistory.search(query);
    if (results.length === 0) {
      this.printSystem(`历史记录中未找到: ${query}`);
    } else {
      console.log(chalk.dim("\n📜 历史搜索结果:"));
      for (let i = 0; i < Math.min(results.length, 10); i++) {
        const highlighted = results[i].replace(
          new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          (match) => chalk.yellow.bold(match),
        );
        console.log(`  ${chalk.dim(String(i + 1).padStart(2))} ${highlighted}`);
      }
      console.log("");
    }
  }

  // ─── Exit ───

  private handleExit(): void {
    this.printSystem("正在退出...");
    this.bot.stop();
    // Clear any partial prompt line before exit
    if (this.rl) {
      process.stdout.write("\n");
      this.rl.close();
    }
    process.exit(0);
  }
}

// ─── CLI entry point ───

/**
 * Parse command-line arguments and start the CLI.
 *
 * Supports both non-interactive mode (commander subcommands) and
 * interactive REPL mode.
 */
export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  // No args or "interactive"/"repl" subcommand → interactive mode
  if (args.length === 0 || args[0] === "interactive" || args[0] === "repl") {
    // Remove "interactive"/"repl" from argv so it doesn't confuse readline
    if (args.length > 0) {
      process.argv = process.argv.slice(0, 2).concat(args.slice(1));
    }
    const cli = new InteractiveCli();
    await cli.start();
    return;
  }

  // Otherwise, delegate to Commander non-interactive mode
  const program = buildProgram();

  // Add interactive subcommand
  program
    .command("interactive")
    .alias("repl")
    .description("启动交互式模式 (默认)")
    .action(async () => {
      const cli = new InteractiveCli();
      await cli.start();
    });

  await program.parseAsync(args, { from: "user" });
}

// Auto-run if this file is the entry point
if (
  process.argv[1]?.endsWith("cli-legacy/index.js") ||
  process.argv[1]?.endsWith("cli-legacy.js")
) {
  runCli().catch((err) => {
    console.error(chalk.red(`❌ 启动失败: ${(err as Error).message}`));
    process.exit(1);
  });
}
