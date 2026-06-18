/**
 * /version command handler — extracted from registry.ts (lossless split).
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
        name: "version",
        aliases: ["v", "ver", "版本"],
        description: "查看版本信息",
        usage: "/version   (显示当前版本号)",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          const { getVersion } = await import("../../../version.js");
          await ctx.reply(
            `📦 Yuanbao Lite v${getVersion()}\n轻量级独立腾讯元宝机器人客户端`,
          );
        },
      });
}
