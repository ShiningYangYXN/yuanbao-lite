/**
 * /tempfile command handler — extracted from registry.ts (lossless split).
 * Category: media
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { uploadToLitterbox, uploadAndFormatLink as tempfileFormatLink } from "../../../access/http/tempfile.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "tempfile",
    aliases: ["临时文件", "tmpfile"],
    description: "上传文件到临时平台并发送链接（默认gofile，10天有效）",
    usage: "/tempfile <文件路径> [描述]\n/tempfile <gofile|tmpfiles|uguu|litterbox> <路径> [选项]",
    category: "media" as CommandCategory,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply(
          "用法: /tempfile <文件路径> [描述]\n" +
          "      /tempfile gofile <路径> [描述]\n" +
          "      /tempfile tmpfiles <路径> [描述]\n" +
          "      /tempfile uguu <路径> [描述]\n" +
          "      /tempfile litterbox <路径> [1h|12h|24h|72h] [描述]"
        );
        return;
      }

      const TEMPFILE_PROVIDERS = ["gofile", "tmpfiles", "uguu", "litterbox"];
      let provider: string | undefined;
      let filePath: string;
      let descParts: string[];

      if (TEMPFILE_PROVIDERS.includes(ctx.args[0])) {
        provider = ctx.args[0];
        if (ctx.args.length < 2) {
          await ctx.reply(`❌ 请指定文件路径: /tempfile ${provider} <路径> [选项]`);
          return;
        }
        filePath = resolve(ctx.args[1]);
        descParts = ctx.args.slice(2);
      } else {
        provider = undefined;
        filePath = resolve(ctx.args[0]);
        descParts = ctx.args.slice(1);
      }

      if (!existsSync(filePath)) {
        await ctx.reply(`❌ 文件不存在: ${filePath}`);
        return;
      }

      try {
        let expire: "1h" | "12h" | "24h" | "72h" | undefined;
        if (provider === "litterbox" && descParts.length > 0 && /^(1h|12h|24h|72h)$/.test(descParts[0])) {
          expire = descParts[0] as "1h" | "12h" | "24h" | "72h";
          descParts = descParts.slice(1);
        }

        const desc = descParts.join(" ") || undefined;
        await ctx.reply(`⏳ 正在上传到 ${provider || "gofile"}: ${filePath}...`);

        let shareText: string;
        if (provider === "litterbox" && expire) {
          const result = await uploadToLitterbox(filePath, expire);
          const sizeStr = result.fileSize > 1024 * 1024
            ? `${(result.fileSize / (1024 * 1024)).toFixed(1)}MB`
            : `${(result.fileSize / 1024).toFixed(0)}KB`;
          const expireStr = result.expireInfo ? ` [${result.expireInfo}]` : "";
          const link = result.directUrl || result.pageUrl;
          shareText = `文件分享${desc ? ` (${desc})` : ""}: ${result.fileName} [${sizeStr}]${expireStr}\n链接: ${link}`;
        } else {
          shareText = await tempfileFormatLink(filePath, desc, provider);
        }

        // Send to the conversation where the command was issued
        const to = ctx.isGroup && ctx.groupCode ? ctx.groupCode : ctx.message.fromUserId;
        const isGroup = ctx.isGroup;
        await ctx.bot.sendText({ to, text: shareText, isGroup });
      } catch (err) {
        await ctx.reply(`❌ 临时文件上传失败: ${(err as Error).message}`);
      }
    },
  });
}
