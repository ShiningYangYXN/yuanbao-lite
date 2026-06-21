/**
 * /cron command handler — extracted from registry.ts (lossless split).
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
        name: "cron",
        aliases: ["定时任务", "周期提醒"],
        description: "设置周期性定时任务（cron表达式，持久化，可指定目标）",
        usage: "/cron <cron表达式> <消息> [--to <目标ID>]\n/cron list|cancel <ID>",
        category: "utility" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const reminders = await import("../../../business/reminders.js");
          const { addReminder, removeReminder, listReminders, parseCronExpression, startAllJobs } = reminders;
          type SendFunction = (targetId: string, message: string, isGroup: boolean) => Promise<void>;
          const subCmd = ctx.args[0]?.toLowerCase();

          if (subCmd === "list") {
            const jobs = listReminders(ctx.message.fromUserId).filter(j => j.type === "cron");
            if (jobs.length === 0) {
              await ctx.reply("暂无定时任务");
              return;
            }
            if (ctx.useTable) {
                            const rows = jobs.map(j => [
                j.id,
                j.cronExpr || "",
                j.isGroup ? `群${j.targetId}` : (j.targetId ?? j.userId),
                new Date(j.fireAt).toLocaleString("zh-CN"),
                j.message.substring(0, 30),
              ]);
              await ctx.reply(`📋 定时任务 (${jobs.length}):\n${await ctx.formatTable(["ID", "表达式", "目标", "下次触发", "消息"], rows)}`);
            } else {
              const lines = jobs.map(j => {
                const next = new Date(j.fireAt).toLocaleString("zh-CN");
                const target = j.isGroup ? `群${j.targetId}` : j.targetId ?? j.userId;
                return `  ${j.id}: ${j.cronExpr} → ${target} 下次: ${next}\n    "${j.message}"`;
              });
              await ctx.reply(`📋 定时任务 (${jobs.length}):\n${lines.join("\n")}`);
            }
            return;
          }

          if (subCmd === "cancel" && ctx.args[1]) {
            const ok = removeReminder(ctx.args[1]);
            await ctx.reply(ok ? `✅ 已取消定时任务 ${ctx.args[1]}` : `未找到: ${ctx.args[1]}`);
            return;
          }

          if (ctx.args.length < 6) {
            await ctx.reply(
              "用法: /cron <cron表达式> <消息> [--to <目标ID>]\n" +
              "cron表达式: 分 时 日 月 周 (5个字段)\n" +
              "  * — 任意值\n" +
              "  star/N — 每N个单位\n" +
              "  N-M — 范围\n" +
              "  N,M — 列表\n\n" +
              "示例:\n" +
              "  /cron 30 9 * * 1-5 早安\n" +
              "  /cron 0 */2 * * * 每2小时喝水 --to 765035413 --group\n\n" +
              "管理: /cron list | /cron cancel <ID>",
            );
            return;
          }

          const cronExpr = ctx.args.slice(0, 5).join(" ");
          // Parse --to flag. --group is deprecated — auto-detection via
          // resolveTarget (alias → 9-digit group → user ID) is used instead.
          const remaining = ctx.args.slice(5);
          let targetArg: string | undefined;
          const msgParts: string[] = [];
          for (let i = 0; i < remaining.length; i++) {
            if (remaining[i] === "--to" && remaining[i + 1]) {
              targetArg = remaining[i + 1];
              i++;
            } else if (remaining[i] === "--group") {
              // Deprecated: ignored, auto-detection handles group vs DM.
            } else {
              msgParts.push(remaining[i]);
            }
          }
          const message = msgParts.join(" ");
          if (!message) {
            await ctx.reply("❌ 消息内容不能为空");
            return;
          }

          const parsed = parseCronExpression(cronExpr);
          if (parsed.error) {
            await ctx.reply(`❌ ${parsed.error}`);
            return;
          }

          const nextFire = parsed.getNextFire(Date.now());
          if (nextFire === 0) {
            await ctx.reply("❌ 无法计算下次触发时间");
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
            type: "cron",
            userId: ctx.message.fromUserId,
            message,
            fireAt: nextFire,
            intervalMs: 0,
            cronExpr,
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
            `🔄 定时任务已设置 [${id}]:\n` +
            `  表达式: ${cronExpr}\n` +
            `  消息: "${message}"\n` +
            `  目标: ${isGroup ? "群" : "私聊"} ${targetId}\n` +
            `  下次触发: ${new Date(nextFire).toLocaleString("zh-CN")}\n` +
            `取消: /cron cancel ${id}`,
          );
        },
      });
}
