/**
 * Shared utilities for command handlers.
 *
 * Only GENERIC helpers belong here — functions that are used by multiple
 * handlers and are not specific to any single command.
 *
 * Command-specific helpers (e.g. extractAttachments for /attachment,
 * findMessageByIdOrSuffix for /reply and /attachment) stay in their
 * respective handler files.
 */

import type { ChatMessage } from "../types.js";

// ─── Message helpers (used by /search, /reply, /inspect, etc.) ───

/** Get the short form of a message ID (last 8 chars, or "?" if no ID). */
export function shortId(msg: ChatMessage): string {
  if (!msg.id) return "?";
  return msg.id.length > 8 ? msg.id.slice(-8) : msg.id;
}

/** Return text or "(非文本)" if empty/undefined. */
export function textOrDefault(text: string | undefined): string {
  return text && text.length > 0 ? text : "(非文本)";
}

/** Truncate text to a limit, or return as-is if limit is undefined. */
export function truncate(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  return text.substring(0, limit);
}
