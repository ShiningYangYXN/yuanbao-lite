/**
 * /atbots command handler — @all bot members (yuanbao + lobsters).
 * Category: group
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "atbots",
    aliases: ["所有BOT", "所有Bot", "at-bots"],
    description: "@所有机器人成员并发送消息",
    usage: "/atbots <群号> <消息>   或   /atbots <消息>   (当前群聊)",
    category: "group" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      const { sendScopedAtAll } = await import("./athumans.js");
      await sendScopedAtAll(ctx, "bots");
    },
  });
}
