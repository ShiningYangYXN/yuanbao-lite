/**
 * /commands command handler — extracted from registry.ts (lossless split).
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
        name: "commands",
        aliases: ["cmdlist", "命令列表"],
        description: "列出所有命令和别名（紧凑格式，无描述）",
        usage: "/commands   (列出所有命令名和别名)",
        category: "utility" as CommandCategory,
        handler: async (ctx) => {
          const visible = cmdSys.getAll().filter(c => !c.hidden);
          if (visible.length === 0) {
            await ctx.reply("暂无可用命令");
            return;
          }
          if (ctx.useTable) {
                        const rows = visible.map(cmd => [
              `${cmdSys.config.prefix}${cmd.name}`,
              cmd.aliases?.length ? cmd.aliases.join(", ") : "",
              cmd.description || "",
            ]);
            await ctx.reply(`📋 所有命令 (${visible.length} 个)\n${await ctx.formatTable(["命令", "别名", "描述"], rows)}`);
          } else {
            const lines: string[] = [`📋 所有命令 (${visible.length} 个):`];
            for (const cmd of visible) {
              const aliases = cmd.aliases?.length ? ` (${cmd.aliases.join(", ")})` : "";
              lines.push(`  ${cmdSys.config.prefix}${cmd.name}${aliases}`);
            }
            await ctx.reply(lines.join("\n"));
          }
        },
      });
}
