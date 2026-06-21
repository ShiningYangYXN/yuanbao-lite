/**
 * /contacts command handler — extracted from registry.ts (lossless split).
 * Category: contact
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "contacts",
        aliases: ["联系人"],
        description: "联系人管理（增删改查、备注、标签、收藏）",
        usage: "/contacts <list|add|rm|rename|note|tag|fav|dm|search> [参数]",
        category: "utility" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const store = ctx.bot.getContactStore();

          switch (subCmd) {
            case "add": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /contacts add <ID> <名称> [标签]");
                return;
              }
              const id = ctx.args[1];
              const name = ctx.args[2];
              const tag = ctx.args.slice(3).join(" ") || undefined;
              store.add(id, name, tag);
              await ctx.reply(`✅ 联系人已添加: ${name} -> ${id.substring(0, 20)}...${tag ? ` [${tag}]` : ""}`);
              break;
            }
            case "remove":
            case "rm":
            case "del": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /contacts remove <名称|ID>");
                return;
              }
              const removed = store.remove(ctx.args[1]);
              await ctx.reply(removed ? "✅ 联系人已删除" : `未找到联系人: ${ctx.args[1]}`);
              break;
            }
            case "rename": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /contacts rename <名称|ID> <新名称>");
                return;
              }
              const ok = store.rename(ctx.args[1], ctx.args[2]);
              await ctx.reply(ok ? `✅ 联系人已重命名为: ${ctx.args[2]}` : `未找到联系人: ${ctx.args[1]}`);
              break;
            }
            case "note":
            case "备注": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /contacts note <名称|ID> <备注内容>");
                return;
              }
              if (!store.get(ctx.args[1])) {
                store.add(ctx.args[1], ctx.args[1]);
              }
              const ok = store.setNotes(ctx.args[1], ctx.args.slice(2).join(" "));
              await ctx.reply(ok ? "✅ 联系人备注已更新" : `❌ 设置备注失败: ${ctx.args[1]}`);
              break;
            }
            case "tag": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /contacts tag <名称|ID> <标签>");
                return;
              }
              const ok = store.setTag(ctx.args[1], ctx.args.slice(2).join(" "));
              await ctx.reply(ok ? "✅ 标签已更新" : `未找到联系人: ${ctx.args[1]}`);
              break;
            }
            case "fav":
            case "favorite":
            case "收藏": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /contacts fav <名称|ID>");
                return;
              }
              if (!store.get(ctx.args[1])) {
                store.add(ctx.args[1], ctx.args[1]);
              }
              const ok = store.toggleFavorite(ctx.args[1]);
              const entry = store.get(ctx.args[1]);
              await ctx.reply(ok ? `✅ ${entry?.favorite ? "已收藏" : "已取消收藏"}` : `未找到联系人: ${ctx.args[1]}`);
              break;
            }
            case "dm": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /contacts dm <名称|ID>");
                return;
              }
              const resolved = store.resolve(ctx.args[1]);
              store.touch(ctx.args[1]);
              await ctx.reply(`私聊目标: ${resolved} (使用 /dm 发送消息)`);
              break;
            }
            case "search":
            case "find": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /contacts search <关键词>");
                return;
              }
              const results = store.search(ctx.args.slice(1).join(" "));
              if (results.length === 0) {
                await ctx.reply("未找到匹配的联系人");
              } else {
                const lines = results.map(c => {
                  const fav = c.favorite ? "⭐" : " ";
                  return `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}`;
                });
                await ctx.reply(`📇 搜索结果:\n${lines.join("\n")}`);
              }
              break;
            }
            case "save": {
              const ok = store.save();
              await ctx.reply(ok ? "✅ 联系人已保存" : "❌ 保存失败");
              break;
            }
            case "list":
            case "ls":
            default: {
              const all = store.getAll("name");
              if (all.length === 0) {
                await ctx.reply("暂无联系人。使用 /contacts add <ID> <名称> 添加");
                return;
              }
              if (ctx.useTable) {
                                const rows = all.map(c => [c.favorite ? "⭐" : "", c.name, c.id, c.tag || ""]);
                await ctx.reply(`📇 联系人列表 (${all.length} 个):\n${await ctx.formatTable(["收藏", "名称", "ID", "标签"], rows)}`);
              } else {
                const lines = all.map(c => {
                  const fav = c.favorite ? "⭐" : " ";
                  return `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}`;
                });
                await ctx.reply(`📇 联系人列表:\n${lines.join("\n")}\n共 ${all.length} 个联系人`);
              }
              break;
            }
          }
        },
      });
}
