/**
 * /search command handler — extracted from registry.ts (lossless split).
 * Category: group
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "search",
        aliases: ["搜索", "查找"],
        description: "搜索群组和群成员（模糊匹配）",
        usage: "/search <groups|members> <关键词> [群号]",
        category: "group" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();

          // Lazily create search engine
          const { SearchEngine } = await import("../../../business/search.js");
          const engine = new SearchEngine(ctx.bot);

          switch (subCmd) {
            case "groups":
            case "群":
            case "群组": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /search groups <关键词> [群号1,群号2,...]");
                return;
              }
              const query = ctx.args[1];
              const groupCodes = ctx.args[2]?.split(",");
              const results = await engine.searchGroups(query, groupCodes);
              if (results.length === 0) {
                await ctx.reply(`未找到匹配 "${query}" 的群组`);
                return;
              }
              if (ctx.useTable) {
                                const rows = results.map(r => [r.groupCode, r.groupName || "(未知)", `${r.groupSize}人`, r.matchType]);
                await ctx.reply(`🔍 群组搜索结果 (${results.length} 个)\n${await ctx.formatTable(["群号", "群名", "人数", "匹配类型"], rows)}`);
              } else {
                const lines = results.map(r =>
                  `  ${r.groupCode} — ${r.groupName || "(未知)"} (${r.groupSize}人) [${r.matchType}]`,
                );
                await ctx.reply(`🔍 群组搜索结果:\n${lines.join("\n")}`);
              }
              break;
            }
            case "members":
            case "member":
            case "成员": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /search members <关键词> [群号]");
                return;
              }
              const query = ctx.args[1];
              const groupCode = ctx.args[2] || ctx.groupCode;
              if (!groupCode) {
                await ctx.reply("请指定群号: /search members <关键词> <群号>");
                return;
              }
              const results = await engine.searchGroupMembers(groupCode, query);
              if (results.length === 0) {
                await ctx.reply(`未在群 ${groupCode} 中找到匹配 "${query}" 的成员`);
                return;
              }
              if (ctx.useTable) {
                                const rows = results.map(r => [
                  r.userId,
                  r.nickName,
                  r.userType === 1 ? "人类" : r.userType === 2 ? "元宝" : r.userType === 3 ? "龙虾" : "?",
                  r.matchType,
                ]);
                await ctx.reply(`🔍 成员搜索结果 (${groupCode}, ${results.length} 个)\n${await ctx.formatTable(["用户ID", "昵称", "类型", "匹配类型"], rows)}`);
              } else {
                const lines = results.map(r => {
                  const typeLabel = r.userType === 1 ? "[人类]" : r.userType === 2 ? "[元宝]" : r.userType === 3 ? "[龙虾]" : "";
                  return `  ${r.userId} — ${r.nickName} ${typeLabel} [${r.matchType}]`;
                });
                await ctx.reply(`🔍 成员搜索结果 (${groupCode}):\n${lines.join("\n")}`);
              }
              break;
            }
            default:
              await ctx.reply("用法: /search <groups|members> <关键词> [群号]");
          }
        },
      });
}
