/**
 * Persistent reminder and cron job system.
 *
 * Both /remind and /cron store jobs in ~/.yuanbao-lite/reminders.json
 * and restore them on daemon restart.
 *
 * /remind: one-shot delayed messages (supports relative + absolute time)
 * /cron: recurring scheduled messages (cron-like expressions)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLog } from "../logger.js";

const log = createLog("reminders");

const DATA_FILE = join(homedir(), ".yuanbao-lite", "reminders.json");

export type ReminderJob = {
  id: string;
  type: "remind" | "cron";
  userId: string;
  message: string;
  /** For remind: fire-at timestamp (ms). For cron: next-fire timestamp (ms). */
  fireAt: number;
  /** For cron: interval in ms (0 for one-shot remind) */
  intervalMs: number;
  /** For cron: cron expression parts [minute, hour, dayOfMonth, month, dayOfWeek] */
  cronExpr?: string;
  createdAt: number;
  active: boolean;
  /** Target to send the message to (userId for DM, groupCode for group). Defaults to userId (DM). */
  targetId?: string;
  /** Whether the target is a group (true) or DM (false). Defaults to false (DM). */
  isGroup?: boolean;
};

type ReminderData = {
  version: number;
  jobs: ReminderJob[];
};

let cache: ReminderData | null = null;
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function load(): ReminderData {
  if (cache) return cache;
  try {
    if (existsSync(DATA_FILE)) {
      cache = JSON.parse(readFileSync(DATA_FILE, "utf-8")) as ReminderData;
      return cache;
    }
  } catch (e) {
    log.warn(`load failed: ${(e as Error).message}`);
  }
  cache = { version: 1, jobs: [] };
  return cache;
}

function save(): void {
  try {
    const dir = join(homedir(), ".yuanbao-lite");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (e) {
    log.error(`save failed: ${(e as Error).message}`);
  }
}

/**
 * Parse a time string into milliseconds delay.
 * Supports:
 *   - Relative: "30s", "5m", "2h", "1d", "1w" (seconds/minutes/hours/days/weeks)
 *   - Absolute: "2026-06-18 14:30", "14:30" (today at 14:30), "2026-06-18 14:30:00"
 *   - Combined: "1d2h" (1 day 2 hours), "1h30m" (1 hour 30 minutes)
 * Returns { delayMs, fireAt, error }
 */
export function parseTimeString(timeStr: string): { delayMs: number; fireAt: number; error?: string } {
  const now = Date.now();

  // Try absolute time first: "2026-06-18 14:30" or "14:30"
  // Time-only: "HH:MM" or "HH:MM:SS" — means today at that time
  const timeOnly = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeOnly) {
    const h = parseInt(timeOnly[1], 10);
    const m = parseInt(timeOnly[2], 10);
    const s = parseInt(timeOnly[3] ?? "0", 10);
    const target = new Date();
    target.setHours(h, m, s, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1); // tomorrow
    return { delayMs: target.getTime() - now, fireAt: target.getTime() };
  }

  // Full date-time: "2026-06-18 14:30" or "2026-06-18T14:30:00"
  const dateTime = timeStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (dateTime) {
    const target = new Date(
      parseInt(dateTime[1], 10),
      parseInt(dateTime[2], 10) - 1,
      parseInt(dateTime[3], 10),
      parseInt(dateTime[4], 10),
      parseInt(dateTime[5], 10),
      parseInt(dateTime[6] ?? "0", 10),
    );
    if (target.getTime() <= now) {
      return { delayMs: 0, fireAt: target.getTime(), error: "时间已过去" };
    }
    return { delayMs: target.getTime() - now, fireAt: target.getTime() };
  }

  // Relative: "30s", "5m", "2h", "1d", "1w", or combined "1d2h", "1h30m"
  const units: Record<string, number> = {
    s: 1000, sec: 1000, second: 1000,
    m: 60_000, min: 60_000, minute: 60_000,
    h: 3_600_000, hr: 3_600_000, hour: 3_600_000,
    d: 86_400_000, day: 86_400_000,
    w: 7 * 86_400_000, week: 7 * 86_400_000,
    mo: 30 * 86_400_000, month: 30 * 86_400_000,
    y: 365 * 86_400_000, year: 365 * 86_400_000,
  };

  // Match all number+unit pairs
  const pairs = [...timeStr.matchAll(/(\d+)\s*(s|sec|second|m|min|minute|h|hr|hour|d|day|w|week|mo|month|y|year)/g)];
  if (pairs.length > 0) {
    let totalMs = 0;
    for (const p of pairs) {
      const num = parseInt(p[1], 10);
      const unit = p[2];
      totalMs += num * units[unit];
    }
    return { delayMs: totalMs, fireAt: now + totalMs };
  }

  return { delayMs: 0, fireAt: 0, error: `无法解析时间: ${timeStr}\n支持格式: 30s, 5m, 2h, 1d, 1w, 1mo, 1y, 14:30, 2026-06-18 14:30, 1d2h3m` };
}

/**
 * Parse a simple cron expression.
 * Supports: "* * * * *" (min hour day month weekday)
 * Each field can be: star, number, star/N, N-M, N,M,Z
 * Returns { getNextFire, error }
 */
export function parseCronExpression(expr: string): { error?: string; getNextFire: (after: number) => number } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { error: `cron 表达式需要 5 个字段: 分 时 日 月 周\n例如: "30 9 * * 1-5" (工作日9:30)`, getNextFire: () => 0 };
  }

  const [minF, hourF, domF, monthF, dowF] = parts;

  function parseField(field: string, min: number, max: number): number[] | null {
    if (field === "*") {
      const result: number[] = [];
      for (let i = min; i <= max; i++) result.push(i);
      return result;
    }
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step) || step <= 0) return null;
      const result: number[] = [];
      for (let i = min; i <= max; i += step) result.push(i);
      return result;
    }
    const result: number[] = [];
    for (const part of field.split(",")) {
      if (part.includes("-")) {
        const [s, e] = part.split("-").map(n => parseInt(n, 10));
        if (isNaN(s) || isNaN(e) || s < min || e > max || s > e) return null;
        for (let i = s; i <= e; i++) result.push(i);
      } else {
        const n = parseInt(part, 10);
        if (isNaN(n) || n < min || n > max) return null;
        result.push(n);
      }
    }
    return result.length > 0 ? result : null;
  }

  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monthF, 1, 12);
  const dows = parseField(dowF, 0, 6);

  if (!minutes || !hours || !doms || !months || !dows) {
    return { error: "cron 表达式格式错误", getNextFire: () => 0 };
  }

  const minSet = new Set(minutes);
  const hourSet = new Set(hours);
  const domSet = new Set(doms);
  const monthSet = new Set(months);
  const dowSet = new Set(dows);

  function getNextFire(after: number): number {
    const start = new Date(after + 60_000); // at least 1 minute ahead
    start.setSeconds(0, 0);
    // Search up to 366 days ahead
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const candidate = new Date(start.getTime() + i * 60_000);
      if (!monthSet.has(candidate.getMonth() + 1)) continue;
      if (!domSet.has(candidate.getDate())) continue;
      if (!dowSet.has(candidate.getDay())) continue;
      if (!hourSet.has(candidate.getHours())) continue;
      if (!minSet.has(candidate.getMinutes())) continue;
      return candidate.getTime();
    }
    return 0; // no match found
  }

  return { getNextFire };
}

/**
 * Add a reminder job.
 */
export function addReminder(job: Omit<ReminderJob, "id" | "createdAt" | "active">): string {
  const data = load();
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const fullJob: ReminderJob = { ...job, id, createdAt: Date.now(), active: true };
  data.jobs.push(fullJob);
  save();
  log.info(`added ${job.type} job ${id} for ${job.userId}`);
  return id;
}

/**
 * Remove a reminder job by ID.
 */
export function removeReminder(id: string): boolean {
  const data = load();
  const idx = data.jobs.findIndex(j => j.id === id);
  if (idx < 0) return false;
  data.jobs[idx].active = false;
  data.jobs.splice(idx, 1);
  save();
  const timer = activeTimers.get(id);
  if (timer) { clearTimeout(timer); activeTimers.delete(id); }
  log.info(`removed job ${id}`);
  return true;
}

/**
 * List all active reminder jobs for a user.
 */
export function listReminders(userId?: string): ReminderJob[] {
  const data = load();
  return data.jobs.filter(j => j.active && (!userId || j.userId === userId));
}

/**
 * Start all active jobs (call on daemon boot).
 *
 * Idempotent: if a job already has an active timer (e.g. from a previous
 * startAllJobs call or after a WS reconnect), the old timer is cleared
 * before scheduling a new one. This prevents duplicate firings and
 * memory leaks on reconnect.
 */
export type SendFunction = (targetId: string, message: string, isGroup: boolean) => Promise<void>;

export function startAllJobs(
  sendFn: SendFunction,
): void {
  const data = load();
  let started = 0;
  for (const job of data.jobs) {
    if (!job.active) continue;
    // Clear any existing timer for this job (idempotent re-schedule)
    const existing = activeTimers.get(job.id);
    if (existing) {
      clearTimeout(existing);
      activeTimers.delete(job.id);
    }
    scheduleJob(job, sendFn);
    started++;
  }
  log.info(`started ${started} active jobs`);
}

function scheduleJob(
  job: ReminderJob,
  sendFn: SendFunction,
): void {
  const now = Date.now();

  // For cron jobs with a stale fireAt (in the past), recompute the next
  // future fire time instead of firing immediately. This avoids an
  // annoying "catch-up" reminder when the daemon has been offline for
  // longer than the cron interval. One-shot remind jobs DO fire
  // immediately if past due (so the user doesn't miss the reminder).
  if (job.type === "cron" && job.cronExpr && job.fireAt <= now) {
    const { getNextFire } = parseCronExpression(job.cronExpr);
    const nextFire = getNextFire(now);
    if (nextFire > 0) {
      job.fireAt = nextFire;
      save();
      log.info(`job ${job.id} cron fireAt was stale, rescheduled to ${new Date(nextFire).toISOString()}`);
    } else {
      log.warn(`job ${job.id} cron could not compute next fire, deactivating`);
      job.active = false;
      save();
      return;
    }
  }

  const delay = Math.max(0, job.fireAt - now);

  if (delay > 2_147_483_647) {
    log.info(`job ${job.id} delay >24d, scheduling in 24d chunks`);
    const timer = setTimeout(() => scheduleJob(job, sendFn), 2_147_483_647);
    activeTimers.set(job.id, timer);
    return;
  }

  const targetId = job.targetId ?? job.userId;
  const isGroup = job.isGroup ?? false;

  const timer = setTimeout(async () => {
    activeTimers.delete(job.id);
    try {
      await sendFn(targetId, `⏰ 提醒: ${job.message}`, isGroup);
    } catch (err) {
      log.error(`job ${job.id} send failed: ${(err as Error).message}`);
    }

    // For cron jobs, schedule the next fire
    if (job.type === "cron" && job.cronExpr) {
      const { getNextFire } = parseCronExpression(job.cronExpr);
      const nextFire = getNextFire(Date.now());
      if (nextFire > 0) {
        job.fireAt = nextFire;
        save();
        scheduleJob(job, sendFn);
      } else {
        // No future fire time — deactivate
        job.active = false;
        save();
      }
    } else {
      // One-shot remind — mark inactive
      job.active = false;
      save();
    }
  }, delay);

  activeTimers.set(job.id, timer);
}
