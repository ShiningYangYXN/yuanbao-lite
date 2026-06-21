/**
 * /atlobsters command handler — @all lobster members (exclude yuanbao bots).
 * Category: group
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "atlobsters",
    aliases: ["所有龙虾", "at-lobsters"],
    description: "@所有龙虾成员并发送消息",
    usage: "/atlobsters <群号> <消息>   或   /atlobsters <消息>   (当前群聊)",
    category: "group" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      const { sendScopedAtAll } = await import("./athumans.js");
      await sendScopedAtAll(ctx, "lobsters");
    },
  });
}
