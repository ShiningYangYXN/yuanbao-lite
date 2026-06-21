/**
 * /batch command handler — extracted from registry.ts (lossless split).
 * Category: batch
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "batch",
        aliases: ["批量"],
        description: "批量发送消息（text/sticker/image/file，支持JS插值模板，--spam突破数量上限）",
        usage: "/batch [--spam] <text|sticker|image|file> <目标> <数量> <间隔ms> <模板>\n/batch list | stop [id] | status [id]",
        category: "utility" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();

          // ─── Management sub-commands ───
          if (subCmd === "list") {
            const { getActiveBatchIds, getActiveBatch } = await import("../../../business/batch.js");
            const ids = getActiveBatchIds();
            if (ids.length === 0) {
              await ctx.reply("没有正在运行的批量任务");
              return;
            }
            const batchData = ids.map(id => {
              const b = getActiveBatch(id);
              if (!b) return null;
              return { id, p: b.getProgress() };
            }).filter(Boolean) as { id: string; p: { sent: number; total: number; failed: number; cancelled: boolean } }[];
            if (ctx.useTable) {
              const { formatTable } = await import("../../utils/table.js");
              const rows = batchData.map(({ id, p }) => [id, `${p.sent}/${p.total}`, String(p.failed), p.cancelled ? "已取消" : ""]);
              await ctx.reply(`📋 运行中的批量任务 (${batchData.length}):\n${formatTable(["任务ID", "进度", "失败", "状态"], rows)}`);
            } else {
              const lines = batchData.map(({ id, p }) => `  ${id}: ${p.sent}/${p.total} (失败 ${p.failed})${p.cancelled ? " [已取消]" : ""}`);
              await ctx.reply(`📋 运行中的批量任务:\n${lines.join("\n")}`);
            }
            return;
          }

          if (subCmd === "stop") {
            const { cancelBatch, getActiveBatchIds } = await import("../../../business/batch.js");
            const id = ctx.args[1] ?? getActiveBatchIds()[0];
            if (!id) {
              await ctx.reply("没有正在运行的批量任务");
              return;
            }
            const cancelled = cancelBatch(id);
            await ctx.reply(cancelled ? `✅ 批量任务 ${id} 已取消` : `未找到任务: ${id}`);
            return;
          }

          if (subCmd === "status") {
            const { getActiveBatch, getActiveBatchIds } = await import("../../../business/batch.js");
            const id = ctx.args[1] ?? getActiveBatchIds()[0];
            if (!id) {
              await ctx.reply("没有正在运行的批量任务");
              return;
            }
            const batch = getActiveBatch(id);
            if (!batch) {
              await ctx.reply(`未找到任务: ${id}`);
              return;
            }
            const p = batch.getProgress();
            const eta = p.estimatedRemaining ? ` (~${Math.ceil(p.estimatedRemaining / 1000)}s 剩余)` : "";
            await ctx.reply(
              `📊 批量任务 ${id}:\n` +
              `  进度: ${p.sent}/${p.total}${eta}\n` +
              `  失败: ${p.failed}\n` +
              `  运行中: ${p.running ? "是" : "否"}\n` +
              `  已取消: ${p.cancelled ? "是" : "否"}`,
            );
            return;
          }

          // ─── Batch-start sub-commands: text | sticker | image | file ───
          // Parse --spam flag (allows突破 100 count limit)
          let args = [...ctx.args];
          let spam = false;
          if (args[0] === "--spam") {
            spam = true;
            args = args.slice(1);
          }
          const batchType = args[0]?.toLowerCase();
          const validTypes = ["text", "sticker", "image", "file"];
          if (!validTypes.includes(batchType ?? "")) {
            await ctx.replyDoc(
              "用法:\n" +
              "  /batch [--spam] text    <目标> <数量> <间隔ms> \"模板${i}\"\n" +
              "  /batch [--spam] sticker <目标> <数量> <间隔ms> <stickerId模板>\n" +
              "  /batch [--spam] image   <目标> <数量> <间隔ms> <文件路径模板>\n" +
              "  /batch [--spam] file    <目标> <数量> <间隔ms> <文件路径模板>\n" +
              "  /batch list | stop [id] | status [id]\n" +
              "--spam: 突破数量和频率限制（慎用）\n" +
              "模板变量: ${i}(索引), ${n}(序号), ${total}(总数), ${timestamp}(时间戳)",
            );
            return;
          }

          if (args.length < 5) {
            await ctx.replyDoc(`用法: /batch ${spam ? "--spam " : ""}${batchType} <目标> <数量> <间隔ms> <模板>`);
            return;
          }
          const targetArg = args[1];
          const count = parseInt(args[2], 10);
          const intervalMs = parseInt(args[3], 10);
          const template = args.slice(4).join(" ");

          const maxCount = spam ? Infinity : 100;
          if (isNaN(count) || count < 1 || count > maxCount) {
            await ctx.reply(spam ? "数量必须 >= 1 (--spam 已突破上限)" : "数量范围: 1-100 (用 --spam 突破)");
            return;
          }
          const minInterval = spam ? 0 : 500;
          if (isNaN(intervalMs) || intervalMs < minInterval) {
            await ctx.reply(spam ? "间隔必须 >= 0 (--spam 已突破频率限制)" : "间隔最小 500ms (用 --spam 突破)");
            return;
          }

          // Use resolveTarget for automatic group/DM detection
          const { targetId: cleanTarget, isGroup } = await ctx.resolveTarget(targetArg);

          // Generate a unique batch ID (so multiple batches can run concurrently)
          const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

          const { startBatch, cleanupBatch } = await import("../../../business/batch.js");
          const config: Record<string, unknown> = {
            type: batchType,
            target: cleanTarget,
            isGroup,
            count,
            intervalMs,
            template,
          };
          if (batchType === "sticker") config.stickerTemplate = template;
          if (batchType === "image" || batchType === "file") config.fileTemplate = template;

          const runner = startBatch(batchId, ctx.bot, config as never);

          await ctx.reply(`🔄 批量发送已启动 [${batchId}]: ${batchType} ${count}条, 间隔${intervalMs}ms, 目标 ${cleanTarget}${spam ? " [--spam]" : ""}`);

          runner.run().then((result) => {
            cleanupBatch(batchId);
            ctx.reply(
              `✅ 批量任务 ${batchId} 完成: 成功 ${result.sent}/${result.total}, 失败 ${result.failed}, 耗时 ${result.durationMs}ms`,
            ).catch(() => { });
          }).catch((err) => {
            cleanupBatch(batchId);
            ctx.reply(`❌ 批量任务 ${batchId} 失败: ${(err as Error).message}`).catch(() => { });
          });
        },
      });
}
