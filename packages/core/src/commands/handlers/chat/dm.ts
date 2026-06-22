/**
 * /dm command handler — extracted from registry.ts (lossless split).
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
    name: "dm",
    aliases: ["私聊"],
    description: "发送私聊消息（支持别名解析）",
    usage: "/dm <用户ID或别名> <消息>",
    category: "chat" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length < 2) {
        await ctx.reply("用法: /dm <用户ID> <消息>");
        return;
      }
      // Resolve @-references in the first arg (user ID)
      const rawUserId = await ctx.resolveAtReference(ctx.args[0]);
      const userId = ctx.bot.getContactStore().resolve(rawUserId);
      const text = ctx.args.slice(1).join(" ");
      ctx.bot.getContactStore().touch(rawUserId);
      try {
        await ctx.bot.sendDirectMessage(userId, text);
        await ctx.reply(`✅ 已发送私聊消息给 ${rawUserId === userId ? userId : `${rawUserId} (${userId})`}`);
      } catch (err) {
        await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
      }
    },
  });
}
