/**
 * ContentId store — maps short contentId references to full content
 * (forwarded chat records, web pages, etc.)
 *
 * When a message contains forwarded records or link cards, instead of
 * injecting the full content into LLM context (which wastes tokens),
 * we store the content and inject a [content:abc123] reference.
 * The LLM can then use /query <contentId> to view the full content.
 *
 * Content is stored in-memory (Map) with a simple LRU eviction policy.
 * Persistence is NOT needed — content is only relevant for the current
 * session's LLM context.
 */

import { createLog } from "../logger.js";

const log = createLog("content-store");

type ContentEntry = {
  /** Short ID like "abc123" for easy reference in /query */
  contentId: string;
  /** Content type: "forwarded_records" | "link_card" | "web_page" */
  type: string;
  /** Full expanded content (what /query returns) */
  content: string;
  /** Original source description (for logging) */
  source: string;
  /** When stored (Unix ms) */
  storedAt: number;
};

const MAX_ENTRIES = 200;
const store = new Map<string, ContentEntry>();

/**
 * Generate a short contentId (6 chars, alphanumeric).
 */
function generateContentId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Store content and return a contentId reference.
 * If the same content (by source) already exists, reuse its contentId.
 */
export function storeContent(type: string, content: string, source: string): string {
  // Check if content with same source already exists
  for (const [id, entry] of store) {
    if (entry.source === source && entry.type === type) {
      return id;
    }
  }
  // LRU eviction: remove oldest if at capacity
  if (store.size >= MAX_ENTRIES) {
    const oldest = [...store.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (oldest) {
      store.delete(oldest[0]);
      log.debug(`evicted old content ${oldest[0]} (LRU)`);
    }
  }
  const contentId = generateContentId();
  store.set(contentId, {
    contentId,
    type,
    content,
    source,
    storedAt: Date.now(),
  });
  log.debug(`stored content ${contentId} (type=${type}, ${content.length} chars)`);
  return contentId;
}

/**
 * Retrieve content by contentId.
 * Returns the ContentEntry or undefined if not found.
 */
export function getContent(contentId: string): ContentEntry | undefined {
  return store.get(contentId);
}

/**
 * List all stored content (for /query list).
 */
export function listContent(): ContentEntry[] {
  return [...store.values()].sort((a, b) => b.storedAt - a.storedAt);
}

/**
 * Clear all stored content (for /new /reset).
 */
export function clearContent(): void {
  store.clear();
  log.debug("cleared all content");
}
