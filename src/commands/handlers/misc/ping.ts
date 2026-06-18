/**
 * /ping command handler — extracted from registry.ts (lossless split).
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
        name: "ping",
        aliases: ["pong"],
        description: "测试机器人响应延迟",
        usage: "/ping   (返回pong和延迟时间)",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          const start = Date.now();
          await ctx.reply("🏓 pong!");
          const latency = Date.now() - start;
          cmdSys.log.info(`ping latency: ${latency}ms`);
        },
      });
}
