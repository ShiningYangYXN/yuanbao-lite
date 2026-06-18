/**
 * /echo command handler — extracted from registry.ts (lossless split).
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
        name: "echo",
        aliases: ["say", "重复"],
        description: "回显消息文本",
        usage: "/echo <文本内容>   (原样返回输入文本)",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /echo <文本内容>");
            return;
          }
          await ctx.reply(ctx.args.join(" "));
        },
      });
}
