/**
 * /groups command handler — extracted from registry.ts (lossless split).
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
        name: "groups",
        aliases: ["glist"],
        description: "群聊管理（列表默认20条，--all显示全部）",
        usage: "/groups [--all] <list|add|rm|rename|note|tag|fav|join|search> [参数]   (--all/-a 显示全部)",
        category: "group" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const store = ctx.bot.getGroupStore();

          switch (subCmd) {
            case "add": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /groups add <群号> [名称] [标签]");
                return;
              }
              const groupCode = ctx.args[1];
              const name = ctx.args[2];
              const tag = ctx.args.slice(3).join(" ") || undefined;
              store.add(groupCode, name, tag);

              // Try to fetch group name from server if not provided
              if (!name) {
                try {
                  const info = await ctx.bot.queryGroupInfo(groupCode);
                  if (info.code === 0 && info.group_info?.group_name) {
                    store.setGroupName(groupCode, info.group_info.group_name);
                  }
                } catch {
                  // Ignore query errors
                }
              }

              const updatedEntry = store.get(groupCode);
              const displayName = updatedEntry?.name || updatedEntry?.groupName || groupCode;
              await ctx.reply(`✅ 群聊已收藏: ${displayName}${tag ? ` [${tag}]` : ""}`);
              break;
            }
            case "remove":
            case "rm":
            case "del": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /groups rm <群号>");
                return;
              }
              const removed = store.remove(ctx.args[1]);
              await ctx.reply(removed ? `✅ 群聊已从收藏移除: ${ctx.args[1]}` : `未找到群聊: ${ctx.args[1]}`);
              break;
            }
            case "rename": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /groups rename <群号> <新名称>");
                return;
              }
              const ok = store.rename(ctx.args[1], ctx.args.slice(2).join(" "));
              await ctx.reply(ok ? `✅ 群聊已重命名为: ${ctx.args.slice(2).join(" ")}` : `未找到群聊: ${ctx.args[1]}`);
              break;
            }
            case "note":
            case "备注": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /groups note <群号> <备注内容>");
                return;
              }
              if (!store.get(ctx.args[1])) {
                store.add(ctx.args[1]);
              }
              const ok = store.setNotes(ctx.args[1], ctx.args.slice(2).join(" "));
              await ctx.reply(ok ? "✅ 群聊备注已更新" : `❌ 设置备注失败: ${ctx.args[1]}`);
              break;
            }
            case "tag": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /groups tag <群号> <标签>");
                return;
              }
              if (!store.get(ctx.args[1])) {
                store.add(ctx.args[1]);
              }
              const ok = store.setTag(ctx.args[1], ctx.args.slice(2).join(" "));
              await ctx.reply(ok ? "✅ 群聊标签已更新" : `❌ 设置标签失败: ${ctx.args[1]}`);
              break;
            }
            case "fav":
            case "favorite":
            case "收藏": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /groups fav <群号>");
                return;
              }
              if (!store.get(ctx.args[1])) {
                store.add(ctx.args[1]);
              }
              const ok = store.toggleFavorite(ctx.args[1]);
              const entry = store.get(ctx.args[1]);
              await ctx.reply(ok ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}: ${ctx.args[1]}` : `未找到群聊: ${ctx.args[1]}`);
              break;
            }
            case "search":
            case "find": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /groups search <关键词>");
                return;
              }
              const results = store.search(ctx.args.slice(1).join(" "));
              if (results.length === 0) {
                await ctx.reply("未找到匹配的群聊");
              } else {
                const lines = results.map(g => {
                  const fav = g.favorite ? "⭐" : " ";
                  const displayName = g.name || g.groupName || "未知";
                  return `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}`;
                });
                await ctx.reply(`📋 群聊搜索结果:\n${lines.join("\n")}`);
              }
              break;
            }
            case "save": {
              const ok = store.save();
              await ctx.reply(ok ? "✅ 群聊已保存" : "❌ 保存失败");
              break;
            }
            case "list":
            case "ls":
            default: {
              const all = store.getAll("lastActive");
              if (all.length === 0) {
                await ctx.reply("暂无收藏群聊。使用 /groups add <群号> 添加");
                return;
              }
              // Try to resolve group names for entries that don't have one
              for (const g of all) {
                if (!g.name && !g.groupName) {
                  try {
                    const info = await ctx.bot.queryGroupInfo(g.groupCode);
                    if (info.code === 0 && info.group_info?.group_name) {
                      store.setGroupName(g.groupCode, info.group_info.group_name);
                      g.groupName = info.group_info.group_name;
                    }
                  } catch {
                    // Ignore query errors
                  }
                }
              }
              const lines = all.map(g => {
                const fav = g.favorite ? "⭐" : " ";
                const displayName = g.name || g.groupName || "未知";
                return `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}`;
              });
              await ctx.reply(`📋 收藏群聊列表:\n${lines.join("\n")}\n共 ${all.length} 个群聊`);
              break;
            }
          }
        },
      });
}
