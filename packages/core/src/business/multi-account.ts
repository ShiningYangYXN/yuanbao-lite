/**
 * Multi-account management — run and manage multiple YuanbaoBot instances.
 *
 * Features:
 *   - Add/remove/start/stop multiple bot accounts
 *   - Switch between accounts for CLI operations
 *   - Event aggregation across accounts
 *   - Per-account state tracking
 *   - Broadcast messages across all accounts
 *   - Named account aliases
 */

import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import { YuanbaoBot } from "../index.js";
import type { YuanbaoBotConfig } from "../index.js";
import type { ChatMessage, BotState } from "../types.js";

// ─── Types ───

export type AccountEntry = {
  /** Unique account ID */
  id: string;
  /** Human-readable name */
  name?: string;
  /** The bot instance */
  bot: YuanbaoBot;
  /** Current state */
  state: BotState;
  /** Whether this account is currently active in the CLI */
  active: boolean;
  /** When the account was added */
  addedAt: number;
  /** Custom tags/metadata */
  tags?: string[];
};

export type MultiAccountConfig = {
  /** Account definitions: id -> bot config */
  accounts?: Record<string, YuanbaoBotConfig & { name?: string; tags?: string[] }>;
  /** The default active account ID */
  defaultAccountId?: string;
};

export type MultiAccountEvent = {
  /** Which account emitted the event */
  accountId: string;
  /** The event type */
  type: string;
  /** The event data */
  data: unknown;
};

// ─── MultiAccountManager ───

export class MultiAccountManager {
  private accounts = new Map<string, AccountEntry>();
  private activeAccountId: string | null = null;
  private eventHandlers = new Map<string, Set<(event: MultiAccountEvent) => void>>();
  private log: ModuleLog;

  constructor(config?: MultiAccountConfig) {
    this.log = createLog("multi-account");

    // Initialize accounts from config
    if (config?.accounts) {
      for (const [id, acctConfig] of Object.entries(config.accounts)) {
        this.addAccount(id, acctConfig, acctConfig.name, acctConfig.tags);
      }
    }

    // Set default active account
    if (config?.defaultAccountId && this.accounts.has(config.defaultAccountId)) {
      this.activeAccountId = config.defaultAccountId;
      this.accounts.get(config.defaultAccountId)!.active = true;
    } else if (this.accounts.size > 0) {
      // Default to the first account
      const firstId = [...this.accounts.keys()][0];
      this.activeAccountId = firstId;
      this.accounts.get(firstId)!.active = true;
    }
  }

  // ─── Account management ───

  /**
   * Add a new account.
   *
   * Creates a YuanbaoBot instance with the given config and registers
   * event handlers for aggregation.
   */
  addAccount(
    id: string,
    config: YuanbaoBotConfig,
    name?: string,
    tags?: string[],
  ): AccountEntry {
    if (this.accounts.has(id)) {
      throw new Error(`Account "${id}" already exists. Remove it first or use a different ID.`);
    }

    const bot = new YuanbaoBot(config);
    const entry: AccountEntry = {
      id,
      name: name || config.name || id,
      bot,
      state: { status: "disconnected", connected: false },
      active: false,
      addedAt: Date.now(),
      tags,
    };

    this.accounts.set(id, entry);

    // Set up event forwarding
    this.setupAccountEventHandlers(id, bot);

    // Set as active if it's the first account
    if (this.accounts.size === 1) {
      this.activeAccountId = id;
      entry.active = true;
    }

    this.log.info(`account added: ${id} (${name || "unnamed"})`);
    return entry;
  }

  /**
   * Remove an account by ID.
   *
   * Stops the bot if it's running, then removes it from the manager.
   */
  removeAccount(id: string): boolean {
    const entry = this.accounts.get(id);
    if (!entry) return false;

    // Stop the bot
    entry.bot.stop();

    // Remove from tracking
    this.accounts.delete(id);

    // If this was the active account, switch to another
    if (this.activeAccountId === id) {
      if (this.accounts.size > 0) {
        const newActive = [...this.accounts.keys()][0];
        this.switchAccount(newActive);
      } else {
        this.activeAccountId = null;
      }
    }

    this.log.info(`account removed: ${id}`);
    return true;
  }

  /**
   * Get an account entry by ID.
   */
  getAccount(id: string): AccountEntry | undefined {
    return this.accounts.get(id);
  }

  /**
   * Get all account entries.
   */
  getAllAccounts(): AccountEntry[] {
    return [...this.accounts.values()];
  }

  /**
   * Get the number of accounts.
   */
  get size(): number {
    return this.accounts.size;
  }

  // ─── Active account ───

  /**
   * Switch the active account.
   *
   * The active account is the one used for CLI commands like /dm, /group, etc.
   */
  switchAccount(id: string): boolean {
    const entry = this.accounts.get(id);
    if (!entry) return false;

    // Deactivate current
    if (this.activeAccountId) {
      const current = this.accounts.get(this.activeAccountId);
      if (current) current.active = false;
    }

    // Activate new
    this.activeAccountId = id;
    entry.active = true;

    this.log.info(`switched active account: ${id}`);
    return true;
  }

  /**
   * Get the active account entry.
   */
  getActiveAccount(): AccountEntry | undefined {
    if (!this.activeAccountId) return undefined;
    return this.accounts.get(this.activeAccountId);
  }

  /**
   * Get the active bot instance.
   */
  getActiveBot(): YuanbaoBot | undefined {
    return this.getActiveAccount()?.bot;
  }

  /**
   * Get the active account ID.
   */
  getActiveAccountId(): string | null {
    return this.activeAccountId;
  }

  // ─── Lifecycle ───

  /**
   * Start a specific account's bot.
   */
  async startAccount(id: string): Promise<void> {
    const entry = this.accounts.get(id);
    if (!entry) throw new Error(`Account "${id}" not found`);

    this.log.info(`starting account: ${id}`);

    // Set up state tracking
    entry.bot.on("stateChange", (state: BotState) => {
      entry.state = state;
      this.emitEvent(id, "stateChange", state);
    });

    entry.bot.on("ready", (data) => {
      this.emitEvent(id, "ready", data);
    });

    entry.bot.on("error", (err: Error) => {
      this.emitEvent(id, "error", err);
    });

    await entry.bot.start();
  }

  /**
   * Stop a specific account's bot.
   */
  stopAccount(id: string): void {
    const entry = this.accounts.get(id);
    if (!entry) return;

    entry.bot.stop();
    entry.state = { status: "disconnected", connected: false };
    this.log.info(`stopped account: ${id}`);
  }

  /**
   * Start all accounts.
   */
  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [id] of this.accounts) {
      promises.push(
        this.startAccount(id).catch((err) => {
          this.log.error(`failed to start account ${id}: ${(err as Error).message}`);
        }),
      );
    }
    await Promise.allSettled(promises);
  }

  /**
   * Stop all accounts.
   */
  stopAll(): void {
    for (const [id] of this.accounts) {
      this.stopAccount(id);
    }
  }

  // ─── Broadcast ───

  /**
   * Send a text message from all connected accounts.
   */
  async broadcastText(params: {
    to: string;
    text: string;
    isGroup?: boolean;
  }): Promise<{ sent: number; failed: number; errors: string[] }> {
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const [id, entry] of this.accounts) {
      if (!entry.state.connected) continue;

      try {
        await entry.bot.sendText({
          to: params.to,
          text: params.text,
          isGroup: params.isGroup,
        });
        sent++;
      } catch (err) {
        failed++;
        errors.push(`[${id}] ${(err as Error).message}`);
      }
    }

    return { sent, failed, errors };
  }

  // ─── Events ───

  /**
   * Register an event handler for aggregated events from all accounts.
   */
  onEvent(handler: (event: MultiAccountEvent) => void): void {
    if (!this.eventHandlers.has("global")) {
      this.eventHandlers.set("global", new Set());
    }
    this.eventHandlers.get("global")!.add(handler);
  }

  /**
   * Remove an event handler.
   */
  offEvent(handler: (event: MultiAccountEvent) => void): void {
    this.eventHandlers.get("global")?.delete(handler);
  }

  // ─── Internal ───

  private setupAccountEventHandlers(accountId: string, bot: YuanbaoBot): void {
    bot.on("message", (msg: ChatMessage) => {
      this.emitEvent(accountId, "message", msg);
    });

    bot.on("directMessage", (msg: ChatMessage) => {
      this.emitEvent(accountId, "directMessage", msg);
    });

    bot.on("groupMessage", (msg: ChatMessage) => {
      this.emitEvent(accountId, "groupMessage", msg);
    });

    bot.on("kickout", (data) => {
      this.emitEvent(accountId, "kickout", data);
    });
  }

  private emitEvent(accountId: string, type: string, data: unknown): void {
    const event: MultiAccountEvent = { accountId: accountId, type, data };
    const handlers = this.eventHandlers.get("global");
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          this.log.error(`event handler error: ${(err as Error).message}`);
        }
      }
    }
  }
}
