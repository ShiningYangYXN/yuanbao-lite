/**
 * /atall command handler — extracted from registry.ts (lossless split).
 * Category: group
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "atall",
    aliases: ["所有人", "at-all", "@all"],
    description: "@所有人并发送消息（群聊专用）",
    usage: "/atall <群号> <消息>   或   /atall <消息>   (当前群聊)",
    category: "group" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      let groupCode: string;
      let message: string;

      if (ctx.args.length < 1) {
        await ctx.reply("用法: /atall <群号> <消息>\n或: /atall <消息>  (当前群聊中)");
        return;
      }

      // If only one arg, treat as message and use current group (if in group context)
      if (ctx.args.length === 1) {
        if (!ctx.isGroup || !ctx.groupCode) {
          await ctx.reply("私聊中需要指定群号: /atall <群号> <消息>");
          return;
        }
        groupCode = ctx.groupCode;
        message = ctx.args[0];
      } else {
        // Check if first arg is a group code (all digits)
        const firstArg = ctx.args[0];
        if (/^\d{5,}$/.test(firstArg)) {
          groupCode = firstArg;
          message = ctx.args.slice(1).join(" ");
        } else {
          // First arg is not a group code — treat all as message, use current group
          if (!ctx.isGroup || !ctx.groupCode) {
            await ctx.reply("私聊中需要指定群号: /atall <群号> <消息>");
            return;
          }
          groupCode = ctx.groupCode;
          message = ctx.args.join(" ");
        }
      }

      if (!message.trim()) {
        await ctx.reply("消息内容不能为空");
        return;
      }

      // Use the @[所有人]() syntax which the mention parser will expand
      // into individual @[](userId) TIMCustomElem for every group member.
      const fullMessage = `@[所有人]() ${message}`;

      try {
        await ctx.bot.sendText({
          to: groupCode,
          text: fullMessage,
          isGroup: true,
        });
        // Count members for the confirmation (best-effort, ignore errors)
        let memberCount = -1;
        try {
          const resp = await ctx.bot.getGroupMemberList(groupCode);
          memberCount = resp?.member_list?.length ?? 0;
        } catch {
          // member list fetch failed — just report send success
        }
        const countHint = memberCount >= 0
          ? `（已逐个展开 @${memberCount} 个成员）`
          : "";
        await ctx.reply(`✅ 已发送 @所有人 消息到群 ${groupCode}${countHint}`);
      } catch (err) {
        await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
      }
    },
  });
}
