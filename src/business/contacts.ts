/**
 * Contact management system — private chat contacts with persistence.
 *
 * Provides a way to save and manage frequently-contacted user IDs
 * with nicknames, tags, and file-based persistence.
 *
 * CLI commands:
 *   /contacts                        — list all saved contacts
 *   /contacts add <id> <name> [tag]  — add a contact
 *   /contacts remove <name|id>       — remove a contact
 *   /contacts rename <name|id> <new> — rename a contact
 *   /contacts tag <name|id> <tag>    — set tag for a contact
 *   /contacts save                   — save to disk
 *   /contacts dm <name|id>           — start DM with a contact
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";

// ─── Types ───

export type ContactEntry = {
  /** User ID (Yuanbao account ID) */
  id: string;
  /** Display name / nickname for this contact */
  name: string;
  /** Optional tag (e.g. "friend", "work", "bot-owner") */
  tag?: string;
  /** Optional notes */
  notes?: string;
  /** Whether this is a favorite / frequently contacted */
  favorite?: boolean;
  /** When this contact was created (Unix ms) */
  createdAt: number;
  /** When this contact was last used (Unix ms) */
  lastUsedAt?: number;
};

export type ContactStoreConfig = {
  /** Path to the persistence file (JSON). If omitted, contacts are in-memory only. */
  persistencePath?: string;
  /** Whether to auto-save on every mutation (default: false) */
  autoSave?: boolean;
};

// ─── ContactStore ───

export class ContactStore {
  private contacts = new Map<string, ContactEntry>();   // name -> entry (case-insensitive key)
  private idIndex = new Map<string, ContactEntry>();     // id -> entry
  private config: ContactStoreConfig;
  private log: ModuleLog;

  constructor(config?: ContactStoreConfig) {
    this.config = {
      persistencePath: config?.persistencePath,
      autoSave: config?.autoSave ?? false,
    };
    this.log = createLog("contacts");

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
   * Add a contact.
   *
   * If a contact with the same name already exists, it will be overwritten.
   * If the ID already has a different name, the old name entry is removed first.
   */
  add(id: string, name: string, tag?: string, notes?: string): ContactEntry {
    const normalizedName = name.toLowerCase();

    // Remove old name for this ID if exists
    const existing = this.idIndex.get(id);
    if (existing) {
      this.contacts.delete(existing.name.toLowerCase());
    }

    // Remove old entry for this name if exists (different ID)
    const existingName = this.contacts.get(normalizedName);
    if (existingName && existingName.id !== id) {
      this.idIndex.delete(existingName.id);
    }

    const entry: ContactEntry = {
      id,
      name,
      tag: tag?.trim() || undefined,
      notes: notes?.trim() || undefined,
      favorite: false,
      createdAt: Date.now(),
    };

    this.contacts.set(normalizedName, entry);
    this.idIndex.set(id, entry);

    this.log.info(`contact added: ${name} -> ${id}${tag ? ` [${tag}]` : ""}`);
    this.maybeAutoSave();

    return entry;
  }

  /**
   * Remove a contact by name or ID.
   *
   * @returns true if a contact was removed
   */
  remove(nameOrId: string): boolean {
    // Try as name first
    const byName = this.contacts.get(nameOrId.toLowerCase());
    if (byName) {
      this.contacts.delete(byName.name.toLowerCase());
      this.idIndex.delete(byName.id);
      this.log.info(`contact removed: ${byName.name} -> ${byName.id}`);
      this.maybeAutoSave();
      return true;
    }

    // Try as ID
    const byId = this.idIndex.get(nameOrId);
    if (byId) {
      this.contacts.delete(byId.name.toLowerCase());
      this.idIndex.delete(byId.id);
      this.log.info(`contact removed: ${byId.name} -> ${byId.id}`);
      this.maybeAutoSave();
      return true;
    }

    return false;
  }

  /**
   * Resolve a name or ID to the contact's user ID.
   *
   * If the input is a name, returns the mapped ID.
   * If the input is already an ID (has a registered contact), returns the ID itself.
   * If not found, returns the input as-is (assuming it's a raw ID).
   */
  resolve(nameOrId: string): string {
    const byName = this.contacts.get(nameOrId.toLowerCase());
    if (byName) return byName.id;
    if (this.idIndex.has(nameOrId)) return nameOrId;
    return nameOrId;
  }

  /**
   * Get a contact entry by name or ID.
   */
  get(nameOrId: string): ContactEntry | undefined {
    return this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
  }

  /**
   * Rename a contact.
   */
  rename(nameOrId: string, newName: string): boolean {
    const entry = this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
    if (!entry) return false;

    // Remove old name key
    this.contacts.delete(entry.name.toLowerCase());

    // Update name
    entry.name = newName;
    this.contacts.set(newName.toLowerCase(), entry);
    this.maybeAutoSave();
    return true;
  }

  /**
   * Set or update the tag for a contact.
   */
  setTag(nameOrId: string, tag: string): boolean {
    const entry = this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
    if (!entry) return false;
    entry.tag = tag.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Set or update notes for a contact.
   */
  setNotes(nameOrId: string, notes: string): boolean {
    const entry = this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
    if (!entry) return false;
    entry.notes = notes.trim() || undefined;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Toggle favorite status for a contact.
   */
  toggleFavorite(nameOrId: string): boolean {
    const entry = this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
    if (!entry) return false;
    entry.favorite = !entry.favorite;
    this.maybeAutoSave();
    return true;
  }

  /**
   * Update lastUsedAt timestamp for a contact.
   */
  touch(nameOrId: string): void {
    const entry = this.contacts.get(nameOrId.toLowerCase()) ?? this.idIndex.get(nameOrId);
    if (entry) {
      entry.lastUsedAt = Date.now();
      this.maybeAutoSave();
    }
  }

  /**
   * Search contacts by name, tag, or ID substring.
   */
  search(query: string): ContactEntry[] {
    const q = query.toLowerCase();
    const results: ContactEntry[] = [];

    for (const entry of this.contacts.values()) {
      if (
        entry.name.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q) ||
        (entry.tag && entry.tag.toLowerCase().includes(q)) ||
        (entry.notes && entry.notes.toLowerCase().includes(q))
      ) {
        results.push(entry);
      }
    }

    return results;
  }

  /**
   * Get all contacts, optionally sorted.
   */
  getAll(sortBy: "name" | "lastUsed" | "created" = "name"): ContactEntry[] {
    const entries = [...this.contacts.values()];

    switch (sortBy) {
      case "name":
        return entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      case "lastUsed":
        return entries.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
      case "created":
        return entries.sort((a, b) => b.createdAt - a.createdAt);
    }
  }

  /**
   * Get contacts by tag.
   */
  getByTag(tag: string): ContactEntry[] {
    const t = tag.toLowerCase();
    return [...this.contacts.values()].filter(e => e.tag?.toLowerCase() === t);
  }

  /**
   * Get favorite contacts.
   */
  getFavorites(): ContactEntry[] {
    return [...this.contacts.values()].filter(e => e.favorite);
  }

  /**
   * Get the number of registered contacts.
   */
  get size(): number {
    return this.contacts.size;
  }

  // ─── Persistence ───

  /**
   * Save contacts to the configured persistence file.
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

      const data = [...this.contacts.values()];
      writeFileSync(this.config.persistencePath, JSON.stringify(data, null, 2), "utf-8");
      this.log.info(`contacts saved to ${this.config.persistencePath} (${data.length} entries)`);
      return true;
    } catch (err) {
      this.log.error(`failed to save contacts: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Load contacts from the configured persistence file.
   *
   * Merges with existing in-memory contacts (file entries take precedence).
   */
  load(): boolean {
    if (!this.config.persistencePath) {
      this.log.warn("no persistence path configured, cannot load");
      return false;
    }

    try {
      if (!existsSync(this.config.persistencePath)) {
        this.log.info("persistence file not found, starting with empty contacts");
        return true;
      }

      const raw = readFileSync(this.config.persistencePath, "utf-8");
      const data = JSON.parse(raw) as ContactEntry[];

      for (const entry of data) {
        if (!entry.name || !entry.id) continue;
        this.contacts.set(entry.name.toLowerCase(), entry);
        this.idIndex.set(entry.id, entry);
      }

      this.log.info(`contacts loaded from ${this.config.persistencePath} (${data.length} entries)`);
      return true;
    } catch (err) {
      this.log.error(`failed to load contacts: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Clear all contacts (does not affect the persistence file).
   */
  clear(): void {
    this.contacts.clear();
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

let globalContactStore: ContactStore | null = null;

/**
 * Get or create the global contact store.
 */
export function getGlobalContactStore(config?: ContactStoreConfig): ContactStore {
  if (!globalContactStore) {
    globalContactStore = new ContactStore(config);
  }
  return globalContactStore;
}

/**
 * Reset the global contact store (useful for testing).
 */
export function resetGlobalContactStore(): void {
  globalContactStore = null;
}
