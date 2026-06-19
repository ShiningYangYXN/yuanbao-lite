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
  /**
   * Set of "public" bot user IDs that the IM platform assigns to this bot for
   * group membership. Tencent Yuanbao uses TWO different IDs for the same bot:
   *   - account.botId (from sign-token) — used for sending messages
   *   - "public" bot IDs (visible to group members) — what users @mention
   * We auto-learn public IDs from inbound @bot_* mentions and treat them all
   * as "self" for the purpose of mention detection and skip-self guard.
   */
  private botPublicIds: Set<string> = new Set();

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

    // Initialize LLM engine — always create so /llm commands work.
    // When no llmConfig is provided, use defaults (engine exists but isReady=false
    // until a provider is configured). When llmConfig IS provided, respect it fully.
    // llmAutoReply defaults to true — bot responds when @mentioned in groups or DM'd.
    // The LLM engine's requireMentionInGroup (default true) ensures it only replies
    // to @mentions in groups, preventing spam.
    this.llmAutoReply = config.llmAutoReply ?? true;
    this.llmEngine = createLlmTakeover({
      ...(config.llmConfig ?? {}),
      persistencePath: join(homedir(), ".yuanbao-lite", "llm-config.json"),
    });
    // Diagnostic: log LLM engine state at startup so users can see why auto-reply
    // may not be working (no provider configured, disabled, etc.)
    const _llmCfg = this.llmEngine.getConfig();
    const _providerNames = Object.keys(_llmCfg.customProviders ?? {});
    this.log.info(`LLM engine: enabled=${_llmCfg.enabled} autoReply=${this.llmAutoReply} isReady=${this.llmEngine.isReady} activeProvider="${_llmCfg.provider}" providers=[${_providerNames.join(",")}] persistencePath=${join(homedir(), ".yuanbao-lite", "llm-config.json")}`);
    if (this.llmEngine.isReady) {
      const _ap = _llmCfg.customProviders?.[_llmCfg.provider];
      this.log.info(`LLM active provider: ${_llmCfg.provider} format=${_ap?.apiFormat} model=${_ap?.model} baseUrl=${_ap?.baseUrl} keys=${(_ap?.apiKeys?.length ?? 0) || (_ap?.apiKey ? 1 : 0)}`);
    } else {
      this.log.warn(`LLM not ready — configure a provider via /llm customprovider add <name> openai-chat-completions <model> <baseUrl> <apiKey>, then /llm provider <name>`);
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
        onDispatch: (pushEvent: WsPushEvent) => void this.handleDispatch(pushEvent),
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
    //
    // Safety: in group chats (non-unsafe mode), sanitize interpolation to block
    // dangerous globals (process, env, require, fetch, etc.). This prevents
    // group members from extracting server info via ${process.env.HOME} etc.
    // The bot owner can bypass this by enabling /unsafe mode (5 min window).
    const isUnsafe = this.commandSystem?.isUnsafeMode() ?? false;
    const shouldSanitize = isGroup && !isUnsafe;
    const interpolatedText = skipInterpolation
      ? text
      : interpolate(
          text,
          buildMessageContext(
            contextMsg ? chatContextFromMessage(contextMsg, this.account.botId) : undefined,
          ),
          { sanitize: shouldSanitize },
        );

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

    // Build all-members resolver for @[所有人]() / @[](all) @all syntax
    const allMembersResolver = (isGroup && to)
      ? async () => {
          try {
            const resp = await this.getGroupMemberList(String(to));
            const members = resp?.member_list ?? [];
            return members.map(m => ({ userId: m.user_id, nickname: m.nick_name }));
          } catch {
            return [];
          }
        }
      : undefined;

    // Build userId resolver for @[](id) auto-nickname fetch
    // When @[](id) is used without a nickname, this fetches the member's
    // display name from the group member list.
    const userIdResolver = (isGroup && to)
      ? async (userId: string): Promise<string | null> => {
          try {
            const resp = await this.getGroupMemberList(String(to));
            const members = resp?.member_list ?? [];
            const member = members.find(m => m.user_id === userId);
            return member?.nick_name ?? null;
          } catch {
            return null;
          }
        }
      : undefined;

    // Use buildMentionMsgBody which interleaves TIMCustomElem at correct positions
    // (matching the original project's resolveAtMentions approach)
    const { msgBody: mentionMsgBody, cloudCustomData, mentions: parsedMentions, atAll: _atAll } =
      await buildMentionMsgBody(interpolatedText, this.aliasStore, nicknameResolver, allMembersResolver, userIdResolver);
    // _atAll flag is already encoded in cloudCustomData via buildCloudCustomDataWithMentions
    void _atAll;

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
   * Check if a userId refers to THIS bot (either the internal account.botId
   * from sign-token, or any auto-learned public bot ID visible to group
   * members).
   */
  isSelfUserId(userId: string | undefined | null): boolean {
    if (!userId) return false;
    const uid = String(userId);
    if (this.account.botId && uid === String(this.account.botId)) return true;
    return this.botPublicIds.has(uid);
  }

  /**
   * Check if an inbound message is a CallbackAfterSendMsg (bot's own
   * outgoing message callback). Used to identify and skip other bot
   * instances' messages in group chats.
   */
  private isCallbackAfterSendMsg(msg: YuanbaoInboundMessage): boolean {
    const callbackCmd = msg.callback_command || "";
    return callbackCmd.includes("CallbackAfterSendMsg");
  }

  /**
   * Get the set of all known "self" user IDs (internal botId + auto-learned
   * public IDs). Useful for logging and diagnostics.
   */
  getSelfUserIds(): string[] {
    const ids = new Set<string>();
    if (this.account.botId) ids.add(String(this.account.botId));
    for (const id of this.botPublicIds) ids.add(id);
    return Array.from(ids);
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
    // Also caches the platform-provided bot ID from the QueryBotInfo response.
    // This is the "public" bot ID that users see and @mention in groups —
    // it may differ from account.botId (the sign-token ID used for sending).
    if (this.account.botId && this.client) {
      this.client.queryBotInfo(this.account.botId).then(async (rsp) => {
        if (rsp.code === 0) {
          // Cache the platform-provided bot ID for @mention detection.
          // The QueryBotInfoRsp.botInfo.botId is the authoritative public ID
          // that group members see when they @mention the bot. Using it
          // directly (instead of auto-learning from mentions) is more
          // reliable and avoids false positives.
          if (rsp.botId && rsp.botId !== this.account.botId) {
            this.botPublicIds.add(rsp.botId);
            this.log.info(`platform-provided public bot ID: ${rsp.botId} (sign-token botId=${this.account.botId})`);
          } else if (rsp.botId) {
            // Same as sign-token ID — still add to the set for uniform checking
            this.botPublicIds.add(rsp.botId);
            this.log.info(`platform-provided bot ID matches sign-token ID: ${rsp.botId}`);
          }
          if (rsp.ownerId) {
            this.account.botOwnerId = rsp.ownerId;
            this.log.info(`bot owner cached: ownerId=${rsp.ownerId}`);
            // Auto-trust the master (bot owner) — they can always use /unsafe
            try {
              const { setMasterUserId } = await import("./business/trust.js");
              setMasterUserId(rsp.ownerId);
            } catch {
              // trust module optional
            }
          }
        }
      }).catch((err) => {
        this.log.warn(`failed to query bot owner: ${(err as Error).message}`);
      });
    }

    this.emit("ready", { connectId: data.connectId });
  }

  private async handleDispatch(pushEvent: WsPushEvent): Promise<void> {
    this.log.debug(`dispatch: cmd=${pushEvent.cmd}, type=${pushEvent.type}`);

    const converted = this.pushEventToInboundMessage(pushEvent);
    if (!converted) {
      this.log.debug("non-message event, skipping");
      return;
    }

    const { msg, chatType } = converted;
    const chatMessage = toChatMessage(msg);

    // ─── Skip-self guard (for dispatch) + history storage for bot's own messages ───
    // Prevents infinite echo when the bot's own outgoing messages arrive
    // via Group.CallbackAfterSendMsg / C2C.CallbackAfterSendMsg callbacks.
    // We store the bot's message in history (so /inspect can find it),
    // but we DON'T inject it into LLM context here — that's handled by
    // ctx.reply() in the command system, which injects ASSISTANT context
    // at the moment of sending. This avoids double-injection.
    //
    // IMPORTANT: Tencent uses DIFFERENT bot IDs for the same bot across
    // different contexts (sign-token ID vs group member ID vs callback ID).
    // We only trust IDs from sign-token and QueryBotInfo (stored in
    // botPublicIds). We do NOT auto-learn from callbacks — other bot
    // instances in the same group could send callbacks that reach us.
    // For CallbackAfterSendMsg, we check if the callback is for OUR bot
    // by verifying from_account matches a known self ID.
    if (this.isSelfUserId(chatMessage.fromUserId)) {
      this.log.debug(`self-message detected (fromUserId=${chatMessage.fromUserId}), storing in history but skipping dispatch`);

      // Store in history (so /inspect can find bot's own messages)
      this.historyStore.add(chatMessage);

      // Track group activity for group name resolution
      if (chatMessage.chatType === "group" && chatMessage.groupCode) {
        this.groupStore.trackActivity(chatMessage.groupCode, chatMessage.groupName);
      }

      // Skip command dispatch + LLM auto-reply + context injection
      // (context injection is handled by ctx.reply() in the command system)
      return;
    }

    // For CallbackAfterSendMsg callbacks where from_account is a bot_ ID
    // that we DON'T recognize: this is ANOTHER bot instance in the group.
    // Treat it like any other user message — store in history, inject into
    // LLM context, dispatch commands, and allow LLM auto-reply. The bot's
    // messages are visible to our LLM and can trigger responses.
    if (chatMessage.fromUserId.startsWith("bot_") && this.isCallbackAfterSendMsg(msg)) {
      this.log.debug(`other bot's message detected (fromUserId=${chatMessage.fromUserId}), processing as normal inbound message`);
      // Fall through to normal processing — do NOT return here.
      // The message will be stored in history, context-injected, and
      // dispatched (commands + LLM auto-reply) like any user message.
    }

    // ─── /switch context override ───
    // If the user has an active /switch session, override the chatMessage's
    // chatType/groupCode/fromUserId so subsequent dispatch (commands + LLM)
    // runs in the switched context. The original sender is preserved in
    // a private field for logging. /switch exit (handled by the command)
    // pops the stack and restores the previous context.
    if (this.commandSystem) {
      const cs = this.commandSystem as unknown as {
        _switchSessions?: Map<string, Array<{ chatType: "group" | "direct"; target: string; label: string }>>;
      };
      const stack = cs._switchSessions?.get(chatMessage.fromUserId);
      if (stack && stack.length > 0) {
        const current = stack[stack.length - 1];
        // Override the chatMessage fields to the switched context
        // Preserve original fromUserId so replies go back to the user
        const originalFromUserId = chatMessage.fromUserId;
        if (current.chatType === "group") {
          (chatMessage as { chatType: "group" | "direct" }).chatType = "group";
          (chatMessage as { groupCode?: string }).groupCode = current.target;
          // isMentioned is forced true so commands work in the switched group context
          (chatMessage as { isMentioned?: boolean }).isMentioned = true;
        } else {
          (chatMessage as { chatType: "group" | "direct" }).chatType = "direct";
          (chatMessage as { groupCode?: string }).groupCode = undefined;
        }
        this.log.debug(`switch context active: user ${originalFromUserId} → ${current.label}`);
      }
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

    // Fix isMentioned: verify against the bot's own IDs.
    // The bot's "public" ID (what group members see and @mention) is obtained
    // directly from the platform's QueryBotInfo API at connection time, and
    // cached in botPublicIds. We do NOT auto-learn from mentions — other bot
    // instances in the group could be @mentioned and we'd incorrectly identify
    // them as ourselves.
    if (chatMessage.chatType === "group") {
      // Debug: log raw message structure for mention analysis
      this.log.debug(`mention check: account.botId=${this.account.botId ?? "(none)"} botPublicIds=[${Array.from(this.botPublicIds).join(",")}] mentions=${JSON.stringify(chatMessage.mentions?.map(m => ({userId: m.userId, name: m.displayName})))} cloud_custom_data=${msg.cloud_custom_data?.substring(0, 200)}`);
      this.log.debug(`mention check: from_account=${msg.from_account} to_account=${msg.to_account} group_code=${msg.group_code} bot_owner_id=${msg.bot_owner_id} msg_body types=${msg.msg_body?.map(e => e.msg_type).join(",")} raw text="${chatMessage.text?.substring(0, 100)}"`);

      // Check if any mention matches our internal botId OR any platform-provided public ID
      const mentioned = chatMessage.mentions?.some(m => this.isSelfUserId(String(m.userId)));
      if (mentioned) {
        chatMessage.isMentioned = true;
        this.log.debug(`isMentioned=true: a self-ID was found in mentions`);
      } else {
        // Fallback: check cloud_custom_data groupAtInfo directly from raw message
        let foundInCloudData = false;
        try {
          const rawCloudData = msg.cloud_custom_data;
          if (rawCloudData) {
            const customData = JSON.parse(rawCloudData) as Record<string, unknown>;
            const groupAtInfo = customData.groupAtInfo;
            if (groupAtInfo && typeof groupAtInfo === "object") {
              const gai = groupAtInfo as Record<string, unknown>;
              const userIds = gai.groupAtUserIds;
              if (Array.isArray(userIds) && userIds.some(uid => this.isSelfUserId(String(uid)))) {
                foundInCloudData = true;
              }
            }
          }
        } catch {
          // Ignore JSON parse errors
        }

        if (foundInCloudData) {
          chatMessage.isMentioned = true;
          this.log.debug(`isMentioned=true: a self-ID was found in cloud_custom_data groupAtInfo`);
        } else {
          // Bot is NOT specifically mentioned — override any false positive from isBotMentioned()
          // which checks if ANY mention exists, not specifically the bot
          chatMessage.isMentioned = false;
          this.log.debug(`isMentioned=false: no self-ID found in mentions (raw mention userIds: ${JSON.stringify(chatMessage.mentions?.map(m => m.userId))})`);
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
    void this.feedLlmContext(chatMessage);

    // ─── Step 1.5: Check for active wizard sessions (/init or /llm config) ───
    // If the user has an active wizard session, intercept non-slash messages
    // as wizard input (blocking normal dispatch + LLM).
    if (this.commandSystem && !chatMessage.text.trim().startsWith("/")) {
      const cs = this.commandSystem as unknown as {
        _initWizardSessions?: Map<string, unknown>;
        _handleInitWizardInput?: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean>;
        _llmWizardSessions?: Map<string, unknown>;
        _handleLlmWizardInput?: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean>;
      };
      const userId = chatMessage.fromUserId;

      const replyFn = async (text: string): Promise<void> => {
        try {
          if (chatMessage.chatType === "group" && chatMessage.groupCode) {
            await this.sendGroupMessage(chatMessage.groupCode, text);
          } else {
            await this.sendDirectMessage(chatMessage.fromUserId, text);
          }
        } catch (err) {
          this.log.error(`wizard reply failed: ${(err as Error).message}`);
        }
      };

      // Check /init wizard
      if (cs._initWizardSessions?.has(userId) && cs._handleInitWizardInput) {
        void cs._handleInitWizardInput(this, userId, chatMessage.text, replyFn);
        return;
      }

      // Check /llm config wizard
      if (cs._llmWizardSessions?.has(userId) && cs._handleLlmWizardInput) {
        void cs._handleLlmWizardInput(this, userId, chatMessage.text, replyFn);
        return;
      }

      // Check /term interactive terminal session
      const cs2 = this.commandSystem as unknown as {
        _termSessions?: Map<string, unknown>;
        _handleTermInput?: (bot: unknown, userId: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean>;
      };
      if (cs2._termSessions?.has(userId) && cs2._handleTermInput) {
        // Allow /term exit to pass through to command dispatch
        const text = chatMessage.text.trim();
        if (text === "/term exit" || text === "/term") {
          // Let the command system handle it
        } else {
          void cs2._handleTermInput(this, userId, chatMessage.text, replyFn);
          return;
        }
      }
    }

    // ─── Step 2: Try command dispatch ───
    // Dispatch rules (apply to each line of an incoming message):
    //   1. 未续行 (standalone line, not preceded by \) → independent content,
    //      recognize slash independently (line starting with / is a slash command).
    //   2. 续行 (continuation line, preceded by \) → extension of previous input,
    //      but the joined text preserves \n so each line is dispatched independently
    //      (续行本来就要拆行 — the \ just lets the user span multiple terminal lines).
    //   3. 不符合任何一条规则 (standalone plain text — no slash, not continuation):
    //      - 私聊 (DM / chatType=direct): MUST auto-reply via LLM (user expects
    //        a response to every DM). Use /llm off to disable if needed.
    //      - 群聊 (group): try LLM auto-reply (engine requires @mention by default
    //        to prevent spam — plain text without @ is silently ignored).
    //      - CLI: send directly as chat (handled by cli/client/interactive.ts).
    let dispatchText = chatMessage.text.trim();
    if (chatMessage.chatType === "group") {
      // Strip ALL leading @-components, [custom:...] placeholders, and whitespace
      // before recognizing slash commands. Handles every @-shape the IM client
      // may produce:
      //   - @nickname      (bare @mention typed as plain text, e.g. "@bot")
      //   - @<botId>       (bare ID, e.g. "@bot_c7541b49d8544e4ebe6de4cb5e418085")
      //   - @[nick](id)    (full mention syntax with brackets and parens)
      //   - @[](id)        (mention syntax with empty nickname)
      //   - @[nick]()      (mention syntax with empty id)
      //   - @[所有人]()    (@all syntax)
      // Also handles multiple leading @mentions separated by whitespace, and
      // any leading whitespace (including full-width spaces \u3000).
      // Defensive: also strip leading [custom:...] / [link card] / [forwarded
      // records] placeholders in case the TIMCustomElem parser missed a
      // mention element (so text "[custom:unknown]/status" still becomes "/status").
      const leadingJunkRe = /^(?:@(?:\[[^\]]*\]\([^)]*\)|\S+)|\[custom:[^\]]*\]|\[link card\]|\[forwarded records\])[\s\u3000]*/;
      let prev = "";
      let stripCount = 0;
      while (dispatchText !== prev && leadingJunkRe.test(dispatchText)) {
        prev = dispatchText;
        dispatchText = dispatchText.replace(leadingJunkRe, "");
        stripCount++;
        if (stripCount > 20) break; // safety guard against pathological input
      }
      // Final trim (handles full-width spaces too)
      dispatchText = dispatchText.replace(/^[\s\u3000]+/, "");
      if (stripCount > 0) {
        this.log.debug(`stripped ${stripCount} leading @-component(s) from group message; dispatchText="${dispatchText.substring(0, 100)}"`);
      }
    }

    // Parse multi-line commands with \ continuation support
    // Per dispatch rule 2 (续行本来就要拆行): do NOT join \-continuations into
    // single lines. Each \n-separated line is dispatched independently.
    // (Bot-side IM messages rarely use \-continuation, but if a user pastes
    // multi-line content, each line should be processed on its own.)
    const lines = dispatchText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    // Find lines that start with / (standalone slash commands)
    const commandLines = lines.filter(l => l.startsWith("/"));
    const isSlashCommand = commandLines.length > 0;

    this.log.debug(`dispatch check: rawText="${chatMessage.text.substring(0, 100)}" dispatchText="${dispatchText.substring(0, 100)}" lines=${lines.length} cmdLines=${commandLines.length} chatType=${chatMessage.chatType} isMentioned=${chatMessage.isMentioned}`);

    if (isSlashCommand && this.commandSystem) {
      // Execute each slash command line sequentially.
      // Any plain text lines in the same multi-line message are silently skipped
      // (per dispatch rule 3 — DM would skip them anyway, group only auto-replies
      // on @mention so multi-line plain text is also skipped here).
      const executeCommands = async () => {
        for (const cmdLine of commandLines) {
          const dispatchMsg = { ...chatMessage, text: cmdLine };
          try {
            const result = await this.commandSystem!.dispatch(this, dispatchMsg);
            if (result.handled) {
              this.log.debug(`command handled: ${cmdLine.substring(0, 80)}`);
            } else {
              // Not a recognized slash command — skip silently
              this.log.debug(`skipped unrecognized line: ${cmdLine.substring(0, 80)}`);
            }
          } catch (err) {
            this.log.error(`command dispatch error for "${cmdLine.substring(0, 80)}": ${(err as Error).message}`);
          }
        }
        // Trigger data persistence after all commands
        this.persistData();
      };
      executeCommands().catch((err) => {
        this.log.error(`multi-command execution error: ${(err as Error).message}`);
      });
      return; // Don't fall through to LLM for slash commands
    }

    // No slash commands — pure plain text message.
    // Per dispatch rule 3:
    //   - DM (direct): auto-reply via LLM (user expects a response to every DM).
    //   - Group: try LLM auto-reply (engine requires @mention by default).
    // Both paths call tryLlmAutoReply which checks llmAutoReply flag + engine readiness.
    this.emitMessageEvents(chatMessage, chatType);
    this.tryLlmAutoReply(chatMessage);
  }

  /**
   * Feed a message into LLM conversation context (without triggering API call).
   *
   * ALL messages (including slash commands) are stored so the LLM always
   * has full conversation awareness. The API call is only triggered when
   * the user @mentions the bot in a group or sends a DM.
   *
   * Format (shared with formatMessageForLlm in llm-takeover.ts):
   *   [HH:MM:SS] [昵称](用户ID)@群名或DM: 文本 [引用: #消息ID尾号]
   *
   * - Timestamp gives the LLM temporal awareness
   * - [昵称](用户ID) lets the LLM @mention the user via @[昵称](id) syntax
   * - Quote suffix shows when the user is replying to a specific message
   */
  private async feedLlmContext(chatMessage: ChatMessage): Promise<void> {
    if (!this.llmEngine) return;
    const text = chatMessage.text?.trim();
    if (!text) return;
    // Use the shared formatter so feedLlmContext and the engine's fallback
    // produce identical output. The formatted text includes timestamp,
    // sender nickname+ID, scope (group/DM), and quote suffix.
    const { formatChatMessageForContext } = await import("./business/llm-takeover.js");
    const formatted = formatChatMessageForContext(chatMessage);
    this.llmEngine.addContextMessage(chatMessage, formatted);
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

    // Check if the user is blocked from LLM auto-reply (block > trust > unsafe)
    try {
      const { isBlockedFromLlm, isBlockedFrom } = await import("./business/block.js");
      if (isBlockedFromLlm(chatMessage.fromUserId) || isBlockedFrom(chatMessage.fromUserId, "all")) {
        this.log.info(`tryLlmAutoReply: user ${chatMessage.fromUserId} is blocked from LLM, skipping`);
        return;
      }
      // Also check wildcard "*" blocks
      if (isBlockedFromLlm("*") || isBlockedFrom("*", "all")) {
        this.log.info(`tryLlmAutoReply: global LLM block active, skipping`);
        return;
      }
    } catch {
      // block module optional
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
export { LlmTakeoverEngine, ConversationManager, markdownToImText, createLlmTakeover, API_FORMATS } from "./business/llm-takeover.js";
export type { LlmTakeoverConfig, TakeoverResult, LlmResponse, ConversationHistory, ConversationState, ApiFormat, ProviderConfig } from "./business/llm-takeover.js";
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
export { createLog, setLogLevel } from "./logger.js";
export { getVersion, getVersionString } from "./version.js";
export type * from "./types.js";
