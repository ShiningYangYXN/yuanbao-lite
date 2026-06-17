/**
 * Yuanbao Lite — Lightweight standalone Yuanbao bot client.
 *
 * This is the main entry point providing a simple, event-driven API
 * for connecting to Yuanbao via WebSocket and exchanging chat messages.
 * No OpenClaw dependency, no Agent support — pure chat only.
 *
 * @example
 * ```typescript
 * import { YuanbaoBot } from "yuanbao-lite";
 *
 * const bot = new YuanbaoBot({
 *   appKey: "your_app_key",
 *   appSecret: "your_app_secret",
 * });
 *
 * bot.on("message", (msg) => {
 *   console.log(`${msg.fromNickname}: ${msg.text}`);
 *   bot.sendText({ to: msg.fromUserId, text: "Hello!" });
 * });
 *
 * bot.on("groupMessage", (msg) => {
 *   console.log(`[${msg.groupName}] ${msg.fromNickname}: ${msg.text}`);
 *   bot.sendText({ to: msg.groupCode!, text: "Got it!", isGroup: true });
 * });
 *
 * bot.on("stateChange", (state) => {
 *   console.log(`Bot state: ${state.status}`);
 * });
 *
 * await bot.start();
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { YuanbaoWsClient } from "./access/ws/client.js";
import { decodeInboundMessage } from "./access/ws/biz-codec.js";
import { createLog, setLogLevel, setLogPrefix } from "./logger.js";
import type { ModuleLog, PluginLogger } from "./logger.js";
import { getSignToken, forceRefreshSignToken, clearAllSignTokenCache } from "./access/http/request.js";
import { resolveAccount } from "./accounts.js";
import { toChatMessage, buildTextMsgBody, splitTextChunks } from "./business/messaging/extract.js";
import { CommandSystem } from "./commands/registry.js";
import type { CommandSystemConfig, CommandDefinition } from "./commands/types.js";
import { uploadMedia, downloadMedia, extractMediaInfo, downloadAllMedia, buildImageMsgBody, buildFileMsgBody } from "./access/http/media.js";
import type { UploadResult, DownloadResult, MediaInfo } from "./access/http/media.js";
import { detectSticker, prepareStickerMsgBody, buildEmojiMsgBody } from "./business/sticker.js";
import type { StickerInfo } from "./business/sticker.js";
import { LlmTakeoverEngine, createLlmTakeover } from "./business/llm-takeover.js";
import type { LlmTakeoverConfig } from "./business/llm-takeover.js";
import { AliasStore, getGlobalAliasStore } from "./business/alias.js";
import { ContactStore, getGlobalContactStore } from "./business/contacts.js";
import { GroupStore, getGlobalGroupStore } from "./business/groups.js";
import { parseMentions, buildMentionMsgBody, buildCloudCustomDataWithMentions } from "./business/mention.js";
import { interpolate, buildMessageContext, chatContextFromMessage } from "./business/interpolate.js";
import { MessageHistoryStore, getGlobalHistoryStore } from "./business/history.js";
import { MultiAccountManager } from "./business/multi-account.js";
import { SearchEngine } from "./business/search.js";
import type { YuanbaoAccountConfig, ResolvedYuanbaoAccount, YuanbaoInboundMessage, YuanbaoMsgBodyElement, ChatMessage, SendTextMessageParams, BotStatus, BotState } from "./types.js";
import type { WsPushEvent, WsAuthBindResult, WsClientState } from "./access/ws/types.js";

// ─── Event types ───

export type BotEventType =
  | "message"
  | "directMessage"
  | "groupMessage"
  | "stateChange"
  | "error"
  | "ready"
  | "close"
  | "kickout";

export type BotEventHandler<T extends BotEventType> = T extends "message"
  ? (msg: ChatMessage) => void
  : T extends "directMessage"
    ? (msg: ChatMessage) => void
    : T extends "groupMessage"
      ? (msg: ChatMessage) => void
      : T extends "stateChange"
        ? (state: BotState) => void
        : T extends "error"
          ? (error: Error) => void
          : T extends "ready"
            ? (data: { connectId: string }) => void
            : T extends "close"
              ? () => void
              : T extends "kickout"
                ? (data: { status: number; reason: string }) => void
                : never;

// ─── Bot config ───

export type YuanbaoBotConfig = YuanbaoAccountConfig & {
  /** Log level: "debug" | "info" | "warn" | "error" (default: "info") */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Custom logger instance */
  logger?: PluginLogger;
  /** Maximum reconnect attempts (default: 100) */
  maxReconnectAttempts?: number;
  /** Command system configuration */
  commands?: CommandSystemConfig | false;
  /** Custom commands to register */
  customCommands?: CommandDefinition[];
  /** LLM takeover configuration — when provided, LLM auto-reply is available */
  llmConfig?: LlmTakeoverConfig;
  /** Whether non-slash messages should trigger LLM auto-reply (default: true) */
  llmAutoReply?: boolean;
};

// ─── Main Bot class ───

export class YuanbaoBot {
  private config: YuanbaoBotConfig;
  private account: ResolvedYuanbaoAccount;
  private client: YuanbaoWsClient | null = null;
  private abortController: AbortController | null = null;
  private log: ModuleLog;

  private eventHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private commandSystem: CommandSystem | null = null;
  private aliasStore: AliasStore;
  private contactStore: ContactStore;
  private groupStore: GroupStore;
  private historyStore: MessageHistoryStore;

  private llmEngine: LlmTakeoverEngine | null = null;
  private llmAutoReply: boolean;
  private llmHintSent = false;
  private multiAccountManager: MultiAccountManager | null = null;

  private currentState: BotState = {
    status: "disconnected",
    connected: false,
  };

  constructor(config: YuanbaoBotConfig) {
    this.config = config;
    this.account = resolveAccount(config, "default");

    if (config.logLevel) {
      setLogLevel(config.logLevel);
    }
    setLogPrefix("[yuanbao-lite]");

    this.log = createLog("bot", config.logger);

    // Initialize alias store
    this.aliasStore = getGlobalAliasStore({
      persistencePath: join(homedir(), ".yuanbao-lite", "aliases.json"),
      autoSave: true,
    });

    // Initialize contact store
    this.contactStore = getGlobalContactStore({
      persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
      autoSave: true,
    });

    // Initialize group store
    this.groupStore = getGlobalGroupStore({
      persistencePath: join(homedir(), ".yuanbao-lite", "groups.json"),
      autoSave: true,
    });

    // Initialize history store
    this.historyStore = getGlobalHistoryStore({
      maxMessages: this.account.historyLimit || 10000,
      persistencePath: join(homedir(), ".yuanbao-lite", "history.jsonl"),
      autoPersist: true,
    });

    // Initialize command system
    if (config.commands !== false) {
      const cmdConfig = typeof config.commands === "object" ? config.commands : undefined;
      this.commandSystem = new CommandSystem(cmdConfig);

      // Register custom commands
      if (config.customCommands) {
        for (const cmd of config.customCommands) {
          this.commandSystem.register(cmd);
        }
      }
    }

    // Initialize LLM engine
    this.llmAutoReply = config.llmAutoReply ?? true;
    if (config.llmConfig) {
      this.llmEngine = createLlmTakeover({
        ...config.llmConfig,
        persistencePath: join(homedir(), ".yuanbao-lite", "llm-config.json"),
      });
    }
  }

  // ─── Event subscription ───

  on<T extends BotEventType>(event: T, handler: BotEventHandler<T>): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<T extends BotEventType>(event: T, handler: BotEventHandler<T>): void {
    this.eventHandlers.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private emit<T extends BotEventType>(event: T, ...args: Parameters<BotEventHandler<T>>): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          this.log.error(`event handler error for "${event}": ${(err as Error).message}`);
        }
      }
    }
  }

  // ─── Lifecycle ───

  /**
   * Start the bot — connects to Yuanbao WebSocket gateway.
   *
   * Resolves when the bot is disconnected (via stop() or fatal error).
   * Use the "ready" event to know when the connection is established.
   */
  async start(): Promise<void> {
    if (!this.account.configured) {
      throw new Error("Bot not configured: appKey and appSecret are required");
    }

    // Load persisted runtime preferences (log level, etc.)
    this.loadRuntimePrefs();

    this.abortController = new AbortController();
    this.log.info("starting Yuanbao Lite bot...");

    // Build auth info
    const auth = await this.resolveWsAuth();

    this.client = new YuanbaoWsClient({
      connection: {
        gatewayUrl: this.account.wsGatewayUrl,
        auth,
      },
      config: {
        maxReconnectAttempts: this.config.maxReconnectAttempts ?? this.account.wsMaxReconnectAttempts,
      },
      callbacks: {
        onReady: (data: WsAuthBindResult) => this.handleReady(data),
        onDispatch: (pushEvent: WsPushEvent) => this.handleDispatch(pushEvent),
        onStateChange: (state: WsClientState) => this.handleStateChange(state),
        onError: (error: Error) => this.handleError(error),
        onClose: (code, reason) => this.log.info(`WebSocket closed: code=${code}, reason=${reason}`),
        onKickout: (data) => this.handleKickout(data),
        onAuthFailed: async (code: number) => {
          this.log.warn(`auth failed (code=${code}), refreshing token`);
          try {
            const tokenData = await forceRefreshSignToken(this.account);
            const uid = tokenData.bot_id || this.account.botId || "";
            if (tokenData.bot_id) {
              this.account.botId = tokenData.bot_id;
            }
            return {
              bizId: "ybBot",
              uid,
              source: tokenData.source || "bot",
              token: tokenData.token,
              routeEnv: this.account.config?.routeEnv,
            };
          } catch (err) {
            this.log.error(`token refresh failed: ${(err as Error).message}`);
            return null;
          }
        },
      },
      log: {
        info: (msg: string) => this.log.info(msg),
        warn: (msg: string) => this.log.warn(msg),
        error: (msg: string) => this.log.error(msg),
        debug: (msg: string) => this.log.debug(msg),
      },
    });

    this.client.connect();

    // Wait for abort signal
    return new Promise<void>((resolve) => {
      const onAbort = () => {
        this.log.info("received stop signal, disconnecting");
        this.client?.disconnect();
        this.client = null;
        clearAllSignTokenCache();
        this.updateState({ status: "disconnected", connected: false });
        this.emit("close");
        resolve();
      };

      this.abortController!.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Stop the bot — gracefully disconnects from Yuanbao.
   */
  stop(): void {
    this.abortController?.abort();
  }

  // ─── Send messages ───

  /**
   * Send a text message.
   *
   * Automatically handles long messages by splitting them into chunks
   * that respect the Yuanbao character limit.
   * Supports:
   *   - @mention syntax: @[nickname](id)
   *   - $ interpolation: ${expr} with any valid JavaScript
   *   - Chat context variables: ${sender.name}, ${group.code}, ${bot.id}, etc.
   *   - \@ and \${} to escape
   *
   * @param params - Send parameters including optional contextMsg for interpolation context
   */
  async sendText(params: SendTextMessageParams & { contextMsg?: ChatMessage }): Promise<void> {
    if (!this.client) {
      throw new Error("Bot not connected");
    }

    const { to, text, isGroup, quoteMsgId, quoteMsgSeq, contextMsg, skipInterpolation } = params;

    // Step 1: Build interpolation context (with chat context if provided)
    // Skip interpolation if caller has already resolved ${...} expressions (e.g. batch)
    const interpolatedText = skipInterpolation
      ? text
      : interpolate(text, buildMessageContext(
          contextMsg ? chatContextFromMessage(contextMsg, this.account.botId) : undefined,
        ));

    // Step 2: Build @mention msg_body with interleaved TIMCustomElem elements
    // Build nickname resolver for @[昵称]() auto-matching in groups
    const nicknameResolver = (isGroup && to)
      ? async (nickname: string) => {
          try {
            const searchEngine = new SearchEngine(this);
            const results = await searchEngine.searchGroupMembers(String(to), nickname);
            // Only return exact or very close matches
            const exactMatches = results.filter(r => r.score >= 0.8);
            return exactMatches.map(r => ({ userId: r.userId, nickname: r.nickName }));
          } catch {
            return [];
          }
        }
      : undefined;

    // Use buildMentionMsgBody which interleaves TIMCustomElem at correct positions
    // (matching the original project's resolveAtMentions approach)
    const { msgBody: mentionMsgBody, cloudCustomData, mentions: parsedMentions } =
      await buildMentionMsgBody(interpolatedText, this.aliasStore, nicknameResolver);

    // Handle long messages by splitting if needed
    if (mentionMsgBody.length <= 2 && !parsedMentions.length) {
      // Simple case: just text, may need splitting
      const textContent = mentionMsgBody.find(el => el.msg_type === "TIMTextElem")?.msg_content?.text || "";
      const chunks = splitTextChunks(textContent, 3000);

      for (const chunk of chunks) {
        const msgBody = buildTextMsgBody(chunk);
        if (isGroup) {
          await this.client.sendGroupMessage({
            group_code: to,
            from_account: this.account.botId || "",
            msg_body: msgBody,
            msg_id: quoteMsgId,
            ref_msg_id: quoteMsgId,
            msg_seq: quoteMsgSeq,
            cloud_custom_data: cloudCustomData,
          });
        } else {
          await this.client.sendC2CMessage({
            to_account: to,
            from_account: this.account.botId || "",
            msg_body: msgBody,
            msg_id: quoteMsgId,
            ref_msg_id: quoteMsgId,
            cloud_custom_data: cloudCustomData,
          });
        }
      }
    } else {
      // Has mentions or complex msg_body — send as-is (already interleaved correctly)
      if (isGroup) {
        await this.client.sendGroupMessage({
          group_code: to,
          from_account: this.account.botId || "",
          msg_body: mentionMsgBody,
          msg_id: quoteMsgId,
          ref_msg_id: quoteMsgId,
          msg_seq: quoteMsgSeq,
          cloud_custom_data: cloudCustomData,
        });
      } else {
        await this.client.sendC2CMessage({
          to_account: to,
          from_account: this.account.botId || "",
          msg_body: mentionMsgBody,
          msg_id: quoteMsgId,
          ref_msg_id: quoteMsgId,
          cloud_custom_data: cloudCustomData,
        });
      }
    }
  }

  /**
   * Send a direct (C2C) text message.
   */
  async sendDirectMessage(userId: string, text: string): Promise<void> {
    return this.sendText({ to: userId, text, isGroup: false });
  }

  /**
   * Send a group text message.
   */
  async sendGroupMessage(groupCode: string, text: string): Promise<void> {
    return this.sendText({ to: groupCode, text, isGroup: true });
  }

  /**
   * Send a raw message with full control over msg_body.
   *
   * This is the low-level API for sending messages with rich content
   * (stickers, images, files, custom elements) that cannot be expressed
   * as plain text. Use this when you need precise control over the
   * message body structure.
   */
  async sendRawMessage(params: {
    to: string;
    msgBody: YuanbaoMsgBodyElement[];
    isGroup?: boolean;
    cloudCustomData?: string;
  }): Promise<void> {
    if (!this.client) throw new Error("Bot not connected");

    if (params.isGroup) {
      await this.client.sendGroupMessage({
        group_code: params.to,
        from_account: this.account.botId || "",
        msg_body: params.msgBody,
        cloud_custom_data: params.cloudCustomData,
      });
    } else {
      await this.client.sendC2CMessage({
        to_account: params.to,
        from_account: this.account.botId || "",
        msg_body: params.msgBody,
        cloud_custom_data: params.cloudCustomData,
      });
    }
  }

  /**
   * Send reply-status heartbeat (RUNNING) to indicate the bot is processing.
   */
  async sendHeartbeatRunning(to: string, isGroup = false, groupCode?: string): Promise<void> {
    if (!this.client || !this.account.botId) return;

    if (isGroup && groupCode) {
      await this.client.sendGroupHeartbeat({
        from_account: this.account.botId,
        to_account: to,
        group_code: groupCode,
        send_time: Date.now(),
        heartbeat: 1, // RUNNING
      });
    } else {
      await this.client.sendPrivateHeartbeat({
        from_account: this.account.botId,
        to_account: to,
        heartbeat: 1, // RUNNING
      });
    }
  }

  /**
   * Send reply-status heartbeat (FINISH) to indicate the bot is done.
   */
  async sendHeartbeatFinish(to: string, isGroup = false, groupCode?: string): Promise<void> {
    if (!this.client || !this.account.botId) return;

    if (isGroup && groupCode) {
      await this.client.sendGroupHeartbeat({
        from_account: this.account.botId,
        to_account: to,
        group_code: groupCode,
        send_time: Date.now(),
        heartbeat: 2, // FINISH
      });
    } else {
      await this.client.sendPrivateHeartbeat({
        from_account: this.account.botId,
        to_account: to,
        heartbeat: 2, // FINISH
      });
    }
  }

  // ─── Query APIs ───

  /**
   * Query group info.
   */
  async queryGroupInfo(groupCode: string) {
    if (!this.client) throw new Error("Bot not connected");
    return this.client.queryGroupInfo({ group_code: groupCode });
  }

  /**
   * Get group member list.
   */
  async getGroupMemberList(groupCode: string) {
    if (!this.client) throw new Error("Bot not connected");
    return this.client.getGroupMemberList({ group_code: groupCode });
  }

  // ─── Media APIs ───

  /**
   * Upload a media file to Yuanbao's media server.
   */
  async uploadMedia(filePath: string, mediaType?: import("./access/http/media.js").MediaType): Promise<UploadResult> {
    return uploadMedia(this.account, filePath, { mediaType });
  }

  /**
   * Download a media file from a URL.
   */
  async downloadMedia(url: string, saveDir?: string, fileName?: string): Promise<DownloadResult> {
    return downloadMedia(url, saveDir, fileName);
  }

  /**
   * Download all media attachments from a message.
   */
  async downloadAllMedia(msgBody: YuanbaoMsgBodyElement[], saveDir?: string): Promise<DownloadResult[]> {
    return downloadAllMedia(msgBody, saveDir);
  }

  /**
   * Extract media information from a message body.
   */
  extractMediaInfo(msgBody: YuanbaoMsgBodyElement[]): MediaInfo[] {
    return extractMediaInfo(msgBody);
  }

  // ─── Send Image / File ───

  /**
   * Send an image message.
   *
   * Uploads the image file and sends it as a TIMImageElem.
   * Supports @mention via cloud_custom_data and $ interpolation.
   */
  async sendImage(params: {
    to: string;
    filePath: string;
    isGroup?: boolean;
    mentions?: string;
    contextMsg?: ChatMessage;
  }): Promise<void> {
    if (!this.client) throw new Error("Bot not connected");

    const uploadResult = await uploadMedia(this.account, params.filePath, { mediaType: "image" });

    const msgBody = buildImageMsgBody({
      uuid: uploadResult.uuid,
      url: uploadResult.url,
      size: uploadResult.fileSize,
    });

    // Handle mentions
    let cloudCustomData: string | undefined;
    if (params.mentions) {
      const chatCtx = params.contextMsg
        ? chatContextFromMessage(params.contextMsg, this.account.botId)
        : undefined;
      const interpolatedMentions = interpolate(params.mentions, buildMessageContext(chatCtx));
      const mentionResult = await parseMentions(interpolatedMentions, this.aliasStore);
      if (mentionResult.mentionedUserIds.length > 0) {
        cloudCustomData = buildCloudCustomDataWithMentions(undefined, mentionResult);
      }
    }

    if (params.isGroup) {
      await this.client.sendGroupMessage({
        group_code: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    } else {
      await this.client.sendC2CMessage({
        to_account: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    }
  }

  /**
   * Send a file message.
   *
   * Uploads the file and sends it as a TIMFileElem.
   * Supports @mention via cloud_custom_data and $ interpolation.
   */
  async sendFile(params: {
    to: string;
    filePath: string;
    isGroup?: boolean;
    mentions?: string;
    contextMsg?: ChatMessage;
  }): Promise<void> {
    if (!this.client) throw new Error("Bot not connected");

    const uploadResult = await uploadMedia(this.account, params.filePath, { mediaType: "file" });

    const msgBody = buildFileMsgBody({
      uuid: uploadResult.uuid,
      fileName: uploadResult.fileName,
      fileSize: uploadResult.fileSize,
      url: uploadResult.url,
    });

    // Handle mentions
    let cloudCustomData: string | undefined;
    if (params.mentions) {
      const chatCtx = params.contextMsg
        ? chatContextFromMessage(params.contextMsg, this.account.botId)
        : undefined;
      const interpolatedMentions = interpolate(params.mentions, buildMessageContext(chatCtx));
      const mentionResult = await parseMentions(interpolatedMentions, this.aliasStore);
      if (mentionResult.mentionedUserIds.length > 0) {
        cloudCustomData = buildCloudCustomDataWithMentions(undefined, mentionResult);
      }
    }

    if (params.isGroup) {
      await this.client.sendGroupMessage({
        group_code: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    } else {
      await this.client.sendC2CMessage({
        to_account: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    }
  }

  // ─── Sticker APIs ───

  /**
   * Send a sticker by its ID.
   *
   * Supports @mention and $ interpolation in text overlay.
   * Chat context variables available in interpolation when contextMsg provided.
   */
  async sendSticker(params: { to: string; stickerId: string; isGroup?: boolean; text?: string; mentions?: string; contextMsg?: ChatMessage }): Promise<void> {
    if (!this.client) throw new Error("Bot not connected");

    // Build interpolation context
    const chatCtx = params.contextMsg
      ? chatContextFromMessage(params.contextMsg, this.account.botId)
      : undefined;

    // Process $ interpolation in stickerId
    const resolvedStickerId = interpolate(params.stickerId, buildMessageContext(chatCtx));

    const msgBody = await prepareStickerMsgBody(this.account, resolvedStickerId);

    // Handle mentions via cloud_custom_data
    let cloudCustomData: string | undefined;
    if (params.mentions) {
      const mentionResult = await parseMentions(params.mentions, this.aliasStore);
      if (mentionResult.mentionedUserIds.length > 0) {
        cloudCustomData = buildCloudCustomDataWithMentions(undefined, mentionResult);
      }
    }

    // Handle text overlay with interpolation + mentions
    if (params.text) {
      const interpolatedText = interpolate(params.text, buildMessageContext());
      const mentionResult = await parseMentions(interpolatedText, this.aliasStore);
      if (mentionResult.mentionedUserIds.length > 0) {
        cloudCustomData = buildCloudCustomDataWithMentions(cloudCustomData, mentionResult);
      }
    }

    if (params.isGroup) {
      await this.client.sendGroupMessage({
        group_code: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    } else {
      await this.client.sendC2CMessage({
        to_account: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    }
  }

  /**
   * Send an emoji sticker by index.
   *
   * Supports @mention via cloud_custom_data.
   */
  async sendEmoji(params: { to: string; emojiIndex: number; isGroup?: boolean; mentions?: string }): Promise<void> {
    if (!this.client) throw new Error("Bot not connected");

    const msgBody = buildEmojiMsgBody(params.emojiIndex);

    // Handle mentions
    let cloudCustomData: string | undefined;
    if (params.mentions) {
      const mentionResult = await parseMentions(params.mentions, this.aliasStore);
      if (mentionResult.mentionedUserIds.length > 0) {
        cloudCustomData = buildCloudCustomDataWithMentions(undefined, mentionResult);
      }
    }

    if (params.isGroup) {
      await this.client.sendGroupMessage({
        group_code: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    } else {
      await this.client.sendC2CMessage({
        to_account: params.to,
        from_account: this.account.botId || "",
        msg_body: msgBody,
        cloud_custom_data: cloudCustomData,
      });
    }
  }

  /**
   * Detect if a message contains a sticker.
   */
  detectSticker(msgBody: YuanbaoMsgBodyElement[]): StickerInfo | null {
    return detectSticker(msgBody);
  }

  // ─── Command System ───

  /**
   * Get the command system instance.
   */
  getCommandSystem(): CommandSystem | null {
    return this.commandSystem;
  }

  /**
   * Register a custom command.
   */
  registerCommand(def: CommandDefinition): void {
    if (!this.commandSystem) {
      this.commandSystem = new CommandSystem();
    }
    this.commandSystem.register(def);
  }

  /**
   * Unregister a command.
   */
  unregisterCommand(name: string): boolean {
    return this.commandSystem?.unregister(name) ?? false;
  }

  // ─── State ───

  /**
   * Get current bot state.
   */
  getState(): BotState {
    return { ...this.currentState };
  }

  /**
   * Get the resolved account configuration.
   */
  getAccount(): ResolvedYuanbaoAccount {
    return { ...this.account };
  }

  /**
   * Get the alias store instance.
   */
  getAliasStore(): AliasStore {
    return this.aliasStore;
  }

  /**
   * Get the contact store instance.
   */
  getContactStore(): ContactStore {
    return this.contactStore;
  }

  /**
   * Get the message history store instance.
   */
  getHistoryStore(): MessageHistoryStore {
    return this.historyStore;
  }

  /**
   * Get the group store instance.
   */
  getGroupStore(): GroupStore {
    return this.groupStore;
  }

  /**
   * Get the LLM takeover engine (or null if not initialized).
   */
  getLlmEngine(): LlmTakeoverEngine | null {
    return this.llmEngine;
  }

  /**
   * Set the LLM takeover engine.
   */
  setLlmEngine(engine: LlmTakeoverEngine): void {
    this.llmEngine = engine;
  }

  /**
   * Check if LLM auto-reply is enabled.
   */
  isLlmAutoReply(): boolean {
    return this.llmAutoReply;
  }

  /**
   * Enable or disable LLM auto-reply.
   */
  setLlmAutoReply(enabled: boolean): void {
    this.llmAutoReply = enabled;
  }

  /**
   * Get or create the multi-account manager.
   */
  getMultiAccountManager(): MultiAccountManager {
    if (!this.multiAccountManager) {
      this.multiAccountManager = new MultiAccountManager();
      // Add the current bot as the default account
      this.multiAccountManager.addAccount("default", {
        appKey: this.config.appKey,
        appSecret: this.config.appSecret,
        token: this.config.token,
      }, "默认账号");
    }
    return this.multiAccountManager;
  }

  // ─── Internal handlers ───

  private async resolveWsAuth() {
    this.log.info("resolving WS auth...");

    if (this.account.token) {
      const uid = this.account.botId || "";
      return {
        bizId: "ybBot",
        uid,
        source: "bot",
        token: this.account.token,
        routeEnv: this.account.config?.routeEnv,
      };
    }

    const tokenData = await getSignToken(this.account);
    const uid = tokenData.bot_id || this.account.botId || "";

    if (tokenData.bot_id) {
      this.account.botId = tokenData.bot_id;
    }

    this.log.info(`sign-token done: uid=${uid} (bot_id=${tokenData.bot_id})`);

    return {
      bizId: "ybBot",
      uid,
      source: tokenData.source || "bot",
      token: tokenData.token,
      routeEnv: this.account.config?.routeEnv,
    };
  }

  /**
   * Load persisted runtime preferences from ~/.yuanbao-lite/runtime-prefs.json.
   * Restores settings like log level that were changed via /log command.
   */
  private loadRuntimePrefs(): void {
    try {
      const prefsPath = join(homedir(), ".yuanbao-lite", "runtime-prefs.json");
      if (!existsSync(prefsPath)) return;
      const raw = readFileSync(prefsPath, "utf-8");
      const prefs = JSON.parse(raw) as Record<string, unknown>;
      if (prefs.logLevel && typeof prefs.logLevel === "string") {
        const validLevels = ["debug", "info", "warn", "error"];
        if (validLevels.includes(prefs.logLevel)) {
          setLogLevel(prefs.logLevel as "debug" | "info" | "warn" | "error");
          this.log.info(`restored log level from prefs: ${prefs.logLevel}`);
        }
      }
    } catch {
      // Non-critical: just use default log level
    }
  }

  private handleReady(data: WsAuthBindResult): void {
    this.log.info(`connected: connectId=${data.connectId}`);
    this.updateState({
      status: "connected",
      connected: true,
      connectId: data.connectId,
      lastConnectedAt: Date.now(),
      botId: this.account.botId,
    });

    // Query bot owner info (non-blocking)
    if (this.account.botId && this.client) {
      this.client.queryBotInfo(this.account.botId).then((rsp) => {
        if (rsp.code === 0 && rsp.ownerId) {
          this.account.botOwnerId = rsp.ownerId;
          this.log.info(`bot owner cached: ownerId=${rsp.ownerId}`);
        }
      }).catch((err) => {
        this.log.warn(`failed to query bot owner: ${(err as Error).message}`);
      });
    }

    this.emit("ready", { connectId: data.connectId });
  }

  private handleDispatch(pushEvent: WsPushEvent): void {
    this.log.debug(`dispatch: cmd=${pushEvent.cmd}, type=${pushEvent.type}`);

    const converted = this.pushEventToInboundMessage(pushEvent);
    if (!converted) {
      this.log.debug("non-message event, skipping");
      return;
    }

    const { msg, chatType } = converted;
    const chatMessage = toChatMessage(msg);

    // ─── Skip-self guard ───
    // Prevents infinite echo when the bot's own outgoing messages arrive
    // via Group.CallbackAfterSendMsg / C2C.CallbackAfterSendMsg callbacks.
    if (this.account.botId && chatMessage.fromUserId === this.account.botId) {
      this.log.debug("skipping self-message");
      return;
    }

    // ─── Skip-placeholder guard ───
    // Abort if the message body is empty (group: only when not @bot) or
    // is a single bracket placeholder like "[image]" with no actual content.
    // Allows "[EMOJI: ...]" since that carries semantic meaning.
    const trimmedText = chatMessage.text.trim();
    if (!trimmedText) {
      // Empty message — only process if bot is mentioned (so /commands with
      // media attachments still work) or it's a DM
      if (chatMessage.chatType === "group" && !chatMessage.isMentioned) {
        this.log.debug("skipping empty group message (not @bot)");
        return;
      }
    } else if (
      /^\[[a-z]+\]$/.test(trimmedText) &&
      !trimmedText.startsWith("[EMOJI:")
    ) {
      // Single bracket placeholder like [image], [file], [video], [voice]
      // with no additional text — skip to avoid wasting LLM calls
      this.log.debug(`skipping placeholder message: ${trimmedText}`);
      return;
    }

    // Fix isMentioned: always verify against the bot's own ID
    // The default isBotMentioned() checks if ANY mention exists (not bot-specific),
    // so we always override based on whether the bot is specifically mentioned.
    // Also use String() for comparison since user_id from TIMCustomElem may be a number.
    if (chatMessage.chatType === "group" && this.account.botId) {
      const botId = String(this.account.botId);
      const mentioned = chatMessage.mentions?.some(m => String(m.userId) === botId);
      if (mentioned) {
        chatMessage.isMentioned = true;
        this.log.debug(`isMentioned=true: bot ${botId} found in TIMCustomElem mentions`);
      } else {
        // Fallback: check cloud_custom_data groupAtInfo directly from raw message
        // The extractMentionsFromMsgBody may miss mentions if TIMCustomElem parsing fails
        let foundInCloudData = false;
        try {
          const rawCloudData = msg.cloud_custom_data;
          if (rawCloudData) {
            const customData = JSON.parse(rawCloudData) as Record<string, unknown>;
            const groupAtInfo = customData.groupAtInfo;
            if (groupAtInfo && typeof groupAtInfo === "object") {
              const gai = groupAtInfo as Record<string, unknown>;
              const userIds = gai.groupAtUserIds;
              if (Array.isArray(userIds) && userIds.some(uid => String(uid) === botId)) {
                foundInCloudData = true;
              }
            }
          }
        } catch {
          // Ignore JSON parse errors
        }

        if (foundInCloudData) {
          chatMessage.isMentioned = true;
          this.log.debug(`isMentioned=true: bot ${botId} found in cloud_custom_data groupAtInfo`);
        } else {
          // Bot is NOT specifically mentioned — override any false positive from isBotMentioned()
          // which checks if ANY mention exists, not specifically the bot
          chatMessage.isMentioned = false;
          this.log.debug(`isMentioned=false: bot ${botId} NOT in mentions (raw mentions: ${JSON.stringify(chatMessage.mentions?.map(m => m.userId))})`);
        }
      }
    }

    // Store in history
    this.historyStore.add(chatMessage);

    // Track group activity for group name resolution
    if (chatMessage.chatType === "group" && chatMessage.groupCode) {
      this.groupStore.trackActivity(chatMessage.groupCode, chatMessage.groupName);
    }

    // ─── Step 1: Store ALL messages in LLM conversation context ───
    // Every message (including slash commands) feeds context so the LLM
    // always has full conversation awareness.
    this.feedLlmContext(chatMessage);

    // ─── Step 2: Try command dispatch ───
    const isSlashCommand = chatMessage.text.trim().startsWith("/");
    if (isSlashCommand && this.commandSystem) {
      this.commandSystem.dispatch(this, chatMessage).then((result) => {
        if (result.handled) {
          this.log.debug(`command handled: ${chatMessage.text}`);
          // Trigger data persistence after command execution
          this.persistData();
          return;
        }
        // Unknown slash command — still emit and try LLM
        this.emitMessageEvents(chatMessage, chatType);
        this.tryLlmAutoReply(chatMessage);
      }).catch((err) => {
        this.log.error(`command dispatch error: ${(err as Error).message}`);
        this.emitMessageEvents(chatMessage, chatType);
        this.tryLlmAutoReply(chatMessage);
      });
    } else {
      // Non-slash message — emit events and try LLM auto-reply
      this.emitMessageEvents(chatMessage, chatType);
      this.tryLlmAutoReply(chatMessage);
    }
  }

  /**
   * Feed a message into LLM conversation context (without triggering API call).
   *
   * ALL messages (including slash commands) are stored so the LLM always
   * has full conversation awareness. The API call is only triggered when
   * the user @mentions the bot in a group or sends a DM.
   */
  private feedLlmContext(chatMessage: ChatMessage): void {
    if (!this.llmEngine) return;
    const text = chatMessage.text?.trim();
    if (!text) return;
    const sender = chatMessage.fromNickname || chatMessage.fromUserId;
    this.llmEngine.addContextMessage(chatMessage, `[${sender}]: ${text}`);
  }

  /**
   * Persist all data stores to disk.
   * Called after command execution to ensure data is saved.
   */
  private persistData(): void {
    try {
      this.aliasStore.save();
    } catch { /* ignore */ }
    try {
      this.contactStore.save();
    } catch { /* ignore */ }
    try {
      this.groupStore.save();
    } catch { /* ignore */ }
  }

  /**
   * Try LLM auto-reply — only triggers API call when @mentioned or in DM.
   *
   * Context is already fed via feedLlmContext() for ALL messages.
   * This method only decides whether to make an API call.
   */
  private async tryLlmAutoReply(chatMessage: ChatMessage): Promise<void> {
    // Skip slash commands
    if (chatMessage.text.trim().startsWith("/")) {
      this.log.debug("tryLlmAutoReply: skipping slash command");
      return;
    }

    // Check if LLM auto-reply is enabled
    if (!this.llmAutoReply) {
      this.log.debug("tryLlmAutoReply: auto-reply is disabled");
      return;
    }

    if (!this.llmEngine) {
      if (!this.llmHintSent && this.config.llmConfig) {
        // LLM config was provided but engine couldn't initialize
        this.llmHintSent = true;
        this.log.warn("LLM config was provided but engine is null — check llmConfig initialization");
      }
      this.log.debug("tryLlmAutoReply: llmEngine is null, skipping");
      return;
    }

    if (!this.llmEngine.isReady) {
      this.log.debug("tryLlmAutoReply: llmEngine exists but isReady=false (enabled=false or provider not configured)");
      return;
    }

    try {
      const result = await this.llmEngine.handleMessage(this, chatMessage);
      if (result.handled && result.response) {
        this.log.info(`LLM auto-replied to ${chatMessage.fromUserId}: ${result.response.processedText.substring(0, 50)}...`);
      } else if (result.handled) {
        this.log.debug(`tryLlmAutoReply: message buffered for merge (handled=true, no response yet)`);
      } else {
        this.log.debug(`tryLlmAutoReply: handleMessage returned handled=${result.handled} for ${chatMessage.fromUserId}`);
      }
    } catch (err) {
      this.log.error(`LLM auto-reply error: ${(err as Error).message}`);
    }
  }

  private emitMessageEvents(chatMessage: ChatMessage, chatType: "c2c" | "group"): void {
    // Emit generic message event
    this.emit("message", chatMessage);

    // Emit specific events
    if (chatType === "group") {
      this.emit("groupMessage", chatMessage);
    } else {
      this.emit("directMessage", chatMessage);
    }
  }

  private handleStateChange(state: WsClientState): void {
    const statusMap: Record<WsClientState, BotStatus> = {
      disconnected: "disconnected",
      connecting: "connecting",
      authenticating: "authenticating",
      connected: "connected",
      reconnecting: "reconnecting",
    };

    this.updateState({
      status: statusMap[state],
      connected: state === "connected",
    });
  }

  private handleError(error: Error): void {
    this.log.error(`WebSocket error: ${error.message}`);
    this.updateState({ lastError: error.message });
    this.emit("error", error);
  }

  private handleKickout(data: { status: number; reason: string }): void {
    this.log.warn(`kicked out: status=${data.status}, reason=${data.reason}`);
    this.emit("kickout", data);
  }

  private updateState(patch: Partial<BotState>): void {
    this.currentState = { ...this.currentState, ...patch };
    this.emit("stateChange", this.currentState);
  }

  // ─── Push event to inbound message conversion ───

  private pushEventToInboundMessage(
    pushEvent: WsPushEvent,
  ): { msg: YuanbaoInboundMessage; chatType: "c2c" | "group" } | null {
    // Try JSON decode on connData first (Yuanbao sends inbound messages as raw JSON in connData)
    if (pushEvent.connData && pushEvent.connData.length > 0) {
      try {
        const text = new TextDecoder().decode(pushEvent.connData);
        if (text.startsWith("{")) {
          const rawJson = JSON.parse(text);
          if (rawJson && this.hasValidMsgFields(rawJson)) {
            const msg = rawJson as YuanbaoInboundMessage;
            if (!msg.trace_id && rawJson.log_ext?.trace_id) {
              msg.trace_id = rawJson.log_ext.trace_id;
            }
            return { msg, chatType: this.inferChatType(msg) };
          }
        }
      } catch {
        // Not JSON, try protobuf below
      }

      // Try protobuf decode via connData
      const decoded = decodeInboundMessage(pushEvent.connData);
      if (decoded && this.hasValidMsgFields(decoded)) {
        const chatType = this.inferChatType(decoded);
        return { msg: decoded, chatType };
      }
    }

    // Try rawData (PushMsg.data)
    if (pushEvent.rawData && pushEvent.rawData.length > 0) {
      // Try JSON first
      try {
        const text = new TextDecoder().decode(pushEvent.rawData);
        if (text.startsWith("{")) {
          const rawJson = JSON.parse(text);
          if (rawJson && this.hasValidMsgFields(rawJson)) {
            const msg = rawJson as YuanbaoInboundMessage;
            if (!msg.trace_id && rawJson.log_ext?.trace_id) {
              msg.trace_id = rawJson.log_ext.trace_id;
            }
            return { msg, chatType: this.inferChatType(msg) };
          }
        }
      } catch {
        // Not JSON
      }

      // Try protobuf
      const decoded = decodeInboundMessage(pushEvent.rawData);
      if (decoded && this.hasValidMsgFields(decoded)) {
        const chatType = this.inferChatType(decoded);
        return { msg: decoded, chatType };
      }
    }

    // Try content string
    if (pushEvent.content) {
      return this.decodeFromContent(pushEvent);
    }

    return null;
  }

  private decodeFromContent(pushEvent: WsPushEvent): { msg: YuanbaoInboundMessage; chatType: "c2c" | "group" } | null {
    const msgBody = this.parsePushContentToMsgBody(pushEvent.content);
    if (!msgBody) return null;

    let parsedContent: Record<string, unknown> = {};
    try {
      parsedContent = JSON.parse(pushEvent.content as string);
    } catch { /* not JSON */ }

    const chatType = parsedContent.group_code ? "group" : "c2c";
    return {
      msg: {
        callback_command: chatType === "group" ? "Group.CallbackAfterSendMsg" : "C2C.CallbackAfterSendMsg",
        from_account: parsedContent.from_account as string | undefined,
        group_code: parsedContent.group_code as string | undefined,
        msg_body: msgBody,
        msg_key: parsedContent.msg_key as string | undefined,
        msg_seq: parsedContent.msg_seq as number | undefined,
        msg_time: parsedContent.msg_time as number | undefined,
        trace_id: (parsedContent.log_ext as { trace_id?: string } | undefined)?.trace_id ?? (parsedContent.trace_id as string | undefined),
      },
      chatType,
    };
  }

  private parsePushContentToMsgBody(content: unknown): YuanbaoMsgBodyElement[] | undefined {
    if (typeof content === "string" && content.trim()) {
      try {
        const parsed = JSON.parse(content);
        if (parsed?.msg_body && Array.isArray(parsed.msg_body)) {
          return parsed.msg_body;
        }
        if (parsed?.text) {
          return [{ msg_type: "TIMTextElem", msg_content: { text: parsed.text } }];
        }
      } catch {
        // Plain text
      }
      return [{ msg_type: "TIMTextElem", msg_content: { text: content } }];
    }
    return undefined;
  }

  private inferChatType(msg: YuanbaoInboundMessage): "c2c" | "group" {
    if (msg.group_code) return "group";
    const cmd = msg.callback_command;
    if (cmd === "Group.CallbackAfterRecallMsg" || cmd === "Group.CallbackAfterSendMsg") return "group";
    return "c2c";
  }

  private hasValidMsgFields(msg: YuanbaoInboundMessage): boolean {
    return Boolean(msg.callback_command || msg.from_account || msg.msg_body);
  }
}

// ─── Re-exports for advanced usage ───

export { resolveAccount } from "./accounts.js";
export { toChatMessage, extractTextFromMsgBody, buildTextMsgBody, splitTextChunks } from "./business/messaging/extract.js";
export { YuanbaoWsClient } from "./access/ws/client.js";
export { getSignToken, forceRefreshSignToken, clearAllSignTokenCache } from "./access/http/request.js";
export { uploadMedia, uploadMediaToCos, downloadMedia, extractMediaInfo, downloadAllMedia, buildImageMsgBody, buildFileMsgBody } from "./access/http/media.js";
export type { UploadResult, DownloadResult, MediaInfo, MediaType } from "./access/http/media.js";
export { uploadToGoFile, uploadAndFormatLink } from "./access/http/gofile.js";
export type { GoFileUploadResult } from "./access/http/gofile.js";
export { CommandSystem } from "./commands/registry.js";
export type { CommandContext, CommandDefinition, CommandResult, CommandSystemConfig } from "./commands/types.js";
export { detectSticker, prepareStickerMsgBody, buildEmojiMsgBody, buildCustomStickerMsgBody, buildStickerImageMsgBody, buildStickerMsgBody, buildStickerMsgBodyFromParts, registerStickerPack, unregisterStickerPack, getSticker, getStickerPacks, searchStickers, loadStickerPacksFromDir, getBuiltinEmojis, getBuiltinStickersData, cacheReceivedSticker } from "./business/sticker.js";
export type { StickerInfo, StickerType, StickerPack } from "./business/sticker.js";
export { LlmTakeoverEngine, ConversationManager, markdownToImText, createLlmTakeover, ZaiProvider, OpenAIProvider, AnthropicProvider, DeepSeekProvider, CustomProvider, createProvider } from "./business/llm-takeover.js";
export type { LlmTakeoverConfig, TakeoverResult, LlmResponse, ConversationHistory, ConversationState, LlmProvider, LlmProviderType } from "./business/llm-takeover.js";
export { AliasStore, getGlobalAliasStore, resetGlobalAliasStore } from "./business/alias.js";
export type { AliasEntry, AliasStoreConfig } from "./business/alias.js";
export { ContactStore, getGlobalContactStore, resetGlobalContactStore } from "./business/contacts.js";
export type { ContactEntry, ContactStoreConfig } from "./business/contacts.js";
export { GroupStore, getGlobalGroupStore, resetGlobalGroupStore } from "./business/groups.js";
export type { GroupEntry, GroupStoreConfig } from "./business/groups.js";
export { parseMentions, buildMentionMsgBody, extractMentionsFromMsgBody, isUserMentioned, buildCloudCustomDataWithMentions, buildMentionMsgBodyElements, buildAtUserMsgBodyItem } from "./business/mention.js";
export type { MentionInfo as MentionInfoBusiness, ParsedMentions, GroupAtInfo, NicknameResolver, NicknameMatch } from "./business/mention.js";
export { MessageHistoryStore, getGlobalHistoryStore, resetGlobalHistoryStore, formatHistoryMessage, formatHistoryList } from "./business/history.js";
export type { HistoryFilter, HistoryPage, HistoryStats, HistoryStoreConfig, HistoryFormatOptions } from "./business/history.js";
export { BatchRunner, startBatch, cancelBatch, cleanupBatch, getActiveBatch, getActiveBatchIds, interpolateTemplate, buildBatchContext } from "./business/batch.js";
export type { BatchConfig, BatchMessageType, BatchProgress, BatchResult } from "./business/batch.js";
export { interpolate, buildMessageContext, hasInterpolation, chatContextFromMessage, buildBatchContext as buildInterpolationBatchContext } from "./business/interpolate.js";
export type { ChatContext } from "./business/interpolate.js";
export { MultiAccountManager } from "./business/multi-account.js";
export type { AccountEntry, MultiAccountConfig, MultiAccountEvent } from "./business/multi-account.js";
export { SearchEngine } from "./business/search.js";
export type { GroupSearchResult, MemberSearchResult, SearchConfig } from "./business/search.js";
export { InteractiveCli, runCli } from "./cli-legacy/index.js";
export { createLog, setLogLevel } from "./logger.js";
export { getVersion, getVersionString } from "./version.js";
export type * from "./types.js";
