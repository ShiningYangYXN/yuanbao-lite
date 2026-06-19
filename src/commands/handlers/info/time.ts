/**
 * /time command handler — extracted from registry.ts (lossless split).
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
        name: "time",
        aliases: ["时间", "now", "当前时间"],
        description: "显示当前时间（支持时区）",
        usage: "/time [时区]   例: /time, /time Asia/Tokyo, /time America/New_York",
        category: "info" as CommandCategory,
        handler: async (ctx) => {
          const tz = ctx.args[0] || "Asia/Shanghai";
          try {
            const now = new Date();
            const formatter = new Intl.DateTimeFormat("zh-CN", {
              timeZone: tz,
              year: "numeric", month: "2-digit", day: "2-digit",
              hour: "2-digit", minute: "2-digit", second: "2-digit",
              hour12: false,
            });
            await ctx.reply(`🕐 ${tz}:\n${formatter.format(now)}`);
          } catch {
            await ctx.reply(`❌ 无效时区: ${tz}\n示例: Asia/Shanghai, Asia/Tokyo, America/New_York, Europe/London`);
          }
        },
      });
}
