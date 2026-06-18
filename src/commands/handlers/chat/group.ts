/**
 * /group command handler — extracted from registry.ts (lossless split).
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
        name: "group",
        aliases: ["群发"],
        description: "发送群聊消息",
        usage: "/group <群号> <消息>",
        category: "chat" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length < 2) {
            await ctx.reply("用法: /group <群号> <消息>");
            return;
          }
          const groupCode = ctx.args[0];
          const text = ctx.args.slice(1).join(" ");
          try {
            await ctx.bot.sendGroupMessage(groupCode, text);
            await ctx.reply(`✅ 已发送群聊消息到 ${groupCode}`);
          } catch (err) {
            await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
          }
        },
      });
}
