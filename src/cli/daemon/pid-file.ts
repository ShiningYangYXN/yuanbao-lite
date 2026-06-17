/**
 * PID file management for the daemon.
 *
 * - `acquirePidFile()`: writes our PID to the lock file. If another live daemon
 *   holds it, send SIGTERM and wait briefly before taking over.
 * - `releasePidFile()`: unlink the file (only if it still belongs to us).
 * - `readPidFile()`: peek the current holder (without touching it).
 *
 * The PID file lives at `~/.yuanbao-lite/daemon.pid`.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PID_FILE = join(homedir(), ".yuanbao-lite", "daemon.pid");

/** Wait for a PID to exit, up to `timeoutMs`. Returns true if it exited. */
async function waitForExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // throws if not running
    } catch {
      return true; // process gone
    }
    await sleep(100);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Returns true if `pid` is currently running. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the PID stored in the lock file (or `null` if missing/invalid). */
export function readPidFile(): number | null {
  if (!existsSync(PID_FILE)) return null;
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the daemon PID file. If another live daemon holds the lock, SIGTERM
 * it and wait up to 3s for it to exit before taking over.
 *
 * Throws if the existing daemon refuses to exit.
 */
export async function acquirePidFile(): Promise<{ killedStale: boolean; stalePid?: number }> {
  const stalePid = readPidFile();
  let killedStale = false;

  if (stalePid && isPidAlive(stalePid)) {
    try {
      process.kill(stalePid, "SIGTERM");
    } catch {
      // EPERM or already gone — proceed
    }
    const exited = await waitForExit(stalePid, 3000);
    if (!exited && isPidAlive(stalePid)) {
      // Last resort
      try {
        process.kill(stalePid, "SIGKILL");
      } catch {
        // ignore
      }
      await waitForExit(stalePid, 1500);
    }
    if (isPidAlive(stalePid)) {
      throw new Error(`stale daemon (pid=${stalePid}) refused to exit`);
    }
    killedStale = true;
  }

  const dir = PID_FILE.substring(0, PID_FILE.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
  return { killedStale, stalePid: killedStale ? (stalePid ?? undefined) : undefined };
}

/** Release the PID file — only if it still records our own PID. */
export function releasePidFile(): void {
  const current = readPidFile();
  if (current === process.pid) {
    try {
      unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }
}

/** Returns the absolute path to the PID file. */
export function getPidFilePath(): string {
  return PID_FILE;
}
