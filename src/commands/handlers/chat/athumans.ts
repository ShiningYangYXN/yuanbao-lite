/**
 * /athumans command handler — @all human members (exclude bots).
 * Category: chat
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "athumans",
    aliases: ["所有人类", "at-humans"],
    description: "@所有人类成员（排除机器人）并发送消息",
    usage: "/athumans <群号> <消息>   或   /athumans <消息>   (当前群聊)",
    category: "chat" as CommandCategory,
    requireConnected: true,
    dmOnly: true,
    handler: async (ctx) => {
      await sendScopedAtAll(ctx, "humans");
    },
  });
}

export async function sendScopedAtAll(ctx: import("../../types.js").CommandContext, scope: "humans" | "bots" | "lobsters"): Promise<void> {
  let groupCode: string;
  let message: string;

  if (ctx.args.length < 1) {
    const scopeLabel = scope === "humans" ? "人类" : scope === "bots" ? "BOT" : "龙虾";
    await ctx.reply(`用法: /at${scope} <群号> <消息>\n或: /at${scope} <消息>  (当前群聊中)`);
    return;
  }

  if (ctx.args.length === 1) {
    if (!ctx.isGroup || !ctx.groupCode) {
      const scopeLabel = scope === "humans" ? "人类" : scope === "bots" ? "BOT" : "龙虾";
      await ctx.reply(`私聊中需要指定群号: /at${scope} <群号> <消息>`);
      return;
    }
    groupCode = ctx.groupCode;
    message = ctx.args[0];
  } else {
    const firstArg = ctx.args[0];
    if (/^\d{5,}$/.test(firstArg)) {
      groupCode = firstArg;
      message = ctx.args.slice(1).join(" ");
    } else {
      if (!ctx.isGroup || !ctx.groupCode) {
        await ctx.reply(`私聊中需要指定群号`);
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

  const scopeSyntax = scope === "humans" ? "@[所有人类](humans)"
    : scope === "bots" ? "@[所有BOT](bots)"
    : "@[所有龙虾](lobsters)";
  const fullMessage = `${scopeSyntax} ${message}`;

  try {
    await ctx.bot.sendText({
      to: groupCode,
      text: fullMessage,
      isGroup: true,
    });
    // Count matching members
    let matchCount = -1;
    try {
      const resp = await ctx.bot.getGroupMemberList(groupCode);
      const members = resp?.member_list ?? [];
      matchCount = members.filter(m => {
        const uid = String(m.user_id ?? "");
        if (scope === "humans") return !uid.startsWith("bot_");
        if (scope === "bots") return uid.startsWith("bot_");
        if (scope === "lobsters") return uid.startsWith("bot_");
        return true;
      }).length;
    } catch { /* ignore */ }

    const scopeLabel = scope === "humans" ? "人类" : scope === "bots" ? "BOT" : "龙虾";
    const countHint = matchCount >= 0 ? `（已逐个展开 @${matchCount} 个${scopeLabel}成员）` : "";
    await ctx.reply(`✅ 已发送 @所有${scopeLabel} 消息到群 ${groupCode}${countHint}`);
  } catch (err) {
    await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
  }
}
