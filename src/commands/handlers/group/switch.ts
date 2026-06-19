/**
 * /switch command handler — extracted from registry.ts (lossless split).
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
        name: "switch",
        aliases: ["切换", "sw"],
        description: "阻塞式临时切换上下文（允许嵌套，/switch exit 返回上层）",
        usage: "/switch [group <群号> | dm <用户ID> | exit]   (无参数=查看当前栈)",
        category: "group" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const sessionKey = sessionKeyFromMessage(ctx.message);
          // Ensure the switch session map exists on the CommandSystem
          const cs = cmdSys as unknown as {
            _switchSessions?: Map<string, Array<{ chatType: "group" | "direct"; target: string; label: string; groupName?: string; lastActivity: number }>>;
          };
          if (!cs._switchSessions) cs._switchSessions = new Map();
          const stack = cs._switchSessions.get(sessionKey) ?? [];

          const subArg = ctx.args[0]?.toLowerCase();

          // /switch exit — pop one level
          if (subArg === "exit" || subArg === "退出") {
            if (stack.length === 0) {
              await ctx.reply("⚠️ 当前不在任何切换上下文中");
              return;
            }
            const popped = stack.pop()!;
            if (stack.length === 0) {
              cs._switchSessions.delete(sessionKey);
            } else {
              cs._switchSessions.set(sessionKey, stack);
            }
            const current = stack.length > 0 ? stack[stack.length - 1] : null;
            await ctx.reply(
              `↩️ 已退出切换上下文: ${popped.label}\n` +
              (current ? `当前上下文: ${current.label}` : `已回到原始上下文`),
            );
            return;
          }

          // /switch group <群号> — push group context
          if (subArg === "group" && ctx.args[1]) {
            const groupCode = ctx.args[1];
            // Try to resolve group name
            let groupName: string | undefined;
            let label = `群聊 ${groupCode}`;
            try {
              const info = await ctx.bot.queryGroupInfo(groupCode);
              if (info.code === 0 && info.group_info?.group_name) {
                groupName = info.group_info.group_name;
                label = `群聊 ${groupName} (${groupCode})`;
                // Persist to group store so future lookups don't need queryGroupInfo
                ctx.bot.getGroupStore().setGroupName(groupCode, groupName);
                ctx.bot.getGroupStore().trackActivity(groupCode, groupName);
              }
            } catch {
              // ignore query errors — try group store as fallback
              const existing = ctx.bot.getGroupStore().get(groupCode);
              if (existing?.groupName) {
                groupName = existing.groupName;
                label = `群聊 ${groupName} (${groupCode})`;
              } else if (existing?.name) {
                groupName = existing.name;
                label = `群聊 ${groupName} (${groupCode})`;
              }
            }
            stack.push({ chatType: "group", target: groupCode, label, groupName, lastActivity: Date.now() });
            cs._switchSessions.set(sessionKey, stack);
            await ctx.reply(
              `✅ 已切换到 ${label}\n` +
              `层级: ${stack.length}\n` +
              `后续消息将在该上下文中处理\n` +
              `退出: /switch exit`,
            );
            return;
          }

          // /switch dm <用户ID> — push DM context
          if (subArg === "dm" && ctx.args[1]) {
            const targetUserId = ctx.args[1];
            stack.push({ chatType: "direct", target: targetUserId, label: `私聊 ${targetUserId}`, lastActivity: Date.now() });
            cs._switchSessions.set(sessionKey, stack);
            await ctx.reply(
              `✅ 已切换到 私聊 ${targetUserId}\n` +
              `层级: ${stack.length}\n` +
              `后续消息将在该上下文中处理\n` +
              `退出: /switch exit`,
            );
            return;
          }

          // No args — show current stack
          if (stack.length === 0) {
            await ctx.reply(
              "📋 当前无切换上下文\n\n" +
              "用法:\n" +
              "  /switch group <群号>  — 切换到群聊上下文\n" +
              "  /switch dm <用户ID>   — 切换到私聊上下文\n" +
              "  /switch exit          — 退出当前切换（返回上层）\n" +
              "  /switch               — 查看当前栈",
            );
            return;
          }
          const lines = stack.map((s, i) => `  ${i + 1}. ${s.label}`);
          await ctx.reply(`📋 切换上下文栈 (层级 ${stack.length}):\n${lines.join("\n")}\n\n当前: ${stack[stack.length - 1].label}\n退出: /switch exit`);
        },
      });
}
