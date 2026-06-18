/**
 * /reply command handler — extracted from registry.ts (lossless split).
 * Category: chat
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "reply",
        aliases: ["引用回复"],
        description: "引用回复指定消息（支持消息ID或尾号）",
        usage: "/reply <消息ID或#尾号> <回复内容>",
        category: "chat" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          if (ctx.args.length < 2) {
            await ctx.reply("用法: /reply <消息ID或尾号> <回复内容>\n提示: 历史消息中的 #xxxxxxxx 即为消息ID尾号");
            return;
          }
          let msgId = ctx.args[0];
          const replyText = ctx.args.slice(1).join(" ");
          const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
          const isGroup = ctx.isGroup;

          // Strip leading # if present (user may copy the #xxxxxxxx format)
          if (msgId.startsWith("#")) {
            msgId = msgId.slice(1);
          }

          // Try to find the message by ID or short ID suffix
          const store = ctx.bot.getHistoryStore();

          // 1. Try exact match first
          const exactMatch = store.getById(msgId);
          if (exactMatch) {
            msgId = exactMatch.id!;
          } else {
            // 2. Short ID suffix match: search recent messages whose ID ends with this suffix
            //    This works for both short IDs (<=8 chars) and partial IDs
            const recentMsgs = store.getRecent(500);
            const candidates = recentMsgs.filter(m => m.id && String(m.id).endsWith(msgId));
            if (candidates.length === 1) {
              msgId = candidates[0].id!;
            } else if (candidates.length > 1) {
              // Multiple matches — show ambiguous results
              const lines = candidates.slice(0, 5).map(m => {
                const shortId = m.id!.length > 8 ? m.id!.slice(-8) : m.id!;
                const sender = m.fromNickname || m.fromUserId;
                const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
                return `  #${shortId} [${time}] ${sender}: ${(m.text || "").substring(0, 40)}`;
              });
              await ctx.reply(`⚠️ 消息尾号 ${msgId} 匹配到多条消息，请使用更长的ID:\n${lines.join("\n")}`);
              return;
            } else {
              // No match by endsWith — try String() conversion for numeric IDs
              const candidatesAlt = recentMsgs.filter(m => {
                if (!m.id) return false;
                const idStr = String(m.id);
                return idStr.endsWith(msgId) || idStr === msgId;
              });
              if (candidatesAlt.length === 1) {
                msgId = candidatesAlt[0].id!;
              } else if (candidatesAlt.length > 1) {
                const lines = candidatesAlt.slice(0, 5).map(m => {
                  const shortId = m.id!.length > 8 ? m.id!.slice(-8) : m.id!;
                  const sender = m.fromNickname || m.fromUserId;
                  const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
                  return `  #${shortId} [${time}] ${sender}: ${(m.text || "").substring(0, 40)}`;
                });
                await ctx.reply(`⚠️ 消息尾号 ${msgId} 匹配到多条消息，请使用更长的ID:\n${lines.join("\n")}`);
                return;
              } else {
                // No match found
                await ctx.reply(`❌ 未找到消息尾号为 ${msgId} 的消息，请检查ID是否正确`);
                return;
              }
            }
          }

          try {
            await ctx.bot.sendText({ to, text: replyText, isGroup, quoteMsgId: msgId });
            await ctx.reply(`✅ 已引用回复消息 #${msgId.length > 8 ? msgId.slice(-8) : msgId}`);
          } catch (err) {
            await ctx.reply(`❌ 引用回复失败: ${(err as Error).message}`);
          }
        },
      });
}
