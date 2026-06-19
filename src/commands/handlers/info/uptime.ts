/**
 * /uptime command handler — extracted from registry.ts (lossless split).
 * Category: misc
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "uptime",
        aliases: ["运行时间"],
        description: "查看机器人运行时间",
        usage: "/uptime   (显示已运行时长)",
        category: "info" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          const state = ctx.bot.getState();
          if (!state.lastConnectedAt) {
            await ctx.reply("暂无连接信息");
            return;
          }
          const uptimeMs = Date.now() - state.lastConnectedAt;
          const hours = Math.floor(uptimeMs / 3600000);
          const minutes = Math.floor((uptimeMs % 3600000) / 60000);
          const seconds = Math.floor((uptimeMs % 60000) / 1000);
          await ctx.reply(`⏱️ 运行时间: ${hours}h ${minutes}m ${seconds}s`);
        },
      });
}
