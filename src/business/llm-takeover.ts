/**
 * LLM Takeover Module — AI-powered automatic message response.
 *
 * Powered by the Vercel AI SDK (@ai-sdk/*), supporting 5 API formats:
 *   1. openai-chat-completions  — OpenAI /v1/chat/completions (and compatible)
 *   2. anthropic-messages       — Anthropic /v1/messages
 *   3. google-gemini-rest       — Google Gemini REST API
 *   4. aws-bedrock-converse     — AWS Bedrock Converse API
 *   5. azure-openai             — Azure OpenAI (deployment-based)
 *
 * Features:
 * - Command invoke mechanism: LLM can embed <<command>>/cmd<<command>> in responses
 * - Iterative invoke: <<command>>/cmd<<command>>... feeds results back to LLM
 * - Key pools with auto-rotation on failure
 * - Provider pools with auto-switching
 * - Per-conversation history with context injection
 * - Usage/billing tracking per provider
 *
 * @module business/llm-takeover
 */

import { generateText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { marked } from "marked";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { ChatMessage } from "../types.js";
import type { YuanbaoBot } from "../index.js";
import { splitTextChunks } from "./messaging/extract.js";

const _log = createLog("llm-takeover");
void _log;

// ─── API Format Types ───

export type ApiFormat =
  | "openai-chat-completions"
  | "anthropic-messages"
  | "google-gemini-rest"
  | "aws-bedrock-converse"
  | "azure-openai";

export const API_FORMATS: Array<{ value: ApiFormat; label: string; defaultEndpoint: string; defaultModel: string }> = [
  { value: "openai-chat-completions", label: "OpenAI Chat Completions (/v1/chat/completions)", defaultEndpoint: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { value: "anthropic-messages", label: "Anthropic Messages (/v1/messages) — Claude", defaultEndpoint: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-20250514" },
  { value: "google-gemini-rest", label: "Google Gemini REST API", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-2.0-flash" },
  { value: "aws-bedrock-converse", label: "AWS Bedrock Converse API", defaultEndpoint: "", defaultModel: "anthropic.claude-3-5-sonnet-20241022-v2:0" },
  { value: "azure-openai", label: "Azure OpenAI (deployment-based)", defaultEndpoint: "https://{resource}.openai.azure.com/openai", defaultModel: "gpt-4o" },
];

// ─── Provider Config ───

export type ProviderConfig = {
  apiFormat: ApiFormat;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeys?: string[];
  region?: string;
  apiVersion?: string;
};

// ─── Billing/Usage Tracking ───

type UsageRecord = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
};

// ─── LLM Config ───

export type LlmTakeoverConfig = {
  enabled?: boolean;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxHistoryTurns?: number;
  enableInGroup?: boolean;
  enableInDirect?: boolean;
  requireMentionInGroup?: boolean;
  cooldownMs?: number;
  mergeWindowMs?: number;
  responsePrefix?: string;
  shouldRespond?: (msg: ChatMessage) => boolean | Promise<boolean>;
  postProcess?: (text: string, msg: ChatMessage) => string | Promise<string>;
  markdownRawMode?: boolean;
  maxIterate?: number;
  provider?: string;
  customProviders?: Record<string, ProviderConfig>;
  autoRotateKeys?: boolean;
  autoSwitchProvider?: boolean;
  keyCooldownMs?: number;
  maxFailuresBeforeSwitch?: number;
  /** User-defined system prompt appended after the default prompt with a header */
  userSystemPrompt?: string;
};

// ─── Types ───

export type ConversationHistory = { role: "system" | "user" | "assistant"; content: string };
export type ConversationState = { history: ConversationHistory[]; lastResponseAt: number; messageCount: number };
export type LlmResponse = { rawText: string; processedText: string; sent: boolean; chunkCount: number; tokensUsed?: number; markdownRawMode: boolean };
export type TakeoverResult = { handled: boolean; response?: LlmResponse; error?: Error };

// ─── Defaults ───

const DEFAULT_SYSTEM_PROMPT = `你是元宝Lite智能助手，一个友好、专业的AI聊天机器人，运行在腾讯元宝IM平台上。

## 基本行为

- 用简洁、自然的方式回复用户消息，语言与用户保持一致
- 群聊中保持回复简洁（建议不超过500字），避免刷屏
- 复杂问题给出结构化回答，使用markdown格式但保持简单易读
- 不确定答案时诚实说明，不要编造信息
- 你可以主动使用命令来获取信息、执行操作，不必仅依赖自身知识

## 消息条目格式

你收到的每条用户消息都按以下格式呈现（位于对话历史中）：

  [YYYY-MM-DD HH:MM:SS] [昵称](用户ID)@群名或DM: 消息文本 [引用: #消息ID尾号]

字段说明：
- YYYY-MM-DD HH:MM:SS — 消息发送的本地日期和时间（年-月-日 时:分:秒）
- [昵称](用户ID) — 发送者的昵称和稳定用户ID。你可以用 @[昵称](用户ID) 语法在回复中@该用户
- @群名或DM — 群聊时显示群名，私聊显示 DM
- 消息文本 — 用户发送的实际内容。@提及会以 @[昵称](用户ID) 语法在原位显示
  （例如：@[小明](u_abc123) 你好 — 表示用户@了小明并说了"你好"）
- [引用: #消息ID尾号] — 仅当用户引用了某条消息时出现，尾号是该消息ID的最后8位字符

示例：
  [2026-06-19 14:23:05] [小明](u_abc123)@技术交流群: 你好
  [2026-06-19 14:23:18] [小红](u_def456)@技术交流群: @[小明](u_abc123) 看看这个 [引用: #a1b2c3d4]

## 命令执行

你可以在回复中嵌入命令来执行系统操作。格式：

  <<command>>/命令名 参数<<command>>

多个命令可以分行执行，结果会附加在你的回复之后。例如：
  <<command>>/ping<<command>>
  <<command>>/stickers search 狗头<<command>>
  <<command>>/members 707881071<<command>>

## 迭代调用

如果需要查看命令执行结果并基于结果继续回复，在命令标签末尾加...：
  <<command>>/命令名 参数<<command>>...

命令结果会反馈给你，你可以基于结果继续思考和回复。支持无限链式调用。

应主动使用迭代调用的场景：
1. 查询信息后再做判断（先查群成员、历史记录，再回答）
2. 多步骤任务（先搜索，再操作）
3. 需要验证的操作（发送后确认结果）
4. 探索性任务（逐步尝试，根据结果调整策略）

示例：
  用户问"群里有多少人" → <<command>>/groupinfo 群号<<command>>... 查询，再基于结果回答
  用户说"帮我发个表情" → <<command>>/stickers search 关键词<<command>>... 搜索，再用 /sticker 贴纸ID 发送
  用户问"刚才谁说了什么" → <<command>>/hsearch 关键词<<command>>... 搜索，再总结结果

## 安全机制

### 危险模式
某些命令仅限私聊(dmOnly)。在群聊中使用这些命令需要：
- /unsafe on [分钟] — 开启危险模式（默认5分钟），允许所有dmOnly命令在群聊使用
- /unsafe on forever — 永久开启（需受信用户）
- /unsafe off — 关闭危险模式
- /unsafe status — 查看当前状态和已授权命令
- /unsafe 和 /trust 命令本身不支持被授权

### 单命令授权
不需要全局危险模式，可以授权单个命令：
- /unsafe allow <命令名> [分钟|forever] — 授权单个命令在群聊使用（默认5分钟）
- /unsafe disallow <命令名> — 取消授权
- 非dmOnly命令无需授权
- 不可授权命令: unsafe, trust, block, config, init, daemon

### 用户信任与封禁
- 主人（bot owner）自动受信，不可移除
- 受信用户才能开启危险模式或管理信任列表
- /trust status — 查看信任状态（全局开放）
- /trust list|add|remove — 管理信任列表（仅私聊）
- /block — 封禁用户使用全部或部分功能（优先级高于unsafe，可禁用非受限命令）
- 被封禁用户不能被添加到信任列表

## 系统命令

/shell 命令可在服务器上执行系统命令（仅私聊，需受信）：
  <<command>>/shell ls -la<<command>>  — 列出文件
  <<command>>/shell cat /etc/os-release<<command>>  — 查看系统信息
  <<command>>/shell --all python3 script.py<<command>>  — 不截断输出

注意：
- /shell 默认截断输出到2000字符，--all 取消截断
- --all/-h/-? 标志必须在实际命令前，放在命令后会被原样传递给shell

## @提及语法

在回复中可以@群成员，格式为 @[昵称](用户ID)（方括号和圆括号不可省略）：
  @[昵称](用户ID) — 用指定昵称@指定用户
  @[](用户ID) — 用平台默认昵称@指定用户（自动获取昵称）
  @[昵称]() — 群聊中按昵称自动匹配用户ID，多个匹配则全部@
  @[所有人]() — @所有人（逐个@每个群成员）
  @[](all) — @所有人（等价写法）
  @[所有人](all) — @所有人（等价写法）

示例：@[小明](12345) 表示用"小明"@用户12345
注意：必须严格使用 @[...](...) 格式，不可省略方括号或圆括号`;

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MAX_HISTORY_TURNS = 20;
// Cooldown and merge window are DISABLED by default (0ms).
// Rationale: these were designed to prevent spam in busy groups, but they
// cause confusing "skipped" behavior — users send a message and get no
// response because the engine is "cooling down" or "merging". Users who
// need throttling can enable it explicitly via /llm cooldown <ms> and
// /llm merge <ms>.
const DEFAULT_COOLDOWN_MS = 0;
const DEFAULT_MERGE_WINDOW_MS = 0;
const DEFAULT_MAX_ITERATE = 50;

// ─── Provider Factory ───

function createLanguageModel(config: ProviderConfig, activeKey: string): LanguageModel {
  switch (config.apiFormat) {
    case "openai-chat-completions": {
      const provider = createOpenAICompatible({ name: "openai-compatible", baseURL: config.baseUrl.replace(/\/+$/, ""), apiKey: activeKey });
      return provider(config.model);
    }
    case "anthropic-messages": {
      const provider = createAnthropic({ baseURL: config.baseUrl.replace(/\/+$/, ""), apiKey: activeKey });
      return provider(config.model);
    }
    case "google-gemini-rest": {
      const provider = createGoogleGenerativeAI({ baseURL: config.baseUrl.replace(/\/+$/, ""), apiKey: activeKey });
      return provider(config.model);
    }
    case "aws-bedrock-converse": {
      const region = config.region || "us-east-1";
      const provider = createAmazonBedrock({ region, accessKeyId: activeKey });
      return provider(config.model);
    }
    case "azure-openai": {
      const provider = createOpenAI({ baseURL: config.baseUrl.replace(/\/+$/, ""), apiKey: activeKey });
      return provider.chat(config.model);
    }
    default:
      throw new Error(`Unsupported API format: ${config.apiFormat}`);
  }
}

// ─── Markdown ───

marked.setOptions({ gfm: true, breaks: true });

export function markdownToImText(markdown: string): string {
  try {
    return marked.parse(markdown, { async: false }) as string;
  } catch {
    return markdown;
  }
}

// ─── Context Message Formatting ───

/**
 * Format a ChatMessage into the canonical context string injected into LLM
 * conversation history.
 *
 * Format: [YYYY-MM-DD HH:MM:SS] [昵称](用户ID)@群名或DM: 文本 [引用: #消息ID尾号]
 *
 * - Timestamp (YYYY-MM-DD HH:MM:SS, local timezone) gives the LLM full date
 *   + time awareness (useful for "yesterday", "last week" references)
 * - [昵称](用户ID) lets the LLM @mention the user via @[昵称](id) syntax
 * - @群名 (group) or @DM (direct) identifies the conversation scope
 * - [引用: #尾号] suffix appears only when the user quoted a message
 *
 * This is used by both feedLlmContext (in src/index.ts) and the engine's
 * internal formatMessageForLlm fallback, ensuring consistent formatting.
 */
export function formatChatMessageForContext(msg: ChatMessage): string {
  // Timestamp: YYYY-MM-DD HH:MM:SS (local timezone, full date + time)
  const ts = msg.timestamp > 0 ? formatDateTime(msg.timestamp) : "????-??-?? ??:??:??";

  // Sender label: [昵称](用户ID) or [用户ID] when no nickname
  const nick = msg.fromNickname;
  const uid = msg.fromUserId;
  const senderLabel = nick ? `[${nick}](${uid})` : `[${uid}]`;

  // Scope: @群名 (or @群号 if no name) for group, @DM for direct
  const scope = msg.chatType === "group"
    ? `@${msg.groupName || msg.groupCode || "群"}`
    : "@DM";

  // Quote suffix: only when the message references another message
  let quoteSuffix = "";
  if (msg.quoteMsgId && msg.quoteMsgId.length > 0) {
    const tail = msg.quoteMsgId.slice(-8);
    quoteSuffix = ` [引用: #${tail}]`;
  }

  return `[${ts}] ${senderLabel}${scope}: ${msg.text ?? ""}${quoteSuffix}`;
}

/** Format a Unix-ms timestamp as YYYY-MM-DD HH:MM:SS (local timezone). */
function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n < 10 ? `0${n}` : String(n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Conversation Manager ───

export class ConversationManager {
  private conversations = new Map<string, ConversationState>();
  private maxTurns: number;

  constructor(maxTurns: number = DEFAULT_MAX_HISTORY_TURNS) { this.maxTurns = maxTurns; }

  getKey(msg: ChatMessage): string {
    return msg.chatType === "group" ? `group:${msg.groupCode}` : `dm:${msg.fromUserId}`;
  }

  getOrCreate(key: string): ConversationState {
    let state = this.conversations.get(key);
    if (!state) { state = { history: [], lastResponseAt: 0, messageCount: 0 }; this.conversations.set(key, state); }
    return state;
  }

  addUserMessage(key: string, text: string): void {
    const s = this.getOrCreate(key);
    s.history.push({ role: "user", content: text });
    s.messageCount++;
    this.trim(key);
  }

  addAssistantMessage(key: string, text: string): void {
    const s = this.getOrCreate(key);
    s.history.push({ role: "assistant", content: text });
    s.lastResponseAt = Date.now();
    this.trim(key);
  }

  getHistory(key: string): ConversationHistory[] { return this.getOrCreate(key).history; }
  clearHistory(key: string): void { this.conversations.delete(key); }
  clearAll(): void { this.conversations.clear(); }

  private trim(key: string): void {
    const s = this.getOrCreate(key);
    const max = this.maxTurns * 2;
    if (s.history.length > max) s.history = s.history.slice(-max);
  }

  get size(): number { return this.conversations.size; }
  get keys(): Iterable<string> { return this.conversations.keys(); }
}

// ─── LLM Engine ───

export class LlmTakeoverEngine {
  private config: Required<LlmTakeoverConfig>;
  private conversationManager: ConversationManager;
  private log: ModuleLog;
  private mergeBuffer = new Map<string, { messages: ChatMessage[]; timer: ReturnType<typeof setTimeout> }>();
  private persistencePath: string | undefined;
  private activeProviderName: string = "";
  private activeKeyIndex = 0;
  private keyFailures = new Map<string, number>();
  private keyCooldowns = new Map<string, number>();
  private providerFailures = 0;
  private usageRecords: UsageRecord[] = [];

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
      postProcess: config?.postProcess ?? ((t: string) => t),
      markdownRawMode: config?.markdownRawMode ?? true,
      maxIterate: config?.maxIterate ?? DEFAULT_MAX_ITERATE,
      provider: config?.provider ?? "",
      customProviders: config?.customProviders ?? {},
      autoRotateKeys: config?.autoRotateKeys ?? true,
      autoSwitchProvider: config?.autoSwitchProvider ?? true,
      keyCooldownMs: config?.keyCooldownMs ?? 5 * 60 * 1000,
      maxFailuresBeforeSwitch: config?.maxFailuresBeforeSwitch ?? 3,
      userSystemPrompt: config?.userSystemPrompt ?? "",
    };
    this.conversationManager = new ConversationManager(this.config.maxHistoryTurns);
    this.log = createLog("llm-takeover");
    this.persistencePath = config?.persistencePath;
    this.activeProviderName = this.config.provider;
    if (this.persistencePath) {
      const existed = existsSync(this.persistencePath);
      this.loadPersistedConfig();
      if (!existed) this.persistConfig();
    }
  }

  getConfig(): Readonly<Required<LlmTakeoverConfig>> { return { ...this.config }; }

  getPoolStatus() {
    const provider = this.getActiveProviderConfig();
    const keys = this.getActiveKeyPool(provider);
    const now = Date.now();
    return {
      activeProvider: this.activeProviderName,
      activeKeyIndex: this.activeKeyIndex,
      keyPoolSize: keys.length,
      keysInCooldown: keys.filter(k => (this.keyCooldowns.get(k) ?? 0) > now).length,
      providerPoolSize: Object.keys(this.config.customProviders).length,
      providerFailures: this.providerFailures,
      maxFailuresBeforeSwitch: this.config.maxFailuresBeforeSwitch,
    };
  }

  getUsage(): { records: UsageRecord[]; totalTokens: number; totalCalls: number; byProvider: Record<string, { calls: number; tokens: number }> } {
    const byProvider: Record<string, { calls: number; tokens: number }> = {};
    let totalTokens = 0;
    for (const r of this.usageRecords) {
      totalTokens += r.totalTokens;
      if (!byProvider[r.provider]) byProvider[r.provider] = { calls: 0, tokens: 0 };
      byProvider[r.provider].calls++;
      byProvider[r.provider].tokens += r.totalTokens;
    }
    return { records: this.usageRecords.slice(-100), totalTokens, totalCalls: this.usageRecords.length, byProvider };
  }

  clearUsage(): void { this.usageRecords = []; }

  updateConfig(patch: Partial<LlmTakeoverConfig>): void {
    let changed = false;
    if (patch.enabled !== undefined) this.config.enabled = patch.enabled;
    // systemPrompt is locked to DEFAULT_SYSTEM_PROMPT — users can only set userSystemPrompt
    // (which is appended after the default). Ignore any attempt to override systemPrompt.
    // if (patch.systemPrompt !== undefined) this.config.systemPrompt = patch.systemPrompt;
    if (patch.model !== undefined) this.config.model = patch.model;
    if (patch.temperature !== undefined) this.config.temperature = patch.temperature;
    if (patch.maxTokens !== undefined) this.config.maxTokens = patch.maxTokens;
    if (patch.maxHistoryTurns !== undefined) this.config.maxHistoryTurns = patch.maxHistoryTurns;
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
    if (patch.provider !== undefined) { this.config.provider = patch.provider; this.activeProviderName = patch.provider; changed = true; }
    if (patch.customProviders !== undefined) { this.config.customProviders = patch.customProviders; changed = true; }
    if (patch.autoRotateKeys !== undefined) this.config.autoRotateKeys = patch.autoRotateKeys;
    if (patch.autoSwitchProvider !== undefined) this.config.autoSwitchProvider = patch.autoSwitchProvider;
    if (patch.keyCooldownMs !== undefined) this.config.keyCooldownMs = patch.keyCooldownMs;
    if (patch.maxFailuresBeforeSwitch !== undefined) this.config.maxFailuresBeforeSwitch = patch.maxFailuresBeforeSwitch;
    if (patch.userSystemPrompt !== undefined) this.config.userSystemPrompt = patch.userSystemPrompt;
    if (changed) { this.activeKeyIndex = 0; this.providerFailures = 0; }
    if (this.persistencePath) this.persistConfig();
  }

  getPersistencePath(): string | undefined { return this.persistencePath; }
  persistConfig(): void {
    if (!this.persistencePath) return;
    try {
      const dir = dirname(this.persistencePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistencePath, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (e) { this.log.error(`persist failed: ${(e as Error).message}`); }
  }

  private loadPersistedConfig(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.persistencePath, "utf-8")) as Partial<LlmTakeoverConfig>;
      // Never allow persisted config to override the default systemPrompt
      delete saved.systemPrompt;
      this.config = { ...this.config, ...saved };
      this.activeProviderName = this.config.provider;
    } catch (e) { this.log.warn(`load persisted config failed: ${(e as Error).message}`); }
  }

  get isReady(): boolean {
    const p = this.getActiveProviderConfig();
    if (!p) return false;
    return this.getActiveKeyPool(p).length > 0;
  }
  getProvider(): { name: string } | null { return this.isReady ? { name: this.activeProviderName } : null; }
  getConversationManager(): ConversationManager { return this.conversationManager; }

  private getActiveProviderConfig(): ProviderConfig | null {
    return this.config.customProviders[this.activeProviderName] ?? null;
  }
  private getActiveKeyPool(p: ProviderConfig | null): string[] {
    if (!p) return [];
    if (p.apiKeys && p.apiKeys.length > 0) return p.apiKeys;
    return p.apiKey ? [p.apiKey] : [];
  }
  private getActiveApiKey(p: ProviderConfig | null): string {
    const keys = this.getActiveKeyPool(p);
    if (keys.length === 0) return "";
    const now = Date.now();
    for (let i = 0; i < keys.length; i++) {
      const idx = (this.activeKeyIndex + i) % keys.length;
      if ((this.keyCooldowns.get(keys[idx]) ?? 0) <= now) { this.activeKeyIndex = idx; return keys[idx]; }
    }
    return keys[0];
  }
  private markKeyFailed(key: string): void {
    const c = (this.keyFailures.get(key) ?? 0) + 1;
    this.keyFailures.set(key, c);
    if (c >= this.config.maxFailuresBeforeSwitch) {
      this.keyCooldowns.set(key, Date.now() + this.config.keyCooldownMs);
      this.keyFailures.set(key, 0);
      const p = this.getActiveProviderConfig();
      const keys = this.getActiveKeyPool(p);
      if (keys.length > 1 && this.config.autoRotateKeys) this.activeKeyIndex = (this.activeKeyIndex + 1) % keys.length;
    }
  }
  private markKeySuccess(): void {
    const p = this.getActiveProviderConfig();
    const keys = this.getActiveKeyPool(p);
    const k = keys[this.activeKeyIndex];
    if (k) this.keyFailures.set(k, 0);
    this.providerFailures = 0;
  }
  private markProviderFailed(): void {
    this.providerFailures++;
    if (this.providerFailures >= this.config.maxFailuresBeforeSwitch && this.config.autoSwitchProvider && Object.keys(this.config.customProviders).length > 1) {
      this.switchToNextProvider();
    }
  }
  private switchToNextProvider(): void {
    const names = Object.keys(this.config.customProviders);
    if (names.length === 0) return;
    const idx = names.indexOf(this.activeProviderName);
    this.activeProviderName = names[(idx + 1) % names.length];
    this.activeKeyIndex = 0;
    this.providerFailures = 0;
    this.log.info(`switched to provider: ${this.activeProviderName}`);
  }

  // ─── LLM Call ───

  private async callLlm(messages: ConversationHistory[]): Promise<{ content: string; tokensUsed?: number; promptTokens?: number; completionTokens?: number }> {
    const provider = this.getActiveProviderConfig();
    if (!provider) throw new Error(`no provider configured: ${this.activeProviderName}`);
    const maxAttempts = this.getActiveKeyPool(provider).length + Object.keys(this.config.customProviders).length;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const activeKey = this.getActiveApiKey(provider);
      if (!activeKey) throw new Error("no API key available");
      try {
        this.log.info(`calling LLM (${this.activeProviderName}/${provider.apiFormat}) attempt ${attempt + 1}/${maxAttempts}`);
        const model = createLanguageModel(provider, activeKey);
        const systemMessages = messages.filter(m => m.role === "system");
        const chatMessages = messages.filter(m => m.role !== "system");
        const systemPrompt = systemMessages.map(m => m.content).join("\n");

        const result = await generateText({
          model,
          system: systemPrompt || undefined,
          messages: chatMessages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
          temperature: this.config.temperature,
        });

        this.markKeySuccess();

        // Track usage
        const usageObj = result.usage as unknown as Record<string, number>;
        const promptTokens = usageObj?.inputTokens ?? 0;
        const completionTokens = usageObj?.outputTokens ?? 0;
        const totalTokens = usageObj?.totalTokens ?? (promptTokens + completionTokens);
        this.usageRecords.push({
          provider: this.activeProviderName,
          model: provider.model,
          promptTokens,
          completionTokens,
          totalTokens,
          timestamp: Date.now(),
        });

        return { content: result.text, tokensUsed: totalTokens, promptTokens, completionTokens };
      } catch (err) {
        lastError = err as Error;
        const msg = (err as Error).message.toLowerCase();
        if (/401|403|429|rate.?limit|unauthor|invalid.?api.?key/.test(msg)) { this.markKeyFailed(activeKey); continue; }
        if (/5\d{2}|server.?error|timeout|econnreset|enotfound/.test(msg)) { this.markProviderFailed(); continue; }
        throw err;
      }
    }
    throw lastError ?? new Error("all LLM providers failed");
  }

  // ─── Context & Message Building ───

  addContextMessage(msg: ChatMessage, formattedText?: string): void {
    const key = this.conversationManager.getKey(msg);
    const text = formattedText ?? this.formatMessageForLlm(msg);
    this.conversationManager.addUserMessage(key, text);
  }

  private formatMessageForLlm(msg: ChatMessage): string {
    // Format: [HH:MM:SS] [昵称](用户ID)@群名或DM: 文本 [引用: #尾号]
    // - Timestamp helps the LLM understand temporal context
    // - [昵称](用户ID) lets the LLM @mention the user via @[昵称](id) syntax
    // - Quote suffix shows when the user is replying to a specific message
    return formatChatMessageForContext(msg);
  }

  private buildLlmMessages(convKey: string, msg: ChatMessage, bot?: YuanbaoBot): ConversationHistory[] {
    const messages: ConversationHistory[] = [];
    // Start with default system prompt, append user-defined prompt if set
    let systemPrompt = this.config.systemPrompt;
    if (this.config.userSystemPrompt && this.config.userSystemPrompt.trim()) {
      systemPrompt += `\n\n## 用户添加的系统提示词\n\n${this.config.userSystemPrompt.trim()}`;
    }

    // Chat type context
    if (msg.chatType === "group") {
      systemPrompt += `\n\n当前是群聊环境（群名: ${msg.groupName || msg.groupCode || "未知"}，群号: ${msg.groupCode || "未知"}）。请保持回复简洁。`;
    } else {
      systemPrompt += "\n\n当前是私聊环境。";
    }

    // Inject group history
    if (bot && msg.chatType === "group" && msg.groupCode) {
      try {
        const historyStore = bot.getHistoryStore();
        const recent = historyStore.getRecent(30, { groupCode: msg.groupCode });
        if (recent.length > 0) {
          const lines = recent.map(m => {
            const sender = m.fromNickname || m.fromUserId;
            const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
            const shortId = m.id ? (m.id.length > 8 ? m.id.slice(-8) : m.id) : "?";
            return `[${time}] ${sender}(${m.fromUserId}): ${m.text || "(非文本)"} #${shortId}`;
          });
          systemPrompt += `\n\n=== 最近群聊记录 ===\n${lines.join("\n")}\n=== 记录结束 ===`;
        }
      } catch { /* ignore */ }
    }

    // Inject available commands
    if (bot) {
      const cmdSys = bot.getCommandSystem();
      if (cmdSys) {
        const commands = cmdSys.getAll().filter(c => !c.hidden);
        const isGroup = msg.chatType === "group";
        const unsafe = cmdSys.isUnsafeMode();
        const cmdLines: string[] = [];
        for (const cmd of commands) {
          if (isGroup && cmd.dmOnly && !unsafe) continue;
          const aliases = cmd.aliases?.length ? ` (别名: ${cmd.aliases.join(", ")})` : "";
          const dmLabel = cmd.dmOnly ? " [仅私聊]" : "";
          cmdLines.push(`  /${cmd.name}${aliases}${dmLabel} — ${cmd.description}${cmd.usage ? ` | 用法: ${cmd.usage}` : ""}`);
        }
        if (cmdLines.length > 0) {
          systemPrompt += `\n\n=== 可用命令 ===\n${cmdLines.join("\n")}\n=== 命令结束 ===`;
          if (unsafe) {
            systemPrompt += `\n\n你可以通过在回复中嵌入 <<command>>/命令名 参数<<command>> 来执行命令。⚠️ 危险模式已开启，所有命令（包括dmOnly命令）均可在群聊中使用。`;
          } else {
            systemPrompt += `\n\n你可以通过在回复中嵌入 <<command>>/命令名 参数<<command>> 来执行命令。例如: <<command>>/ping<<command>> 或 <<command>>/sticker 狗头<<command>>。在群聊中，dmOnly命令不可用。`;
          }
        }
      }
    }

    messages.push({ role: "system", content: systemPrompt });
    const history = this.conversationManager.getHistory(convKey);
    messages.push(...history);
    return messages;
  }

  // ─── Command Invoke Mechanism ───

  private async handleCommandInvocations(bot: YuanbaoBot, msg: ChatMessage, text: string): Promise<{
    firstRoundText: string;
    hasFollowUp: boolean;
    followUpResults: string[];
  } | null> {
    const invokePattern = /<<command>>\s*(\/\S+(?:\s[^<]*?)?)\s*<<command>>(\.\.\.)?/g;
    const matches = [...text.matchAll(invokePattern)];
    if (matches.length === 0) return null;

    const cmdSystem = bot.getCommandSystem();
    if (!cmdSystem) return null;

    const results: string[] = [];
    const followUpResults: string[] = [];
    let cleanedText = text;
    let hasFollowUp = false;

    for (const match of matches) {
      const fullCmd = match[1].trim();
      const isFollowUp = Boolean(match[2]);
      cleanedText = cleanedText.replace(match[0], "");
      this.log.info(`LLM invoke: ${fullCmd}${isFollowUp ? " (follow-up)" : ""}`);

      const syntheticMsg: ChatMessage = { ...msg, text: fullCmd };
      try {
        let commandOutput = "";
        const captureReply = async (output: string) => { commandOutput += output + "\n"; };
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
        if (isFollowUp) { hasFollowUp = true; followUpResults.push(`[命令执行结果] ${fullCmd} → ${resultText}`); }
      } catch (err) {
        const errorText = `执行失败 — ${(err as Error).message}`;
        results.push(`⚠️ ${fullCmd}: ${errorText}`);
        if (isFollowUp) { hasFollowUp = true; followUpResults.push(`[命令执行结果] ${fullCmd} → ${errorText}`); }
      }
    }

    cleanedText = cleanedText.trim();
    const resultSection = results.join("\n\n");
    const firstRoundText = cleanedText ? (resultSection ? `${cleanedText}\n\n${resultSection}` : cleanedText) : resultSection;

    return { firstRoundText, hasFollowUp, followUpResults };
  }

  private async executeIterativeInvoke(bot: YuanbaoBot, msg: ChatMessage, initialFollowUpResults: string[]): Promise<void> {
    const convKey = this.conversationManager.getKey(msg);
    const maxIter = this.config.maxIterate;
    let followUpResults = initialFollowUpResults;
    let iteration = 0;

    while (true) {
      iteration++;
      if (maxIter > 0 && iteration > maxIter) {
        this.log.warn(`iterative invoke: max iterations (${maxIter}) reached`);
        try {
          const isGroup = msg.chatType === "group";
          const limitMsg = `⚠️ 迭代调用已达上限 (${maxIter}轮)`;
          if (isGroup && msg.groupCode) await bot.sendGroupMessage(msg.groupCode, limitMsg);
          else await bot.sendDirectMessage(msg.fromUserId, limitMsg);
        } catch { /* ignore */ }
        break;
      }

      const followUpContext = followUpResults.join("\n");
      this.conversationManager.addUserMessage(convKey, `[系统] 命令执行反馈 (第${iteration}轮):\n${followUpContext}\n\n请根据以上命令执行结果继续回复。如果还需要执行命令，继续使用 <<command>>...<<command>> 格式。`);

      try {
        this.log.info(`iterative invoke: round ${iteration}${maxIter > 0 ? `/${maxIter}` : ""} for ${convKey}`);
        const llmMessages = this.buildLlmMessages(convKey, msg, bot);
        const llmResult = await this.callLlm(llmMessages);
        const rawText = llmResult.content;
        if (!rawText || !rawText.trim()) { this.log.warn("iterative invoke: empty response, stopping"); break; }

        let processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);
        try { processedText = await this.config.postProcess(processedText, msg); } catch { /* ignore */ }
        if (this.config.responsePrefix) processedText = this.config.responsePrefix + processedText;

        this.conversationManager.addAssistantMessage(convKey, rawText);

        const invokeResult = await this.handleCommandInvocations(bot, msg, processedText);
        if (invokeResult) processedText = invokeResult.firstRoundText;

        await this.sendResponse(bot, msg, processedText);

        if (!invokeResult?.hasFollowUp) { this.log.info(`iterative invoke: done after round ${iteration}`); break; }
        followUpResults = invokeResult.followUpResults;
      } catch (err) {
        this.log.error(`iterative invoke: round ${iteration} failed: ${(err as Error).message}`);
        break;
      }
    }
  }

  private async sendResponse(bot: YuanbaoBot, msg: ChatMessage, text: string): Promise<number> {
    const chunks = splitTextChunks(text, 3000);
    for (const chunk of chunks) {
      if (msg.chatType === "group" && msg.groupCode) await bot.sendGroupMessage(msg.groupCode, chunk);
      else await bot.sendDirectMessage(msg.fromUserId, chunk);
    }
    return chunks.length;
  }

  // ─── Main Entry ───

  async handleMessage(bot: YuanbaoBot, msg: ChatMessage): Promise<TakeoverResult> {
    if (!this.config.enabled || !this.isReady) return { handled: false };
    if (msg.chatType === "group" && !this.config.enableInGroup) return { handled: false };
    if (msg.chatType === "direct" && !this.config.enableInDirect) return { handled: false };
    if (msg.chatType === "group" && this.config.requireMentionInGroup && !msg.isMentioned) return { handled: false };
    try { if (!(await this.config.shouldRespond(msg))) return { handled: false }; } catch { return { handled: false }; }

    const convKey = this.conversationManager.getKey(msg);

    // Cooldown check
    const convState = this.conversationManager.getOrCreate(convKey);
    if (Date.now() - convState.lastResponseAt < this.config.cooldownMs) {
      this.log.debug(`cooldown active for ${convKey}`);
      return { handled: false };
    }

    // Merge window for group messages
    if (msg.chatType === "group" && this.config.mergeWindowMs > 0) {
      return this.handleWithMerge(bot, msg, convKey);
    }
    return this.processMessage(bot, msg, convKey);
  }

  private handleWithMerge(bot: YuanbaoBot, msg: ChatMessage, convKey: string): Promise<TakeoverResult> {
    return new Promise((resolve) => {
      let buffer = this.mergeBuffer.get(convKey);
      if (!buffer) { buffer = { messages: [], timer: null as unknown as ReturnType<typeof setTimeout> }; this.mergeBuffer.set(convKey, buffer); }
      buffer.messages.push(msg);
      if (buffer.timer) clearTimeout(buffer.timer);
      buffer.timer = setTimeout(async () => {
        const msgs = buffer!.messages;
        buffer!.messages = [];
        this.mergeBuffer.delete(convKey);
        if (msgs.length === 0) { resolve({ handled: false }); return; }
        for (const m of msgs) this.addContextMessage(m);
        const result = await this.processMessage(bot, msgs[msgs.length - 1], convKey);
        resolve(result);
      }, this.config.mergeWindowMs);
    });
  }

  private async processMessage(bot: YuanbaoBot, msg: ChatMessage, convKey: string): Promise<TakeoverResult> {
    try {
      const llmMessages = this.buildLlmMessages(convKey, msg, bot);
      this.log.info(`calling LLM for ${convKey}: "${msg.text.substring(0, 50)}..."`);
      const result = await this.callLlm(llmMessages);

      const rawText = result.content;
      if (!rawText || !rawText.trim()) { this.log.warn("LLM returned empty"); return { handled: false }; }

      let processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);
      try { processedText = await this.config.postProcess(processedText, msg); } catch { /* ignore */ }
      if (this.config.responsePrefix) processedText = this.config.responsePrefix + processedText;

      this.conversationManager.addAssistantMessage(convKey, rawText);

      // Handle command invocations
      const invokeResult = await this.handleCommandInvocations(bot, msg, processedText);
      if (invokeResult) processedText = invokeResult.firstRoundText;

      // Send first round immediately
      const chunkCount = await this.sendResponse(bot, msg, processedText);

      // Iterative invoke loop (async, non-blocking)
      if (invokeResult?.hasFollowUp) {
        this.executeIterativeInvoke(bot, msg, invokeResult.followUpResults).catch(err => {
          this.log.error(`iterative invoke error: ${(err as Error).message}`);
        });
      }

      return { handled: true, response: { rawText, processedText, sent: true, chunkCount, tokensUsed: result.tokensUsed, markdownRawMode: this.config.markdownRawMode } };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error(`LLM call failed: ${error.message}`);
      return { handled: false, error };
    }
  }

  // ─── Direct Chat ───

  async chat(prompt: string, conversationKey?: string): Promise<{ rawText: string; processedText: string }> {
    const key = conversationKey || "cli:default";
    this.conversationManager.addUserMessage(key, prompt);
    const messages = this.buildLlmMessages(key, {
      id: "cli", fromUserId: "cli-user", chatType: "direct", text: prompt, timestamp: Date.now(),
    });
    const result = await this.callLlm(messages);
    const rawText = result.content;
    const processedText = this.config.markdownRawMode ? rawText : markdownToImText(rawText);
    this.conversationManager.addAssistantMessage(key, rawText);
    return { rawText, processedText };
  }
}

export function createLlmTakeover(config?: LlmTakeoverConfig & { persistencePath?: string }): LlmTakeoverEngine {
  return new LlmTakeoverEngine(config);
}
