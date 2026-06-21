/**
 * /remind command handler — extracted from registry.ts (lossless split).
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
        name: "remind",
        aliases: ["提醒", "timer"],
        description: "设置定时提醒（支持任意时长、时间点、目标，持久化）",
        usage: "/remind <时间> <消息> [--to <目标ID>]\n/remind list|cancel <ID>",
        category: "utility" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const reminders = await import("../../../business/reminders.js");
          const { addReminder, removeReminder, listReminders, parseTimeString, startAllJobs } = reminders;
          type SendFunction = (targetId: string, message: string, isGroup: boolean) => Promise<void>;
          const subCmd = ctx.args[0]?.toLowerCase();

          if (subCmd === "list") {
            const jobs = listReminders(ctx.message.fromUserId);
            if (jobs.length === 0) {
              await ctx.reply("暂无提醒");
              return;
            }
            if (ctx.useTable) {
              const { formatTable } = await import("../../utils/table.js");
              const rows = jobs.map(j => [
                j.id,
                new Date(j.fireAt).toLocaleString("zh-CN"),
                j.isGroup ? `群${j.targetId}` : (j.targetId ?? j.userId),
                j.message.substring(0, 30),
              ]);
              await ctx.reply(`📋 提醒列表 (${jobs.length}):\n${formatTable(["ID", "触发时间", "目标", "消息"], rows)}`);
            } else {
              const lines = jobs.map(j => {
                const time = new Date(j.fireAt).toLocaleString("zh-CN");
                const target = j.isGroup ? `群${j.targetId}` : j.targetId ?? j.userId;
                return `  ${j.id}: ${time} → ${target} — "${j.message}"`;
              });
              await ctx.reply(`📋 提醒列表 (${jobs.length}):\n${lines.join("\n")}`);
            }
            return;
          }

          if (subCmd === "cancel" && ctx.args[1]) {
            const ok = removeReminder(ctx.args[1]);
            await ctx.reply(ok ? `✅ 已取消提醒 ${ctx.args[1]}` : `未找到提醒: ${ctx.args[1]}`);
            return;
          }

          if (ctx.args.length < 2) {
            await ctx.reply(
              "用法: /remind <时间> <消息> [--to <目标ID>] [--group]\n" +
              "时间格式:\n" +
              "  相对: 30s, 5m, 2h, 1d, 1w, 1mo, 1y\n" +
              "  组合: 1d2h3m\n" +
              "  时间点: 14:30\n" +
              "  完整: 2026-06-18 14:30\n" +
              "目标: --to <用户ID/群号/别名> (默认当前会话, 自动识别群聊/私聊)\n\n" +
              "管理: /remind list | /remind cancel <ID>",
            );
            return;
          }

          const timeStr = ctx.args[0];
          // Parse --to flag (target ID). --group is deprecated — auto-detection
          // via resolveTarget (alias → 9-digit group → user ID) is used instead.
          const remaining = ctx.args.slice(1);
          let targetArg: string | undefined;
          const msgParts: string[] = [];
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i] === "--to" && remaining[i + 1]) {
              targetArg = remaining[i + 1];
              i++;
            } else if (remaining[i] === "--group") {
              // Deprecated: ignored, auto-detection handles group vs DM.
              // Kept for backward compat — does nothing now.
            } else {
              msgParts.push(remaining[i]);
            }
          }
          const message = msgParts.join(" ");
          if (!message) {
            await ctx.reply("❌ 消息内容不能为空");
            return;
          }

          const parsed = parseTimeString(timeStr);
          if (parsed.error) {
            await ctx.reply(`❌ ${parsed.error}`);
            return;
          }

          // Default target: current chat. Otherwise resolve via resolveTarget.
          let targetId: string;
          let isGroup: boolean;
          if (!targetArg) {
            targetId = ctx.isGroup ? (ctx.groupCode ?? ctx.message.fromUserId) : ctx.message.fromUserId;
            isGroup = ctx.isGroup;
          } else {
            const resolved = await ctx.resolveTarget(targetArg);
            targetId = resolved.targetId;
            isGroup = resolved.isGroup;
          }

          const id = addReminder({
            type: "remind",
            userId: ctx.message.fromUserId,
            message,
            fireAt: parsed.fireAt,
            intervalMs: 0,
            targetId,
            isGroup,
          });

          // Start all jobs (idempotent — re-schedules all active jobs,
          // clearing existing timers first). This picks up the new job
          // and ensures jobs are scheduled even if daemon just started.
          const sendFn: SendFunction = async (tid, msg, grp) => {
            if (grp) await ctx.bot.sendGroupMessage(tid, msg);
            else await ctx.bot.sendDirectMessage(tid, msg);
          };
          startAllJobs(sendFn);

          await ctx.reply(
            `⏰ 提醒已设置 [${id}]:\n` +
            `  消息: "${message}"\n` +
            `  触发: ${new Date(parsed.fireAt).toLocaleString("zh-CN")}\n` +
            `  目标: ${isGroup ? "群" : "私聊"} ${targetId}\n` +
            `  (距现在 ${Math.round(parsed.delayMs / 1000)} 秒)\n` +
            `取消: /remind cancel ${id}`,
          );
        },
      });
}
