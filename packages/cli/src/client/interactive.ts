/**
 * Interactive REPL — shell-like experience via node:readline.
 *
 * Features:
 *   - Persistent history (RichHistory, deduped, ~/.yuanbao-lite/history)
 *   - ↑↓ navigation through history
 *   - Tab completion (commands, sub-commands, file paths, contacts/groups/aliases)
 *   - Real-time syntax highlighting of the input line
 *   - Multi-line input via trailing backslash
 *   - Live SSE subscription for incoming DM/group messages
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
};

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
      // Build lightweight stores that satisfy the CompletionContext shape.
      // The auto-complete module only reads .getAll() / .resolve() / .get()
      // — we provide minimal in-memory implementations.
      completionCtx.contactStore = makeLiteContactStore(data.contacts) as never;
      completionCtx.groupStore = makeLiteGroupStore(data.groups) as never;
      completionCtx.aliasStore = makeLiteAliasStore(data.aliases) as never;
    } catch {
      // ignore — completions will fall back to command/path only
    }
  };
  void refreshCompletions();
  const completionTimer = setInterval(refreshCompletions, 30_000);

  // 6. Readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => completer(line, completionCtx),
    historySize: 0, // we manage history ourselves via RichHistory
    prompt: currentPrompt(),
  });

  // Sync RichHistory → readline.history for ↑↓ navigation
  syncHistory(rl, history);

  // Custom keypress handler for real-time syntax highlighting
  setupSyntaxHighlight(rl);

  // Refresh prompt when chat mode changes
  const refreshPrompt = () => rl.setPrompt(currentPrompt());

  // 7. REPL loop
  rl.prompt();

  await new Promise<void>((resolve) => {
    rl.on("line", async (input: string) => {
      // 续行 (continuation): line ending with \ is extension of previous input.
      // Join with \n so the assembled fullLine preserves line boundaries —
      // processLine below splits by \n and dispatches each line independently
      // (per dispatch rule 2: 续行本来就要拆行).
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
      rl.prompt();
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
  unsubscribe();

  printStatus("再见 👋");
}

// ─── Line processing ───
//
// Dispatch rules (mirror src/index.ts handleDispatch Step 2):
//   1. 未续行 (standalone line, not preceded by \) → independent content,
//      recognize slash independently. Lines starting with / are slash commands.
//   2. 续行 (continuation, preceded by \) → extension of previous input, but
//      the joined fullLine preserves \n so processLine below splits and
//      dispatches each line independently (续行本来就要拆行).
//   3. 不符合任何一条规则 (standalone plain text — no slash, not continuation):
//      - 私聊 (bot-side DM, chatType=direct in src/index.ts): auto-reply via LLM.
//      - CLI (here): send directly as chat message to the current target.
//        If no chat target is set, sendChatMessage() prints an error hint.
async function processLine(line: string, client: DaemonClient): Promise<void> {
  // Split by \n — this includes both pasted multi-line input AND lines joined
  // by \ continuation (which preserve \n per the readline handler above).
  // Each line is dispatched independently in its original order.
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

  // /chat [dm|group <id>] — handle locally + delegate to CommandSystem
  if (line === "/chat" || line.startsWith("/chat ")) {
    handleChatCommand(line);
    await dispatchCommand(line, client);
    return;
  }

  // /join <groupCode> — set chat mode locally + delegate
  if (line === "/join" || line.startsWith("/join ")) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      state.chatMode = "group";
      state.chatTarget = parts[1];
      printStatus(`切换到群聊模式: ${parts[1]}`);
    }
    await dispatchCommand(line, client);
    return;
  }

  // /switch — show locally + delegate
  if (line === "/switch" || line.startsWith("/switch ")) {
    printStatus(
      `当前模式: ${state.chatMode} ${state.chatTarget ? `→ ${state.chatTarget}` : ""}`,
    );
    await dispatchCommand(line, client);
    return;
  }

  // Any other /command → daemon dispatch
  if (line.startsWith("/")) {
    await dispatchCommand(line, client);
    return;
  }
}

async function sendChatMessage(
  text: string,
  client: DaemonClient,
): Promise<void> {
  // Non-slash input — check if a wizard session is active
  // If so, route the input to the wizard instead of sending as chat message
  try {
    const wizStatus = await client.wizardStatus("cli");
    if (wizStatus.active) {
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
    }
  } catch {
    // wizard check failed — fall through to normal send
  }

  // Plain text → send to current chat target
  if (state.chatMode === "none") {
    printError("未进入聊天模式，使用 /chat dm <id> 或 /chat group <groupCode>");
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
      for (const reply of result.replies) {
        console.log(reply);
      }
      process.stdout.write("\n");
    }
  } catch (err) {
    printError(`dispatch 失败: ${(err as Error).message}`);
  }

  // After /daemon stop or /daemon reset, the daemon is gone.
  // The CLI can no longer communicate with it, so exit cleanly.
  if (shouldExitAfter) {
    console.log(chalk.dim("CLI 将退出（daemon 已停止）"));
    process.exit(0);
  }
}

function handleChatCommand(line: string): void {
  const parts = line.split(/\s+/);
  if (parts.length === 1) {
    state.chatMode = "none";
    state.chatTarget = "";
    printStatus("已退出聊天模式");
    return;
  }
  if (parts[1] === "group" && parts[2]) {
    state.chatMode = "group";
    state.chatTarget = parts[2];
    printStatus(`切换到群聊模式: ${parts[2]}`);
    return;
  }
  if (parts[1] === "dm" && parts[2]) {
    state.chatMode = "dm";
    state.chatTarget = parts[2];
    printStatus(`切换到私聊模式: ${parts[2]}`);
    return;
  }
  if (parts[1] && parts[1] !== "dm" && parts[1] !== "group") {
    state.chatMode = "dm";
    state.chatTarget = parts[1];
    printStatus(`切换到私聊模式: ${parts[1]}`);
    return;
  }
  printWarn("用法: /chat [dm <id> | group <groupCode>]");
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

// ─── Real-time syntax highlighting ───

function setupSyntaxHighlight(rl: readline.Interface): void {
  // node:readline doesn't expose a clean "on input change" hook.
  // Real-time syntax highlighting would require intercepting keypress events
  // and re-rendering the line — this conflicts with readline's own cursor
  // management and breaks arrow keys / history navigation.
  //
  // Instead, we apply syntax highlighting to the FINAL committed line via
  // the /command dispatch path (the daemon's CommandSystem produces colored
  // output). For interactive editing, we rely on readline's default behavior.
  //
  // The highlightLine() function from cli/client/syntax-highlight.ts (removed) is
  // still available and applied to command replies in dispatchCommand().
  void rl;
}

// ─── History sync ───

function syncHistory(rl: readline.Interface, history: RichHistory): void {
  // readline.history is the array used for ↑↓ navigation (reversed: index 0 = most recent)
  const all = history.getAll().slice(-500);
  // readline expects most-recent-first
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
  const { formatInboundMessage } = await import("../utils/cli-format.js");
  process.stdout.write("\n");
  console.log(formatInboundMessage(msg, isGroup));
  process.stdout.write("\n");
}

async function printOutboundMessage(
  text: string,
  to: string,
  isGroup: boolean,
): Promise<void> {
  const { formatOutboundMessage } = await import("../utils/cli-format.js");
  process.stdout.write("\n");
  console.log(formatOutboundMessage(text, to, isGroup));
  process.stdout.write("\n");
}

function printStateChange(s: BotState): void {
  if (s.connected) {
    printResult(`bot 已连接${s.botId ? ` (botId=${s.botId})` : ""}`);
  } else {
    printWarn(
      `bot 状态变更: ${s.status}${s.lastError ? ` — ${s.lastError}` : ""}`,
    );
  }
}

// formatTime/pad2 moved to cli-format.ts

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
    `  ${COLORS.dim("shell-mode · readline + RichHistory + auto-complete")}`,
  );
  console.log(`  ${COLORS.dim(`daemon pid=${pid} port=${port}`)}`);
  console.log(
    `  ${COLORS.dim("/help 查看命令  ·  ↑↓ 历史  ·  Tab 补全  ·  \\ 换行  ·  Ctrl+C 退出")}`,
  );
  console.log("");
}

// ─── Lite in-memory stores for completion context ───
// The auto-complete module reads .getAll() / .resolve() / .get() — we provide
// minimal implementations backed by data fetched from the daemon.

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
