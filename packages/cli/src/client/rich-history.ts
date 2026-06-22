/**
 * Rich command history with persistence, deduplication, and size limits.
 *
 * Provides a shell-like history experience:
 * - Persistent across sessions (saved to ~/.yuanbao-lite/history)
 * - Deduplication of consecutive identical entries
 * - Configurable max size (default 2000 entries)
 * - Reverse search capability
 * - Session boundary markers
 *
 * @module cli/rich-history
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLog } from "@yuanbao-lite/core/logger";

// ─── Constants ───

const DEFAULT_HISTORY_PATH = join(homedir(), ".yuanbao-lite", "history");
const DEFAULT_MAX_SIZE = 2000;

// ─── RichHistory class ───

export class RichHistory {
  private filePath: string;
  private maxSize: number;
  private entries: string[] = [];
  private currentIndex = -1; // for up/down navigation
  private log = createLog("history");

  constructor(options?: { filePath?: string; maxSize?: number }) {
    this.filePath = options?.filePath || DEFAULT_HISTORY_PATH;
    this.maxSize = options?.maxSize || DEFAULT_MAX_SIZE;
    this.load();
  }

  // ─── Public API ───

  /**
   * Add an entry to history.
   * Skips empty lines, duplicates of the last entry, and sensitive commands.
   */
  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Skip if identical to the last entry (dedup consecutive)
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) {
      return;
    }

    // Skip sensitive commands (don't save passwords/keys to disk)
    if (/\/llm\s+(apikey|密钥)\s+\S/.test(trimmed)) return;
    if (/\/alias\s+add\s+.*\s+.*token.*/i.test(trimmed)) return;

    this.entries.push(trimmed);

    // Trim to max size (keep most recent)
    if (this.entries.length > this.maxSize) {
      this.entries = this.entries.slice(-this.maxSize);
    }

    // Append to file immediately
    this.appendToFile(trimmed);

    // Reset navigation index
    this.currentIndex = this.entries.length;
  }

  /**
   * Get the previous entry (up arrow).
   */
  prev(): string | null {
    if (this.entries.length === 0) return null;
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.entries[this.currentIndex];
    }
    return this.entries[0];
  }

  /**
   * Get the next entry (down arrow).
   */
  next(): string | null {
    if (this.currentIndex < this.entries.length - 1) {
      this.currentIndex++;
      return this.entries[this.currentIndex];
    }
    this.currentIndex = this.entries.length;
    return null;
  }

  /**
   * Reset navigation position to the end (after command execution).
   */
  resetNav(): void {
    this.currentIndex = this.entries.length;
  }

  /**
   * Search history for entries containing the given substring.
   * Returns matches in reverse chronological order.
   */
  search(query: string, limit = 20): string[] {
    const lowerQuery = query.toLowerCase();
    const results: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && results.length < limit; i--) {
      if (this.entries[i].toLowerCase().includes(lowerQuery)) {
        results.push(this.entries[i]);
      }
    }
    return results;
  }

  /**
   * Get all entries (for export/debugging).
   */
  getAll(): string[] {
    return [...this.entries];
  }

  /**
   * Get the number of entries.
   */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Clear all history (memory and file).
   */
  clear(): void {
    this.entries = [];
    this.currentIndex = 0;
    try {
      writeFileSync(this.filePath, "", "utf-8");
    } catch {
      // Ignore write errors
    }
  }

  /**
   * Save all history to file (full rewrite).
   */
  save(): void {
    try {
      const dir = join(this.filePath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, this.entries.join("\n"), "utf-8");
    } catch (err) {
      this.log.error(`save failed: ${(err as Error).message}`);
    }
  }

  // ─── Internal ───

  /**
   * Load history from file.
   */
  private load(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.entries = [];
        return;
      }
      const content = readFileSync(this.filePath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());

      // Deduplicate consecutive entries during load
      const deduped: string[] = [];
      for (const line of lines) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
          deduped.push(line);
        }
      }

      // Trim to max size
      this.entries = deduped.length > this.maxSize
        ? deduped.slice(-this.maxSize)
        : deduped;

      this.currentIndex = this.entries.length;
    } catch {
      this.entries = [];
      this.currentIndex = 0;
    }
  }

  /**
   * Append a single entry to the history file.
   */
  private appendToFile(line: string): void {
    try {
      const dir = join(this.filePath, "..");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      appendFileSync(this.filePath, line + "\n", "utf-8");
    } catch {
      // Ignore write errors - history is best-effort
    }
  }
}
