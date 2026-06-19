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
        description: "引用回复指定消息（支持消息ID或尾号，省略则用被引用的消息）",
        usage: "/reply [消息ID或#尾号] <回复内容>   (省略ID时需引用一条消息)",
        category: "chat" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          let msgId: string | undefined;
          let replyText: string;

          if (ctx.args.length === 0) {
            await ctx.reply("用法: /reply [消息ID或尾号] <回复内容>\n省略ID时需引用一条消息（回复该消息后执行 /reply <内容>）");
            return;
          }

          // Check if first arg looks like a message ID or if we should use the quoted message
          const firstArg = ctx.args[0];
          const hasQuote = Boolean(ctx.message.quoteMsgId);

          // If the first arg starts with # or is a long ID-like string, treat it as message ID
          // Otherwise, if there's a quoted message, use it and treat all args as reply text
          const looksLikeId = firstArg.startsWith("#") || /^\d{3,}[-\d]*$/.test(firstArg) || firstArg.length > 10;

          if (looksLikeId) {
            // First arg is the message ID
            msgId = firstArg;
            replyText = ctx.args.slice(1).join(" ");
            if (!replyText) {
              await ctx.reply("用法: /reply <消息ID或尾号> <回复内容>");
              return;
            }
          } else if (hasQuote) {
            // No explicit ID, but there's a quoted message — use it
            msgId = ctx.message.quoteMsgId;
            replyText = ctx.args.join(" ");
          } else {
            // No ID and no quote — treat all args as reply text but require an ID or quote
            await ctx.reply("用法: /reply [消息ID或尾号] <回复内容>\n省略ID时需引用一条消息（回复该消息后执行 /reply <内容>）");
            return;
          }

          const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
          const isGroup = ctx.isGroup;

          // Strip leading # if present (user may copy the #xxxxxxxx format)
          if (msgId!.startsWith("#")) {
            msgId = msgId!.slice(1);
          }

          // Try to find the message by ID or short ID suffix
          const store = ctx.bot.getHistoryStore();

          // 1. Try exact match first
          const exactMatch = store.getById(msgId!);
          if (exactMatch) {
            msgId = exactMatch.id!;
          } else {
            // 2. Short ID suffix match: search recent messages whose ID ends with this suffix
            const recentMsgs = store.getRecent(500);
            const candidates = recentMsgs.filter(m => m.id && String(m.id).endsWith(msgId!));
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
                return idStr.endsWith(msgId!) || idStr === msgId!;
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
            await ctx.reply(`✅ 已引用回复消息 #${msgId!.length > 8 ? msgId!.slice(-8) : msgId}`);
          } catch (err) {
            await ctx.reply(`❌ 引用回复失败: ${(err as Error).message}`);
          }
        },
      });
}
