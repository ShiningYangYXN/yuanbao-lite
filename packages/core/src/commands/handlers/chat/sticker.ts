/**
 * /sticker command handler — extracted from registry.ts (lossless split).
 * Category: sticker
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "sticker",
    aliases: ["贴纸"],
    description: "发送贴纸（使用 emoji_编号 格式，可指定目标）",
    usage: "/sticker <贴纸ID> [目标ID]   (目标默认为当前会话)",
    category: "chat" as CommandCategory,
    elevated: true,
    requireConnected: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply("用法: /sticker <贴纸ID> [目标ID]");
        return;
      }
      const stickerId = ctx.args[0];
      // Use resolveTarget if target arg provided, otherwise default to current chat
      let to: string;
      let isGroup: boolean;
      if (ctx.args[1]) {
        const resolved = await ctx.resolveTarget(ctx.args[1]);
        to = resolved.targetId;
        isGroup = resolved.isGroup;
      } else {
        to =
          ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
        isGroup = ctx.isGroup;
      }
      try {
        await ctx.bot.sendSticker({ to, stickerId, isGroup });
        await ctx.reply(`✅ 贴纸已发送: ${stickerId}`);
      } catch (err) {
        await ctx.reply(`❌ 贴纸发送失败: ${(err as Error).message}`);
      }
    },
  });
}
