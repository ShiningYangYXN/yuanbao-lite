/**
 * Alias management system — ID aliases with optional nicknames and persistence.
 *
 * Provides a way to define short aliases for user/group IDs,
 * with optional custom default nicknames and file-based persistence.
 *
 * Usage:
 *   /alias add <id> <alias> [nickname]   — add alias
 *   /alias remove <alias|id>             — remove alias
 *   /alias list                          — list all aliases
 *   /alias save                          — save to disk
 *   /alias load                          — load from disk
 *   /alias resolve <alias|id>            — resolve to original ID
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";

// ─── Types ───

export type AliasEntry = {
  /** The original ID (user ID or group code) */
  id: string;
  /** The short alias name */
  alias: string;
  /** Custom default nickname for this ID */
  nickname?: string;
  /** When this alias was created (Unix ms) */
  createdAt: number;
};

export type AliasStoreConfig = {
  /** Path to the persistence file (JSON). If omitted, aliases are in-memory only. */
  persistencePath?: string;
  /** Whether to auto-save on every mutation (default: false) */
  autoSave?: boolean;
};

// ─── AliasStore ───

export class AliasStore {
  private aliases = new Map<string, AliasEntry>();   // alias -> entry
  private idIndex = new Map<string, AliasEntry>();    // id -> entry
  private config: AliasStoreConfig;
  private log: ModuleLog;

  constructor(config?: AliasStoreConfig) {
    this.config = {
      persistencePath: config?.persistencePath,
      autoSave: config?.autoSave ?? false,
    };
    this.log = createLog("alias");

    // Auto-load if persistence path is set; auto-create the file if it doesn't exist
    if (this.config.persistencePath) {
      const fileExisted = existsSync(this.config.persistencePath);
      this.load();
      if (!fileExisted) {
        this.save();
      }
    }
  }

  // ─── CRUD ───

  /**
   * Add an alias for an ID with optional custom nickname.
   *
   * If the alias already exists, it will be overwritten.
   * If the ID already has a different alias, the old alias is removed first.
   */
  add(id: string, alias: string, nickname?: string): AliasEntry {
    // Remove old alias for this ID if exists
    const existing = this.idIndex.get(id);
    if (existing) {
      this.aliases.delete(existing.alias);
    }

    // Remove old entry for this alias if exists
    const existingAlias = this.aliases.get(alias);
    if (existingAlias) {
      this.idIndex.delete(existingAlias.id);
    }

    const entry: AliasEntry = {
      id,
      alias,
      nickname: nickname?.trim() || undefined,
      createdAt: Date.now(),
    };

    this.aliases.set(alias, entry);
    this.idIndex.set(id, entry);

    this.log.info(`alias added: ${alias} -> ${id}${nickname ? ` (nick: ${nickname})` : ""}`);
    this.maybeAutoSave();

    return entry;
  }

  /**
   * Remove an alias by alias name or original ID.
   *
   * @returns true if an alias was removed
   */
  remove(aliasOrId: string): boolean {
    // Try as alias first
    const byAlias = this.aliases.get(aliasOrId);
    if (byAlias) {
      this.aliases.delete(byAlias.alias);
      this.idIndex.delete(byAlias.id);
      this.log.info(`alias removed: ${byAlias.alias} -> ${byAlias.id}`);
      this.maybeAutoSave();
      return true;
    }

    // Try as ID
    const byId = this.idIndex.get(aliasOrId);
    if (byId) {
      this.aliases.delete(byId.alias);
      this.idIndex.delete(byId.id);
      this.log.info(`alias removed: ${byId.alias} -> ${byId.id}`);
      this.maybeAutoSave();
      return true;
    }

    return false;
  }

  /**
   * Resolve an alias or ID to the original ID.
   *
   * If the input is an alias, returns the mapped ID.
   * If the input is already an ID (has a registered alias), returns the ID itself.
   * If not found, returns the input as-is (assuming it's a raw ID).
   */
  resolve(aliasOrId: string): string {
    const byAlias = this.aliases.get(aliasOrId);
    if (byAlias) return byAlias.id;
    // Check if it's a known ID — return as-is
    if (this.idIndex.has(aliasOrId)) return aliasOrId;
    // Unknown — return as-is
    return aliasOrId;
  }

  /**
   * Get the nickname for an alias or ID.
   *
   * Returns the custom nickname if set, otherwise undefined.
   */
  getNickname(aliasOrId: string): string | undefined {
    const byAlias = this.aliases.get(aliasOrId);
    if (byAlias) return byAlias.nickname;
    const byId = this.idIndex.get(aliasOrId);
    if (byId) return byId.nickname;
    return undefined;
  }

  /**
   * Update the nickname for an existing alias entry.
   */
  setNickname(aliasOrId: string, nickname: string): boolean {
    const entry = this.aliases.get(aliasOrId) ?? this.idIndex.get(aliasOrId);
    if (!entry) return false;
    entry.nickname = nickname.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Get an alias entry by alias name or ID.
   */
  get(aliasOrId: string): AliasEntry | undefined {
    return this.aliases.get(aliasOrId) ?? this.idIndex.get(aliasOrId);
  }

  /**
   * Get all alias entries.
   */
  getAll(): AliasEntry[] {
    return [...this.aliases.values()];
  }

  /**
   * Get the number of registered aliases.
   */
  get size(): number {
    return this.aliases.size;
  }

  // ─── Persistence ───

  /**
   * Save aliases to the configured persistence file.
   */
  save(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured, cannot save");
      return false;
    }

    try {
      const dir = dirname(this.config.persistencePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = [...this.aliases.values()];
      writeFileSync(this.config.persistencePath, JSON.stringify(data, null, 2), "utf-8");
      this.log.info(`aliases saved to ${this.config.persistencePath} (${data.length} entries)`);
      return true;
    } catch (err) {
      this.log.error(`failed to save aliases: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Load aliases from the configured persistence file.
   *
   * Merges with existing in-memory aliases (file entries take precedence).
   */
  load(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured, cannot load");
      return false;
    }

    try {
      if (!existsSync(this.config.persistencePath)) {
        this.log.info("persistence file not found, starting with empty store");
        return true;
      }

      const raw = readFileSync(this.config.persistencePath, "utf-8");
      const data = JSON.parse(raw) as AliasEntry[];

      for (const entry of data) {
        if (!entry.alias || !entry.id) continue;
        this.aliases.set(entry.alias, entry);
        this.idIndex.set(entry.id, entry);
      }

      this.log.info(`aliases loaded from ${this.config.persistencePath} (${data.length} entries)`);
      return true;
    } catch (err) {
      this.log.error(`failed to load aliases: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Clear all aliases (does not affect the persistence file).
   */
  clear(): void {
    this.aliases.clear();
    this.idIndex.clear();
    this.maybeAutoSave();
  }

  private maybeAutoSave(): void {
    if (this.config.autoSave && this.config.persistencePath) {
      this.save();
    }
  }
}

// ─── Singleton for convenience ───

let globalAliasStore: AliasStore | null = null;

/**
 * Get or create the global alias store.
 */
export function getGlobalAliasStore(config?: AliasStoreConfig): AliasStore {
  if (!globalAliasStore) {
    globalAliasStore = new AliasStore(config);
  }
  return globalAliasStore;
}

/**
 * Reset the global alias store (useful for testing).
 */
export function resetGlobalAliasStore(): void {
  globalAliasStore = null;
}
