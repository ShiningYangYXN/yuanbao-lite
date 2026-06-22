/**
 * /status command handler — extracted from registry.ts (lossless split).
 * Category: info
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "status",
    aliases: ["state", "状态"],
    description: "查看机器人连接状态和账号信息",
    usage: "/status   (显示连接状态、Bot ID、名称等)",
    category: "info" as CommandCategory,
    requireConnected: false,
    handler: async (ctx) => {
      const state = ctx.bot.getState();
      const account = ctx.bot.getAccount();
      const kv: [string, string][] = [
        ["连接", state.connected ? "✅ 已连接" : "❌ 未连接"],
        ["状态", state.status],
      ];
      if (state.connectId) kv.push(["连接ID", state.connectId]);
      if (state.botId) kv.push(["Bot ID", state.botId]);
      if (state.lastConnectedAt)
        kv.push([
          "上次连接",
          new Date(state.lastConnectedAt).toLocaleString("zh-CN"),
        ]);
      if (state.lastError) kv.push(["最近错误", state.lastError]);
      if (account.name) kv.push(["名称", account.name]);

      if (ctx.useTable) {
        await ctx.reply(
          `📊 机器人状态\n${await ctx.formatTable(["属性", "值"], kv)}`,
        );
      } else {
        const lines = ["📊 机器人状态", ...kv.map(([k, v]) => `  ${k}: ${v}`)];
        await ctx.reply(lines.join("\n"));
      }
    },
  });
}
