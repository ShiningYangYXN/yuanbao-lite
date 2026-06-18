/**
 * /term command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { generateColoredHelp } from "../../help-text.js";
import {
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../../../business/sticker.js";
import {
  uploadToLitterbox,
  uploadAndFormatLink as tempfileFormatLink,
} from "../../../access/http/tempfile.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "term",
        aliases: ["终端", "terminal", "shell-session"],
        description: "进入交互式终端（阻塞，5分钟无操作自动退出，仅私聊）",
        usage: "/term   (进入交互式终端，5分钟无操作自动退出)\n/term exit 退出终端",
        category: "system" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args[0]?.toLowerCase() === "exit") {
            const sessions = (cmdSys as unknown as { _termSessions?: Map<string, unknown> })._termSessions;
            if (sessions) {
              const session = sessions.get(ctx.message.fromUserId) as { shell: { kill: (sig: string) => void } } | undefined;
              if (session) {
                session.shell.kill("SIGTERM");
                sessions.delete(ctx.message.fromUserId);
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
          const existing = sessions.get(ctx.message.fromUserId);
          if (existing) {
            existing.shell.kill("SIGTERM");
            sessions.delete(ctx.message.fromUserId);
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
              sessions.delete(ctx.message.fromUserId);
              ctx.bot.sendDirectMessage(ctx.message.fromUserId, "⏰ 终端已超时（5分钟无操作），自动退出").catch(() => {});
            }
          }, 30_000);

          sessions.set(ctx.message.fromUserId, session);

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
}
