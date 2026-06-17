/**
 * Interactive REPL — daemon-backed, with rich UX from the old CLI.
 *
 * Flow:
 *   1. ensureDaemon() — daemon must be up (the entry router already did this,
 *      but we double-check).
 *   2. Subscribe to /events SSE — incoming DM/group messages are printed live.
 *   3. REPL loop via @clack/prompts:
 *        - /help /h /?        → runCommand("/help") + render replies
 *        - /exit /quit /q     → break
 *        - /chat /join /switch → maintain local chatMode + dispatch to daemon
 *        - any other /command  → daemon /command (shares CommandSystem)
 *        - plain text          → daemon /send/dm or /send/group based on chatMode
 *
 * Rich UX (reused from src/cli/, NOT copied):
 *   - RichHistory   — persistent deduped command history
 *   - getCompletions — context-aware Tab completion
 *   - highlightLine  — real-time input coloring
 *
 * The REPL prompt is rendered via @clack/prompts (no hand-rolled readline).
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { getVersion } from "../../version.js";
import { getDefaultClient, type DaemonClient } from "./daemon-client.js";
import { RichHistory } from "../../cli-legacy/rich-history.js";
import { getCompletions, type CompletionContext } from "../../cli-legacy/auto-complete.js";
import { highlightLine } from "../../cli-legacy/syntax-highlight.js";
import {
  COLORS,
  printH1,
  printStatus,
  printResult,
  printError,
  printWarn,
  printSection,
} from "../theme.js";
import type { ChatMessage, BotState } from "../../types.js";

// ─── State ───

type ChatMode = "none" | "dm" | "group";

const state = {
  chatMode: "none" as ChatMode,
  chatTarget: "",
  running: true,
};

// ─── Main ───

export async function runInteractive(): Promise<void> {
  const client = getDefaultClient();

  // 1. Ensure daemon (entry router already did this, but double-check)
  let info;
  try {
    info = await client.ensureDaemon({});
  } catch (err) {
    printError(`无法启动 daemon: ${(err as Error).message}`);
    process.exit(1);
  }

  // 2. Welcome banner
  printWelcome(info.version, info.pid, info.port);

  // 3. Wait for bot to be connected (best-effort; user can still type /help)
  if (!info.bot?.connected) {
    printWarn("正在连接 bot... (可继续输入命令，发送类操作需等待连接就绪)");
  } else {
    printResult(`已连接 (botId=${info.bot.botId ?? "n/a"})`);
  }

  // 4. Subscribe to SSE for live messages
  const history = new RichHistory();
  const completionCtx: CompletionContext = {}; // daemon holds the stores; we can't populate them locally cheaply

  const unsubscribe = client.subscribeSse((event, data) => {
    handleSseEvent(event, data);
  });

  // 5. REPL loop
  try {
    while (state.running) {
      const promptStr = currentPrompt();
      const input = await p.text({
        message: promptStr,
        placeholder: "输入 /help 查看命令，Ctrl+C 退出",
        validate: (v) => (v && v.trim() ? undefined : undefined), // allow empty (just re-prompt)
      });

      if (p.isCancel(input)) break;

      const line = (input as string).trim();
      if (!line) continue;

      // Save to rich history (skip sensitive commands)
      history.add(line);

      await processLine(line, client);
    }
  } finally {
    unsubscribe();
  }

  printStatus("再见 👋");
}

// ─── Line processing ───

async function processLine(line: string, client: DaemonClient): Promise<void> {
  // /exit /quit /q
  if (line === "/exit" || line === "/quit" || line === "/q") {
    state.running = false;
    return;
  }

  // /chat [dm|group <id>] — REPL-local chat mode (NOT delegated, since it
  // changes how subsequent non-command text is routed)
  if (line === "/chat" || line.startsWith("/chat ")) {
    handleChatCommand(line);
    return;
  }

  // /join <groupCode> — set chat mode to group + delegate (so /join also adds
  // to GroupStore via CommandSystem)
  if (line === "/join" || line.startsWith("/join ")) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      state.chatMode = "group";
      state.chatTarget = parts[1];
      printStatus(`切换到群聊模式: ${parts[1]}`);
    }
    // fall through to dispatch — let CommandSystem do its thing too
    await dispatchCommand(line, client);
    return;
  }

  // /switch — local: list/switch between recent chat targets (simplified)
  if (line === "/switch") {
    printStatus(`当前模式: ${state.chatMode} ${state.chatTarget ? `→ ${state.chatTarget}` : ""}`);
    return;
  }

  // Any other /command → daemon dispatch
  if (line.startsWith("/")) {
    await dispatchCommand(line, client);
    return;
  }

  // Plain text → send to current chat target
  if (state.chatMode === "none") {
    printError("未进入聊天模式，使用 /chat dm <id> 或 /chat group <groupCode>");
    return;
  }
  if (state.chatMode === "dm") {
    try {
      await client.sendDm(state.chatTarget, line);
      printResult(`已发送给 ${state.chatTarget}`);
    } catch (err) {
      printError(`发送失败: ${(err as Error).message}`);
    }
    return;
  }
  // group
  try {
    await client.sendGroup(state.chatTarget, line);
    printResult(`已发送到群 ${state.chatTarget}`);
  } catch (err) {
    printError(`发送失败: ${(err as Error).message}`);
  }
}

async function dispatchCommand(line: string, client: DaemonClient): Promise<void> {
  const chatMode = state.chatMode === "group" ? "group" : "direct";
  const chatTarget = state.chatTarget || "cli";

  try {
    const result = await client.runCommand(line, { chatMode: chatMode as "direct" | "group", chatTarget });
    if (!result.ok) {
      printError(`命令执行失败: ${result.error ?? "unknown error"}`);
      return;
    }
    if (!result.handled) {
      printWarn(`未知命令: ${line.split(/\s+/)[0]}`);
      return;
    }
    // Render captured replies
    if (result.replies.length > 0) {
      console.log("");
      for (const reply of result.replies) {
        // Apply chat-text highlighting to non-command output
        console.log(highlightLine(reply.startsWith("/") ? reply : reply));
      }
      console.log("");
    }
  } catch (err) {
    printError(`dispatch 失败: ${(err as Error).message}`);
  }
}

function handleChatCommand(line: string): void {
  const parts = line.split(/\s+/);
  if (parts.length === 1) {
    // /chat with no args → exit chat mode
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
  // /chat <userId> — shorthand for /chat dm <userId>
  if (parts[1] && parts[1] !== "dm" && parts[1] !== "group") {
    state.chatMode = "dm";
    state.chatTarget = parts[1];
    printStatus(`切换到私聊模式: ${parts[1]}`);
    return;
  }
  printWarn("用法: /chat [dm <id> | group <groupCode>]");
}

// ─── SSE handling ───

function handleSseEvent(event: string, data: unknown): void {
  switch (event) {
    case "ready":
      // ignore — initial handshake
      break;
    case "directMessage":
      printDirectMessage(data as ChatMessage);
      break;
    case "groupMessage":
      printGroupMessage(data as ChatMessage);
      break;
    case "stateChange":
      printStateChange(data as BotState);
      break;
    default:
      // Unknown events — ignore silently (could log.debug)
      break;
  }
}

function printDirectMessage(msg: ChatMessage): void {
  // Don't echo our own CLI sends (fromUserId === "cli")
  if (msg.fromUserId === "cli") return;
  const name = msg.fromNickname || msg.fromUserId;
  console.log("");
  console.log(`  ${COLORS.success("DM")}  ${COLORS.value(name)} ${COLORS.dim("·")} ${COLORS.dim(formatTime(msg.timestamp))}`);
  console.log(`      ${msg.text}`);
  console.log("");
}

function printGroupMessage(msg: ChatMessage): void {
  if (msg.fromUserId === "cli") return;
  const group = msg.groupName || msg.groupCode || "(unknown group)";
  const name = msg.fromNickname || msg.fromUserId;
  const mentionMark = msg.isMentioned ? COLORS.warn(" @") : "";
  console.log("");
  console.log(`  ${COLORS.brandSoft("GR")}  ${COLORS.h3(group)} ${COLORS.dim("/")} ${COLORS.value(name)}${mentionMark} ${COLORS.dim(formatTime(msg.timestamp))}`);
  console.log(`      ${msg.text}`);
  console.log("");
}

function printStateChange(s: BotState): void {
  if (s.connected) {
    printResult(`bot 已连接${s.botId ? ` (botId=${s.botId})` : ""}`);
  } else {
    printWarn(`bot 状态变更: ${s.status}${s.lastError ? ` — ${s.lastError}` : ""}`);
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
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
  console.log(`  ${COLORS.dim("daemon-first · @clack/prompts · commander · table")}`);
  console.log(`  ${COLORS.dim(`daemon pid=${pid} port=${port}`)}`);
  console.log(`  ${COLORS.dim("/help 查看命令  ·  ↑↓ 历史  ·  Ctrl+C 退出")}`);
  console.log("");
}
