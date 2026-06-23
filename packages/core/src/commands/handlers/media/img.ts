/**
 * /img command handler — extracted from registry.ts (lossless split).
 * Category: media
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "img",
    aliases: ["图片", "发送图片"],
    description: "发送图片消息",
    usage: "/img <图片路径> [目标ID]   (目标默认为当前会话)",
    category: "media" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply("用法: /img <图片路径> [目标ID]");
        return;
      }
      const filePath = ctx.args[0];
      // Use resolveTarget if target arg provided, otherwise default to current chat
      let target: string;
      let isGroup: boolean;
      if (ctx.args[1]) {
        const resolved = await ctx.resolveTarget(ctx.args[1]);
        target = resolved.targetId;
        isGroup = resolved.isGroup;
      } else {
        target = ctx.isGroup
          ? (ctx.groupCode ?? ctx.message.fromUserId)
          : ctx.message.fromUserId;
        isGroup = ctx.isGroup;
      }
      try {
        await ctx.bot.sendImage({
          to: target,
          filePath,
          isGroup,
        });
        await ctx.reply(`✅ 图片已发送到 ${target}`);
      } catch (err) {
        await ctx.reply(`❌ 图片发送失败: ${(err as Error).message}`);
      }
    },
  });
}
