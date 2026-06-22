/**
 * /chat command handler — extracted from registry.ts (lossless split).
 * Category: chat
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
const USAGE = "/chat <目标> <消息>";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "chat",
    aliases: ["聊天"],
    description: "向指定目标发送消息（私聊或群聊）",
    usage: USAGE,
    category: "chat" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply(`用法: ${USAGE}`);
        return;
      }
      if (/^\d{9}$/.test(ctx.args[0].trim()) && ctx.args.length >= 2) {
        const groupCode = ctx.args[1];
        const text = ctx.args.slice(2).join(" ");
        try {
          await ctx.bot.sendGroupMessage(groupCode, text);
          await ctx.reply(`✅ 已发送群聊消息到 ${groupCode}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      } else if (ctx.args.length >= 2) {
        // Resolve @-references in the first arg (user ID)
        const userId = await ctx.resolveAtReference(ctx.args[0]);
        const text = ctx.args.slice(1).join(" ");
        try {
          await ctx.bot.sendDirectMessage(userId, text);
          await ctx.reply(`✅ 已发送私聊消息给 ${userId}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
      } else {
        await ctx.reply(`用法: ${USAGE}`);
      }
    },
  });
}
