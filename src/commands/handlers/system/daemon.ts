/**
 * /daemon command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  // Per-user confirmation tracking: key = `${userId}:${subCmd}`, value = { count, firstAt }
  const daemonConfirmations = new Map<string, { count: number; firstAt: number }>();
  const CONFIRM_WINDOW_MS = 60_000; // 1 minute
  const REQUIRED_CONFIRMATIONS = 3;

  cmdSys.register({
    name: "daemon",
    aliases: ["守护进程"],
    description: "daemon 进程管理（stop/reset/restart，需3次确认）",
    usage: "/daemon <stop|reset|restart|status>   (1分钟内发送3次才生效)",
    category: "system" as CommandCategory,
    requireConnected: false,
    elevated: true,
    handler: async (ctx) => {
      const subCmd = ctx.args[0]?.toLowerCase();
      const userId = ctx.message.fromUserId;

      if (!subCmd || subCmd === "status") {
        // Status — no confirmation needed
        const { getDefaultClient } = await import("../../../cli/client/daemon-client.js");
        const client = getDefaultClient();
        const info = await client.ping();
        if (!info) {
          await ctx.reply("daemon 未在运行");
          return;
        }
        const bot = info.bot;
        const lines = [
          `📊 daemon 状态:`,
          `  PID: ${info.pid}`,
          `  版本: ${info.version}`,
          `  端口: ${info.port}`,
          `  运行: ${info.uptime}s`,
          `  Bot: ${bot?.connected ? "✓ 已连接" : "✗ 未连接"}`,
          ...(bot?.botId ? [`  Bot ID: ${bot.botId}`] : []),
        ];
        await ctx.reply(lines.join("\n"));
        return;
      }

      if (!["stop", "reset", "restart"].includes(subCmd)) {
        await ctx.reply("用法: /daemon <stop|reset|restart|status>\nstop/reset/restart 需要1分钟内发送3次确认");
        return;
      }

      // CLI source bypasses the 3x confirmation (CLI is pre-authorized)
      if (ctx.source === "cli") {
        const { getDefaultClient } = await import("../../../cli/client/daemon-client.js");
        const client = getDefaultClient();
        try {
          if (subCmd === "stop") {
            await client.shutdown();
            await ctx.reply(`✅ daemon 已停止 (CLI 直接执行)`);
          } else if (subCmd === "restart") {
            // CRITICAL: do NOT call client.shutdown() then client.ensureDaemon().
            // When this runs INSIDE the daemon (via /command), shutdown() kills
            // the current process before ensureDaemon() can run — the daemon
            // dies permanently. Instead, use client.restart() which spawns a
            // fresh detached daemon; the new daemon's acquirePidFile() will
            // SIGTERM the old one and take over.
            await client.restart();
            await ctx.reply(`✅ daemon 已重启 (CLI 直接执行)`);
          } else if (subCmd === "reset") {
            // reset = restart + (caches cleared on boot by the new daemon)
            await client.restart();
            await ctx.reply(`✅ daemon 已重置 (CLI 直接执行，缓存已清除)`);
          }
        } catch (err) {
          await ctx.reply(`❌ daemon ${subCmd} 失败: ${(err as Error).message}`);
        }
        return;
      }

      // Confirmation tracking (chat source only)
      const key = `${userId}:${subCmd}`;
      const now = Date.now();
      const entry = daemonConfirmations.get(key);

      if (!entry || now - entry.firstAt > CONFIRM_WINDOW_MS) {
        // First confirmation (or window expired)
        daemonConfirmations.set(key, { count: 1, firstAt: now });
        await ctx.reply(
          `⚠️ 确认 ${subCmd} daemon (1/3)\n` +
          `请在 ${CONFIRM_WINDOW_MS / 1000}s 内再发送 ${REQUIRED_CONFIRMATIONS - 1} 次 /daemon ${subCmd} 以确认操作`,
        );
        return;
      }

      entry.count++;
      if (entry.count < REQUIRED_CONFIRMATIONS) {
        await ctx.reply(
          `⚠️ 确认 ${subCmd} daemon (${entry.count}/${REQUIRED_CONFIRMATIONS})\n` +
          `还需 ${REQUIRED_CONFIRMATIONS - entry.count} 次确认`,
        );
        return;
      }

      // Reached required confirmations — execute
      daemonConfirmations.delete(key);
      const { getDefaultClient } = await import("../../../cli/client/daemon-client.js");
      const client = getDefaultClient();

      try {
        if (subCmd === "stop") {
          await client.shutdown();
          await ctx.reply(`✅ daemon 已停止 (${REQUIRED_CONFIRMATIONS} 次确认完成)`);
        } else if (subCmd === "restart") {
          // CRITICAL: do NOT call client.shutdown() then client.ensureDaemon().
          // When this runs INSIDE the daemon (via /command from chat), shutdown()
          // kills the current process before ensureDaemon() can run — the daemon
          // dies permanently AND the user gets no reply. Instead, use
          // client.restart() which spawns a fresh detached daemon; the new
          // daemon's acquirePidFile() SIGTERMs the old one and takes over.
          // The reply is sent BEFORE the old daemon is killed (the new daemon
          // takes a few seconds to start up and kill the old one).
          await client.restart();
          await ctx.reply(`✅ daemon 已重启 (${REQUIRED_CONFIRMATIONS} 次确认完成)`);
        } else if (subCmd === "reset") {
          // reset = restart + (caches cleared on boot by the new daemon)
          await client.restart();
          await ctx.reply(`✅ daemon 已重置 (${REQUIRED_CONFIRMATIONS} 次确认完成，缓存已清除)`);
        }
      } catch (err) {
        await ctx.reply(`❌ daemon ${subCmd} 失败: ${(err as Error).message}`);
      }
    },
  });
}
