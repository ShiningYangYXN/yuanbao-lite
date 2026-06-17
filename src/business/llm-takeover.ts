/**
 * LLM Takeover Module — AI-powered automatic message response.
 *
 * Supports multiple LLM providers (z-ai, openai, anthropic, deepseek, custom)
 * and uses the mature `marked` library for markdown parsing/processing.
 * Provides conversation history management per user/group,
 * configurable system prompts, and rich response formatting.
 *
 * Key design decisions:
 * - Uses `marked` (mature markdown parser) instead of hand-rolled parsing
 * - Multi-provider architecture with LlmProvider interface
 * - ZAI (z-ai-web-dev-sdk) remains the default for backward compatibility
 * - Maintains per-conversation history with configurable limits
 * - Supports both direct message and group message contexts
 * - Auto-splits long responses respecting Yuanbao character limits
 * - Supports markdownRawMode for platforms with native markdown rendering
 */

import ZAI from "z-ai-web-dev-sdk";
import { marked } from "marked";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { ChatMessage } from "../types.js";
import type { YuanbaoBot } from "../index.js";
import { splitTextChunks } from "./messaging/extract.js";

// ─── Provider Types ───

/** LLM provider type identifiers */
export type LlmProviderType = "z-ai" | "openai" | "anthropic" | "deepseek" | "custom" | (string & {});

/** LLM provider interface — all providers must implement this */
export interface LlmProvider {
  /** Provider name identifier */
  readonly name: LlmProviderType;
  /**
   * Send a chat completion request.
   * @param messages - Array of chat messages
   * @param options - Generation options
   * @returns Response with content and optional token usage
   */
  chat(messages: Array<{ role: string; content: string }>, options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{ content: string; tokensUsed?: number }>;
}

// ─── Provider Implementations ───

/**
 * ZAI provider — wraps z-ai-web-dev-sdk (the original default).
 */
export class ZaiProvider implements LlmProvider {
  readonly name: LlmProviderType = "z-ai";
  private zai: ZAI | null = null;
  private initPromise: Promise<void> | null = null;
  private log: ModuleLog;

  constructor() {
    this.log = createLog("llm-provider:z-ai");
  }

  private async ensureInit(): Promise<ZAI> {
    if (this.zai) return this.zai;
    if (this.initPromise) {
      await this.initPromise;
      if (this.zai) return this.zai;
      throw new Error("ZAI SDK initialization failed");
    }

    this.initPromise = (async () => {
      try {
        this.zai = await ZAI.create();
        this.log.info("ZAI SDK initialized successfully");
      } catch (err) {
        this.log.error(`ZAI SDK init failed: ${(err as Error).message}`);
        this.zai = null;
      }
    })();

    await this.initPromise;
    if (!this.zai) throw new Error("ZAI SDK not initialized");
    return this.zai;
  }

  async chat(messages: Array<{ role: string; content: string }>, options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{ content: string; tokensUsed?: number }> {
    const zai = await this.ensureInit();
    const completion = await zai.chat.completions.create({
      messages: messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      ...(options.model ? { model: options.model } : {}),
    });

    const content = completion.choices?.[0]?.message?.content || "";
    const tokensUsed = completion.usage?.total_tokens;

    return { content, tokensUsed };
  }
}

/**
 * OpenAI-compatible provider — works with OpenAI, Azure OpenAI, and any compatible endpoint.
 */
export class OpenAIProvider implements LlmProvider {
  readonly name: LlmProviderType = "openai";
  protected baseUrl: string;
  protected apiKey: string;
  protected apiVersion?: string;
  protected defaultModel: string;
  protected log: ModuleLog;

  constructor(config: { apiKey: string; baseUrl?: string; apiVersion?: string; defaultModel?: string }) {
    this.baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.apiVersion = config.apiVersion;
    this.defaultModel = config.defaultModel || "gpt-4o";
    this.log = createLog("llm-provider:openai");
  }

  async chat(messages: Array<{ role: string; content: string }>, options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{ content: string; tokensUsed?: number }> {
    const model = options.model || this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
    if (this.apiVersion) {
      headers["api-version"] = this.apiVersion;
    }

    const body = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content || "";
    const tokensUsed = data.usage?.total_tokens;

    return { content, tokensUsed };
  }
}

/**
 * Anthropic Claude provider — uses the Anthropic Messages API.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name: LlmProviderType = "anthropic";
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private log: ModuleLog;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel || "claude-sonnet-4-20250514";
    this.log = createLog("llm-provider:anthropic");
  }

  async chat(messages: Array<{ role: string; content: string }>, options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{ content: string; tokensUsed?: number }> {
    const model = options.model || this.defaultModel;
    const url = `${this.baseUrl}/v1/messages`;

    // Anthropic requires system message separate from messages array
    let systemPrompt = "";
    const chatMessages: Array<{ role: string; content: string }> = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n" : "") + msg.content;
      } else {
        chatMessages.push(msg);
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages: chatMessages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 2048,
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // Extract text from Anthropic response format
    const content = data.content
      ?.filter(block => block.type === "text")
      .map(block => block.text || "")
      .join("") || "";
    const tokensUsed = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);

    return { content, tokensUsed };
  }
}

/**
 * DeepSeek provider — OpenAI-compatible API with DeepSeek's endpoint.
 */
export class DeepSeekProvider extends OpenAIProvider {
  readonly name: LlmProviderType = "deepseek";

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || "https://api.deepseek.com/v1",
      defaultModel: config.defaultModel || "deepseek-chat",
    });
    this.log = createLog("llm-provider:deepseek");
  }
}

/**
 * Custom provider — any OpenAI-compatible endpoint (Ollama, vLLM, etc.).
 * Requires baseUrl to be specified.
 */
export class CustomProvider extends OpenAIProvider {
  readonly name: LlmProviderType = "custom";

  constructor(config: { apiKey: string; baseUrl: string; defaultModel?: string }) {
    super({
      apiKey: config.apiKey || "no-key",
      baseUrl: config.baseUrl, // baseUrl is required for custom
      defaultModel: config.defaultModel || "default",
    });
    this.log = createLog("llm-provider:custom");
  }
}

// ─── Provider Factory ───

/**
 * Create a provider instance from config.
 */
export function createProvider(config: LlmTakeoverConfig): LlmProvider {
  const provider = config.provider || "z-ai";

  switch (provider) {
    case "z-ai":
      return new ZaiProvider();
    case "openai":
      if (!config.apiKey) throw new Error("apiKey is required for OpenAI provider");
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        apiVersion: config.apiVersion,
      });
    case "anthropic":
      if (!config.apiKey) throw new Error("apiKey is required for Anthropic provider");
      return new AnthropicProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
    case "deepseek":
      if (!config.apiKey) throw new Error("apiKey is required for DeepSeek provider");
      return new DeepSeekProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      });
    case "custom":
      if (!config.baseUrl) throw new Error("baseUrl is required for custom provider");
      return new CustomProvider({
        apiKey: config.apiKey || "",
        baseUrl: config.baseUrl,
      });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ─── Config Types ───

export type LlmTakeoverConfig = {
  /** Whether LLM takeover is enabled (default: true) */
  enabled?: boolean;
  /** System prompt for the LLM */
  systemPrompt?: string;
  /** Model name (default: system default) */
  model?: string;
  /** Temperature for generation (0-2, default: 0.7) */
  temperature?: number;
  /** Maximum tokens in response (default: 2048) */
  maxTokens?: number;
  /** Maximum conversation history turns per conversation (default: 20) */
  maxHistoryTurns?: number;
  /** Whether to respond in group chats (default: true) */
  enableInGroup?: boolean;
  /** Whether to respond in direct messages (default: true) */
  enableInDirect?: boolean;
  /** Whether the bot must be @mentioned in groups to respond (default: false) */
  requireMentionInGroup?: boolean;
  /** Cooldown between responses in ms (default: 1000) */
  cooldownMs?: number;
  /** Time window to merge consecutive group messages in ms (default: 3000).
   *  When multiple messages arrive in a group within this window, they are
   *  combined into a single LLM call for better context understanding. */
  mergeWindowMs?: number;
  /** Custom response prefix (e.g. "🤖 ") */
  responsePrefix?: string;
  /** Custom filter function — return false to skip LLM response */
  shouldRespond?: (msg: ChatMessage) => boolean | Promise<boolean>;
  /** Custom post-processing for LLM output before sending */
  postProcess?: (text: string, msg: ChatMessage) => string | Promise<string>;
  /** LLM provider type (default: "z-ai") */
  provider?: LlmProviderType;
  /** API key for the provider (required for openai/anthropic/deepseek/custom) */
  apiKey?: string;
  /** Base URL override (for custom endpoints, Azure, etc.) */
  baseUrl?: string;
  /** API version (for Azure OpenAI) */
  apiVersion?: string;
  /** Whether to send raw markdown instead of IM-formatted text (default: true) */
  markdownRawMode?: boolean;
  /** Maximum invoke iteration rounds (default: 50, 0 = unlimited) */
  maxIterate?: number;

  // ─── Model pool & key pool (new) ───

  /** Pool of API keys for the active provider. On error (401/429), the engine
   *  automatically rotates to the next key. */
  apiKeys?: string[];
  /** Pool of fallback providers. If the active provider fails after all keys
   *  are exhausted, the engine switches to the next provider in the pool. */
  providerPool?: Array<{
    provider: LlmProviderType;
    model?: string;
    apiKey?: string;
    apiKeys?: string[];
    baseUrl?: string;
    apiVersion?: string;
  }>;
  /** Whether to auto-rotate keys on 401/429 errors (default: true) */
  autoRotateKeys?: boolean;
  /** Whether to auto-switch providers on repeated failures (default: true) */
  autoSwitchProvider?: boolean;
  /** Cooldown for a failed key before retrying it (ms, default: 5 min) */
  keyCooldownMs?: number;
  /** Max consecutive failures before switching provider (default: 3) */
  maxFailuresBeforeSwitch?: number;

  // ─── Custom provider registry ───

  /** Custom provider definitions. Each custom provider has a name and its own
   *  key pool. The provider type determines the underlying SDK (openai/anthropic/etc.),
   *  while the name is a user-friendly label for management.
   *
   *  Example:
   *    customProviders: {
   *      "my-azure": { type: "openai", baseUrl: "https://xxx.openai.azure.com", apiKeys: ["sk-1","sk-2"] },
   *      "backup-claude": { type: "anthropic", apiKeys: ["sk-3"] },
   *    }
   */
  customProviders?: Record<string, {
    /** Underlying provider type (openai/anthropic/deepseek/custom) */
    type: "openai" | "anthropic" | "deepseek" | "custom" | "z-ai";
    /** Default model for this provider */
    model?: string;
    /** Single API key (use apiKeys for a pool) */
    apiKey?: string;
    /** Key pool for this provider */
    apiKeys?: string[];
    /** Base URL override */
    baseUrl?: string;
    /** API version (Azure) */
    apiVersion?: string;
  }>;
};

export type ConversationHistory = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ConversationState = {
  history: ConversationHistory[];
  lastResponseAt: number;
  messageCount: number;
};

export type LlmResponse = {
  /** The raw LLM output text */
  rawText: string;
  /** The processed text ready for sending (after markdown stripping/formatting) */
  processedText: string;
  /** Whether the response was sent successfully */
  sent: boolean;
  /** Number of chunks the response was split into */
  chunkCount: number;
  /** Tokens used (if available) */
  tokensUsed?: number;
  /** Whether raw markdown mode was used */
  markdownRawMode: boolean;
};

export type TakeoverResult = {
  /** Whether the LLM handled this message */
  handled: boolean;
  /** The LLM response details, if handled */
  response?: LlmResponse;
  /** Error if the LLM call failed */
  error?: Error;
};

// ─── Defaults ───

const DEFAULT_SYSTEM_PROMPT = `你是元宝Lite智能助手，一个友好、专业的AI聊天机器人。请用简洁、自然的方式回复用户的消息。
- 在群聊中，保持回复简洁，避免过长的消息
- 对于复杂问题，给出结构化的回答
- 如果不确定答案，诚实地说明
- 支持使用markdown格式，但保持简单易读

== 命令执行 ==

你可以执行系统命令来帮助用户。当需要执行命令时，在回复中单独一行使用以下格式：
  <<command>>/命令名 参数<<command>>
  例如：<<command>>/ping<<command>>
  例如：<<command>>/sticker 狗头<<command>>
  例如：<<command>>/members 707881071<<command>>
你可以同时执行多个命令，每个命令一行。命令执行结果会附加在你的回复之后。
在群聊中，dmOnly命令不可用。

== 迭代调用（重要） ==

如果你需要查看命令的执行结果并基于结果继续回复，在命令标签末尾加上...：
  <<command>>/命令名 参数<<command>>...
这样命令执行后，结果会被反馈给你，你可以基于结果继续思考和回复。
你可以在后续回复中继续使用 <<command>>...<<command>> 来链式执行更多命令。
这个机制支持无限循环——每轮执行后结果会立即反馈，你可以在下一轮继续执行命令。

**重要：以下场景应主动使用迭代调用（加...）：**
1. 查询信息后再做判断：先查后答（如查群成员、查历史记录）
2. 多步骤任务：先执行步骤1，看结果再执行步骤2（如先搜索再操作）
3. 需要验证的操作：执行后确认结果（如发送文件后确认是否成功）
4. 探索性任务：逐步尝试，根据结果调整策略
5. 条件性操作：先获取条件信息，再决定是否执行

示例：用户问"群里有多少人"→ 先用 <<command>>/groupinfo 群号<<command>>... 查询，再基于结果回答
示例：用户说"帮我发个表情"→ 先用 <<command>>/stickers 关键词<<command>>... 搜索可用表情，再选择发送
示例：用户问"刚才谁说了什么"→ 先用 <<command>>/hsearch 关键词<<command>>... 搜索，再总结结果

== @提及语法 ==

你可以在回复中使用@提及语法来@群成员。格式为 @[昵称](用户ID) ，其中方括号[]和圆括号()均不可省略，但内容可以为空：
  @[昵称](用户ID) — 用指定昵称@指定用户
  @[](用户ID) — 用平台默认昵称@指定用户
  @[昵称]() — 在群聊中按昵称自动匹配用户ID，多个匹配则全部@
  例如：@[小明](12345) 表示用"小明"这个名字@用户12345
  例如：@[张三]() 表示在群聊中自动查找昵称为"张三"的用户并@
  注意：必须严格使用 @[...](...) 格式，方括号和圆括号不可省略，不可用其他符号替代`;

const DEFAULT_MAX_HISTORY_TURNS = 20;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_COOLDOWN_MS = 0;
const DEFAULT_MERGE_WINDOW_MS = 0;
const DEFAULT_MAX_ITERATE = 50; // Maximum invoke iterations (0 = unlimited)

/**
 * Schema version for persisted config.
 * When this is incremented, loadPersistedConfig() will reset
 * the systemPrompt to the current DEFAULT_SYSTEM_PROMPT
 * (unless the user has explicitly customized it).
 */
const CONFIG_SCHEMA_VERSION = 2;

// ─── Markdown Processing ───

/**
 * Configure marked with sensible defaults for IM-friendly output.
 *
 * Uses the mature `marked` library to parse markdown from LLM responses
 * and convert it to a format suitable for IM messaging. Instead of
 * rendering to HTML, we strip markdown formatting for plain-text IM
 * while preserving readable structure.
 */
function configureMarked(): void {
  marked.setOptions({
    gfm: true,
    breaks: true,
  });
}

configureMarked();

/**
 * Process LLM markdown output into IM-friendly plain text.
 *
 * Uses `marked.lexer()` to tokenize the markdown (mature parser),
 * then converts tokens back to a clean plain-text format suitable
 * for IM messaging. This ensures proper handling of code blocks,
 * lists, emphasis, links, and other markdown constructs without
 * any hand-rolled parsing.
 *
 * @param markdown - Raw markdown text from LLM
 * @returns IM-friendly plain text
 */
export function markdownToImText(markdown: string): string {
  if (!markdown || !markdown.trim()) return "";

  try {
    // Use marked's mature lexer to parse markdown into tokens
    const tokens = marked.lexer(markdown);

    // Convert parsed tokens to IM-friendly plain text
    const parts: string[] = [];

    for (const token of tokens) {
      switch (token.type) {
        case "paragraph": {
          const text = renderInlineTokens(token.tokens || []);
          if (text) parts.push(text);
          break;
        }
        case "heading": {
          const text = renderInlineTokens(token.tokens || []);
          parts.push(`【${text}】`);
          break;
        }
        case "code": {
          const lang = token.lang ? `[${token.lang}]` : "";
          parts.push(`${lang}\n${token.text}`);
          break;
        }
        case "list": {
          const items = token.items || [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const prefix = token.ordered ? `${i + 1}. ` : "• ";
            const text = renderInlineTokens(item.tokens || []);
            parts.push(`${prefix}${text}`);
          }
          break;
        }
        case "blockquote": {
          const text = renderBlockTokens(token.tokens || []);
          parts.push(text.split("\n").map((l: string) => `│ ${l}`).join("\n"));
          break;
        }
        case "hr": {
          parts.push("─".repeat(20));
          break;
        }
        case "table": {
          // Simple table rendering for IM
          const headerCells = (token.header || []).map((h: { tokens?: Array<{ text?: string }> }) =>
            renderInlineTokens(h.tokens || [])
          );
          const rows = (token.rows || []).map((row: Array<{ tokens?: Array<{ text?: string }> }>) =>
            row.map((cell) => renderInlineTokens(cell.tokens || [])).join(" | ")
          );
          parts.push(headerCells.join(" | "));
          parts.push(headerCells.map(() => "---").join(" | "));
          for (const row of rows) {
            parts.push(row);
          }
          break;
        }
        case "space": {
          // Skip empty space tokens
          break;
        }
        default: {
          // For unknown token types, try to extract text
          if ("text" in token && typeof (token as { text?: string }).text === "string") {
            parts.push((token as { text: string }).text);
          }
          break;
        }
      }
    }

    return parts.join("\n").trim();
  } catch {
    // Fallback: return raw markdown if parsing fails
    return markdown.trim();
  }
}

/**
 * Render inline markdown tokens to plain text.
 * Handles emphasis, strong, codespan, links, etc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderInlineTokens(tokens: any[]): string {
  if (!tokens || tokens.length === 0) return "";

  return tokens.map((token) => {
    switch (token.type) {
      case "text":
        return token.text || "";
      case "strong":
        return `*${renderInlineTokens(token.tokens || [])}*`;
      case "em":
        return `_${renderInlineTokens(token.tokens || [])}_`;
      case "codespan":
        return `\`${token.text || ""}\``;
      case "link": {
        const linkText = renderInlineTokens(token.tokens || []);
        return linkText;
      }
      case "escape":
        return token.text || "";
      case "br":
        return "\n";
      default:
        if (token.text) return token.text;
        if (token.tokens) return renderInlineTokens(token.tokens);
        return "";
    }
  }).join("");
}

/**
 * Render block-level tokens (for nested structures like blockquote items).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderBlockTokens(tokens: any[]): string {
  if (!tokens || tokens.length === 0) return "";

  return tokens.map((token) => {
    if (token.type === "paragraph" && token.tokens) {
      return renderInlineTokens(token.tokens);
    }
    if (token.tokens) {
      return renderInlineTokens(token.tokens);
    }
    return token.text || "";
  }).join("\n");
}

// ─── Conversation Manager ───

/**
 * Manages conversation history per user/group.
 *
 * Each conversation is identified by a key derived from the message
 * source (userId for DM, groupCode for group). History is maintained
 * as a sliding window of the most recent turns.
 */
export class ConversationManager {
  private conversations = new Map<string, ConversationState>();
  private maxHistoryTurns: number;
  private log: ModuleLog;

  constructor(maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS) {
    this.maxHistoryTurns = maxHistoryTurns;
    this.log = createLog("conversation");
  }

  /**
   * Get the conversation key for a message.
   * One key per conversation (group or DM), not per user.
   * Group: keyed by groupCode (all members share one context)
   * DM: keyed by userId (one context per DM partner)
   */
  getKey(msg: ChatMessage): string {
    if (msg.chatType === "group" && msg.groupCode) {
      return `group:${msg.groupCode}`;
    }
    return `dm:${msg.fromUserId}`;
  }

  /**
   * Get or create conversation state.
   */
  getOrCreate(key: string): ConversationState {
    let state = this.conversations.get(key);
    if (!state) {
      state = {
        history: [],
        lastResponseAt: 0,
        messageCount: 0,
      };
      this.conversations.set(key, state);
    }
    return state;
  }

  /**
   * Add a user message to conversation history.
   */
  addUserMessage(key: string, text: string): void {
    const state = this.getOrCreate(key);
    state.history.push({ role: "user", content: text });
    state.messageCount++;
    this.trimHistory(state);
  }

  /**
   * Add an assistant message to conversation history.
   */
  addAssistantMessage(key: string, text: string): void {
    const state = this.getOrCreate(key);
    state.history.push({ role: "assistant", content: text });
    state.lastResponseAt = Date.now();
    this.trimHistory(state);
  }

  /**
   * Get the full conversation history for a key.
   */
  getHistory(key: string): ConversationHistory[] {
    const state = this.conversations.get(key);
    return state?.history || [];
  }

  /**
   * Clear conversation history for a key.
   */
  clearHistory(key: string): void {
    this.conversations.delete(key);
    this.log.info(`cleared conversation: ${key}`);
  }

  /**
   * Clear all conversation histories.
   */
  clearAll(): void {
    this.conversations.clear();
    this.log.info("cleared all conversations");
  }

  /**
   * Get number of active conversations.
   */
  get size(): number {
    return this.conversations.size;
  }

  /**
   * Get all conversation keys.
   */
  get keys(): string[] {
    return [...this.conversations.keys()];
  }

  /**
   * Trim history to the maximum number of turns.
   */
  private trimHistory(state: ConversationState): void {
    // Keep system messages + max user/assistant turns
    const systemMsgs = state.history.filter(h => h.role === "system");
    const conversationMsgs = state.history.filter(h => h.role !== "system");

    if (conversationMsgs.length > this.maxHistoryTurns * 2) {
      const excess = conversationMsgs.length - this.maxHistoryTurns * 2;
      const trimmed = conversationMsgs.slice(excess);
      state.history = [...systemMsgs, ...trimmed];
    }
  }
}

// ─── LLM Takeover Engine ───

/**
 * Main LLM takeover engine.
 *
 * Handles message interception, LLM API calls, response processing,
 * and message dispatch. Supports multiple providers via the LlmProvider
 * interface, with z-ai as the default for backward compatibility.
 */
export class LlmTakeoverEngine {
  private config: Required<LlmTakeoverConfig>;
  private conversationManager: ConversationManager;
  private provider: LlmProvider;
  private log: ModuleLog;
  /** Message merge buffer: convKey -> buffered messages waiting for merge window */
  private mergeBuffer = new Map<string, { messages: ChatMessage[]; timer: ReturnType<typeof setTimeout> }>();
  /** Path to persist LLM config as JSON. If set, config changes are auto-saved. */
  private persistencePath: string | undefined;

  // ─── Model pool & key pool state ───
  /** Active key index within apiKeys[] (or 0 if only apiKey is set) */
  private activeKeyIndex = 0;
  /** Active provider index within providerPool[] (0 = primary config) */
  private activeProviderIndex = 0;
  /** Map of key → failure count */
  private keyFailures = new Map<string, number>();
  /** Map of key → cooldown-until timestamp */
  private keyCooldowns = new Map<string, number>();
  /** Consecutive failure count for the active provider */
  private providerFailures = 0;

  constructor(config?: LlmTakeoverConfig & { persistencePath?: string }) {
    this.config = {
      enabled: config?.enabled ?? true,
      systemPrompt: config?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model: config?.model ?? "",
      temperature: config?.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
      maxHistoryTurns: config?.maxHistoryTurns ?? DEFAULT_MAX_HISTORY_TURNS,
      enableInGroup: config?.enableInGroup ?? true,
      enableInDirect: config?.enableInDirect ?? true,
      requireMentionInGroup: config?.requireMentionInGroup ?? true,
      cooldownMs: config?.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      mergeWindowMs: config?.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS,
      responsePrefix: config?.responsePrefix ?? "",
      shouldRespond: config?.shouldRespond ?? (() => true),
      postProcess: config?.postProcess ?? ((text: string) => text),
      provider: config?.provider ?? "z-ai",
      apiKey: config?.apiKey ?? "",
      baseUrl: config?.baseUrl ?? "",
      apiVersion: config?.apiVersion ?? "",
      markdownRawMode: config?.markdownRawMode ?? true,
      maxIterate: config?.maxIterate ?? DEFAULT_MAX_ITERATE,
      // New pool config
      apiKeys: config?.apiKeys ?? [],
      providerPool: config?.providerPool ?? [],
      autoRotateKeys: config?.autoRotateKeys ?? true,
      autoSwitchProvider: config?.autoSwitchProvider ?? true,
      keyCooldownMs: config?.keyCooldownMs ?? 5 * 60 * 1000,
      maxFailuresBeforeSwitch: config?.maxFailuresBeforeSwitch ?? 3,
      customProviders: config?.customProviders ?? {},
    };

    this.conversationManager = new ConversationManager(this.config.maxHistoryTurns);
    this.log = createLog("llm-takeover");
    this.persistencePath = config?.persistencePath;

    // Load persisted config if available (overrides constructor defaults)
    // Auto-create the persisted config file if it doesn't exist
    if (this.persistencePath) {
      const fileExisted = existsSync(this.persistencePath);
      this.loadPersistedConfig();
      if (!fileExisted) {
        this.persistConfig();
      }
    }

    // Create provider based on config
    this.provider = this.createProviderFromConfig();
  }

  // ─── Key pool & provider pool management ───

  /**
   * Get the active API key (from apiKeys[] pool or single apiKey).
   * Skips keys that are in cooldown.
   */
  private getActiveApiKey(): string {
    const keys = this.getActiveKeyPool();
    if (keys.length === 0) return "";

    // Try the active key first
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (this.activeKeyIndex + i) % keys.length;
      const key = keys[idx];
      const cooldownUntil = this.keyCooldowns.get(key) ?? 0;
      if (now >= cooldownUntil) {
        this.activeKeyIndex = idx;
        return key;
      }
    }

    // All keys in cooldown — return the one with the shortest remaining cooldown
    this.log.warn("all API keys in cooldown, using least-cooling key");
    let bestKey = keys[0];
    let bestCooldown = Infinity;
    for (const key of keys) {
      const until = this.keyCooldowns.get(key) ?? 0;
      if (until < bestCooldown) {
        bestCooldown = until;
        bestKey = key;
      }
    }
    return bestKey;
  }

  /**
   * Get the key pool for the active provider.
   * Falls back to [apiKey] if apiKeys[] is empty.
   */
  private getActiveKeyPool(): string[] {
    // Check if the active provider is a custom provider
    const activeProviderName = this.getActiveProviderName();
    const customProvider = this.config.customProviders?.[activeProviderName];
    if (customProvider) {
      if (customProvider.apiKeys && customProvider.apiKeys.length > 0) return customProvider.apiKeys;
      return customProvider.apiKey ? [customProvider.apiKey] : [];
    }

    // If we're using the primary config (index 0), use config.apiKeys or [config.apiKey]
    if (this.activeProviderIndex === 0) {
      if (this.config.apiKeys.length > 0) return this.config.apiKeys;
      return this.config.apiKey ? [this.config.apiKey] : [];
    }
    // Otherwise, use the providerPool entry
    const poolEntry = this.config.providerPool[this.activeProviderIndex - 1];
    if (!poolEntry) return [];
    if (poolEntry.apiKeys && poolEntry.apiKeys.length > 0) return poolEntry.apiKeys;
    return poolEntry.apiKey ? [poolEntry.apiKey] : [];
  }

  /**
   * Mark a key as failed. After maxFailuresBeforeSwitch consecutive failures,
   * put it in cooldown and rotate to the next key.
   */
  private markKeyFailed(key: string): void {
    const count = (this.keyFailures.get(key) ?? 0) + 1;
    this.keyFailures.set(key, count);
    this.log.warn(`key ${key.slice(0, 8)}... failed ${count}/${this.config.maxFailuresBeforeSwitch} times`);

    if (count >= this.config.maxFailuresBeforeSwitch) {
      // Put in cooldown
      this.keyCooldowns.set(key, Date.now() + this.config.keyCooldownMs);
      this.log.warn(`key ${key.slice(0, 8)}... put in cooldown for ${this.config.keyCooldownMs / 1000}s`);

      // Reset failure count (will start fresh after cooldown)
      this.keyFailures.set(key, 0);

      // Rotate to next key
      const keys = this.getActiveKeyPool();
      if (keys.length > 1 && this.config.autoRotateKeys) {
        this.activeKeyIndex = (this.activeKeyIndex + 1) % keys.length;
        this.log.info(`rotated to key index ${this.activeKeyIndex}`);
      }
    }
  }

  /**
   * Mark a successful call — resets failure count for the active key.
   */
  private markKeySuccess(): void {
    const keys = this.getActiveKeyPool();
    const activeKey = keys[this.activeKeyIndex];
    if (activeKey) {
      this.keyFailures.set(activeKey, 0);
    }
    this.providerFailures = 0;
  }

  /**
   * Mark the active provider as failed. If failures exceed the threshold,
   * switch to the next provider in the pool.
   */
  private markProviderFailed(): void {
    this.providerFailures++;
    this.log.warn(`provider ${this.getActiveProviderName()} failed ${this.providerFailures}/${this.config.maxFailuresBeforeSwitch} times`);

    if (
      this.providerFailures >= this.config.maxFailuresBeforeSwitch &&
      this.config.autoSwitchProvider &&
      this.config.providerPool.length > 0
    ) {
      this.switchToNextProvider();
    }
  }

  /**
   * Switch to the next provider in the pool (cyclic).
   */
  private switchToNextProvider(): void {
    const totalProviders = 1 + this.config.providerPool.length; // primary + pool
    this.activeProviderIndex = (this.activeProviderIndex + 1) % totalProviders;
    this.activeKeyIndex = 0;
    this.providerFailures = 0;
    this.log.info(`switched to provider index ${this.activeProviderIndex}: ${this.getActiveProviderName()}`);

    // Recreate the provider instance
    this.provider = this.createProviderFromConfig();
  }

  /**
   * Get the name of the active provider.
   */
  private getActiveProviderName(): string {
    if (this.activeProviderIndex === 0) return this.config.provider;
    return this.config.providerPool[this.activeProviderIndex - 1]?.provider ?? "unknown";
  }

  /**
   * Get the active model (from providerPool entry if applicable).
   */
  private getActiveModel(): string {
    if (this.activeProviderIndex === 0) return this.config.model;
    return this.config.providerPool[this.activeProviderIndex - 1]?.model ?? this.config.model;
  }

  /**
   * Call the LLM provider with automatic key/provider failover.
   *
   * On error (401/429/network), marks the active key as failed and retries
   * with the next key. If all keys are exhausted, switches to the next
   * provider in the pool and retries.
   *
   * Returns the provider's response, or throws if all providers fail.
   */
  private async callProviderWithFailover(
    messages: ConversationHistory[],
    options: { temperature: number; maxTokens: number; model?: string },
  ): Promise<{ content: string; tokensUsed?: number }> {
    const maxAttempts = 1 + this.getActiveKeyPool().length + this.config.providerPool.length;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        this.log.info(`calling LLM (${this.getActiveProviderName()}) attempt ${attempt + 1}/${maxAttempts}`);
        const result = await this.provider.chat(messages, {
          ...options,
          model: options.model || this.getActiveModel() || undefined,
        });
        this.markKeySuccess();
        return result;
      } catch (err) {
        lastError = err as Error;
        const errMsg = (err as Error).message.toLowerCase();

        // Check if this is a key-related error (401/429/rate limit)
        const isKeyError = /401|403|429|rate.?limit|unauthor|invalid.?api.?key/.test(errMsg);
        const isServerError = /5\d{2}|server.?error|timeout|econnreset|enotfound/.test(errMsg);

        if (isKeyError) {
          const keys = this.getActiveKeyPool();
          const activeKey = keys[this.activeKeyIndex];
          if (activeKey) {
            this.markKeyFailed(activeKey);
          }
          // Recreate provider with the new active key
          this.provider = this.createProviderFromConfig();
          continue;
        }

        if (isServerError) {
          this.markProviderFailed();
          // Provider may have been switched in markProviderFailed
          continue;
        }

        // Non-retryable error — rethrow
        throw err;
      }
    }

    throw lastError ?? new Error("all LLM providers failed");
  }

  /**
   * Create a provider from the current active config.
   *
   * If we're using the primary config (index 0), uses config.provider/apiKey/etc.
   * If we're using a pool entry (index > 0), uses that entry's settings.
   */
  private createProviderFromConfig(): LlmProvider {
    try {
      // Check if the active provider is a custom provider
      const activeProviderName = this.getActiveProviderName();
      const customProvider = this.config.customProviders?.[activeProviderName];
      if (customProvider) {
        // Use the custom provider's underlying type + key pool
        const keys = customProvider.apiKeys ?? (customProvider.apiKey ? [customProvider.apiKey] : []);
        const activeKey = keys.length > 0 ? keys[this.activeKeyIndex % keys.length] : "";
        const mergedConfig: LlmTakeoverConfig = {
          ...this.config,
          provider: customProvider.type,
          model: customProvider.model ?? this.config.model,
          apiKey: activeKey,
          baseUrl: customProvider.baseUrl ?? this.config.baseUrl,
          apiVersion: customProvider.apiVersion ?? this.config.apiVersion,
        };
        return createProvider(mergedConfig);
      }

      // If using a providerPool entry, merge its config
      if (this.activeProviderIndex > 0) {
        const poolEntry = this.config.providerPool[this.activeProviderIndex - 1];
        if (poolEntry) {
          const mergedConfig: LlmTakeoverConfig = {
            ...this.config,
            provider: poolEntry.provider,
            model: poolEntry.model ?? this.config.model,
            apiKey: poolEntry.apiKey ?? this.getActiveApiKey(),
            apiKeys: poolEntry.apiKeys,
            baseUrl: poolEntry.baseUrl ?? this.config.baseUrl,
            apiVersion: poolEntry.apiVersion ?? this.config.apiVersion,
          };
          return createProvider(mergedConfig);
        }
      }
      // Primary config — inject the active key from the pool
      const activeKey = this.getActiveApiKey();
      if (activeKey && activeKey !== this.config.apiKey) {
        const mergedConfig: LlmTakeoverConfig = {
          ...this.config,
          apiKey: activeKey,
        };
        return createProvider(mergedConfig);
      }
      return createProvider(this.config);
    } catch (err) {
      this.log.error(`provider creation failed: ${(err as Error).message}`);
      // Fallback to z-ai
      return new ZaiProvider();
    }
  }

  // ─── Configuration ───

  /**
   * Update configuration at runtime.
   */
  updateConfig(patch: Partial<LlmTakeoverConfig>): void {
    let providerChanged = false;

    if (patch.enabled !== undefined) {
      this.config.enabled = patch.enabled;
    }
    if (patch.systemPrompt !== undefined) this.config.systemPrompt = patch.systemPrompt;
    if (patch.model !== undefined) this.config.model = patch.model;
    if (patch.temperature !== undefined) this.config.temperature = patch.temperature;
    if (patch.maxTokens !== undefined) this.config.maxTokens = patch.maxTokens;
    if (patch.enableInGroup !== undefined) this.config.enableInGroup = patch.enableInGroup;
    if (patch.enableInDirect !== undefined) this.config.enableInDirect = patch.enableInDirect;
    if (patch.requireMentionInGroup !== undefined) this.config.requireMentionInGroup = patch.requireMentionInGroup;
    if (patch.cooldownMs !== undefined) this.config.cooldownMs = patch.cooldownMs;
    if (patch.mergeWindowMs !== undefined) this.config.mergeWindowMs = patch.mergeWindowMs;
    if (patch.responsePrefix !== undefined) this.config.responsePrefix = patch.responsePrefix;
    if (patch.shouldRespond !== undefined) this.config.shouldRespond = patch.shouldRespond;
    if (patch.postProcess !== undefined) this.config.postProcess = patch.postProcess;
    if (patch.markdownRawMode !== undefined) this.config.markdownRawMode = patch.markdownRawMode;
    if (patch.maxIterate !== undefined) this.config.maxIterate = patch.maxIterate;

    // Provider-related config changes
    if (patch.provider !== undefined && patch.provider !== this.config.provider) {
      this.config.provider = patch.provider;
      providerChanged = true;
    }
    if (patch.apiKey !== undefined) {
      this.config.apiKey = patch.apiKey;
      providerChanged = true;
    }
    if (patch.baseUrl !== undefined) {
      this.config.baseUrl = patch.baseUrl;
      providerChanged = true;
    }
    if (patch.apiVersion !== undefined) {
      this.config.apiVersion = patch.apiVersion;
      providerChanged = true;
    }

    // New pool config
    if (patch.apiKeys !== undefined) {
      this.config.apiKeys = patch.apiKeys;
      this.activeKeyIndex = 0; // reset on pool change
      providerChanged = true;
    }
    if (patch.providerPool !== undefined) {
      this.config.providerPool = patch.providerPool;
      this.activeProviderIndex = 0; // reset to primary
      providerChanged = true;
    }
    if (patch.autoRotateKeys !== undefined) this.config.autoRotateKeys = patch.autoRotateKeys;
    if (patch.autoSwitchProvider !== undefined) this.config.autoSwitchProvider = patch.autoSwitchProvider;
    if (patch.keyCooldownMs !== undefined) this.config.keyCooldownMs = patch.keyCooldownMs;
    if (patch.maxFailuresBeforeSwitch !== undefined) this.config.maxFailuresBeforeSwitch = patch.maxFailuresBeforeSwitch;
    if (patch.customProviders !== undefined) {
      this.config.customProviders = patch.customProviders;
      providerChanged = true;
    }

    // Recreate provider if relevant config changed
    if (providerChanged) {
      try {
        this.provider = this.createProviderFromConfig();
        this.log.info(`provider switched to: ${this.provider.name}`);
      } catch (err) {
        this.log.error(`provider switch failed: ${(err as Error).message}`);
      }
    }

    this.log.info("config updated");

    // Auto-persist configuration changes to disk
    this.maybePersistConfig();
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<Required<LlmTakeoverConfig>> {
    return { ...this.config };
  }

  /**
   * Get the current pool status (active provider, key index, failure counts).
   * Useful for /llm status command.
   */
  getPoolStatus(): {
    activeProvider: string;
    activeProviderIndex: number;
    activeKeyIndex: number;
    activeModel: string;
    keyPoolSize: number;
    keysInCooldown: number;
    providerPoolSize: number;
    providerFailures: number;
    maxFailuresBeforeSwitch: number;
  } {
    const keys = this.getActiveKeyPool();
    const now = Date.now();
    const keysInCooldown = keys.filter(k => (this.keyCooldowns.get(k) ?? 0) > now).length;
    return {
      activeProvider: this.getActiveProviderName(),
      activeProviderIndex: this.activeProviderIndex,
      activeKeyIndex: this.activeKeyIndex,
      activeModel: this.getActiveModel(),
      keyPoolSize: keys.length,
      keysInCooldown,
      providerPoolSize: this.config.providerPool.length,
      providerFailures: this.providerFailures,
      maxFailuresBeforeSwitch: this.config.maxFailuresBeforeSwitch,
    };
  }

  /**
   * Get the persistence path (if configured).
   */
  getPersistencePath(): string | undefined {
    return this.persistencePath;
  }

  // ─── Configuration Persistence ───

  /**
   * Persist the current LLM configuration to disk.
   *
   * Saves a JSON file with all serializable config fields.
   * Non-serializable fields (shouldRespond, postProcess) are excluded.
   * This is called automatically when updateConfig() is invoked.
   */
  persistConfig(): boolean {
    if (!this.persistencePath) return false;
    try {
      const dir = dirname(this.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Only persist serializable fields (exclude functions)
      const data: Record<string, unknown> = {
        _schemaVersion: CONFIG_SCHEMA_VERSION,
        enabled: this.config.enabled,
        systemPrompt: this.config.systemPrompt,
        model: this.config.model,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        maxHistoryTurns: this.config.maxHistoryTurns,
        enableInGroup: this.config.enableInGroup,
        enableInDirect: this.config.enableInDirect,
        requireMentionInGroup: this.config.requireMentionInGroup,
        cooldownMs: this.config.cooldownMs,
        mergeWindowMs: this.config.mergeWindowMs,
        responsePrefix: this.config.responsePrefix,
        provider: this.config.provider,
        apiKey: this.config.apiKey,
        baseUrl: this.config.baseUrl,
        apiVersion: this.config.apiVersion,
        markdownRawMode: this.config.markdownRawMode,
        maxIterate: this.config.maxIterate,
      };
      writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), "utf-8");
      this.log.info(`LLM config persisted to ${this.persistencePath}`);
      return true;
    } catch (err) {
      this.log.error(`failed to persist LLM config: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Load persisted LLM configuration from disk.
   *
   * Merges saved values into the current config, only overriding
   * fields that are present in the persisted file.
   * Called automatically during construction if persistencePath is set.
   */
  loadPersistedConfig(): void {
    if (!this.persistencePath) return;
    try {
      if (!existsSync(this.persistencePath)) {
        this.log.info("no persisted LLM config found, using defaults");
        return;
      }
      const raw = readFileSync(this.persistencePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;

      // Schema migration: if the persisted config has an older schema version
      // (or no version at all), reset systemPrompt to the current default.
      // This ensures new prompt features (like iterative invoke, @mention, /unsafe)
      // are available after upgrades, unless the user explicitly customized the prompt.
      const persistedVersion = (data._schemaVersion as number) || 0;
      if (persistedVersion < CONFIG_SCHEMA_VERSION) {
        this.log.info(`persisted config schema ${persistedVersion} < current ${CONFIG_SCHEMA_VERSION}, resetting systemPrompt to default`);
        // Keep systemPrompt at DEFAULT_SYSTEM_PROMPT (already set in constructor)
        // Do NOT apply the persisted systemPrompt — it's outdated
      } else {
        // Schema is current, apply persisted systemPrompt
        if (data.systemPrompt !== undefined) this.config.systemPrompt = data.systemPrompt as string;
      }

      // Merge persisted values (only serializable fields)
      if (data.enabled !== undefined) this.config.enabled = data.enabled as boolean;
      if (data.model !== undefined) this.config.model = data.model as string;
      if (data.temperature !== undefined) this.config.temperature = data.temperature as number;
      if (data.maxTokens !== undefined) this.config.maxTokens = data.maxTokens as number;
      if (data.maxHistoryTurns !== undefined) this.config.maxHistoryTurns = data.maxHistoryTurns as number;
      if (data.enableInGroup !== undefined) this.config.enableInGroup = data.enableInGroup as boolean;
      if (data.enableInDirect !== undefined) this.config.enableInDirect = data.enableInDirect as boolean;
      if (data.requireMentionInGroup !== undefined) this.config.requireMentionInGroup = data.requireMentionInGroup as boolean;
      if (data.cooldownMs !== undefined) this.config.cooldownMs = data.cooldownMs as number;
      if (data.mergeWindowMs !== undefined) this.config.mergeWindowMs = data.mergeWindowMs as number;
      if (data.responsePrefix !== undefined) this.config.responsePrefix = data.responsePrefix as string;
      if (data.provider !== undefined) this.config.provider = data.provider as LlmProviderType;
      if (data.apiKey !== undefined) this.config.apiKey = data.apiKey as string;
      if (data.baseUrl !== undefined) this.config.baseUrl = data.baseUrl as string;
      if (data.apiVersion !== undefined) this.config.apiVersion = data.apiVersion as string;
      if (data.markdownRawMode !== undefined) this.config.markdownRawMode = data.markdownRawMode as boolean;
      if (data.maxIterate !== undefined) this.config.maxIterate = data.maxIterate as number;

      // If schema was upgraded, persist immediately with new version
      if (persistedVersion < CONFIG_SCHEMA_VERSION) {
        this.persistConfig();
      }

      this.log.info(`LLM config loaded from ${this.persistencePath} (schema v${persistedVersion} -> v${CONFIG_SCHEMA_VERSION})`);
    } catch (err) {
      this.log.error(`failed to load persisted LLM config: ${(err as Error).message}`);
    }
  }

  private maybePersistConfig(): void {
    if (this.persistencePath) {
      this.persistConfig();
    }
  }

  /**
   * Get the conversation manager.
   */
  getConversationManager(): ConversationManager {
    return this.conversationManager;
  }

  /**
   * Get the current provider.
   */
  getProvider(): LlmProvider {
    return this.provider;
  }

  /**
   * Check if LLM takeover is enabled and ready.
   */
  get isReady(): boolean {
    return this.config.enabled;
  }

  // ─── Context Feeding ───

  /**
   * Add a message to conversation context WITHOUT triggering an API call.
   *
   * Called for EVERY incoming message (including slash commands) so the LLM
   * always has full conversation awareness. The API call is only triggered
   * by handleMessage() when the bot is @mentioned or in a DM.
   *
   * @param msg - The original chat message
   * @param formattedText - Pre-formatted text with sender label, e.g. "[张三]: 你好"
   */
  addContextMessage(msg: ChatMessage, formattedText: string): void {
    const convKey = this.conversationManager.getKey(msg);
    this.conversationManager.addUserMessage(convKey, formattedText);
  }

  // ─── Message Handling ───

  /**
   * Process an incoming message — decide whether to trigger an LLM API call.
   *
   * Context is already fed via addContextMessage() for ALL messages.
   * This method ONLY decides whether to make the API call:
   * - DM: always trigger (if enabled)
   * - Group: only trigger if @mentioned (requireMentionInGroup) or if mentioned
   *
   * The message is NOT added to context again here — that was already done.
   */
  async handleMessage(bot: YuanbaoBot, msg: ChatMessage): Promise<TakeoverResult> {
    if (!this.config.enabled) {
      return { handled: false };
    }

    // Check if this chat type is enabled
    if (msg.chatType === "group" && !this.config.enableInGroup) {
      return { handled: false };
    }
    if (msg.chatType === "direct" && !this.config.enableInDirect) {
      return { handled: false };
    }

    // Check mention requirement for groups
    if (msg.chatType === "group" && this.config.requireMentionInGroup && !msg.isMentioned) {
      return { handled: false };
    }

    // Check custom filter
    try {
      const shouldRespond = await this.config.shouldRespond(msg);
      if (!shouldRespond) {
        return { handled: false };
      }
    } catch (err) {
      this.log.warn(`shouldRespond filter error: ${(err as Error).message}`);
    }

    // Skip empty messages
    if (!msg.text || !msg.text.trim()) {
      return { handled: false };
    }

    // Context is already fed — go directly to API call
    // (No merge window since mergeWindowMs defaults to 0 now)
    return this.processMessage(bot, [msg]);
  }

  /**
   * Handle a group message with merge window.
   * 
   * Buffers incoming messages for a short window (mergeWindowMs), then 
   * processes all buffered messages together. This gives the LLM full 
   * context when someone sends multiple quick messages in a row.
   */
  private handleGroupMessageWithMerge(bot: YuanbaoBot, msg: ChatMessage): Promise<TakeoverResult> {
    const convKey = this.conversationManager.getKey(msg);

    // Check if there's already a pending merge for this conversation
    const existing = this.mergeBuffer.get(convKey);

    if (existing) {
      // Append to existing buffer and reset the timer
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this.flushMergeBuffer(bot, convKey);
      }, this.config.mergeWindowMs);
      this.log.debug(`merge: appended message to buffer for ${convKey} (now ${existing.messages.length} messages)`);
      return Promise.resolve({ handled: true }); // Acknowledge — will process after window
    }

    // Start a new merge buffer
    const buffer = { messages: [msg], timer: setTimeout(() => {
      this.flushMergeBuffer(bot, convKey);
    }, this.config.mergeWindowMs) };
    this.mergeBuffer.set(convKey, buffer);
    this.log.debug(`merge: started new buffer for ${convKey} (window: ${this.config.mergeWindowMs}ms)`);

    return Promise.resolve({ handled: true }); // Acknowledge — will process after window
  }

  /**
   * Flush the merge buffer for a conversation and process all buffered messages.
   */
  private async flushMergeBuffer(bot: YuanbaoBot, convKey: string): Promise<void> {
    const buffer = this.mergeBuffer.get(convKey);
    if (!buffer) return;

    // Remove from map before async processing
    this.mergeBuffer.delete(convKey);

    const messages = buffer.messages;
    this.log.info(`merge: flushing ${messages.length} buffered messages for ${convKey}`);

    try {
      const result = await this.processMessage(bot, messages);
      if (result.handled && result.response) {
        this.log.info(`merge: LLM responded to ${messages.length} merged messages in ${convKey}`);
      }
    } catch (err) {
      this.log.error(`merge: error processing buffered messages: ${(err as Error).message}`);
    }
  }

  /**
   * Core message processing logic — makes the LLM API call.
   * 
   * Context is already fed via addContextMessage(). This method:
   * 1. Checks cooldown
   * 2. Builds the LLM messages array (system + history + latest)
   * 3. Calls the LLM provider
   * 4. Processes and sends the response IMMEDIATELY
   * 5. If response contains invoke markers (...), executes commands and LOOPS
   *    — each iteration sends its response immediately before the next LLM call
   * 6. The loop continues until no more invoke markers are found,
   *    or maxIterate is reached (default: 50, 0 = unlimited)
   */
  private async processMessage(bot: YuanbaoBot, msgs: ChatMessage[]): Promise<TakeoverResult> {
    const msg = msgs[0]; // Primary message for context (group info, reply target)
    const convKey = this.conversationManager.getKey(msg);

    // Check cooldown
    const convState = this.conversationManager.getOrCreate(convKey);
    if (Date.now() - convState.lastResponseAt < this.config.cooldownMs) {
      this.log.debug(`cooldown active for ${convKey}, skipping`);
      return { handled: false };
    }

    // Build messages array for LLM with injected context
    // (user message already in history via addContextMessage)
    const llmMessages = this.buildLlmMessages(convKey, msg, bot);

    // Call LLM via provider
    try {
      this.log.info(`calling LLM (${this.getActiveProviderName()}) for ${convKey}: "${msg.text.substring(0, 50)}..."`);

      const result = await this.callProviderWithFailover(llmMessages, {
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        model: this.getActiveModel() || undefined,
      });

      const rawText = result.content;
      if (!rawText || !rawText.trim()) {
        this.log.warn("LLM returned empty response");
        return { handled: false };
      }

      // Process markdown → IM-friendly text, or use raw markdown based on config
      let processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);

      // Apply custom post-processing
      try {
        processedText = await this.config.postProcess(processedText, msg);
      } catch (err) {
        this.log.warn(`postProcess error: ${(err as Error).message}`);
      }

      // Add response prefix
      if (this.config.responsePrefix) {
        processedText = this.config.responsePrefix + processedText;
      }

      // Add assistant response to history
      this.conversationManager.addAssistantMessage(convKey, rawText);

      // Handle command invocations from LLM response
      const invokeResult = await this.handleCommandInvocations(bot, msg, processedText);
      if (invokeResult) {
        processedText = invokeResult.firstRoundText;
      }

      // Send first-round response IMMEDIATELY (before any follow-up LLM call)
      // This ensures users see the response promptly, avoiding delay/reordering
      const chunkCount = await this.sendResponse(bot, msg, processedText);

      // If there are follow-up invokes, enter the iterative invoke loop
      if (invokeResult?.hasFollowUp) {
        // Execute follow-up loop asynchronously — don't await to avoid blocking the return
        // Each iteration sends its response immediately before the next
        this.executeIterativeInvoke(bot, msg, invokeResult.followUpResults).catch(err => {
          this.log.error(`iterative invoke error: ${(err as Error).message}`);
        });
      }

      return {
        handled: true,
        response: {
          rawText,
          processedText,
          sent: true,
          chunkCount,
          tokensUsed: result.tokensUsed,
          markdownRawMode: this.config.markdownRawMode,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`LLM call failed: ${error.message}`);
      return { handled: false, error };
    }
  }

  /**
   * Build the messages array for LLM API call.
   * Injects group history context and command usage documentation.
   */
  private buildLlmMessages(
    convKey: string,
    msg: ChatMessage,
    bot?: YuanbaoBot,
  ): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

    // System prompt
    let systemPrompt = this.config.systemPrompt;

    // Add context about the chat type
    if (msg.chatType === "group") {
      systemPrompt += `\n\n当前是群聊环境（群名: ${msg.groupName || msg.groupCode || "未知"}，群号: ${msg.groupCode || "未知"}）。请保持回复简洁。`;
    } else {
      systemPrompt += "\n\n当前是私聊环境。";
    }

    // Inject group history context for group chats
    if (bot && msg.chatType === "group" && msg.groupCode) {
      const historyStore = bot.getHistoryStore();
      const recentGroupMsgs = historyStore.getRecent(30, { groupCode: msg.groupCode });
      if (recentGroupMsgs.length > 0) {
        const historyLines = recentGroupMsgs.map(m => {
          const sender = m.fromNickname || m.fromUserId;
          const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
          const shortId = m.id ? (m.id.length > 8 ? m.id.slice(-8) : m.id) : "?";
          return `[${time}] ${sender}(${m.fromUserId}): ${m.text || "(非文本)"} #${shortId}`;
        });
        systemPrompt += `\n\n=== 最近群聊记录 ===\n${historyLines.join("\n")}\n=== 记录结束 ===`;
      }
    }

    // Inject command usage documentation
    if (bot) {
      const cmdSystem = bot.getCommandSystem();
      if (cmdSystem) {
        const commands = cmdSystem.getAll().filter(c => !c.hidden);
        const isGroup = msg.chatType === "group";
        const unsafeMode = cmdSystem.isUnsafeMode();
        const cmdLines: string[] = [];
        for (const cmd of commands) {
          // Skip dmOnly commands in group context unless unsafe mode is active
          if (isGroup && cmd.dmOnly && !unsafeMode) continue;
          const aliasStr = cmd.aliases?.length ? ` (别名: ${cmd.aliases.join(", ")})` : "";
          const dmLabel = cmd.dmOnly ? " [仅私聊]" : "";
          cmdLines.push(`  /${cmd.name}${aliasStr}${dmLabel} — ${cmd.description}${cmd.usage ? ` | 用法: ${cmd.usage}` : ""}`);
        }
        if (cmdLines.length > 0) {
          systemPrompt += `\n\n=== 可用命令 ===\n${cmdLines.join("\n")}\n=== 命令结束 ===`;
          if (unsafeMode) {
            systemPrompt += `\n\n你可以通过在回复中嵌入 <<command>>/命令名 参数<<command>> 来执行命令。⚠️ 危险模式已开启，所有命令（包括dmOnly命令）均可在群聊中使用。`;
          } else {
            systemPrompt += `\n\n你可以通过在回复中嵌入 <<command>>/命令名 参数<<command>> 来执行命令。例如: <<command>>/ping<<command>> 或 <<command>>/sticker 狗头<<command>>。在群聊中，dmOnly命令不可用。`;
          }
        }
      }
    }

    messages.push({ role: "system", content: systemPrompt });

    // Add conversation history
    const history = this.conversationManager.getHistory(convKey);
    for (const entry of history) {
      messages.push({ role: entry.role, content: entry.content });
    }

    return messages;
  }

  /**
   * Handle command invocations from LLM response text.
   * Detects <<command>>/cmd args<<command>> patterns and executes them.
   * Supports multiple commands in a single response.
   *
   * Follow-up mechanism (trailing "..."):
   *   <<command>>/cmd args<<command>>...
   *   When "..." appears immediately after the closing tag, it signals the LLM
   *   wants to see the command result and continue the conversation.
   *
   * IMPORTANT: To avoid message delay/reordering issues, this method sends
   * the first-round response (with invoke results) BEFORE executing the
   * follow-up LLM call. The follow-up response is sent separately afterward.
   *
   * Returns an object with:
   *   - firstRoundText: text to send immediately (with invoke results)
   *   - hasFollowUp: whether a follow-up LLM call is needed
   *   - followUpContext: the context for the follow-up call
   * Or null if no invocations found.
   */
  private async handleCommandInvocations(
    bot: YuanbaoBot,
    msg: ChatMessage,
    text: string,
  ): Promise<{
    firstRoundText: string;
    hasFollowUp: boolean;
    followUpResults: string[];
    cleanedText: string;
  } | null> {
    // Detect <<command>>/cmd args<<command>>...? patterns (supports multiple)
    // The trailing "..." is a follow-up marker: LLM wants to see results and continue
    const invokePattern = /<<command>>\s*(\/\S+(?:\s[^<]*?)?)\s*<<command>>(\.\.\.)?/g;
    const matches = [...text.matchAll(invokePattern)];
    if (matches.length === 0) return null;

    const cmdSystem = bot.getCommandSystem();
    if (!cmdSystem) return null;

    const results: string[] = [];
    const followUpResults: string[] = []; // Commands with "..." marker
    let cleanedText = text;
    let hasFollowUp = false;

    for (const match of matches) {
      const fullCmd = match[1].trim(); // e.g. "/ping" or "/sticker 狗头"
      const isFollowUp = Boolean(match[2]); // "..." present
      cleanedText = cleanedText.replace(match[0], ""); // Remove the tag from response

      this.log.info(`LLM invoke detected: ${fullCmd}${isFollowUp ? " (follow-up)" : ""}`);

      // Build a synthetic message for command dispatch
      const syntheticMsg: ChatMessage = {
        ...msg,
        text: fullCmd,
      };

      try {
        // Capture command output
        let commandOutput = "";
        const captureReply = async (output: string) => {
          commandOutput += output + "\n";
        };

        const result = await cmdSystem.dispatch(bot, syntheticMsg, captureReply);

        let resultText: string;
        if (result.handled && commandOutput.trim()) {
          resultText = commandOutput.trim();
          results.push(`⚡ ${fullCmd}:\n${resultText}`);
        } else if (result.handled) {
          resultText = "(已执行)";
          results.push(`⚡ ${fullCmd}: ${resultText}`);
        } else {
          resultText = "(命令未识别)";
          results.push(`⚡ ${fullCmd}: ${resultText}`);
        }

        if (isFollowUp) {
          hasFollowUp = true;
          followUpResults.push(`[命令执行结果] ${fullCmd} → ${resultText}`);
        }
      } catch (err) {
        this.log.warn(`LLM invoke failed: ${fullCmd} — ${(err as Error).message}`);
        const errorText = `执行失败 — ${(err as Error).message}`;
        results.push(`⚠️ ${fullCmd}: ${errorText}`);
        if (isFollowUp) {
          hasFollowUp = true;
          followUpResults.push(`[命令执行结果] ${fullCmd} → ${errorText}`);
        }
      }
    }

    cleanedText = cleanedText.trim();

    // Build first-round text (to be sent immediately)
    let firstRoundText: string;
    if (results.length > 0) {
      const resultSection = results.join("\n\n");
      firstRoundText = cleanedText ? `${cleanedText}\n\n${resultSection}` : resultSection;
    } else {
      firstRoundText = cleanedText;
    }

    return {
      firstRoundText,
      hasFollowUp,
      followUpResults,
      cleanedText,
    };
  }

  /**
   * Iterative invoke loop — continues calling LLM as long as the response
   * contains follow-up invoke markers.
   *
   * Each iteration:
   * 1. Feeds command results back as user context
   * 2. Calls LLM with updated context
   * 3. Sends the response IMMEDIATELY (before next iteration)
   * 4. Checks for more invoke markers — if found, loops again
   *
   * The loop exits when:
   * - The LLM response contains no more invoke markers
   * - maxIterate is reached (default: 50, 0 = unlimited)
   * - An error occurs
   *
   * This design ensures:
   * - Users see each response as soon as it's generated (no delay)
   * - Complex multi-step tasks can chain arbitrarily many commands
   * - Safety limit prevents truly infinite loops from bugs
   */
  private async executeIterativeInvoke(
    bot: YuanbaoBot,
    msg: ChatMessage,
    initialFollowUpResults: string[],
  ): Promise<void> {
    const convKey = this.conversationManager.getKey(msg);
    const maxIterations = this.config.maxIterate; // 0 = unlimited

    let followUpResults = initialFollowUpResults;
    let iteration = 0;

    while (true) {
      iteration++;

      // Safety: check iteration limit
      if (maxIterations > 0 && iteration > maxIterations) {
        this.log.warn(`iterative invoke: reached max iterations (${maxIterations}), stopping`);
        // Notify the user that we've hit the limit
        try {
          const isGroup = msg.chatType === "group";
          const limitMsg = `⚠️ 迭代调用已达上限 (${maxIterations}轮)`;
          if (isGroup && msg.groupCode) {
            await bot.sendGroupMessage(msg.groupCode, limitMsg);
          } else {
            await bot.sendDirectMessage(msg.fromUserId, limitMsg);
          }
        } catch { /* ignore */ }
        break;
      }

      // Feed command results as user context for the next LLM call
      const followUpContext = followUpResults.join("\n");
      this.conversationManager.addUserMessage(convKey, `[系统] 命令执行反馈 (第${iteration}轮):\n${followUpContext}\n\n请根据以上命令执行结果继续回复。如果还需要执行命令，继续使用 <<command>>...<<command>> 格式。`);

      // Call LLM with updated context
      try {
        this.log.info(`iterative invoke: round ${iteration}${maxIterations > 0 ? `/${maxIterations}` : ""} for ${convKey}`);
        const llmMessages = this.buildLlmMessages(convKey, msg, bot);

        const llmResult = await this.callProviderWithFailover(llmMessages, {
          temperature: this.config.temperature,
          maxTokens: this.config.maxTokens,
          model: this.getActiveModel() || undefined,
        });

        const rawText = llmResult.content;
        if (!rawText || !rawText.trim()) {
          this.log.warn("iterative invoke: LLM returned empty response, stopping");
          break;
        }

        // Process the response
        let processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);
        try {
          processedText = await this.config.postProcess(processedText, msg);
        } catch { /* ignore */ }
        if (this.config.responsePrefix) {
          processedText = this.config.responsePrefix + processedText;
        }

        // Add to conversation history
        this.conversationManager.addAssistantMessage(convKey, rawText);

        // Check for more command invocations in this response
        const invokeResult = await this.handleCommandInvocations(bot, msg, processedText);
        if (invokeResult) {
          processedText = invokeResult.firstRoundText;
        }

        // Send this round's response IMMEDIATELY before the next iteration
        await this.sendResponse(bot, msg, processedText);

        // If no more follow-up markers, the loop ends
        if (!invokeResult?.hasFollowUp) {
          this.log.info(`iterative invoke: no more follow-ups after round ${iteration}, done`);
          break;
        }

        // Prepare for next iteration
        followUpResults = invokeResult.followUpResults;

      } catch (err) {
        this.log.error(`iterative invoke: round ${iteration} failed: ${(err as Error).message}`);
        break;
      }
    }
  }

  /**
   * Send the processed LLM response to the user/group.
   *
   * Handles long message splitting.
   */
  private async sendResponse(bot: YuanbaoBot, msg: ChatMessage, text: string): Promise<number> {
    const chunks = splitTextChunks(text);
    const isGroup = msg.chatType === "group";

    for (const chunk of chunks) {
      if (isGroup && msg.groupCode) {
        await bot.sendGroupMessage(msg.groupCode, chunk);
      } else {
        await bot.sendDirectMessage(msg.fromUserId, chunk);
      }
    }

    return chunks.length;
  }

  // ─── Direct LLM call (for CLI usage) ───

  /**
   * Make a direct LLM call without message context.
   *
   * Useful for CLI commands where the user wants to interact
   * with the LLM directly.
   */
  async chat(
    prompt: string,
    conversationKey?: string,
  ): Promise<{ text: string; processedText: string }> {
    const key = conversationKey || "cli:default";

    // Add user message to history
    this.conversationManager.addUserMessage(key, prompt);

    const messages = this.buildLlmMessages(key, {
      id: "cli",
      fromUserId: "cli-user",
      chatType: "direct",
      text: prompt,
      timestamp: Date.now(),
    });

    const result = await this.callProviderWithFailover(messages, {
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      model: this.getActiveModel() || undefined,
    });

    const rawText = result.content;
    const processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);

    // Add to history
    this.conversationManager.addAssistantMessage(key, rawText);

    return { text: rawText, processedText };
  }
}

// ─── Factory ───

/**
 * Create a pre-configured LlmTakeoverEngine instance.
 */
export function createLlmTakeover(config?: LlmTakeoverConfig & { persistencePath?: string }): LlmTakeoverEngine {
  return new LlmTakeoverEngine(config);
}
