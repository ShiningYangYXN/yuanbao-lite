/**
 * /join command handler — extracted from registry.ts (lossless split).
 * Category: group
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import { sessionKeyFromMessage } from "../../session-utils.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "join",
        aliases: ["加入"],
        description: "加入群聊会话并切换上下文（阻塞式，模仿 /switch）",
        usage: "/join <群号>",
        category: "group" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /join <群号>");
            return;
          }
          const groupCode = ctx.args[0];
          const store = ctx.bot.getGroupStore();
          if (!store.get(groupCode)) {
            store.add(groupCode);
          }

          // Resolve group name
          let groupName: string | undefined;
          let label = `群聊 ${groupCode}`;
          try {
            const info = await ctx.bot.queryGroupInfo(groupCode);
            if (info.code === 0 && info.group_info?.group_name) {
              groupName = info.group_info.group_name;
              label = `群聊 ${groupName} (${groupCode})`;
              store.setGroupName(groupCode, groupName);
            }
            store.trackActivity(groupCode, groupName);
          } catch {
            store.trackActivity(groupCode);
          }

          // Push onto /switch stack (blocking context switch, same as /switch group)
          const cs = cmdSys as unknown as {
            _switchSessions?: Map<string, Array<{ chatType: "group" | "direct"; target: string; label: string; groupName?: string; lastActivity: number }>>;
          };
          if (!cs._switchSessions) cs._switchSessions = new Map();
          const sessionKey = sessionKeyFromMessage(ctx.message);
          const stack = cs._switchSessions.get(sessionKey) ?? [];
          stack.push({ chatType: "group", target: groupCode, label, groupName, lastActivity: Date.now() });
          cs._switchSessions.set(sessionKey, stack);

          await ctx.reply(
            `✅ 已加入 ${label}\n` +
            `层级: ${stack.length}\n` +
            `后续消息将在该群上下文中处理\n` +
            `退出: /switch exit`,
          );
        },
      });
}
