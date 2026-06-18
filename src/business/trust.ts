/**
 * User trust management — persistent trusted user list with fine-grained
 * per-command authorization.
 *
 * Design:
 *   - The bot owner (master) is always trusted and cannot be removed.
 *   - All trust is PERSISTED to ~/.yuanbao-lite/trust.json (survives restarts).
 *   - "Temporary trust" is the DEFAULT — adding a user to the trust list
 *     grants them the ability to use /unsafe and other trust-gated commands.
 *     There is no separate "temporary" vs "permanent" distinction; trust
 *     entries persist until explicitly removed.
 *   - Per-command per-user authorization: a trusted user can be granted
 *     time-limited access to a specific dmOnly command in group chat,
 *     WITHOUT enabling global unsafe mode. This is more granular than
 *     /unsafe allow (which is global, not per-user).
 *
 * Interaction with block.ts:
 *   - A user in the block list CANNOT be added to trust. addTrust() will
 *     refuse and return an error.
 *   - When a user is blocked, they are IMMEDIATELY removed from trust
 *     (block.ts calls removeTrustOnBlock).
 *   - block has higher priority than trust: a blocked user is denied even
 *     if they somehow appear in the trust list.
 *
 * Persistence: ~/.yuanbao-lite/trust.json
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLog } from "../logger.js";

const log = createLog("trust");

const TRUST_FILE = join(homedir(), ".yuanbao-lite", "trust.json");

export type TrustEntry = {
  /** User ID (Yuanbao account ID) */
  userId: string;
  /** Display nickname (for readability) */
  nickname?: string;
  /** When the trust was granted (Unix ms) */
  trustedAt: number;
  /** Whether this is the bot owner (master) — cannot be removed */
  isMaster: boolean;
  /**
   * Per-command authorization grants for this user.
   * Map: commandName (lowercase) → { expiresAt: 0 means forever, grantedAt }
   * These allow the user to run specific dmOnly commands in group chat
   * without enabling global unsafe mode.
   */
  commandGrants?: Record<string, { expiresAt: number; grantedAt: number }>;
};

export type TrustData = {
  version: number;
  /** The bot owner's user ID — always trusted, auto-added on first connection */
  masterUserId: string | null;
  entries: TrustEntry[];
};

let cache: TrustData | null = null;
/** In-memory timers for expiring command grants (not persisted). */
const grantTimers = new Map<string, ReturnType<typeof setTimeout>>();

function load(): TrustData {
  if (cache) return cache;
  try {
    if (existsSync(TRUST_FILE)) {
      const raw = readFileSync(TRUST_FILE, "utf-8");
      cache = JSON.parse(raw) as TrustData;
      return cache;
    }
  } catch (err) {
    log.warn(`failed to load trust file: ${(err as Error).message}`);
  }
  cache = { version: 1, masterUserId: null, entries: [] };
  return cache;
}

function save(): void {
  try {
    const dir = join(homedir(), ".yuanbao-lite");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(TRUST_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    log.error(`failed to save trust file: ${(err as Error).message}`);
  }
}

/** Clear all in-memory grant timers (called on shutdown). */
export function clearGrantTimers(): void {
  for (const t of grantTimers.values()) clearTimeout(t);
  grantTimers.clear();
}

function grantTimerKey(userId: string, cmdName: string): string {
  return `${userId}:${cmdName}`;
}

/**
 * Set the master (bot owner) user ID. Called when the bot connects and
 * resolves its owner. The master is auto-trusted and cannot be removed.
 */
export function setMasterUserId(userId: string, nickname?: string): void {
  const data = load();
  data.masterUserId = userId;
  const existing = data.entries.find(e => e.userId === userId);
  if (!existing) {
    data.entries.push({
      userId,
      nickname,
      trustedAt: Date.now(),
      isMaster: true,
    });
  } else {
    existing.isMaster = true;
    if (nickname) existing.nickname = nickname;
  }
  save();
}

/**
 * Check if a user is trusted.
 * The master is always trusted.
 */
export function isTrusted(userId: string): boolean {
  const data = load();
  if (data.masterUserId === userId) return true;
  return data.entries.some(e => e.userId === userId);
}

/**
 * Add a user to the trust list.
 * Returns { ok, reason? }. Refuses if the user is blocked.
 * Returns ok=false (reason="already") if already trusted.
 */
export async function addTrust(userId: string, nickname?: string): Promise<{ ok: boolean; reason?: string }> {
  // Check block list first — blocked users cannot be trusted
  try {
    const { isBlocked } = await import("./block.js");
    if (isBlocked(userId)) {
      return { ok: false, reason: "用户已被封禁，不能添加到信任列表。请先解封：/block remove <ID>" };
    }
  } catch {
    // block module optional — proceed if not available
  }
  const data = load();
  const existing = data.entries.find(e => e.userId === userId);
  if (existing) {
    if (nickname) {
      existing.nickname = nickname;
      save();
    }
    return { ok: false, reason: "already" };
  }
  data.entries.push({
    userId,
    nickname,
    trustedAt: Date.now(),
    isMaster: data.masterUserId === userId,
  });
  save();
  log.info(`user ${userId} added to trust list`);
  return { ok: true };
}

/**
 * Remove a user from the trust list.
 * The master cannot be removed — returns { ok: false, reason }.
 * Also clears all their command grants.
 */
export function removeTrust(userId: string): { ok: boolean; reason?: string } {
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry) {
    return { ok: false, reason: "用户不在信任列表中" };
  }
  if (entry.isMaster || data.masterUserId === userId) {
    return { ok: false, reason: "主人不能被移出信任列表" };
  }
  // Clear all grant timers for this user
  if (entry.commandGrants) {
    for (const cmdName of Object.keys(entry.commandGrants)) {
      const t = grantTimers.get(grantTimerKey(userId, cmdName));
      if (t) clearTimeout(t);
      grantTimers.delete(grantTimerKey(userId, cmdName));
    }
  }
  data.entries = data.entries.filter(e => e.userId !== userId);
  save();
  log.info(`user ${userId} removed from trust list`);
  return { ok: true };
}

/**
 * Called by block.ts when a user is blocked — immediately removes them
 * from trust if present. Does NOT remove the master (master cannot be
 * blocked — block.ts enforces this).
 */
export function removeTrustOnBlock(userId: string): void {
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry) return;
  if (entry.isMaster || data.masterUserId === userId) {
    // Master cannot be blocked — block.ts should have refused, but defend
    log.warn(`refused to remove master ${userId} from trust on block`);
    return;
  }
  // Clear grant timers
  if (entry.commandGrants) {
    for (const cmdName of Object.keys(entry.commandGrants)) {
      const t = grantTimers.get(grantTimerKey(userId, cmdName));
      if (t) clearTimeout(t);
      grantTimers.delete(grantTimerKey(userId, cmdName));
    }
  }
  data.entries = data.entries.filter(e => e.userId !== userId);
  save();
  log.info(`user ${userId} removed from trust list (blocked)`);
}

/**
 * Grant a specific command to a user for a limited time.
 * The user does NOT need to be trusted first — this is a standalone grant.
 * @param userId - The user to grant the command to
 * @param cmdName - The command name (lowercase, no prefix)
 * @param durationMs - Duration in ms (0 = forever)
 */
export async function grantCommand(userId: string, cmdName: string, durationMs: number): Promise<{ ok: boolean; reason?: string }> {
  // Blocked users cannot receive grants
  try {
    const { isBlocked } = await import("./block.js");
    if (isBlocked(userId)) {
      return { ok: false, reason: "用户已被封禁，不能授权命令" };
    }
  } catch {
    // block module optional
  }
  const normalized = cmdName.toLowerCase().replace(/^\//, "");
  const data = load();
  let entry = data.entries.find(e => e.userId === userId);
  if (!entry) {
    // Auto-add to trust list with a note that this is a grant-only entry
    entry = {
      userId,
      trustedAt: Date.now(),
      isMaster: data.masterUserId === userId,
      commandGrants: {},
    };
    data.entries.push(entry);
  }
  if (!entry.commandGrants) entry.commandGrants = {};

  // Clear existing timer for this grant
  const oldTimer = grantTimers.get(grantTimerKey(userId, normalized));
  if (oldTimer) clearTimeout(oldTimer);

  const expiresAt = durationMs > 0 ? Date.now() + durationMs : 0;
  entry.commandGrants[normalized] = { expiresAt, grantedAt: Date.now() };

  if (durationMs > 0) {
    const timer = setTimeout(() => {
      const d = load();
      const e = d.entries.find(x => x.userId === userId);
      if (e?.commandGrants) {
        delete e.commandGrants[normalized];
        save();
      }
      grantTimers.delete(grantTimerKey(userId, normalized));
      log.info(`grant expired: ${userId} /${normalized}`);
    }, durationMs);
    grantTimers.set(grantTimerKey(userId, normalized), timer);
  }

  save();
  log.info(`granted /${normalized} to ${userId}${durationMs > 0 ? ` for ${durationMs}ms` : " (forever)"}`);
  return { ok: true };
}

/**
 * Revoke a specific command grant from a user.
 */
export function revokeCommand(userId: string, cmdName: string): { ok: boolean; reason?: string } {
  const normalized = cmdName.toLowerCase().replace(/^\//, "");
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry || !entry.commandGrants || !(normalized in entry.commandGrants)) {
    return { ok: false, reason: `用户没有 /${normalized} 的授权` };
  }
  const t = grantTimers.get(grantTimerKey(userId, normalized));
  if (t) clearTimeout(t);
  grantTimers.delete(grantTimerKey(userId, normalized));
  delete entry.commandGrants[normalized];
  save();
  log.info(`revoked /${normalized} from ${userId}`);
  return { ok: true };
}

/**
 * Check if a user has been granted a specific command (time-limited or forever).
 * Auto-cleans expired grants.
 */
export function hasCommandGrant(userId: string, cmdName: string): boolean {
  const normalized = cmdName.toLowerCase().replace(/^\//, "");
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry?.commandGrants) return false;
  const grant = entry.commandGrants[normalized];
  if (!grant) return false;
  if (grant.expiresAt === 0) return true; // forever
  if (grant.expiresAt <= Date.now()) {
    // Expired — clean up
    delete entry.commandGrants[normalized];
    save();
    return false;
  }
  return true;
}

/**
 * List all command grants for a user.
 */
export function listCommandGrants(userId: string): Array<{ command: string; expiresAt: number; forever: boolean }> {
  const data = load();
  const entry = data.entries.find(e => e.userId === userId);
  if (!entry?.commandGrants) return [];
  const now = Date.now();
  const result: Array<{ command: string; expiresAt: number; forever: boolean }> = [];
  for (const [cmd, g] of Object.entries(entry.commandGrants)) {
    if (g.expiresAt === 0 || g.expiresAt > now) {
      result.push({ command: cmd, expiresAt: g.expiresAt, forever: g.expiresAt === 0 });
    }
  }
  return result;
}

/**
 * List all trusted users.
 */
export function listTrust(): TrustEntry[] {
  return load().entries.slice();
}

/**
 * Get the master user ID (if set).
 */
export function getMasterUserId(): string | null {
  return load().masterUserId;
}

/**
 * Get a single trust entry by user ID (or null).
 */
export function getTrustEntry(userId: string): TrustEntry | null {
  return load().entries.find(e => e.userId === userId) ?? null;
}
