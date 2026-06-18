/**
 * User block list — persistent per-user feature restrictions.
 *
 * Priority: BLOCK > TRUST > UNSAFE
 *   - A blocked user is denied even if they are trusted or unsafe mode is on.
 *   - A blocked user cannot be added to trust (trust.ts refuses and returns
 *     an error). When a user is blocked, they are IMMEDIATELY removed from
 *     the trust list.
 *
 * Block scopes (per user, multiple can be combined — additive):
 *   - "all"      — deny ALL bot interaction (commands + LLM auto-reply)
 *   - "llm"      — deny LLM auto-reply (slash commands still work, unless
 *                  "all" or the specific command is also blocked)
 *   - "command"  — deny ALL slash commands (LLM still works, unless "llm"
 *                  or "all" is also blocked)
 *   - "<cmd>"    — deny a specific slash command (e.g. "shell", "unsafe").
 *                  Can be any command name, including non-dmOnly commands.
 *                  This is more granular than /unsafe allow (which only
 *                  lifts dmOnly restriction).
 *
 * Special values for /block add:
 *   - "all"     → blocks everything
 *   - "llm"     → blocks LLM auto-reply
 *   - "command" → blocks all slash commands
 *   - any other string → treated as a command name to block specifically
 *
 * Multiple /block add operations on the same user APPEND to the block list
 * (do not replace). Use /block remove <user> [scope] to remove.
 *
 * The master (bot owner) CANNOT be blocked.
 *
 * Persistence: ~/.yuanbao-lite/block.json
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLog } from "../logger.js";

const log = createLog("block");

const BLOCK_FILE = join(homedir(), ".yuanbao-lite", "block.json");

export type BlockEntry = {
  /** User ID (Yuanbao account ID). Use "*" to match ALL users. */
  userId: string;
  /** Display nickname (for readability) */
  nickname?: string;
  /** When the block was first applied (Unix ms) */
  blockedAt: number;
  /**
   * Block scopes — a Set of strings. Possible values:
   *   "all", "llm", "command", or any specific command name (lowercase).
   * Multiple scopes are OR'd: if ANY scope matches the action, the user
   * is blocked from that action.
   */
  scopes: string[];
};

export type BlockData = {
  version: number;
  entries: BlockEntry[];
};

let cache: BlockData | null = null;

function load(): BlockData {
  if (cache) return cache;
  try {
    if (existsSync(BLOCK_FILE)) {
      const raw = readFileSync(BLOCK_FILE, "utf-8");
      cache = JSON.parse(raw) as BlockData;
      return cache;
    }
  } catch (err) {
    log.warn(`failed to load block file: ${(err as Error).message}`);
  }
  cache = { version: 1, entries: [] };
  return cache;
}

function save(): void {
  try {
    const dir = join(homedir(), ".yuanbao-lite");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BLOCK_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    log.error(`failed to save block file: ${(err as Error).message}`);
  }
}

/** Valid special scope values. Any other string is treated as a command name. */
export const SPECIAL_SCOPES = new Set(["all", "llm", "command"]);

/**
 * Normalize a scope string: lowercase, strip leading "/".
 */
function normalizeScope(scope: string): string {
  return scope.toLowerCase().replace(/^\//, "");
}

/**
 * Check if a user is blocked at ALL (has any block entry).
 * Use isBlockedFrom() to check a specific action.
 */
export function isBlocked(userId: string): boolean {
  const data = load();
  return data.entries.some(e => e.userId === userId || e.userId === "*");
}

/**
 * Check if a user is blocked from a specific action.
 * @param userId - The user ID to check
 * @param action - One of: "llm", "command:<cmdName>", or "all"
 *
 * Logic:
 *   - If user has "all" scope → blocked from everything
 *   - If action is "llm" and user has "llm" scope → blocked
 *   - If action is "command:X" and user has "command" scope → blocked
 *   - If action is "command:X" and user has "X" scope → blocked
 *   - Wildcard "*" entries apply to ALL users
 */
export function isBlockedFrom(userId: string, action: string): boolean {
  const data = load();
  const normalizedAction = action.toLowerCase();
  for (const entry of data.entries) {
    // Match this user OR the wildcard "*"
    if (entry.userId !== userId && entry.userId !== "*") continue;
    for (const scope of entry.scopes) {
      if (scope === "all") return true;
      if (normalizedAction === "llm" && scope === "llm") return true;
      if (normalizedAction.startsWith("command:")) {
        const cmdName = normalizedAction.slice("command:".length);
        if (scope === "command") return true;
        if (scope === cmdName) return true;
      }
    }
  }
  return false;
}

/**
 * Check if a user is blocked from LLM auto-reply.
 */
export function isBlockedFromLlm(userId: string): boolean {
  return isBlockedFrom(userId, "llm");
}

/**
 * Check if a user is blocked from a specific command.
 */
export function isBlockedFromCommand(userId: string, cmdName: string): boolean {
  return isBlockedFrom(userId, `command:${cmdName.toLowerCase().replace(/^\//, "")}`);
}

/**
 * Add a block scope to a user. APPENDS to existing scopes (does not replace).
 * Refuses to block the master (bot owner).
 * @param userId - User ID, or "*" for all users
 * @param scope - "all", "llm", "command", or a command name
 * @param nickname - Optional nickname for readability
 */
export async function addBlock(userId: string, scope: string, nickname?: string): Promise<{ ok: boolean; reason?: string }> {
  // Refuse to block the master
  try {
    const { getMasterUserId } = await import("./trust.js");
    const master = getMasterUserId();
    if (master && userId === master) {
      return { ok: false, reason: "不能封禁主人（bot owner）" };
    }
  } catch {
    // trust module optional — proceed (but this should never happen)
  }

  const normalizedScope = normalizeScope(scope);
  if (!normalizedScope) {
    return { ok: false, reason: "无效的封禁范围" };
  }

  const data = load();
  let entry = data.entries.find(e => e.userId === userId);
  if (!entry) {
    entry = {
      userId,
      nickname,
      blockedAt: Date.now(),
      scopes: [],
    };
    data.entries.push(entry);
    // If blocking a real user (not wildcard), immediately remove from trust
    if (userId !== "*") {
      try {
        const { removeTrustOnBlock } = await import("./trust.js");
        removeTrustOnBlock(userId);
      } catch {
        // trust module optional
      }
    }
  } else {
    if (nickname) entry.nickname = nickname;
  }

  if (!entry.scopes.includes(normalizedScope)) {
    entry.scopes.push(normalizedScope);
  }

  save();
  log.info(`block added: ${userId} → ${normalizedScope}`);
  return { ok: true };
}

/**
 * Remove a block scope from a user. If no scope is specified, remove ALL
 * scopes (fully unblock).
 * @param userId - User ID, or "*" for all users
 * @param scope - Optional scope to remove. If omitted, removes all scopes.
 */
export function removeBlock(userId: string, scope?: string): { ok: boolean; reason?: string } {
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry) {
    return { ok: false, reason: "用户不在封禁列表中" };
  }

  if (!scope) {
    // Remove all scopes (delete the entry entirely)
    data.entries = data.entries.filter(e => e.userId !== userId);
    save();
    log.info(`block removed entirely: ${userId}`);
    return { ok: true };
  }

  const normalizedScope = normalizeScope(scope);
  const idx = entry.scopes.indexOf(normalizedScope);
  if (idx < 0) {
    return { ok: false, reason: `用户没有被封禁 ${normalizedScope}` };
  }
  entry.scopes.splice(idx, 1);
  if (entry.scopes.length === 0) {
    data.entries = data.entries.filter(e => e.userId !== userId);
  }
  save();
  log.info(`block scope removed: ${userId} ← ${normalizedScope}`);
  return { ok: true };
}

/**
 * List all blocked users and their scopes.
 */
export function listBlocks(): BlockEntry[] {
  return load().entries.slice();
}

/**
 * Get the block entry for a specific user (or null).
 */
export function getBlockEntry(userId: string): BlockEntry | null {
  return load().entries.find(e => e.userId === userId) ?? null;
}
