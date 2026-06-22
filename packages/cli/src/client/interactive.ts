/**
 * Interactive REPL — shell-like experience via node:readline.
 *
 * Features:
 *   - Persistent history (RichHistory, deduped, ~/.yuanbao-lite/history)
 *   - ↑↓ navigation through history
 *   - Tab completion (commands, sub-commands, file paths, contacts/groups/aliases)
 *   - Committed-line syntax highlighting (slash commands, flags, mentions)
 *   - Multi-line input via trailing backslash
 *   - Live SSE subscription for incoming DM/group messages
 *   - Prompt re-rendering after inbound messages (stays at terminal bottom)
 *   - Wizard real-time content display (init/llm config wizards)
 *   - Unified /chat session mode (auto-detect group vs DM by 9-digit regex)
 *
 * All commands route through the daemon via /command — zero business logic
 * in the client.
 */

import * as readline from "node:readline";
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
  /** Wizard active flag — cached locally to avoid 2 HTTP hops per message */
  wizardActive: false,
};

// 9-digit pure number = group code (per /chat handler convention)
const GROUP_CODE_RE = /^\d{9}$/;

// ─── Main ───

export async function runInteractive(): Promise<void> {
  const client = getDefaultClient();

  // 1. Ensure daemon
  let info;
  try {
    info = await client.ensureDaemon({});
  } catch (err) {
    printError(`无法启动 daemon: ${(err as Error).message}`);
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

  // 5. Periodically refresh completion data from daemon
  const completionCtx: CompletionContext = {};
  const refreshCompletions = async () => {
    try {
      const data = await client.fetchCompletions();
      completionCtx.contactStore = makeLiteContactStore(data.contacts) as never;
      completionCtx.groupStore = makeLiteGroupStore(data.groups) as never;
      completionCtx.aliasStore = makeLiteAliasStore(data.aliases) as never;
    } catch {
      // ignore — completions will fall back to command/path only
    }
  };
  void refreshCompletions();
  const completionTimer = setInterval(refreshCompletions, 30_000);

  // Also poll wizard status every 2s so wizardActive stays fresh without
  // adding a round-trip to every plain-text message
  const wizardTimer = setInterval(async () => {
    try {
      const wiz = await client.wizardStatus("cli");
      state.wizardActive = wiz.active;
    } catch {
      state.wizardActive = false;
    }
  }, 2000);

  // 6. Readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => completer(line, completionCtx),
    historySize: 0, // we manage history ourselves via RichHistory
    prompt: currentPrompt(),
    // terminal: true is the default when stdout is a TTY; explicit for safety
    terminal: true,
  });

  // Expose rl to SSE handlers so they can re-render the prompt after
  // printing inbound messages (keeps prompt at terminal bottom).
  rlInstance = rl;

  // Sync RichHistory → readline.history for ↑↓ navigation
  syncHistory(rl, history);

  // Refresh prompt when chat mode changes
  const refreshPrompt = () => {
    rl.setPrompt(currentPrompt());
    rl.prompt(true);
  };

  // 7. REPL loop
  rl.prompt();

  await new Promise<void>((resolve) => {
    rl.on("line", async (input: string) => {
      // 续行 (continuation): line ending with \ is extension of previous input.
      if (input.endsWith("\\") && !input.endsWith("\\\\")) {
        state.multilineBuffer += input.slice(0, -1) + "\n";
        rl.setPrompt(
          chalk.dim("... ") + " ".repeat(state.chatTarget.length + 2),
        );
        rl.prompt();
        return;
      }

      const fullLine = (state.multilineBuffer + input).trim();
      state.multilineBuffer = "";
      refreshPrompt();

      if (!fullLine) {
        rl.prompt();
        return;
      }

      // Re-display the committed line with syntax highlighting.
      // readline already echoed the raw input; we move up one line, clear
      // it, and re-print the highlighted version so the user sees colored
      // output in their scrollback.
      if (fullLine.startsWith("/")) {
        process.stdout.write("\r\x1b[K"); // CR + clear current line
        process.stdout.write(
          `${currentPrompt()}${highlightLine(fullLine)}\n`,
        );
      }

      // Save to history (skip sensitive commands)
      history.add(fullLine);
      syncHistory(rl, history);

      // Process the line
      await processLine(fullLine, client);

      if (!state.running) {
        rl.close();
        resolve();
        return;
      }

      refreshPrompt();
    });

    rl.on("SIGINT", () => {
      if (state.multilineBuffer) {
        // Cancel multi-line
        state.multilineBuffer = "";
        refreshPrompt();
        rl.prompt();
        return;
      }
      rl.close();
      resolve();
    });

    rl.on("close", () => {
      resolve();
    });
  });

  // Cleanup
  clearInterval(completionTimer);
  clearInterval(wizardTimer);
  unsubscribe();
  rlInstance = null;

  printStatus("再见 👋");
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
  // /exit /quit /q
  if (line === "/exit" || line === "/quit" || line === "/q") {
    state.running = false;
    return;
  }

  // /chat with a target but no message → enter session mode (CLI-side)
  // /chat with no args → exit session mode
  if (line === "/chat" || line.startsWith("/chat ")) {
    const handled = handleChatCommand(line);
    if (handled) {
      // Session mode change handled locally — still dispatch to daemon
      // so the bot-side context is consistent, but only if there's a message
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        await dispatchCommand(line, client);
      }
      return;
    }
    await dispatchCommand(line, client);
    return;
  }

  // /switch — show current mode locally + delegate
  if (line === "/switch" || line.startsWith("/switch ")) {
    printStatus(
      `当前模式: ${state.chatMode} ${state.chatTarget ? `→ ${state.chatTarget}` : ""}`,
    );
    await dispatchCommand(line, client);
    return;
  }

  // Any other /command → daemon dispatch
  await dispatchCommand(line, client);
}

/**
 * Handle /chat locally for session mode entry/exit.
 * Returns true if the command was a session-mode change (no message to send),
 * false if it should be dispatched to the daemon.
 */
function handleChatCommand(line: string): boolean {
  const parts = line.split(/\s+/);
  // /chat (no args) → exit session mode
  if (parts.length === 1) {
    if (state.chatMode !== "none") {
      state.chatMode = "none";
      state.chatTarget = "";
      printStatus("已退出会话模式");
    }
    return true;
  }
  // /chat <target> (no message) → enter session mode
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
    return true;
  }
  // /chat <target> <message> → not a session change, dispatch to daemon
  return false;
}

async function sendChatMessage(
  text: string,
  client: DaemonClient,
): Promise<void> {
  // If a wizard session is active (cached locally), route input to it
  if (state.wizardActive) {
    try {
      const result = await client.wizardInput(text, "cli");
      if (result.handled) {
        if (result.replies.length > 0) {
          process.stdout.write("\n");
          for (const reply of result.replies) {
            console.log(reply);
          }
          process.stdout.write("\n");
        }
        return;
      }
    } catch {
      // wizard check failed — fall through to normal send
    }
  }

  // Plain text → send to current chat target
  if (state.chatMode === "none") {
    printError("未进入会话模式，使用 /chat <目标> 进入（9位数字=群，其他=私聊）");
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

  // Check for commands that should terminate the CLI after execution
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
      process.stdout.write("\n");
      const { renderMarkdownAnsi } = await import("../utils/cli-format.js");
      for (const reply of result.replies) {
        console.log(await renderMarkdownAnsi(reply));
      }
      process.stdout.write("\n");
    }
  } catch (err) {
    printError(`dispatch 失败: ${(err as Error).message}`);
  }

  // After /daemon stop or /daemon reset, the daemon is gone.
  if (shouldExitAfter) {
    console.log(chalk.dim("CLI 将退出（daemon 已停止）"));
    process.exit(0);
  }
}

// ─── Tab completion ───

function completer(line: string, ctx: CompletionContext): [string[], string] {
  try {
    const result: CompletionResult = getCompletions(line, ctx);
    return [result.completions, result.replaceFrom];
  } catch {
    return [[], line];
  }
}

// ─── History sync ───

function syncHistory(rl: readline.Interface, history: RichHistory): void {
  const all = history.getAll().slice(-500);
  (rl as unknown as { history: string[] }).history = all.slice().reverse();
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
      const d = data as { text: string; to: string; isGroup: boolean };
      void printOutboundMessage(d.text, d.to, d.isGroup);
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

  // Session-mode filtering: if the user is in a group/DM session, only
  // show messages from THAT session. Other messages are silently dropped
  // (the user explicitly entered a focused session).
  if (state.chatMode === "group" && state.chatTarget) {
    if (!isGroup || msg.groupCode !== state.chatTarget) return;
  } else if (state.chatMode === "dm" && state.chatTarget) {
    if (isGroup || msg.fromUserId !== state.chatTarget) return;
  }

  const { formatInboundMessage } = await import("../utils/cli-format.js");
  // Clear the current prompt line, print the message, then re-render the
  // prompt below it — this keeps the prompt "stuck" to the bottom of the
  // terminal instead of leaving it stranded mid-screen.
  process.stdout.write("\r\x1b[K"); // CR + clear line
  console.log(formatInboundMessage(msg, isGroup));
  // Re-render prompt on the new bottom line
  if (rlInstance) {
    rlInstance.prompt(true);
  }
}

async function printOutboundMessage(
  text: string,
  to: string,
  isGroup: boolean,
): Promise<void> {
  const { formatOutboundMessage } = await import("../utils/cli-format.js");
  process.stdout.write("\r\x1b[K");
  console.log(formatOutboundMessage(text, to, isGroup));
  if (rlInstance) {
    rlInstance.prompt(true);
  }
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
  if (rlInstance) {
    rlInstance.prompt(true);
  }
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

// rlInstance is set after readline.createInterface so that SSE handlers
// can re-render the prompt after printing inbound messages.
let rlInstance: readline.Interface | null = null;

function printWelcome(version: string, pid: number, port: number): void {
  printH1(`Yuanbao Lite CLI v${version}`);
  console.log(
    `  ${COLORS.dim("shell-mode · readline + RichHistory + auto-complete + syntax-highlight")}`,
  );
  console.log(`  ${COLORS.dim(`daemon pid=${pid} port=${port}`)}`);
  console.log(
    `  ${COLORS.dim("/help 查看命令  ·  ↑↓ 历史  ·  Tab 补全  ·  \\ 换行  ·  Ctrl+C 退出")}`,
  );
  console.log(
    `  ${COLORS.dim("/chat <目标> 进入会话  ·  /chat 退出会话  (9位数字=群，其他=私聊)")}`,
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
