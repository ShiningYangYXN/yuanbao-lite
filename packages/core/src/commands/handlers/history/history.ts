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

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "history",
    aliases: ["hist", "历史"],
    description:
      "查看消息历史（stats/recent/user/group，搜索请用 /search history）",
    usage:
      "/history [stats|recent|user|group] [--all] [参数]   (搜索请用 /search history)",
    category: "history" as CommandCategory,
    handler: async (ctx) => {
      const subCmd = ctx.args[0]?.toLowerCase();
      const store = ctx.bot.getHistoryStore();

      // Lazily import formatHistoryList
      const { formatHistoryList } =
        await import("../../../business/history.js");
      const botId = ctx.bot.getAccount().botId;

      switch (subCmd) {
        case "search":
        case "find":
        case "搜索": {
          await ctx.reply(
            "💡 历史搜索已合并到 /search\n请使用: /search history <关键词>",
          );
          return;
        }
        case "stats":
        case "统计": {
          const stats = store.getStats();
          const kv: [string, string][] = [
            ["总消息", String(stats.totalMessages)],
            ["私聊", String(stats.directMessages)],
            ["群聊", String(stats.groupMessages)],
            ["独立用户", String(stats.uniqueUsers)],
            ["独立群组", String(stats.uniqueGroups)],
            [
              "最早",
              stats.oldestAt
                ? new Date(stats.oldestAt).toLocaleString("zh-CN")
                : "无",
            ],
            [
              "最新",
              stats.newestAt
                ? new Date(stats.newestAt).toLocaleString("zh-CN")
                : "无",
            ],
          ];
          if (ctx.useTable) {
            await ctx.reply(
              `📊 消息统计\n${await ctx.formatTable(["属性", "值"], kv)}`,
            );
          } else {
            await ctx.reply(
              `📊 消息统计:\n${kv.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
            );
          }
          break;
        }
        case "recent":
        case "最近": {
          const count = parseInt(ctx.args[1] || "10", 10);
          const filter =
            ctx.isGroup && ctx.groupCode
              ? { groupCode: ctx.groupCode }
              : { fromUserId: ctx.message.fromUserId };
          const recent = store.getRecent(count, filter);
          if (recent.length === 0) {
            await ctx.reply("当前会话暂无历史消息");
            return;
          }
          const scopeLabel = ctx.isGroup ? `群${ctx.groupCode}` : "当前私聊";
          if (ctx.useTable) {
            const rows = recent.map((m) => [
              new Date(m.timestamp).toLocaleString("zh-CN"),
              m.fromNickname || m.fromUserId,
              (m.text || "(非文本)").substring(0, 50),
            ]);
            await ctx.reply(
              `${scopeLabel} 最近消息\n${await ctx.formatTable(["时间", "发送者", "内容"], rows)}`,
            );
          } else {
            const output = formatHistoryList(recent, {
              botId,
              colorize: false,
              title: `${scopeLabel} 最近消息`,
            });
            await ctx.reply(output);
          }
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
          if (ctx.useTable) {
            const rows = msgs.map((m) => [
              new Date(m.timestamp).toLocaleString("zh-CN"),
              m.chatType === "group" ? m.groupCode || "" : "DM",
              (m.text || "(非文本)").substring(0, 50),
            ]);
            await ctx.reply(
              `用户 ${userId} 的消息\n${await ctx.formatTable(["时间", "群号", "内容"], rows)}`,
            );
          } else {
            const output = formatHistoryList(msgs, {
              botId,
              colorize: false,
              title: `用户 ${userId} 的消息`,
            });
            await ctx.reply(output);
          }
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
          if (ctx.useTable) {
            const rows = msgs.map((m) => [
              new Date(m.timestamp).toLocaleString("zh-CN"),
              m.fromNickname || m.fromUserId,
              (m.text || "(非文本)").substring(0, 50),
            ]);
            await ctx.reply(
              `群 ${groupCode} 的消息\n${await ctx.formatTable(["时间", "发送者", "内容"], rows)}`,
            );
          } else {
            const output = formatHistoryList(msgs, {
              botId,
              colorize: false,
              title: `群 ${groupCode} 的消息`,
            });
            await ctx.reply(output);
          }
          break;
        }
        default:
          await ctx.reply(
            "用法: /history <search|stats|recent|user|group> [参数]",
          );
      }
    },
  });
}
