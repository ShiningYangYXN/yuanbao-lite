/**
 * User trust management — persistent trusted user list.
 *
 * The bot owner (configured via appKey) is always trusted and cannot be removed.
 * Trusted users can use /unsafe in groups (non-trusted users get a prompt).
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
};

export type TrustData = {
  version: number;
  /** The bot owner's user ID — always trusted, auto-added on first connection */
  masterUserId: string | null;
  entries: TrustEntry[];
};

let cache: TrustData | null = null;

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

/**
 * Set the master (bot owner) user ID. Called when the bot connects and
 * resolves its owner. The master is auto-trusted and cannot be removed.
 */
export function setMasterUserId(userId: string, nickname?: string): void {
  const data = load();
  data.masterUserId = userId;
  // Ensure master is in the entries list
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
 * Returns true if added, false if already trusted.
 */
export function addTrust(userId: string, nickname?: string): boolean {
  const data = load();
  if (data.entries.some(e => e.userId === userId)) {
    // Update nickname if provided
    if (nickname) {
      const entry = data.entries.find(e => e.userId === userId)!;
      entry.nickname = nickname;
      save();
    }
    return false;
  }
  data.entries.push({
    userId,
    nickname,
    trustedAt: Date.now(),
    isMaster: data.masterUserId === userId,
  });
  save();
  log.info(`user ${userId} added to trust list`);
  return true;
}

/**
 * Remove a user from the trust list.
 * The master cannot be removed — returns false.
 * Returns true if removed, false if not found or is master.
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
  data.entries = data.entries.filter(e => e.userId !== userId);
  save();
  log.info(`user ${userId} removed from trust list`);
  return { ok: true };
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
