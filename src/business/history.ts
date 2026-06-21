/**
 * Message history store — in-memory message history with optional persistence,
 * full-text search, and multi-dimensional filtering.
 *
 * Features:
 *   - In-memory ring buffer with configurable size limit
 *   - Optional file-based persistence (JSONL format)
 *   - Full-text keyword search with case-insensitive matching
 *   - Filter by: user, group, chat type, time range, content
 *   - Pagination support for large result sets
 *   - Statistics (message counts, active users/groups)
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { ChatMessage } from "../types.js";

// ─── Types ───

export type HistoryFilter = {
  /** Filter by sender user ID */
  fromUserId?: string;
  /** Filter by group code */
  groupCode?: string;
  /** Filter by chat type */
  chatType?: "direct" | "group";
  /** Filter by minimum timestamp (inclusive, Unix ms) */
  since?: number;
  /** Filter by maximum timestamp (inclusive, Unix ms) */
  until?: number;
  /** Full-text keyword search (case-insensitive) */
  keyword?: string;
  /** Regular expression search */
  regex?: string;
  /** Whether the keyword/regex should match fromNickname too */
  searchNickname?: boolean;
};

export type HistoryPage = {
  /** The messages in this page */
  messages: ChatMessage[];
  /** Total number of matching messages */
  total: number;
  /** Current page number (1-based) */
  page: number;
  /** Page size */
  pageSize: number;
  /** Total number of pages */
  totalPages: number;
};

export type HistoryStats = {
  /** Total messages stored */
  totalMessages: number;
  /** Number of direct messages */
  directMessages: number;
  /** Number of group messages */
  groupMessages: number;
  /** Unique users seen */
  uniqueUsers: number;
  /** Unique groups seen */
  uniqueGroups: number;
  /** Time range of stored messages */
  oldestAt?: number;
  newestAt?: number;
};

export type HistoryStoreConfig = {
  /** Maximum number of messages to keep in memory (default: 10000) */
  maxMessages?: number;
  /** Path to the persistence file (JSONL format). If omitted, in-memory only. */
  persistencePath?: string;
  /** Whether to auto-persist every new message (default: false) */
  autoPersist?: boolean;
  /** Whether to auto-load on startup (default: true if persistencePath is set) */
  autoLoad?: boolean;
};

// ─── HistoryStore ───

export class MessageHistoryStore {
  private messages: ChatMessage[] = [];
  private config: Required<Pick<HistoryStoreConfig, "maxMessages" | "autoPersist">> & {
    persistencePath?: string;
    autoLoad: boolean;
  };
  private log: ModuleLog;

  constructor(config?: HistoryStoreConfig) {
    this.config = {
      maxMessages: config?.maxMessages ?? 10000,
      persistencePath: config?.persistencePath,
      autoPersist: config?.autoPersist ?? false,
      autoLoad: config?.autoLoad ?? Boolean(config?.persistencePath),
    };
    this.log = createLog("history");

    if (this.config.autoLoad && this.config.persistencePath) {
      const fileExisted = existsSync(this.config.persistencePath);
      this.load();
      if (!fileExisted) {
        this.save();
      }
    }
  }

  // ─── Add messages ───

  /**
   * Add a message to the history store.
   *
   * If the store exceeds maxMessages, the oldest messages are evicted.
   */
  add(msg: ChatMessage): void {
    this.messages.push(msg);

    // Enforce size limit
    while (this.messages.length > this.config.maxMessages) {
      this.messages.shift();
    }

    this.maybeAutoPersist(msg);
  }

  /**
   * Add multiple messages at once.
   */
  addMany(msgs: ChatMessage[]): void {
    for (const msg of msgs) {
      this.add(msg);
    }
  }

  // ─── Query ───

  /**
   * Search messages with filtering and pagination.
   */
  search(filter: HistoryFilter, page = 1, pageSize = 50): HistoryPage {
    const filtered = this.applyFilter(filter);
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));

    const start = (safePage - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const messages = filtered.slice(start, end);

    return { messages, total, page: safePage, pageSize, totalPages };
  }

  /**
   * Get messages matching a filter (no pagination, returns all matches).
   *
   * Use with caution for large stores — prefer search() with pagination.
   */
  getHistory(filter?: HistoryFilter): ChatMessage[] {
    return filter ? this.applyFilter(filter) : [...this.messages];
  }

  /**
   * Get recent messages (optionally filtered).
   */
  getRecent(count = 20, filter?: HistoryFilter): ChatMessage[] {
    const pool = filter ? this.applyFilter(filter) : this.messages;
    return pool.slice(-count);
  }

  /**
   * Get a specific message by ID.
   */
  getById(id: string): ChatMessage | undefined {
    return this.messages.find(m => m.id === id);
  }

  /**
   * Remove a message by ID (used for recall handling).
   * Returns true if a message was removed, false if not found.
   */
  removeById(id: string): boolean {
    const idx = this.messages.findIndex(m => m.id === id);
    if (idx < 0) return false;
    this.messages.splice(idx, 1);
    this.save();
    return true;
  }

  /**
   * Get messages from a specific user.
   */
  getByUser(userId: string, limit = 50): ChatMessage[] {
    return this.applyFilter({ fromUserId: userId }).slice(-limit);
  }

  /**
   * Get messages in a specific group.
   */
  getByGroup(groupCode: string, limit = 50): ChatMessage[] {
    return this.applyFilter({ groupCode }).slice(-limit);
  }

  /**
   * Get messages in a time range.
   */
  getByTimeRange(since: number, until?: number, limit = 200): ChatMessage[] {
    return this.applyFilter({ since, until }).slice(-limit);
  }

  /**
   * Full-text keyword search (case-insensitive).
   *
   * Searches in message text and optionally in sender nickname.
   */
  searchByKeyword(keyword: string, options?: { searchNickname?: boolean; limit?: number }): ChatMessage[] {
    const lower = keyword.toLowerCase();
    const results = this.messages.filter(msg => {
      if (msg.text.toLowerCase().includes(lower)) return true;
      if (options?.searchNickname && msg.fromNickname?.toLowerCase().includes(lower)) return true;
      return false;
    });
    return options?.limit ? results.slice(-options.limit) : results;
  }

  /**
   * Regular expression search.
   */
  searchByRegex(pattern: string, flags = "i", limit = 200): ChatMessage[] {
    try {
      const regex = new RegExp(pattern, flags);
      return this.messages.filter(m => regex.test(m.text)).slice(-limit);
    } catch {
      this.log.warn(`invalid regex pattern: ${pattern}`);
      return [];
    }
  }

  // ─── Statistics ───

  /**
   * Get statistics about the stored messages.
   */
  getStats(): HistoryStats {
    const users = new Set<string>();
    const groups = new Set<string>();
    let directCount = 0;
    let groupCount = 0;

    for (const msg of this.messages) {
      users.add(msg.fromUserId);
      if (msg.chatType === "group") {
        groupCount++;
        if (msg.groupCode) groups.add(msg.groupCode);
      } else {
        directCount++;
      }
    }

    return {
      totalMessages: this.messages.length,
      directMessages: directCount,
      groupMessages: groupCount,
      uniqueUsers: users.size,
      uniqueGroups: groups.size,
      oldestAt: this.messages[0]?.timestamp,
      newestAt: this.messages[this.messages.length - 1]?.timestamp,
    };
  }

  /**
   * Get the number of stored messages.
   */
  get size(): number {
    return this.messages.length;
  }

  // ─── Persistence ───

  /**
   * Save all messages to the persistence file (JSONL format).
   */
  save(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured");
      return false;
    }

    try {
      const dir = dirname(this.config.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const lines = this.messages.map(m => JSON.stringify(m)).join("\n") + "\n";
      writeFileSync(this.config.persistencePath, lines, "utf-8");
      this.log.info(`history saved: ${this.messages.length} messages to ${this.config.persistencePath}`);
      return true;
    } catch (err) {
      this.log.error(`failed to save history: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Append a single message to the persistence file (efficient for auto-persist).
   */
  append(msg: ChatMessage): boolean {
    if (!this.config.persistencePath) return false;

    try {
      const dir = dirname(this.config.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      appendFileSync(this.config.persistencePath, JSON.stringify(msg) + "\n", "utf-8");
      return true;
    } catch (err) {
      this.log.error(`failed to append history: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Load messages from the persistence file.
   *
   * Respects maxMessages limit — oldest messages are discarded if the file is larger.
   */
  load(): boolean {
    if (!this.config.persistencePath) return false;

    try {
      if (!existsSync(this.config.persistencePath)) {
        this.log.info("persistence file not found, starting with empty history");
        return true;
      }

      const raw = readFileSync(this.config.persistencePath, "utf-8").trim();
      if (!raw) return true;

      const lines = raw.split("\n");
      const loaded: ChatMessage[] = [];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          loaded.push(JSON.parse(line) as ChatMessage);
        } catch {
          // Skip malformed lines
        }
      }

      // Keep only the most recent maxMessages
      const toKeep = loaded.slice(-this.config.maxMessages);
      this.messages = toKeep;

      this.log.info(`history loaded: ${toKeep.length} messages from ${this.config.persistencePath}`);
      return true;
    } catch (err) {
      this.log.error(`failed to load history: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Clear all stored messages (does not affect the persistence file).
   */
  clear(): void {
    this.messages = [];
    this.log.info("history cleared");
  }

  // ─── Internal ───

  private applyFilter(filter: HistoryFilter): ChatMessage[] {
    let result = this.messages;

    if (filter.fromUserId) {
      result = result.filter(m => m.fromUserId === filter.fromUserId);
    }

    if (filter.groupCode) {
      result = result.filter(m => m.groupCode === filter.groupCode);
    }

    if (filter.chatType) {
      result = result.filter(m => m.chatType === filter.chatType);
    }

    if (filter.since !== undefined) {
      result = result.filter(m => m.timestamp >= filter.since!);
    }

    if (filter.until !== undefined) {
      result = result.filter(m => m.timestamp <= filter.until!);
    }

    if (filter.keyword) {
      const lower = filter.keyword.toLowerCase();
      result = result.filter(m => {
        if (m.text.toLowerCase().includes(lower)) return true;
        if (filter.searchNickname && m.fromNickname?.toLowerCase().includes(lower)) return true;
        return false;
      });
    }

    if (filter.regex) {
      try {
        const regex = new RegExp(filter.regex, "i");
        result = result.filter(m => regex.test(m.text));
      } catch {
        // Invalid regex — skip regex filter
      }
    }

    return result;
  }

  private maybeAutoPersist(msg: ChatMessage): void {
    if (this.config.autoPersist && this.config.persistencePath) {
      this.append(msg);
    }
  }
}

// ─── Singleton ───

let globalHistoryStore: MessageHistoryStore | null = null;

/**
 * Get or create the global message history store.
 */
export function getGlobalHistoryStore(config?: HistoryStoreConfig): MessageHistoryStore {
  if (!globalHistoryStore) {
    globalHistoryStore = new MessageHistoryStore(config);
  }
  return globalHistoryStore;
}

/**
 * Reset the global history store.
 */
export function resetGlobalHistoryStore(): void {
  globalHistoryStore = null;
}

// ─── History Formatting ───

export type HistoryFormatOptions = {
  /** Maximum width for the output (default: 80) */
  maxWidth?: number;
  /** Whether to colorize output with ANSI codes (default: true) */
  colorize?: boolean;
  /** Whether to show group name (default: true for group messages) */
  showGroupName?: boolean;
  /** Bot user ID, used to determine outgoing messages */
  botId?: string;
};

/**
 * Format a single chat message into a structured, readable line.
 *
 * Format:
 *   [14:23:05] 📨 张三                    │ 你好，这是一个测试消息
 *   [14:23:12] 📤 李四                    │ @张三 收到了！
 *   [14:25:01] 📨 王五                    │ [图片]
 *   [14:25:30] 📨 王五                    │ [文件: report.pdf (2.3MB)]
 */
export function formatHistoryMessage(msg: ChatMessage, options?: HistoryFormatOptions): string {
  const maxWidth = options?.maxWidth ?? 80;
  const colorize = options?.colorize ?? true;
  const showGroupName = options?.showGroupName ?? true;
  const botId = options?.botId;

  // Message ID (short form for readability, last 8 chars)
  const msgId = msg.id || "";
  const shortId = msgId.length > 8 ? msgId.slice(-8) : msgId;

  // Time in HH:MM:SS format
  const date = new Date(msg.timestamp);
  const time = date.toLocaleTimeString("zh-CN", { hour12: false });

  // Direction icon: 📤 for outgoing (bot is sender), 📨 for incoming
  const isOutgoing = botId && msg.fromUserId === botId;
  const icon = isOutgoing ? "📤" : "📨";

  // Sender name with ID for reply usage
  const senderName = msg.fromNickname || msg.fromUserId;
  const senderDisplay = `${senderName}(${msg.fromUserId})`;
  const senderPadded = senderDisplay.length > 28 ? senderDisplay.substring(0, 26) + ".." : senderDisplay.padEnd(28);

  // Group name prefix when applicable
  let groupPrefix = "";
  if (showGroupName && msg.chatType === "group" && msg.groupName) {
    groupPrefix = `[${msg.groupName}] `;
  }

  // Message content with type indicators
  const text = formatMessageContent(msg);

  // Truncate long messages with ellipsis
  const maxTextLen = maxWidth - 12 - 2 - 28 - 3 - groupPrefix.length - 10; // [time] icon sender │ #id text
  const truncatedText = text.length > maxTextLen ? text.substring(0, maxTextLen - 1) + "…" : text;

  const line = `[${time}] ${icon} ${groupPrefix}${senderPadded} │ #${shortId} ${truncatedText}`;

  if (!colorize) return line;

  // Apply colors
  const timeColored = `\x1b[2m[${time}]\x1b[0m`;
  const iconColored = isOutgoing ? `\x1b[36m${icon}\x1b[0m` : `\x1b[32m${icon}\x1b[0m`;
  const senderColored = `\x1b[1m${senderPadded}\x1b[0m`;
  const groupColored = groupPrefix ? `\x1b[33m${groupPrefix}\x1b[0m` : "";
  const idColored = `\x1b[90m#${shortId}\x1b[0m`;

  return `${timeColored} ${iconColored} ${groupColored}${senderColored} │ ${idColored} ${truncatedText}`;
}

/**
 * Format message content with type indicators for special message types.
 */
function formatMessageContent(msg: ChatMessage): string {
  // Check for special message types in rawBody
  if (msg.rawBody && msg.rawBody.length > 0) {
    const parts: string[] = [];

    for (const elem of msg.rawBody) {
      switch (elem.msg_type) {
        case "TIMImageElem":
          parts.push("[图片]");
          break;
        case "TIMFileElem":
          if (elem.msg_content.file_name) {
            const size = elem.msg_content.file_size;
            const sizeStr = size ? formatFileSize(size) : "";
            parts.push(`[文件: ${elem.msg_content.file_name}${sizeStr ? ` (${sizeStr})` : ""}]`);
          } else {
            parts.push("[文件]");
          }
          break;
        case "TIMFaceElem":
          parts.push("[表情]");
          break;
        case "TIMCustomElem":
          // Sticker
          if (elem.msg_content.desc?.includes("贴纸") || elem.msg_content.data?.includes("sticker")) {
            parts.push("[贴纸]");
          } else {
            parts.push("[自定义消息]");
          }
          break;
        case "TIMTextElem":
          if (elem.msg_content.text) {
            // Check for @mentions
            let text = elem.msg_content.text;
            if (msg.mentions && msg.mentions.length > 0) {
              for (const mention of msg.mentions) {
                text += ` [@${mention.displayName}]`;
              }
            }
            parts.push(text);
          }
          break;
        default:
          // Unknown type, skip
          break;
      }
    }

    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  // Fallback to text
  let text = msg.text || "(空消息)";
  if (msg.mentions && msg.mentions.length > 0) {
    const mentionTags = msg.mentions.map(m => `[@${m.displayName}]`).join(" ");
    text += ` ${mentionTags}`;
  }
  return text;
}

/**
 * Format file size in human-readable form.
 */
function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${bytes}B`;
}

/**
 * Format a list of chat messages with header and footer.
 *
 * Format:
 *   ── 消息历史 (最近 20 条) ──────────────────
 *   [formatted messages]
 *   ── 共 20 条 ───────────────────────────────
 */
export function formatHistoryList(messages: ChatMessage[], options?: HistoryFormatOptions & { title?: string }): string {
  if (messages.length === 0) {
    return "暂无历史消息";
  }

  const title = options?.title ?? `消息历史 (最近 ${messages.length} 条)`;
  const headerWidth = Math.max(title.length + 8, 40);

  const lines: string[] = [];
  lines.push(`── ${title} ${"─".repeat(Math.max(0, headerWidth - title.length - 5))}`);

  for (const msg of messages) {
    lines.push(formatHistoryMessage(msg, options));
  }

  const footer = `共 ${messages.length} 条`;
  lines.push(`── ${footer} ${"─".repeat(Math.max(0, headerWidth - footer.length - 5))}`);

  return lines.join("\n");
}
