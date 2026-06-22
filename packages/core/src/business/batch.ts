/**
 * Batch message sending — configurable count, interval, and JavaScript interpolation.
 *
 * Features:
 *   - Send multiple messages of any type (text, sticker, media)
 *   - Configurable count and interval between messages
 *   - JavaScript $ interpolation: "Hello ${name}" with provided context
 *   - \ escape to prevent interpolation: "\${not_interpolated}" -> "${not_interpolated}"
 *   - Progress tracking and cancellation support
 *   - Rate limiting to prevent flooding
 *
 * Usage:
 *   /batch text <target> <count> <interval_ms> "Hello ${i}"
 *   /batch text <target> 5 1000 "Message ${i} of 5"
 *   /batch text <target> 3 2000 "Hello \${name}, time ${new Date().toISOString()}"
 *   /batch sticker <target> 3 500 sticker_id_prefix_${i}
 *   /batch stop                    — cancel running batch
 *   /batch status                  — show running batch status
 */

import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { YuanbaoBot } from "../index.js";
import {
  interpolate as sharedInterpolate,
  buildBatchContext as sharedBuildBatchContext,
} from "./interpolate.js";

// Re-export for external consumers
export { sharedInterpolate as interpolateTemplate };
export { sharedBuildBatchContext as buildBatchContext };

// ─── Types ───

export type BatchMessageType = "text" | "sticker" | "image" | "file";

export type BatchConfig = {
  /** Type of message to send */
  type: BatchMessageType;
  /** Target user ID or group code */
  target: string;
  /** Whether the target is a group */
  isGroup: boolean;
  /** Number of messages to send */
  count: number;
  /** Interval between messages in milliseconds (minimum: 500) */
  intervalMs: number;
  /** Message template with optional ${...} interpolation */
  template: string;
  /** JavaScript context for interpolation (variable name -> value) */
  context?: Record<string, unknown>;
  /** Sticker ID template (for sticker type) */
  stickerTemplate?: string;
  /** File path template (for image/file type) */
  fileTemplate?: string;
  /** Quote message ID for replies */
  quoteMsgId?: string;
};

export type BatchProgress = {
  /** Total messages to send */
  total: number;
  /** Messages sent so far */
  sent: number;
  /** Messages that failed */
  failed: number;
  /** Whether the batch is running */
  running: boolean;
  /** Whether the batch was cancelled */
  cancelled: boolean;
  /** Estimated time remaining in ms */
  estimatedRemaining?: number;
  /** Time the batch started */
  startedAt?: number;
  /** Last message sent at */
  lastSentAt?: number;
};

export type BatchResult = {
  /** Total messages attempted */
  total: number;
  /** Successfully sent */
  sent: number;
  /** Failed to send */
  failed: number;
  /** Whether the batch completed fully */
  completed: boolean;
  /** Whether it was cancelled */
  cancelled: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Error messages from failed sends */
  errors: string[];
};

// ─── Interpolation (delegated to shared module) ───

// interpolateTemplate and buildBatchContext are re-exported at the top of this file
// from ./interpolate.js

// ─── BatchRunner ───

export class BatchRunner {
  private config: BatchConfig;
  private bot: YuanbaoBot;
  private progress: BatchProgress;
  private abortController: AbortController | null = null;
  private log: ModuleLog;
  private errors: string[] = [];

  constructor(bot: YuanbaoBot, config: BatchConfig) {
    this.bot = bot;
    this.config = config;
    this.log = createLog("batch");

    // Enforce minimum interval (500ms)
    if (this.config.intervalMs < 500) {
      this.config.intervalMs = 500;
    }

    // Enforce maximum count (100)
    if (this.config.count > 100) {
      this.config.count = 100;
    }

    this.progress = {
      total: this.config.count,
      sent: 0,
      failed: 0,
      running: false,
      cancelled: false,
    };
  }

  /**
   * Start the batch message sending.
   *
   * Returns a promise that resolves when all messages are sent
   * or the batch is cancelled.
   */
  async run(): Promise<BatchResult> {
    if (this.progress.running) {
      throw new Error("Batch is already running");
    }

    this.abortController = new AbortController();
    this.progress.running = true;
    this.progress.startedAt = Date.now();
    this.errors = [];

    const startTime = Date.now();

    for (let i = 0; i < this.config.count; i++) {
      // Check for cancellation
      if (this.abortController.signal.aborted) {
        this.progress.cancelled = true;
        break;
      }

      try {
        await this.sendOne(i);
        this.progress.sent++;
        this.progress.lastSentAt = Date.now();
      } catch (err) {
        this.progress.failed++;
        const errMsg = (err as Error).message;
        this.errors.push(`[${i}] ${errMsg}`);
        this.log.warn(`batch send failed [${i}]: ${errMsg}`);

        // If too many consecutive failures, abort
        if (this.progress.failed >= 5 && this.progress.sent === 0) {
          this.log.error("too many consecutive failures, aborting batch");
          break;
        }
      }

      // Wait for interval (except after last message)
      if (i < this.config.count - 1 && !this.abortController.signal.aborted) {
        await this.sleep(this.config.intervalMs, this.abortController.signal);
      }

      // Update estimated remaining time
      if (this.progress.sent > 0) {
        const elapsed = Date.now() - startTime;
        const avgMs = elapsed / this.progress.sent;
        const remaining = this.config.count - i - 1;
        this.progress.estimatedRemaining = remaining * avgMs;
      }
    }

    this.progress.running = false;

    return {
      total: this.config.count,
      sent: this.progress.sent,
      failed: this.progress.failed,
      completed: this.progress.sent === this.config.count,
      cancelled: this.progress.cancelled,
      durationMs: Date.now() - startTime,
      errors: this.errors,
    };
  }

  /**
   * Cancel the running batch.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.progress.cancelled = true;
      this.log.info("batch cancelled");
    }
  }

  /**
   * Get current progress.
   */
  getProgress(): BatchProgress {
    return { ...this.progress };
  }

  // ─── Internal ───

  private async sendOne(index: number): Promise<void> {
    const ctx = sharedBuildBatchContext(
      index,
      this.config.count,
      this.config.target,
      this.config.context,
    );

    switch (this.config.type) {
      case "text": {
        const text = sharedInterpolate(this.config.template, ctx);
        await this.bot.sendText({
          to: this.config.target,
          text,
          isGroup: this.config.isGroup,
          quoteMsgId: this.config.quoteMsgId,
          skipInterpolation: true, // Already interpolated above — avoid double eval
        });
        break;
      }

      case "sticker": {
        const stickerId = this.config.stickerTemplate
          ? sharedInterpolate(this.config.stickerTemplate, ctx)
          : sharedInterpolate(this.config.template, ctx);
        await this.bot.sendSticker({
          to: this.config.target,
          stickerId,
          isGroup: this.config.isGroup,
        });
        break;
      }

      case "image":
      case "file": {
        const filePath = this.config.fileTemplate
          ? sharedInterpolate(this.config.fileTemplate, ctx)
          : sharedInterpolate(this.config.template, ctx);
        const result = await this.bot.uploadMedia(filePath);
        // After upload, we'd need to build the proper msg_body
        // For now, send a text message with the URL as a placeholder
        await this.bot.sendText({
          to: this.config.target,
          text: result.url || `[uploaded: ${result.uuid}]`,
          isGroup: this.config.isGroup,
          skipInterpolation: true, // Avoid evaluating ${result.uuid} again
        });
        break;
      }

      default:
        throw new Error(`Unsupported batch message type: ${this.config.type}`);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

// ─── Active batch tracking ───

const activeBatches = new Map<string, BatchRunner>();

/**
 * Start a batch and track it.
 *
 * Creates a BatchRunner, registers it in the active batch map,
 * and returns it — but does NOT call run().
 * The caller is responsible for calling runner.run() and
 * handling completion/cleanup (typically via cleanupBatch()).
 */
export function startBatch(
  id: string,
  bot: YuanbaoBot,
  config: BatchConfig,
): BatchRunner {
  // Cancel existing batch with same ID
  const existing = activeBatches.get(id);
  if (existing) {
    existing.cancel();
  }

  const runner = new BatchRunner(bot, config);
  activeBatches.set(id, runner);

  return runner;
}

/**
 * Remove a batch from the active map (for cleanup after completion).
 */
export function cleanupBatch(id: string): void {
  activeBatches.delete(id);
}

/**
 * Get an active batch runner by ID.
 */
export function getActiveBatch(id: string): BatchRunner | undefined {
  return activeBatches.get(id);
}

/**
 * Cancel an active batch.
 */
export function cancelBatch(id: string): boolean {
  const runner = activeBatches.get(id);
  if (runner) {
    runner.cancel();
    return true;
  }
  return false;
}

/**
 * Get all active batch IDs.
 */
export function getActiveBatchIds(): string[] {
  return [...activeBatches.keys()];
}
