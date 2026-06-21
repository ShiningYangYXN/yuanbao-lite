/**
 * /hsearch command handler — extracted from registry.ts (lossless split).
 * Category: history
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "hsearch",
        aliases: ["搜索历史", "histsearch"],
        description: "搜索消息历史（默认15条结果+截断文本，--all显示全部+完整文本）",
        usage: "/hsearch [--all] <关键词>   (--all/-a 显示全部结果及完整文本)",
        category: "history" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /hsearch <关键词>");
            return;
          }
          const keyword = ctx.args.join(" ");
          const store = ctx.bot.getHistoryStore();
          const results = store.search({ keyword }, 1, ctx.showAll ? 1000 : 20);
          if (results.total === 0) {
            await ctx.reply(`未找到包含 "${keyword}" 的历史消息`);
            return;
          }
          const maxResults = ctx.showAll ? results.messages.length : 15;
          const display = results.messages.slice(0, maxResults);
          if (ctx.useTable) {
                        const rows = display.map(msg => [
              msg.id || "?",
              new Date(msg.timestamp).toLocaleString("zh-CN"),
              msg.fromNickname || msg.fromUserId,
              (msg.text || "(非文本)").substring(0, 50),
            ]);
            await ctx.reply(`🔍 历史搜索结果 (${results.total} 条)\n${await ctx.formatTable(["消息ID", "时间", "发送者", "内容"], rows)}`);
          } else {
            const lines = display.map(msg => {
              const time = new Date(msg.timestamp).toLocaleString("zh-CN");
              const sender = msg.fromNickname || msg.fromUserId;
              const shortId = msg.id ? (msg.id.length > 8 ? msg.id.slice(-8) : msg.id) : "?";
              const text = ctx.showAll ? msg.text : msg.text.substring(0, 50);
              return `  [${time}] ${sender}(${msg.fromUserId}) #${shortId}: ${text}`;
            });
            const suffix = !ctx.showAll && results.messages.length > 15 ? `\n  ... 及其他 ${results.messages.length - 15} 条 (用 /hsearch --all 查看全部)` : "";
            await ctx.reply(`🔍 历史搜索结果:\n${lines.join("\n")}${suffix}\n共 ${results.total} 条结果`);
          }
        },
      });
}
