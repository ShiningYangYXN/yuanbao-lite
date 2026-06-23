/**
 * /upload command handler — extracted from registry.ts (lossless split).
 * Category: media
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "upload",
    aliases: ["上传"],
    description: "上传文件到媒体服务器",
    usage: "/upload <文件路径>   (返回 uuid 和 url)",
    category: "media" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply("用法: /upload <文件路径>");
        return;
      }
      const filePath = ctx.args[0];
      try {
        const result = await ctx.bot.uploadMedia(filePath);
        await ctx.reply(
          `✅ 上传成功: uuid=${result.uuid}, url=${result.url || "(pending)"}`,
        );
      } catch (err) {
        await ctx.reply(`❌ 上传失败: ${(err as Error).message}`);
      }
    },
  });
}
