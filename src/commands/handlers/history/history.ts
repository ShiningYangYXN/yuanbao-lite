/**
 * /history command handler — extracted from registry.ts (lossless split).
 * Category: history
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { generateColoredHelp } from "../../help-text.js";
import {
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../../../business/sticker.js";
import {
  uploadToLitterbox,
  uploadAndFormatLink as tempfileFormatLink,
} from "../../../access/http/tempfile.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "history",
        aliases: ["hist", "历史"],
        description: "查看和搜索消息历史（search子命令默认20条，--all显示全部）",
        usage: "/history [search|stats|recent|user|group] [--all] [参数]   (search+--all/-a 显示全部)",
        category: "history" as CommandCategory,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const store = ctx.bot.getHistoryStore();

          // Lazily import formatHistoryList
          const { formatHistoryList } = await import("../../../business/history.js");
          const botId = ctx.bot.getAccount().botId;

          switch (subCmd) {
            case "search":
            case "find":
            case "搜索": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /history search <关键词> [数量]");
                return;
              }
              const keyword = ctx.args[1];
              const limit = parseInt(ctx.args[2] || "20", 10);
              const results = store.searchByKeyword(keyword, { searchNickname: true, limit });
              if (results.length === 0) {
                await ctx.reply(`未找到包含 "${keyword}" 的消息`);
                return;
              }
              const output = formatHistoryList(ctx.showAll ? results : results.slice(-20), { botId, colorize: false, title: `搜索结果 (${results.length}条)` });
              await ctx.reply(output);
              break;
            }
            case "stats":
            case "统计": {
              const stats = store.getStats();
              await ctx.reply(
                `📊 消息统计:\n` +
                `  总消息: ${stats.totalMessages}\n` +
                `  私聊: ${stats.directMessages}, 群聊: ${stats.groupMessages}\n` +
                `  独立用户: ${stats.uniqueUsers}, 独立群组: ${stats.uniqueGroups}\n` +
                `  时间范围: ${stats.oldestAt ? new Date(stats.oldestAt).toLocaleString("zh-CN") : "无"} ~ ${stats.newestAt ? new Date(stats.newestAt).toLocaleString("zh-CN") : "无"}`,
              );
              break;
            }
            case "recent":
            case "最近": {
              const count = parseInt(ctx.args[1] || "10", 10);
              const recent = store.getRecent(count);
              if (recent.length === 0) {
                await ctx.reply("暂无历史消息");
                return;
              }
              const output = formatHistoryList(recent, { botId, colorize: false, title: `最近消息` });
              await ctx.reply(output);
              break;
            }
            case "user": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /history user <用户ID> [数量]");
                return;
              }
              const userId = ctx.args[1];
              const limit = parseInt(ctx.args[2] || "20", 10);
              const msgs = store.getByUser(userId, limit);
              if (msgs.length === 0) {
                await ctx.reply(`未找到用户 ${userId} 的消息`);
                return;
              }
              const output = formatHistoryList(msgs, { botId, colorize: false, title: `用户 ${userId} 的消息` });
              await ctx.reply(output);
              break;
            }
            case "group": {
              if (ctx.args.length < 2) {
                await ctx.reply("用法: /history group <群号> [数量]");
                return;
              }
              const groupCode = ctx.args[1];
              const limit = parseInt(ctx.args[2] || "20", 10);
              const msgs = store.getByGroup(groupCode, limit);
              if (msgs.length === 0) {
                await ctx.reply(`未找到群 ${groupCode} 的消息`);
                return;
              }
              const output = formatHistoryList(msgs, { botId, colorize: false, title: `群 ${groupCode} 的消息` });
              await ctx.reply(output);
              break;
            }
            default:
              await ctx.reply("用法: /history <search|stats|recent|user|group> [参数]");
          }
        },
      });
}
