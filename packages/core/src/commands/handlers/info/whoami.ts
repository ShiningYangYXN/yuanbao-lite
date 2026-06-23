/**
 * /whoami command handler — extracted from registry.ts (lossless split).
 * Category: misc
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "whoami",
    aliases: ["我是谁", "我的信息"],
    description: "查看当前发送者的信息（用户ID、昵称、聊天类型等）",
    usage: "/whoami",
    category: "info" as CommandCategory,
    handler: async (ctx) => {
      const msg = ctx.message;
      let trusted = false;
      try {
        const { isTrusted } = await import("../../../business/trust.js");
        trusted = isTrusted(msg.fromUserId);
      } catch {
        /* ignore */
      }

      // Resolve group name: try msg.groupName first, then groupStore
      let groupName = msg.groupName;
      if (!groupName && msg.chatType === "group" && msg.groupCode) {
        const entry = ctx.bot.getGroupStore().get(msg.groupCode);
        groupName = entry?.groupName || entry?.name;
      }

      const kv: [string, string][] = [
        ["用户ID", msg.fromUserId],
        ["昵称", msg.fromNickname || "(未知)"],
        ["聊天类型", msg.chatType === "group" ? "群聊" : "私聊"],
      ];
      if (msg.chatType === "group") {
        kv.push(["群号", msg.groupCode || "(未知)"]);
        kv.push(["群名", groupName || "(未知)"]);
      }
      kv.push(["是否受信", trusted ? "✅ 是" : "❌ 否"]);

      if (ctx.useTable) {
        await ctx.reply(
          `👤 你的信息\n${await ctx.formatTable(["属性", "值"], kv)}`,
        );
      } else {
        const lines = [`👤 你的信息:`, ...kv.map(([k, v]) => `  ${k}: ${v}`)];
        await ctx.reply(lines.join("\n"));
      }
    },
  });
}
