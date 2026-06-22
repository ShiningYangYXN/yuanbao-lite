/**
 * /query command — view content referenced by contentId.
 *
 * When messages contain forwarded chat records or link cards, the content
 * is stored and referenced by a short contentId (e.g. [content:abc123]).
 * This command lets the LLM (and users) view the full content.
 *
 * Usage:
 *   /query <contentId>          — view content by ID
 *   /query list                 — list all stored content
 *
 * Category: utility
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "query",
    aliases: ["查看内容", "content"],
    description: "查看消息中引用的内容（转发聊天记录、网页等）",
    usage: "/query <contentId>   — 查看指定内容\n/query list        — 列出所有内容",
    category: "utility" as CommandCategory,
    handler: async (ctx) => {
      const { getContent, listContent } = await import("../../../business/content-store.js");
      const subCmd = ctx.args[0]?.toLowerCase();

      if (subCmd === "list") {
        const all = listContent();
        if (all.length === 0) {
          await ctx.reply("📋 暂无存储的内容");
          return;
        }
        if (ctx.useTable) {
                    const rows = all.map(e => [
            e.contentId,
            e.type,
            new Date(e.storedAt).toLocaleString("zh-CN"),
            e.content.substring(0, 50).replace(/\n/g, " ") + (e.content.length > 50 ? "..." : ""),
          ]);
          await ctx.reply(`📋 存储的内容 (${all.length} 个):\n${await ctx.formatTable(["ID", "类型", "时间", "预览"], rows)}`);
        } else {
          const lines = all.map(e => {
            const time = new Date(e.storedAt).toLocaleString("zh-CN");
            const preview = e.content.substring(0, 50).replace(/\n/g, " ");
            return `  ${e.contentId} [${e.type}] ${time}: ${preview}${e.content.length > 50 ? "..." : ""}`;
          });
          await ctx.reply(`📋 存储的内容 (${all.length} 个):\n${lines.join("\n")}\n\n查看: /query <contentId>`);
        }
        return;
      }

      if (!ctx.args[0]) {
        await ctx.reply("用法: /query <contentId>\n      /query list");
        return;
      }

      const contentId = ctx.args[0];
      const entry = getContent(contentId);
      if (!entry) {
        await ctx.reply(`❌ 未找到内容: ${contentId}\n使用 /query list 查看所有可用内容`);
        return;
      }
      const time = new Date(entry.storedAt).toLocaleString("zh-CN");
      await ctx.reply(
        `📄 内容 ${entry.contentId}:\n` +
        `类型: ${entry.type}\n` +
        `来源: ${entry.source}\n` +
        `时间: ${time}\n` +
        `长度: ${entry.content.length} 字符\n\n` +
        `--- 内容 ---\n${entry.content}`,
      );
    },
  });
}
