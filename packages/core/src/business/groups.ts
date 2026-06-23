/**
 * Group management system — group chat bookmarks with persistence.
 *
 * Provides a way to save and manage frequently-used group chats
 * with custom names, notes, favorites, and file-based persistence.
 *
 * CLI commands:
 *   /groups                          — list group sessions
 *   /groups add <群号> [名称] [标签] — 添加群聊到收藏
 *   /groups remove <群号>            — 从收藏移除群聊
 *   /groups rename <群号> <新名称>   — 重命名群聊备注
 *   /groups note <群号> <备注>       — 添加群聊备注
 *   /groups tag <群号> <标签>        — 设置标签
 *   /groups fav <群号>               — 切换收藏状态
 *   /groups join <群号>              — 加入群聊会话
 *   /groups save                     — 保存到磁盘
 */

import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { PersistenceAdapter } from "../access/persistence/adapter.js";
import { getDefaultPersistenceAdapter } from "../access/persistence/adapter.js";

// ─── Types ───

export type GroupEntry = {
  /** Group code (群号) */
  groupCode: string;
  /** Custom display name / remark for this group */
  name?: string;
  /** Original group name (from server) */
  groupName?: string;
  /** Optional tag (e.g. "work", "social", "project") */
  tag?: string;
  /** Optional notes / remarks */
  notes?: string;
  /** Whether this is a favorite / bookmarked group */
  favorite?: boolean;
  /** Member count */
  memberCount?: number;
  /** When this group was added (Unix ms) */
  createdAt: number;
  /** When this group was last active (Unix ms) */
  lastActiveAt?: number;
  /** When this group was last used (Unix ms) */
  lastUsedAt?: number;
};

export type GroupStoreConfig = {
  /** Path to the persistence file (JSON). If omitted, groups are in-memory only. */
  persistencePath?: string;
  /** Whether to auto-save on every mutation (default: false) */
  autoSave?: boolean;
  /**
   * Persistence adapter — abstracts file I/O so the store works in browser
   * and edge runtimes. If omitted, the runtime default is used:
   *   - Node.js: NodeFsAdapter (uses node:fs)
   *   - Browser: throws — caller MUST pass an explicit adapter.
   */
  persistenceAdapter?: PersistenceAdapter;
};

// ─── GroupStore ───

export class GroupStore {
  private groups = new Map<string, GroupEntry>(); // groupCode -> entry
  private config: GroupStoreConfig;
  private log: ModuleLog;
  private persistenceAdapter: PersistenceAdapter | null = null;

  constructor(config?: GroupStoreConfig) {
    this.config = {
      persistencePath: config?.persistencePath,
      autoSave: config?.autoSave ?? false,
      persistenceAdapter: config?.persistenceAdapter,
    };
    this.log = createLog("groups");

    // Auto-load if persistence path is set; auto-create the file if it doesn't exist
    if (this.config.persistencePath) {
      const adapter = this.getAdapter();
      const fileExisted = adapter.exists(this.config.persistencePath);
      this.load();
      if (!fileExisted) {
        this.save();
      }
    }
  }

  /**
   * Resolve the persistence adapter — explicit config wins, else runtime default.
   * Throws if no persistencePath is set or no adapter is available (browser).
   */
  private getAdapter(): PersistenceAdapter {
    if (!this.config.persistencePath) {
      throw new Error(
        "GroupStore: persistencePath is required to use persistence",
      );
    }
    if (this.config.persistenceAdapter) {
      return this.config.persistenceAdapter;
    }
    if (!this.persistenceAdapter) {
      this.persistenceAdapter = getDefaultPersistenceAdapter();
    }
    return this.persistenceAdapter;
  }

  // ─── CRUD ───

  /**
   * Add a group.
   *
   * If a group with the same groupCode already exists, it will be updated.
   */
  add(
    groupCode: string,
    name?: string,
    tag?: string,
    notes?: string,
  ): GroupEntry {
    const existing = this.groups.get(groupCode);
    if (existing) {
      // Update existing entry
      if (name) existing.name = name;
      if (tag !== undefined) existing.tag = tag.trim() || undefined;
      if (notes !== undefined) existing.notes = notes.trim() || undefined;
      this.log.info(`group updated: ${groupCode}${name ? ` -> ${name}` : ""}`);
      this.maybeAutoSave();
      return existing;
    }

    const entry: GroupEntry = {
      groupCode,
      name: name?.trim() || undefined,
      tag: tag?.trim() || undefined,
      notes: notes?.trim() || undefined,
      favorite: false,
      createdAt: Date.now(),
    };

    this.groups.set(groupCode, entry);

    this.log.info(
      `group added: ${groupCode}${name ? ` -> ${name}` : ""}${tag ? ` [${tag}]` : ""}`,
    );
    this.maybeAutoSave();

    return entry;
  }

  /**
   * Remove a group by groupCode.
   *
   * @returns true if a group was removed
   */
  remove(groupCode: string): boolean {
    const removed = this.groups.delete(groupCode);
    if (removed) {
      this.log.info(`group removed: ${groupCode}`);
      this.maybeAutoSave();
    }
    return removed;
  }

  /**
   * Get a group entry by groupCode.
   */
  get(groupCode: string): GroupEntry | undefined {
    return this.groups.get(groupCode);
  }

  /**
   * Resolve a groupCode or custom name to the groupCode.
   *
   * If the input is a custom name, returns the mapped groupCode.
   * If not found, returns the input as-is (assuming it's a raw groupCode).
   */
  resolve(nameOrCode: string): string {
    // Try as groupCode first
    const byCode = this.groups.get(nameOrCode);
    if (byCode) return byCode.groupCode;

    // Try as custom name (case-insensitive)
    for (const entry of this.groups.values()) {
      if (entry.name?.toLowerCase() === nameOrCode.toLowerCase()) {
        return entry.groupCode;
      }
    }

    return nameOrCode;
  }

  /**
   * Rename a group's custom display name.
   */
  rename(groupCode: string, newName: string): boolean {
    const entry = this.groups.get(groupCode);
    if (!entry) return false;
    entry.name = newName.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Set or update notes/remarks for a group.
   */
  setNotes(groupCode: string, notes: string): boolean {
    const entry = this.groups.get(groupCode);
    if (!entry) return false;
    entry.notes = notes.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Set or update the tag for a group.
   */
  setTag(groupCode: string, tag: string): boolean {
    const entry = this.groups.get(groupCode);
    if (!entry) return false;
    entry.tag = tag.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Toggle favorite status for a group.
   */
  toggleFavorite(groupCode: string): boolean {
    const entry = this.groups.get(groupCode);
    if (!entry) return false;
    entry.favorite = !entry.favorite;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Update the server-provided group name.
   */
  setGroupName(groupCode: string, groupName: string): void {
    const entry = this.groups.get(groupCode);
    if (entry) {
      entry.groupName = groupName;
      this.maybeAutoSave();
    }
  }

  /**
   * Update member count.
   */
  setMemberCount(groupCode: string, count: number): void {
    const entry = this.groups.get(groupCode);
    if (entry) {
      entry.memberCount = count;
      this.maybeAutoSave();
    }
  }

  /**
   * Update lastActiveAt timestamp for a group.
   */
  touch(groupCode: string): void {
    const entry = this.groups.get(groupCode);
    if (entry) {
      entry.lastActiveAt = Date.now();
      entry.lastUsedAt = Date.now();
      this.maybeAutoSave();
    }
  }

  /**
   * Update lastActiveAt timestamp (called on incoming messages).
   * Also auto-creates an entry if it doesn't exist (auto-track).
   */
  trackActivity(groupCode: string, groupName?: string): void {
    let entry = this.groups.get(groupCode);
    if (!entry) {
      // Auto-track: create entry for any group we see
      entry = {
        groupCode,
        groupName,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      this.groups.set(groupCode, entry);
    } else {
      entry.lastActiveAt = Date.now();
      if (groupName) entry.groupName = groupName;
    }
    this.maybeAutoSave();
  }

  /**
   * Search groups by name, tag, groupCode, or notes substring.
   */
  search(query: string): GroupEntry[] {
    const q = query.toLowerCase();
    const results: GroupEntry[] = [];

    for (const entry of this.groups.values()) {
      if (
        entry.groupCode.includes(q) ||
        (entry.name && entry.name.toLowerCase().includes(q)) ||
        (entry.groupName && entry.groupName.toLowerCase().includes(q)) ||
        (entry.tag && entry.tag.toLowerCase().includes(q)) ||
        (entry.notes && entry.notes.toLowerCase().includes(q))
      ) {
        results.push(entry);
      }
    }

    return results;
  }

  /**
   * Get all groups, optionally sorted.
   */
  getAll(
    sortBy: "name" | "lastActive" | "created" | "code" = "lastActive",
  ): GroupEntry[] {
    const entries = [...this.groups.values()];

    switch (sortBy) {
      case "name":
        return entries.sort((a, b) =>
          (a.name || a.groupName || a.groupCode)
            .toLowerCase()
            .localeCompare(
              (b.name || b.groupName || b.groupCode).toLowerCase(),
            ),
        );
      case "lastActive":
        return entries.sort(
          (a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0),
        );
      case "created":
        return entries.sort((a, b) => b.createdAt - a.createdAt);
      case "code":
        return entries.sort((a, b) => a.groupCode.localeCompare(b.groupCode));
    }
  }

  /**
   * Get groups by tag.
   */
  getByTag(tag: string): GroupEntry[] {
    const t = tag.toLowerCase();
    return [...this.groups.values()].filter((e) => e.tag?.toLowerCase() === t);
  }

  /**
   * Get favorite/bookmarked groups.
   */
  getFavorites(): GroupEntry[] {
    return [...this.groups.values()].filter((e) => e.favorite);
  }

  /**
   * Get the number of registered groups.
   */
  get size(): number {
    return this.groups.size;
  }

  // ─── Persistence ───

  /**
   * Save groups to the configured persistence file.
   */
  save(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured, cannot save");
      return false;
    }

    try {
      const adapter = this.getAdapter();
      const data = [...this.groups.values()];
      adapter.write(this.config.persistencePath, JSON.stringify(data, null, 2));
      this.log.info(
        `groups saved to ${this.config.persistencePath} (${data.length} entries)`,
      );
      return true;
    } catch (err) {
      this.log.error(`failed to save groups: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Load groups from the configured persistence file.
   *
   * Merges with existing in-memory groups (file entries take precedence).
   */
  load(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured, cannot load");
      return false;
    }

    try {
      const adapter = this.getAdapter();
      if (!adapter.exists(this.config.persistencePath)) {
        this.log.info("persistence file not found, starting with empty groups");
        return true;
      }

      const raw = adapter.read(this.config.persistencePath);
      const data = JSON.parse(raw) as GroupEntry[];

      for (const entry of data) {
        if (!entry.groupCode) continue;
        this.groups.set(entry.groupCode, entry);
      }

      this.log.info(
        `groups loaded from ${this.config.persistencePath} (${data.length} entries)`,
      );
      return true;
    } catch (err) {
      this.log.error(`failed to load groups: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Clear all groups (does not affect the persistence file).
   */
  clear(): void {
    this.groups.clear();
    this.maybeAutoSave();
  }

  private maybeAutoSave(): void {
    if (this.config.autoSave && this.config.persistencePath) {
      this.save();
    }
  }
}

// ─── Singleton for convenience ───

let globalGroupStore: GroupStore | null = null;

/**
 * Get or create the global group store.
 */
export function getGlobalGroupStore(config?: GroupStoreConfig): GroupStore {
  if (!globalGroupStore) {
    globalGroupStore = new GroupStore(config);
  }
  return globalGroupStore;
}

/**
 * Reset the global group store (useful for testing).
 */
export function resetGlobalGroupStore(): void {
  globalGroupStore = null;
}
