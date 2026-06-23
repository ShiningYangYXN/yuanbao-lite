/**
 * Interactive REPL — raw-mode terminal implementation.
 *
 * Replaces node:readline with a hand-rolled raw-mode line editor using
 * process.stdin.setRawMode(true). This gives us:
 *   - Real-time syntax highlighting (re-renders on every keystroke)
 *   - Full control over Tab completion rendering
 *   - RichHistory prev()/next()/search() wired up properly
 *   - Prompt always at terminal bottom (re-renders after inbound messages)
 *
 * Why raw mode instead of readline?
 *   - readline's terminal mode intercepts keypresses but doesn't expose
 *     a clean "on input change" hook — real-time highlighting requires
 *     re-rendering the line on every keystroke, which conflicts with
 *     readline's cursor management.
 *   - readline's completer API returns [completions, replaceFrom] but
 *     doesn't let us control how completions are DISPLAYED (single-line
 *     vs multi-line, coloring, etc).
 *   - readline's history is a plain array — no search, no dedup, no
 *     persistence. RichHistory provides all three but its prev()/next()/
 *     search() methods were never wired up.
 *
 * Features:
 *   - Persistent history (RichHistory: deduped, ~/.yuanbao-lite/history)
 *   - ↑↓ navigation through history (via RichHistory.prev/next)
 *   - Ctrl+R reverse search (via RichHistory.search)
 *   - Tab completion (commands, sub-commands, file paths, contacts/groups)
 *   - Real-time syntax highlighting (slash commands, flags, mentions)
 *   - Multi-line input via trailing backslash
 *   - Live SSE subscription for incoming DM/group messages
 *   - Prompt re-rendering after inbound messages (stays at terminal bottom)
 *   - Wizard real-time content display
 *   - Unified /chat session mode (auto-detect group vs DM by 9-digit regex)
 */

import chalk from "chalk";
import {
  getDefaultClient,
  type DaemonClient,
} from "@yuanbao-lite/core/access/daemon/client";
import { RichHistory } from "./rich-history.js";
import {
  getCompletions,
  type CompletionContext,
  type CompletionResult,
} from "./auto-complete.js";
import { highlightLine } from "./syntax-highlight.js";
import {
  COLORS,
  printH1,
  printStatus,
  printResult,
  printError,
  printWarn,
} from "../theme.js";
import type { ChatMessage, BotState } from "@yuanbao-lite/core/types";

// ─── State ───

type ChatMode = "none" | "dm" | "group";

const state = {
  chatMode: "none" as ChatMode,
  chatTarget: "",
  running: true,
  multilineBuffer: "",
  wizardActive: false,
};

// 9-digit pure number = group code (per /chat handler convention)
const GROUP_CODE_RE = /^\d{9}$/;

// ─── Line editor (raw mode) ───

/** Find the longest common prefix of an array of strings. */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (strings[i].indexOf(prefix) !== 0) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return "";
    }
  }
  return prefix;
}

class LineEditor {
  private buffer = "";
  private cursor = 0;
  private history: RichHistory;
  private completionCtx: CompletionContext;
  private renderPrompt: () => string;
  private onSubmit: (line: string) => void;
  // Search mode (Ctrl+R)
  private searchMode = false;
  private searchQuery = "";
  private searchResults: string[] = [];
  private searchIndex = 0;
  // Saved buffer before entering search mode
  private savedBuffer = "";
  private savedCursor = 0;

  constructor(opts: {
    history: RichHistory;
    completionCtx: CompletionContext;
    renderPrompt: () => string;
    onSubmit: (line: string) => void;
  }) {
    this.history = opts.history;
    this.completionCtx = opts.completionCtx;
    this.renderPrompt = opts.renderPrompt;
    this.onSubmit = opts.onSubmit;
  }

  /** Current line content (for testing / external access). */
  getLine(): string {
    return this.buffer;
  }

  /** Handle a single keypress from process.stdin in raw mode. */
  handleKey(key: string, isCtrl: boolean): void {
    // Ctrl+R — toggle reverse search
    if (isCtrl && key === "r") {
      if (this.searchMode) {
        // Already in search mode — cycle to next result
        this.cycleSearch();
      } else {
        this.enterSearch();
      }
      this.render();
      return;
    }

    // Ctrl+C — cancel search / multiline / exit
    if (isCtrl && key === "c") {
      if (this.searchMode) {
        this.exitSearch(false);
        this.render();
        return;
      }
      if (state.multilineBuffer) {
        state.multilineBuffer = "";
        this.buffer = "";
        this.cursor = 0;
        this.render();
        return;
      }
      // Exit CLI
      state.running = false;
      return;
    }

    // Ctrl+D — exit on empty line
    if (isCtrl && key === "d") {
      if (this.buffer.length === 0 && !state.multilineBuffer) {
        state.running = false;
        return;
      }
      return;
    }

    // If in search mode, handle search keys
    if (this.searchMode) {
      this.handleSearchKey(key, isCtrl);
      this.render();
      return;
    }

    // Enter — submit line (or continuation)
    if (key === "\r" || key === "\n") {
      const line = this.buffer;
      // Multi-line continuation: trailing backslash
      if (line.endsWith("\\") && !line.endsWith("\\\\")) {
        state.multilineBuffer += line.slice(0, -1) + "\n";
        this.buffer = "";
        this.cursor = 0;
        this.render();
        return;
      }
      const fullLine = (state.multilineBuffer + line).trim();
      state.multilineBuffer = "";
      this.buffer = "";
      this.cursor = 0;
      this.history.resetNav();
      if (fullLine) {
        this.history.add(fullLine);
      }
      this.onSubmit(fullLine);
      return;
    }

    // Up arrow — history previous
    if (key === "\x1b[A") {
      const prev = this.history.prev();
      if (prev !== null) {
        this.buffer = prev;
        this.cursor = this.buffer.length;
      }
      this.render();
      return;
    }

    // Down arrow — history next
    if (key === "\x1b[B") {
      const next = this.history.next();
      if (next !== null) {
        this.buffer = next;
        this.cursor = this.buffer.length;
      } else {
        this.buffer = "";
        this.cursor = 0;
      }
      this.render();
      return;
    }

    // Right arrow — move cursor right
    if (key === "\x1b[C") {
      if (this.cursor < this.buffer.length) {
        this.cursor++;
        this.render();
      }
      return;
    }

    // Left arrow — move cursor left
    if (key === "\x1b[D") {
      if (this.cursor > 0) {
        this.cursor--;
        this.render();
      }
      return;
    }

    // Home (Ctrl+A) — move to start
    if ((isCtrl && key === "a") || key === "\x1b[H") {
      this.cursor = 0;
      this.render();
      return;
    }

    // End (Ctrl+E) — move to end
    if ((isCtrl && key === "e") || key === "\x1b[F") {
      this.cursor = this.buffer.length;
      this.render();
      return;
    }

    // Ctrl+U — delete to start
    if (isCtrl && key === "u") {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
      this.render();
      return;
    }

    // Ctrl+K — delete to end
    if (isCtrl && key === "k") {
      this.buffer = this.buffer.slice(0, this.cursor);
      this.render();
      return;
    }

    // Ctrl+W — delete previous word
    if (isCtrl && key === "w") {
      const before = this.buffer.slice(0, this.cursor);
      const after = this.buffer.slice(this.cursor);
      const match = before.match(/\S+\s*$/);
      if (match) {
        this.buffer = before.slice(0, before.length - match[0].length) + after;
        this.cursor -= match[0].length;
      }
      this.render();
      return;
    }

    // Tab — completion
    if (key === "\t") {
      this.handleTab();
      this.render();
      return;
    }

    // Backspace
    if (key === "\x7f" || key === "\b") {
      if (this.cursor > 0) {
        this.buffer =
          this.buffer.slice(0, this.cursor - 1) +
          this.buffer.slice(this.cursor);
        this.cursor--;
      }
      this.render();
      return;
    }

    // Delete (forward)
    if (key === "\x1b[3~") {
      if (this.cursor < this.buffer.length) {
        this.buffer =
          this.buffer.slice(0, this.cursor) +
          this.buffer.slice(this.cursor + 1);
      }
      this.render();
      return;
    }

    // Regular printable character
    if (key.length === 1 && !isCtrl) {
      this.buffer =
        this.buffer.slice(0, this.cursor) +
        key +
        this.buffer.slice(this.cursor);
      this.cursor++;
      this.render();
      return;
    }
  }

  /** Render the current line with prompt + syntax highlighting. */
  render(): void {
    // Clear current line and move cursor to start
    process.stdout.write("\r\x1b[K");
    // If in search mode, render search UI
    if (this.searchMode) {
      const match = this.searchResults[this.searchIndex] ?? "";
      process.stdout.write(
        chalk.dim("(reverse-search)`") +
          this.searchQuery +
          chalk.dim("' ") +
          chalk.cyan(match),
      );
      return;
    }
    const prompt = this.renderPrompt();
    const highlighted = this.buffer.startsWith("/")
      ? highlightLine(this.buffer)
      : this.buffer;
    process.stdout.write(prompt + highlighted);
    // Move cursor to correct position (accounting for prompt width)
    // We need to move back to where the cursor should be
    const promptStr = this.renderPrompt();
    const visibleLen = promptStr.length + this.cursor;
    const totalLen = promptStr.length + highlighted.length;
    if (visibleLen < totalLen) {
      // Move cursor left by (totalLen - visibleLen)
      process.stdout.write(`\x1b[${totalLen - visibleLen}D`);
    }
  }

  /** Force a full re-render (called after inbound messages etc). */
  forceRender(): void {
    this.render();
  }

  // ─── Tab completion ───

  private handleTab(): void {
    const result: CompletionResult = getCompletions(
      this.buffer,
      this.completionCtx,
    );
    if (result.completions.length === 0) {
      return;
    }

    if (result.completions.length === 1) {
      // Single completion — replace the partial with the full completion
      const completion = result.completions[0];
      if (result.replaceFrom) {
        // Find the last occurrence of replaceFrom in the buffer
        const idx = this.buffer.lastIndexOf(result.replaceFrom);
        if (idx >= 0) {
          this.buffer =
            this.buffer.slice(0, idx) +
            completion +
            " " +
            this.buffer.slice(idx + result.replaceFrom.length);
          this.cursor = idx + completion.length + 1;
        } else {
          // replaceFrom not found — append the completion
          this.buffer = completion + " ";
          this.cursor = this.buffer.length;
        }
      } else {
        // Empty replaceFrom (e.g. empty line) — just set the completion
        this.buffer = completion + " ";
        this.cursor = this.buffer.length;
      }
      return;
    }

    // Multiple completions — find the common prefix and complete up to it,
    // then print the full list on a new line so the user can see options.
    const commonPrefix = longestCommonPrefix(result.completions);
    if (commonPrefix && commonPrefix.length > result.replaceFrom.length) {
      // Extend the buffer with the common prefix
      const idx = this.buffer.lastIndexOf(result.replaceFrom);
      if (idx >= 0) {
        this.buffer =
          this.buffer.slice(0, idx) +
          commonPrefix +
          this.buffer.slice(idx + result.replaceFrom.length);
        this.cursor = idx + commonPrefix.length;
      }
    }
    // Print the completion options on a new line
    process.stdout.write("\n");
    process.stdout.write(result.completions.join("  ") + "\n");
    // render() will be called by handleKey after this returns, which will
    // clear the current line and re-print the prompt + updated buffer.
  }

  // ─── Reverse search (Ctrl+R) ───

  private enterSearch(): void {
    this.searchMode = true;
    this.searchQuery = "";
    this.searchResults = [];
    this.searchIndex = 0;
    this.savedBuffer = this.buffer;
    this.savedCursor = this.cursor;
  }

  private handleSearchKey(key: string, isCtrl: boolean): void {
    // Enter — accept current match
    if (key === "\r" || key === "\n") {
      this.exitSearch(true);
      return;
    }
    // Escape — cancel search, restore saved buffer
    if (key === "\x1b" || (isCtrl && key === "g")) {
      this.exitSearch(false);
      return;
    }
    // Backspace — remove last char from query
    if (key === "\x7f" || key === "\b") {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.runSearch();
      }
      return;
    }
    // Regular char — add to query
    if (key.length === 1 && !isCtrl) {
      this.searchQuery += key;
      this.runSearch();
      return;
    }
  }

  private runSearch(): void {
    if (this.searchQuery.length === 0) {
      this.searchResults = [];
      this.searchIndex = 0;
      return;
    }
    this.searchResults = this.history.search(this.searchQuery, 20);
    this.searchIndex = 0;
  }

  private cycleSearch(): void {
    if (this.searchResults.length > 0) {
      this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
    }
  }

  private exitSearch(accept: boolean): void {
    if (accept && this.searchResults.length > 0) {
      this.buffer = this.searchResults[this.searchIndex];
      this.cursor = this.buffer.length;
    } else {
      this.buffer = this.savedBuffer;
      this.cursor = this.savedCursor;
    }
    this.searchMode = false;
    this.searchQuery = "";
    this.searchResults = [];
    this.history.resetNav();
  }
}

// ─── Main ───

let editor: LineEditor | null = null;
/** Shared completion context — module-level so SSE handlers can access it
 * for outbound message name resolution. Populated by refreshCompletions(). */
let sharedCompletionCtx: CompletionContext = {};

/** Exit the alternate screen buffer (restores original terminal). */
function exitAltScreen(): void {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1049l"); // exit alt screen
  }
}

/**
 * Resolve a target (group code or user ID) to a display name using the
 * shared completion context's group/contact stores.
 */
function resolveTargetName(to: string, isGroup: boolean): string | undefined {
  try {
    if (isGroup) {
      const g = sharedCompletionCtx.groupStore?.get(to);
      return g?.name ?? g?.groupName;
    } else {
      // Try contact store first
      const c = sharedCompletionCtx.contactStore?.get(to);
      if (c?.name) return c.name;
      // Try alias store
      const a = sharedCompletionCtx.aliasStore?.get(to);
      if (a?.nickname) return a.nickname;
    }
  } catch {
    // store not initialized — fall through
  }
  return undefined;
}

export async function runInteractive(): Promise<void> {
  const client = getDefaultClient();

  // 0. Enter alternate screen buffer (restores the original terminal on exit)
  // This makes the CLI behave like vim/less — full-screen, no scrollback pollution.
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1049h"); // enter alt screen
  }
  // Ensure alt screen is restored on any exit path (SIGTERM, SIGHUP, crash)
  const restoreOnSignal = (sig: string) => {
    exitAltScreen();
    process.exit(0);
  };
  process.on("SIGTERM", () => restoreOnSignal("SIGTERM"));
  process.on("SIGHUP", () => restoreOnSignal("SIGHUP"));

  // 1. Ensure daemon
  let info;
  try {
    info = await client.ensureDaemon({});
  } catch (err) {
    printError(`无法启动 daemon: ${(err as Error).message}`);
    exitAltScreen();
    process.exit(1);
  }

  // 2. Welcome banner
  printWelcome(info.version, info.pid, info.port);

  if (info.bot?.connected) {
    printResult(`已连接 (botId=${info.bot.botId ?? "n/a"})`);
  } else {
    printWarn("正在连接 bot... (可继续输入命令，发送类操作需等待连接就绪)");
  }

  // 3. Persistent history
  const history = new RichHistory();

  // 4. SSE subscription for live messages
  const unsubscribe = client.subscribeSse((event, data) => {
    handleSseEvent(event, data);
  });

  // 4b. Daemon health monitor — detect disconnects, log, and auto-reconnect
  // Uses exponential backoff (2s → 4s → 8s → ... max 60s) to avoid hammering
  // the daemon when it's down for an extended period.
  let daemonConnected = true;
  let reconnecting = false;
  let reconnectDelayMs = 2000;
  const MAX_RECONNECT_DELAY_MS = 60_000;
  const healthCheck = async () => {
    try {
      const pingInfo = await client.ping(2000);
      if (!pingInfo) throw new Error("no response");
      if (!daemonConnected) {
        // Was disconnected, now back — log recovery and reset backoff
        daemonConnected = true;
        reconnecting = false;
        reconnectDelayMs = 2000;
        printResult("daemon 已重连 ✓");
        editor?.forceRender();
      }
    } catch {
      if (daemonConnected) {
        // Just lost connection — log and attempt reconnect
        daemonConnected = false;
        reconnectDelayMs = 2000; // reset backoff on fresh disconnect
        printError("与 daemon 断开连接，正在尝试重连...");
        editor?.forceRender();
      }
      if (!reconnecting) {
        reconnecting = true;
        const delay = reconnectDelayMs;
        reconnectDelayMs = Math.min(
          reconnectDelayMs * 2,
          MAX_RECONNECT_DELAY_MS,
        );
        // Attempt to re-ensure daemon after the backoff delay
        setTimeout(() => {
          client
            .ensureDaemon({})
            .then(() => {
              // Reconnected — next healthCheck tick will confirm and log recovery
              reconnecting = false;
            })
            .catch(() => {
              // Still down — will retry on next healthCheck with longer backoff
              reconnecting = false;
            });
        }, delay);
      }
    }
  };
  const healthTimer = setInterval(healthCheck, 5000);

  // 5. Periodically refresh completion data from daemon
  const completionCtx: CompletionContext = sharedCompletionCtx;
  const refreshCompletions = async () => {
    try {
      const data = await client.fetchCompletions();
      completionCtx.contactStore = makeLiteContactStore(data.contacts) as never;
      completionCtx.groupStore = makeLiteGroupStore(data.groups) as never;
      completionCtx.aliasStore = makeLiteAliasStore(data.aliases) as never;
      // Populate the dynamic command list so auto-complete reflects the
      // actually-registered commands instead of the static fallback.
      completionCtx.commands = data.commands;
    } catch {
      // ignore — completions will fall back to static command list
    }
  };
  void refreshCompletions();
  const completionTimer = setInterval(refreshCompletions, 30_000);

  // Poll wizard status every 2s
  const wizardTimer = setInterval(async () => {
    try {
      const wiz = await client.wizardStatus("cli");
      state.wizardActive = wiz.active;
    } catch {
      state.wizardActive = false;
    }
  }, 2000);

  // 6. Line editor + raw mode
  editor = new LineEditor({
    history,
    completionCtx,
    renderPrompt: currentPrompt,
    onSubmit: async (line: string) => {
      if (!line) {
        editor?.forceRender();
        return;
      }
      // Show the committed line with syntax highlighting (already rendered
      // by the editor, but we need to move to a new line before processing)
      process.stdout.write("\n");
      await processLine(line, client);
      if (!state.running) {
        cleanupAndExit();
        return;
      }
      editor?.forceRender();
    },
  });

  // Switch stdin to raw mode for keystroke-by-keystroke input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.setEncoding("utf-8");
  process.stdin.resume();

  // Handle terminal resize (SIGWINCH) — re-render the prompt so it stays
  // correctly positioned in the alt screen buffer after window resize.
  const onResize = () => {
    // Clear screen and re-render from scratch
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + move cursor home
    editor?.forceRender();
  };
  process.on("SIGWINCH", onResize);

  // Render initial prompt
  editor.forceRender();

  // Read keystrokes
  process.stdin.on("data", (chunk: Buffer | string) => {
    const data = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    // Process each key — escape sequences are multi-char but arrive together
    // We split on escape sequences and single chars
    const keys = parseKeys(data);
    for (const { key, isCtrl } of keys) {
      editor?.handleKey(key, isCtrl);
      if (!state.running) {
        cleanupAndExit();
        return;
      }
    }
  });

  // Wait until state.running becomes false
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!state.running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  function cleanupAndExit(): void {
    clearInterval(completionTimer);
    clearInterval(wizardTimer);
    clearInterval(healthTimer);
    process.removeListener("SIGWINCH", onResize);
    unsubscribe();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    editor = null;
    printStatus("再见 👋");
    exitAltScreen();
  }

  await new Promise((r) => setTimeout(r, 0));
  cleanupAndExit();
}

// ─── Key parsing ───

/**
 * Parse a raw stdin data chunk into individual key presses.
 * Handles UTF-8 multibyte chars, escape sequences (arrows, Delete, Home/End),
 * and Ctrl+letter combinations.
 *
 * Terminal escape sequences:
 *   Up:    \x1b[A    (3 chars: ESC [ A)
 *   Down:  \x1b[B    (3 chars)
 *   Right: \x1b[C    (3 chars)
 *   Left:  \x1b[D    (3 chars)
 *   Home:  \x1b[H    (3 chars) or \x1b[1~  (4 chars)
 *   End:   \x1b[F    (3 chars) or \x1b[4~  (4 chars)
 *   Delete:\x1b[3~   (4 chars: ESC [ 3 ~)
 *   Ins:   \x1b[2~   (4 chars)
 *   PgUp:  \x1b[5~   (4 chars)
 *   PgDn:  \x1b[6~   (4 chars)
 */
function parseKeys(data: string): Array<{ key: string; isCtrl: boolean }> {
  const keys: Array<{ key: string; isCtrl: boolean }> = [];
  let i = 0;
  while (i < data.length) {
    const ch = data[i];
    // Escape sequence — starts with ESC (\x1b)
    if (ch === "\x1b") {
      const remaining = data.slice(i);

      // Arrow keys: \x1b[A \x1b[B \x1b[C \x1b[D (3 chars each)
      const arrowMatch = remaining.match(/^\x1b\[([ABCD])/);
      if (arrowMatch) {
        keys.push({ key: `\x1b[${arrowMatch[1]}`, isCtrl: false });
        i += 3;
        continue;
      }

      // Delete: \x1b[3~ (4 chars)
      if (/^\x1b\[3~/.test(remaining)) {
        keys.push({ key: "\x1b[3~", isCtrl: false });
        i += 4;
        continue;
      }

      // Home/End: \x1b[H \x1b[F (3 chars each)
      const homeEndMatch = remaining.match(/^\x1b\[([HF])/);
      if (homeEndMatch) {
        keys.push({ key: `\x1b[${homeEndMatch[1]}`, isCtrl: false });
        i += 3;
        continue;
      }

      // Home/End alt: \x1b[1~ (Home) \x1b[4~ (End) — 4 chars each
      const homeEndAltMatch = remaining.match(/^\x1b\[([14])~/);
      if (homeEndAltMatch) {
        const code = homeEndAltMatch[1];
        keys.push({
          key: code === "1" ? "\x1b[H" : "\x1b[F",
          isCtrl: false,
        });
        i += 4;
        continue;
      }

      // Insert/PageUp/PageDown: \x1b[2~ \x1b[5~ \x1b[6~ — skip for now (4 chars)
      if (/^\x1b\[[256]~/.test(remaining)) {
        i += 4;
        continue;
      }

      // Plain Escape (single ESC with no following sequence)
      // Only treat as plain ESC if the next char is NOT a known sequence start.
      // In practice, a lone ESC arrives as a single \x1b byte.
      keys.push({ key: "\x1b", isCtrl: false });
      i += 1;
      continue;
    }

    // Ctrl+letter (0x01-0x1a maps to Ctrl+a..Ctrl+z)
    // BUT exclude \r (0x0d=13=Ctrl+M) and \n (0x0a=10=Ctrl+J) and \t (0x09=9=Ctrl+I)
    // because those are Enter/Tab, not Ctrl combinations.
    const code = ch.charCodeAt(0);
    if (code >= 1 && code <= 26 && code !== 9 && code !== 10 && code !== 13) {
      const letter = String.fromCharCode(code + 96); // 1→a, 2→b, ...
      keys.push({ key: letter, isCtrl: true });
      i += 1;
      continue;
    }

    // Backspace (0x7f = DEL key on most terminals, 0x08 = Ctrl+H)
    if (ch === "\x7f" || ch === "\b") {
      keys.push({ key: ch, isCtrl: false });
      i += 1;
      continue;
    }

    // Enter (\r = 0x0d, \n = 0x0a)
    if (ch === "\r" || ch === "\n") {
      keys.push({ key: ch, isCtrl: false });
      i += 1;
      continue;
    }

    // Tab (0x09)
    if (ch === "\t") {
      keys.push({ key: "\t", isCtrl: false });
      i += 1;
      continue;
    }

    // UTF-8 multibyte — collect the full codepoint.
    // JS strings are UTF-16; BMP chars are 1 element, surrogate pairs are 2.
    if (code >= 0x80) {
      // Check for surrogate pair (code points U+10000 and above)
      const next = data[i + 1];
      if (
        next &&
        next.charCodeAt(0) >= 0xdc00 &&
        next.charCodeAt(0) <= 0xdfff
      ) {
        keys.push({ key: ch + next, isCtrl: false });
        i += 2;
      } else {
        keys.push({ key: ch, isCtrl: false });
        i += 1;
      }
      continue;
    }

    // Regular printable ASCII
    keys.push({ key: ch, isCtrl: false });
    i += 1;
  }
  return keys;
}

// ─── Line processing ───

async function processLine(line: string, client: DaemonClient): Promise<void> {
  const lines = line
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return;

  for (const ln of lines) {
    if (ln.startsWith("/")) {
      await processSingleCommand(ln, client);
    } else {
      await sendChatMessage(ln, client);
    }
  }
}

async function processSingleCommand(
  line: string,
  client: DaemonClient,
): Promise<void> {
  if (line === "/exit" || line === "/quit" || line === "/q") {
    state.running = false;
    return;
  }

  if (line === "/chat" || line.startsWith("/chat ")) {
    const parts = line.split(/\s+/);
    // /chat (no args) → exit session mode
    if (parts.length === 1) {
      if (state.chatMode !== "none") {
        state.chatMode = "none";
        state.chatTarget = "";
        printStatus("已退出会话模式");
      }
      return;
    }
    // /chat <target> (no message) → switch CLI session mode ONLY
    if (parts.length === 2) {
      const target = parts[1];
      if (GROUP_CODE_RE.test(target)) {
        state.chatMode = "group";
        state.chatTarget = target;
        printStatus(`切换到群聊会话: ${target}`);
      } else {
        state.chatMode = "dm";
        state.chatTarget = target;
        printStatus(`切换到私聊会话: ${target}`);
      }
      return;
    }
    // /chat <target> <message> → send message ONLY, do NOT switch session.
    // This lets the user send a one-off message without entering a session.
    await dispatchCommand(line, client);
    return;
  }

  // /switch — show current mode locally (session mode is CLI-only)
  if (line === "/switch" || line.startsWith("/switch ")) {
    printStatus(
      `当前模式: ${state.chatMode} ${state.chatTarget ? `→ ${state.chatTarget}` : ""}`,
    );
    return;
  }

  await dispatchCommand(line, client);
}

async function sendChatMessage(
  text: string,
  client: DaemonClient,
): Promise<void> {
  if (state.wizardActive) {
    try {
      const result = await client.wizardInput(text, "cli");
      if (result.handled) {
        if (result.replies.length > 0) {
          for (const reply of result.replies) {
            console.log(reply);
          }
        }
        return;
      }
    } catch {
      // fall through
    }
  }

  if (state.chatMode === "none") {
    printError(
      "未进入会话模式，使用 /chat <目标> 进入（9位数字=群，其他=私聊）",
    );
    return;
  }
  if (state.chatMode === "dm") {
    try {
      await client.sendDm(state.chatTarget, text);
      printResult(`已发送给 ${state.chatTarget}`);
    } catch (err) {
      printError(`发送失败: ${(err as Error).message}`);
    }
    return;
  }
  try {
    await client.sendGroup(state.chatTarget, text);
    printResult(`已发送到群 ${state.chatTarget}`);
  } catch (err) {
    printError(`发送失败: ${(err as Error).message}`);
  }
}

async function dispatchCommand(
  line: string,
  client: DaemonClient,
): Promise<void> {
  const chatMode = state.chatMode === "group" ? "group" : "direct";
  const chatTarget = state.chatTarget || "cli";
  const shouldExitAfter =
    line.startsWith("/daemon stop") || line.startsWith("/daemon reset");

  try {
    const result = await client.runCommand(line, {
      chatMode: chatMode as "direct" | "group",
      chatTarget,
    });
    if (!result.ok) {
      printError(`命令执行失败: ${result.error ?? "unknown error"}`);
      return;
    }
    if (!result.handled) {
      printWarn(`未知命令: ${line.split(/\s+/)[0]}`);
      return;
    }
    if (result.replies.length > 0) {
      const { renderMarkdownAnsi } = await import("../utils/cli-format.js");
      const rendered: string[] = [];
      for (const reply of result.replies) {
        rendered.push(await renderMarkdownAnsi(reply));
      }
      const fullOutput = rendered.join("\n");
      // Route through pager if the output is longer than the terminal height
      await paginate(fullOutput);
    }
  } catch (err) {
    printError(`dispatch 失败: ${(err as Error).message}`);
  }

  if (shouldExitAfter) {
    console.log(chalk.dim("CLI 将退出（daemon 已停止）"));
    // Restore the original terminal (exit alt screen buffer) before exiting.
    // Without this, the user's terminal stays in the alt buffer after the
    // CLI process dies, hiding their previous shell output.
    exitAltScreen();
    process.exit(0);
  }
}

// ─── Pager ───

/**
 * Display text through a simple built-in pager.
 *
 * If the text fits within the terminal height (minus 1 line for the prompt),
 * it's printed directly. Otherwise, a less-style pager is activated:
 *   - Space/PageDown: next page
 *   - b/PageUp: previous page
 *   - q: quit
 *   - Enter/↓: scroll down one line
 *   - ↑: scroll up one line
 *   - g: go to start
 *   - G: go to end
 *
 * The pager runs in the alt screen buffer's raw mode (stdin is already raw).
 */
async function paginate(text: string): Promise<void> {
  const lines = text.split("\n");
  const termHeight = process.stdout.rows || 24;
  const termWidth = process.stdout.columns || 80;

  // If output fits on screen (leaving 1 line for prompt), print directly
  if (lines.length <= termHeight - 1) {
    process.stdout.write(text + "\n");
    return;
  }

  // Wrap long lines to terminal width
  const wrappedLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      wrappedLines.push("");
      continue;
    }
    // Strip ANSI codes for width calculation
    const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (visibleLen <= termWidth) {
      wrappedLines.push(line);
    } else {
      // Simple char-by-char wrap (preserving ANSI)
      let current = "";
      let currentLen = 0;
      let i = 0;
      while (i < line.length) {
        const ch = line[i];
        // Skip ANSI escape sequences (don't count toward width)
        if (ch === "\x1b") {
          const seqEnd = line.indexOf("m", i);
          if (seqEnd >= 0) {
            current += line.slice(i, seqEnd + 1);
            i = seqEnd + 1;
            continue;
          }
        }
        if (currentLen >= termWidth) {
          wrappedLines.push(current);
          current = "";
          currentLen = 0;
        }
        current += ch;
        currentLen++;
        i++;
      }
      if (current) wrappedLines.push(current);
    }
  }

  // Pager state
  let topLine = 0;
  const visibleRows = termHeight - 2; // leave 2 lines for status bar
  const totalLines = wrappedLines.length;

  const renderPage = () => {
    // Clear screen and move cursor home
    process.stdout.write("\x1b[2J\x1b[H");
    const endLine = Math.min(topLine + visibleRows, totalLines);
    for (let i = topLine; i < endLine; i++) {
      process.stdout.write(wrappedLines[i] + "\n");
    }
    // Status bar at the bottom
    const pct = Math.round((endLine / totalLines) * 100);
    process.stdout.write(
      chalk.dim(
        `行 ${endLine}/${totalLines} (${pct}%)  q退出  Space下页  b上页  ↑↓滚动  g/G首尾`,
      ) + "\n",
    );
  };

  renderPage();

  // Pager key loop — reads from stdin (already in raw mode)
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const data = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const keys = parseKeys(data);
      for (const { key } of keys) {
        if (key === "q" || key === "\x1b") {
          // Quit pager
          process.stdout.write("\x1b[2J\x1b[H");
          process.stdin.removeListener("data", onData);
          resolve();
          return;
        }
        if (key === " " || key === "\x1b[6~") {
          // Page down
          topLine = Math.min(topLine + visibleRows, totalLines - visibleRows);
          if (topLine < 0) topLine = 0;
          renderPage();
          continue;
        }
        if (key === "b" || key === "\x1b[5~") {
          // Page up
          topLine = Math.max(topLine - visibleRows, 0);
          renderPage();
          continue;
        }
        if (key === "\r" || key === "\x1b[B") {
          // Scroll down one line (Enter or Down arrow)
          if (topLine < totalLines - visibleRows) {
            topLine++;
            renderPage();
          }
          continue;
        }
        if (key === "\x1b[A") {
          // Scroll up one line (Up arrow)
          if (topLine > 0) {
            topLine--;
            renderPage();
          }
          continue;
        }
        if (key === "g") {
          // Go to start
          topLine = 0;
          renderPage();
          continue;
        }
        if (key === "G") {
          // Go to end
          topLine = Math.max(totalLines - visibleRows, 0);
          renderPage();
          continue;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

// ─── SSE handling ───

function handleSseEvent(event: string, data: unknown): void {
  switch (event) {
    case "ready":
      break;
    case "directMessage":
      void printInboundMessage(data as ChatMessage, false);
      break;
    case "groupMessage":
      void printInboundMessage(data as ChatMessage, true);
      break;
    case "outboundMessage": {
      // Outbound now carries a full ChatMessage (unified with inbound)
      const msg = data as ChatMessage;
      void printOutboundMessage(msg);
      break;
    }
    case "stateChange":
      printStateChange(data as BotState);
      break;
    default:
      break;
  }
}

async function printInboundMessage(
  msg: ChatMessage,
  isGroup: boolean,
): Promise<void> {
  if (msg.fromUserId === "cli") return;

  // Session-mode filtering
  if (state.chatMode === "group" && state.chatTarget) {
    if (!isGroup || msg.groupCode !== state.chatTarget) return;
  } else if (state.chatMode === "dm" && state.chatTarget) {
    if (isGroup || msg.fromUserId !== state.chatTarget) return;
  }

  const { formatInboundMessage } = await import("../utils/cli-format.js");
  // Clear current line, print message, re-render prompt below
  process.stdout.write("\r\x1b[K");
  console.log(formatInboundMessage(msg, isGroup));
  editor?.forceRender();
}

async function printOutboundMessage(msg: ChatMessage): Promise<void> {
  const { formatOutboundMessage } = await import("../utils/cli-format.js");
  process.stdout.write("\r\x1b[K");
  console.log(formatOutboundMessage(msg));
  editor?.forceRender();
}

function printStateChange(s: BotState): void {
  process.stdout.write("\r\x1b[K");
  if (s.connected) {
    printResult(`bot 已连接${s.botId ? ` (botId=${s.botId})` : ""}`);
  } else {
    printWarn(
      `bot 状态变更: ${s.status}${s.lastError ? ` — ${s.lastError}` : ""}`,
    );
  }
  editor?.forceRender();
}

// ─── Prompt rendering ───

function currentPrompt(): string {
  if (state.chatMode === "dm") {
    return chalk.rgb(100, 220, 180).bold(`👤 ${state.chatTarget} ❯ `);
  }
  if (state.chatMode === "group") {
    return chalk.rgb(180, 140, 255).bold(`👥 ${state.chatTarget} ❯ `);
  }
  return chalk.rgb(100, 180, 255).bold("yuanbao ❯ ");
}

function printWelcome(version: string, pid: number, port: number): void {
  printH1(`Yuanbao Lite CLI v${version}`);
  console.log(
    `  ${COLORS.dim("alt-buffer · raw-mode · RichHistory + auto-complete + syntax-highlight + Ctrl+R search")}`,
  );
  console.log(`  ${COLORS.dim(`daemon pid=${pid} port=${port}`)}`);
  console.log(
    `  ${COLORS.dim("/help 查看命令  ·  ↑↓ 历史  ·  Ctrl+R 搜索  ·  Tab 补全  ·  \\ 换行  ·  Ctrl+C 退出")}`,
  );
  console.log(
    `  ${COLORS.dim("/chat <目标> 切换会话  ·  /chat 退出会话  ·  /chat <目标> <消息> 仅发送不切换  (9位数字=群)")}`,
  );
  console.log("");
}

// ─── Lite in-memory stores for completion context ───

type LiteContact = { id: string; name: string; tag?: string };
type LiteGroup = { groupCode: string; name: string; tag?: string };
type LiteAlias = { alias: string; id: string; nickname?: string };

function makeLiteContactStore(contacts: LiteContact[]) {
  return {
    getAll: () =>
      contacts.map((c) => ({ ...c, favorite: false, createdAt: 0 })),
    resolve: (nameOrId: string) =>
      contacts.find((c) => c.name === nameOrId || c.id === nameOrId)?.id ??
      nameOrId,
    get: (nameOrId: string) => {
      const c = contacts.find((x) => x.name === nameOrId || x.id === nameOrId);
      return c ? { ...c, favorite: false, createdAt: 0 } : undefined;
    },
  };
}

function makeLiteGroupStore(groups: LiteGroup[]) {
  return {
    getAll: () =>
      groups.map((g) => ({
        ...g,
        groupName: g.name,
        favorite: false,
        createdAt: 0,
        lastActiveAt: 0,
      })),
    resolve: (nameOrCode: string) =>
      groups.find((g) => g.name === nameOrCode || g.groupCode === nameOrCode)
        ?.groupCode ?? nameOrCode,
    get: (code: string) => {
      const g = groups.find((x) => x.groupCode === code);
      return g
        ? {
            ...g,
            groupName: g.name,
            favorite: false,
            createdAt: 0,
            lastActiveAt: 0,
          }
        : undefined;
    },
  };
}

function makeLiteAliasStore(aliases: LiteAlias[]) {
  return {
    getAll: () => aliases.map((a) => ({ ...a, createdAt: 0 })),
    resolve: (aliasOrId: string) =>
      aliases.find((a) => a.alias === aliasOrId || a.id === aliasOrId)?.id ??
      aliasOrId,
    get: (aliasOrId: string) => {
      const a = aliases.find(
        (x) => x.alias === aliasOrId || x.id === aliasOrId,
      );
      return a ? { ...a, createdAt: 0 } : undefined;
    },
    getNickname: (aliasOrId: string) =>
      aliases.find((a) => a.alias === aliasOrId || a.id === aliasOrId)
        ?.nickname,
  };
}
