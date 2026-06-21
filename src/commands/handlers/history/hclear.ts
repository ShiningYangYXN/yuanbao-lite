/**
 * /hclear command handler — extracted from registry.ts (lossless split).
 * Category: history
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "hclear",
    aliases: ["清除历史"],
    description: "清除消息历史（不可恢复）",
    usage: "/hclear",
    category: "history" as CommandCategory,
    elevated: true,
    handler: async (ctx) => {
      const store = ctx.bot.getHistoryStore();
      store.clear();
      await ctx.reply("✅ 消息历史已清除");
    },
  });
}
