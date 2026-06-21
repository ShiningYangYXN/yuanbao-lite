/**
 * /alias command handler — extracted from registry.ts (lossless split).
 * Category: alias
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "alias",
        aliases: ["别名"],
        description: "管理ID别名映射（为用户ID设置快捷名称）",
        usage: "/alias <add|remove|list|save|load|resolve> [参数]",
        category: "utility" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const store = ctx.bot.getAliasStore();

          switch (subCmd) {
            case "add": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /alias add <id> <alias> [昵称]");
                return;
              }
              const [, , id, alias, ...nickParts] = ctx.args;
              const nickname = nickParts.join(" ") || undefined;
              store.add(id, alias, nickname);
              await ctx.reply(`✅ 别名已添加: ${alias} -> ${id}${nickname ? ` (昵称: ${nickname})` : ""}`);
              break;
            }
            case "remove":
            case "rm":
            case "del": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /alias remove <别名|ID>");
                return;
              }
              const removed = store.remove(ctx.args[1]);
              await ctx.reply(removed ? `✅ 别名已删除` : `未找到别名: ${ctx.args[1]}`);
              break;
            }
            case "list":
            case "ls": {
              const all = store.getAll();
              if (all.length === 0) {
                await ctx.reply("暂无别名");
                return;
              }
              if (ctx.useTable) {
                const { formatTable } = await import("../../utils/table.js");
                const rows = all.map(e => [e.alias, e.id, e.nickname || ""]);
                await ctx.reply(`📋 别名列表 (${all.length} 个):\n${formatTable(["别名", "ID", "昵称"], rows)}`);
              } else {
                const lines = all.map(e => `  ${e.alias} -> ${e.id}${e.nickname ? ` (${e.nickname})` : ""}`);
                await ctx.reply(`📋 别名列表:\n${lines.join("\n")}`);
              }
              break;
            }
            case "save": {
              const ok = store.save();
              await ctx.reply(ok ? "✅ 别名已保存" : "❌ 保存失败");
              break;
            }
            case "load": {
              const ok = store.load();
              await ctx.reply(ok ? "✅ 别名已加载" : "❌ 加载失败");
              break;
            }
            case "resolve": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /alias resolve <别名|ID>");
                return;
              }
              const resolved = store.resolve(ctx.args[1]);
              const nick = store.getNickname(ctx.args[1]);
              await ctx.reply(`解析结果: ${resolved}${nick ? ` (昵称: ${nick})` : ""}`);
              break;
            }
            default:
              await ctx.reply("用法: /alias <add|remove|list|save|load|resolve> [参数]");
          }
        },
      });
}
