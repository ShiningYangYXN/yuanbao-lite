/**
 * /term command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import { sessionKeyFromMessage } from "../../session-utils.js";
import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "term",
        aliases: ["终端", "terminal", "shell-session"],
        description: "进入交互式终端（阻塞，5分钟无操作自动退出，仅私聊）",
        usage: "/term   (进入交互式终端，5分钟无操作自动退出)\n/term exit 退出终端",
        category: "system" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const sessionKey = sessionKeyFromMessage(ctx.message);
          if (ctx.args[0]?.toLowerCase() === "exit") {
            const sessions = (cmdSys as unknown as { _termSessions?: Map<string, unknown> })._termSessions;
            if (sessions) {
              const session = sessions.get(sessionKey) as { shell: { kill: (sig: string) => void } } | undefined;
              if (session) {
                session.shell.kill("SIGTERM");
                sessions.delete(sessionKey);
              }
              await ctx.reply("🖥️ 终端已退出");
            }
            return;
          }

          // Start terminal session
          const sessions = (cmdSys as unknown as { _termSessions?: Map<string, { shell: { kill: (sig: string) => void; killed: boolean; exitCode: number | null; stdout: { on: (e: string, cb: (d: Buffer) => void) => void }; stderr: { on: (e: string, cb: (d: Buffer) => void) => void }; on: (e: string, cb: (code: number | null) => void) => void; stdin: { write: (s: string) => boolean } | null } }> })._termSessions;
          if (!sessions) {
            await ctx.reply("❌ 终端会话管理不可用");
            return;
          }

          // Kill existing session if re-entering
          const existing = sessions.get(sessionKey);
          if (existing) {
            existing.shell.kill("SIGTERM");
            sessions.delete(sessionKey);
          }

          // Spawn a persistent shell process
          const { spawn } = await import("node:child_process");
          const shell = spawn("bash", ["--noprofile", "--norc"], {
            cwd: process.env.HOME || process.cwd(),
            env: { ...process.env, PS1: "", PS2: "" },
            stdio: ["pipe", "pipe", "pipe"],
          }) as unknown as {
            kill: (sig: string) => void;
            killed: boolean;
            exitCode: number | null;
            stdout: { on: (e: string, cb: (d: Buffer) => void) => void };
            stderr: { on: (e: string, cb: (d: Buffer) => void) => void };
            on: (e: string, cb: (code: number | null) => void) => void;
            stdin: { write: (s: string) => boolean } | null;
          };

          const session = {
            shell,
            lastActivity: Date.now(),
            lastExitCode: null as number | null,
            outputBuffer: "",
            commandResolve: null as (() => void) | null,
            idleTimer: null as ReturnType<typeof setInterval> | null,
          };

          // Collect output
          shell.stdout.on("data", (data: Buffer) => {
            session.outputBuffer += data.toString();
          });
          shell.stderr.on("data", (data: Buffer) => {
            session.outputBuffer += data.toString();
          });
          shell.on("exit", (code: number | null) => {
            session.lastExitCode = code ?? 0;
            if (session.commandResolve) {
              session.commandResolve();
              session.commandResolve = null;
            }
          });

          // Set up idle timeout check
          session.idleTimer = setInterval(() => {
            if (Date.now() - session.lastActivity > 5 * 60 * 1000) {
              if (session.idleTimer) clearInterval(session.idleTimer);
              shell.kill("SIGTERM");
              sessions.delete(sessionKey);
              ctx.bot.sendDirectMessage(ctx.message.fromUserId, "⏰ 终端已超时（5分钟无操作），自动退出").catch(() => {});
            }
          }, 30_000);

          sessions.set(sessionKey, session);

          await ctx.reply(
            "🖥️ 交互式终端已启动\n\n" +
            "接下来的消息将作为 shell 命令执行。\n" +
            "工作目录和环境变量变更会保留。\n" +
            "发送 /term exit 退出终端。\n" +
            "5分钟无操作自动退出。\n\n" +
            "示例: cd /tmp, export FOO=bar, ls -la",
          );
        },
      });

  // ─── Terminal session setup ───
  // This MUST be set up so /term can find _termSessions.
  // The terminal input handler is called by YuanbaoBot.handleDispatch when a
  // user has an active session (intercepts non-slash messages).
  type TermSession = {
    shell: { kill: (sig: string) => void; killed: boolean; exitCode: number | null; stdout: { on: (e: string, cb: (d: Buffer) => void) => void }; stderr: { on: (e: string, cb: (d: Buffer) => void) => void }; on: (e: string, cb: (code: number | null) => void) => void; stdin: { write: (s: string) => boolean } | null };
    lastActivity: number;
    lastExitCode: number | null;
    outputBuffer: string;
    commandResolve: (() => void) | null;
    idleTimer: ReturnType<typeof setInterval> | null;
  };
  const termSessions = new Map<string, TermSession>();
  (cmdSys as unknown as { _termSessions: Map<string, unknown> })._termSessions = termSessions;

  (cmdSys as unknown as { _handleTermInput: (bot: unknown, sessionKey: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean> })._handleTermInput =
    async (bot: unknown, sessionKey: string, text: string, reply: (t: string) => Promise<void>): Promise<boolean> => {
      const session = termSessions.get(sessionKey);
      if (!session) return false;

      // Check if shell has exited
      if (session.shell.killed || session.shell.exitCode !== null) {
        termSessions.delete(sessionKey);
        if (session.idleTimer) clearInterval(session.idleTimer);
        await reply(`🖥️ 终端进程已退出 (退出码: ${session.lastExitCode ?? 0})`);
        return true;
      }

      // Check 5-minute timeout
      if (Date.now() - session.lastActivity > 5 * 60 * 1000) {
        session.shell.kill("SIGTERM");
        if (session.idleTimer) clearInterval(session.idleTimer);
        termSessions.delete(sessionKey);
        await reply("⏰ 终端已超时（5分钟无操作），自动退出");
        return true;
      }

      session.lastActivity = Date.now();
      const cmd = text.trim();

      // Check for exit command
      if (cmd === "exit" || cmd === "quit" || cmd === "/term exit" || cmd === "/term") {
        session.shell.kill("SIGTERM");
        if (session.idleTimer) clearInterval(session.idleTimer);
        termSessions.delete(sessionKey);
        await reply(`🖥️ 终端已退出${session.lastExitCode !== null ? ` (最后退出码: ${session.lastExitCode})` : ""}`);
        return true;
      }

      // Execute command in the persistent shell
      session.outputBuffer = "";
      const marker = `__TERM_MARKER_${Date.now()}__`;
      let resolved = false;

      const outputPromise = new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(session.outputBuffer);
            session.outputBuffer = "";
          }
        }, 30_000);

        const checkOutput = () => {
          if (resolved) return;
          if (session.outputBuffer.includes(marker)) {
            resolved = true;
            clearTimeout(timeout);
            const fullBuffer = session.outputBuffer;
            session.outputBuffer = "";
            resolve(fullBuffer);
          } else {
            setTimeout(checkOutput, 50);
          }
        };
        checkOutput();
      });

      if (session.shell.stdin) {
        session.shell.stdin.write(`${cmd}\n`);
        session.shell.stdin.write(`echo "${marker}$?|$(whoami)|$(hostname)|$(pwd)"\n`);
      }

      const rawBuffer = await outputPromise;

      const markerIdx = rawBuffer.indexOf(marker);
      const output = markerIdx >= 0
        ? rawBuffer.slice(0, markerIdx).replace(/\r\n/g, "\n").trim()
        : rawBuffer.replace(/\r\n/g, "\n").trim();
      const afterMarker = markerIdx >= 0
        ? rawBuffer.slice(markerIdx + marker.length).trim()
        : "";

      const promptParts = afterMarker.split("|");
      if (promptParts.length >= 1) {
        session.lastExitCode = parseInt(promptParts[0], 10) || 0;
      }
      const userInfo = promptParts.length >= 2 ? promptParts[1] : "";
      const hostInfo = promptParts.length >= 3 ? promptParts[2] : "";
      const cwdInfo = promptParts.length >= 4 ? promptParts[3] : "";
      const home = process.env.HOME || "";
      const promptStr = (userInfo && hostInfo && cwdInfo)
        ? `${userInfo}@${hostInfo}:${home && cwdInfo.startsWith(home) ? "~" + cwdInfo.slice(home.length) : cwdInfo}$ `
        : "$ ";

      const cleanOutput = output || "(无输出)";
      // Interactive terminal never truncates output — user expects full output
      await reply(`${promptStr}${cmd}\n${cleanOutput}\n[退出码: ${session.lastExitCode ?? 0}]`);
      return true;
    };
}
