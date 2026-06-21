/**
 * /download command handler — extracted from registry.ts (lossless split).
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
        name: "download",
        aliases: ["下载"],
        description: "下载媒体文件到本地（支持自定义保存路径）",
        usage: "/download <URL> [文件名] [--to <保存路径>]\n默认保存到 ~/downloads",
        category: "media" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /download <URL> [文件名] [--to <保存路径>]\n默认保存到 ~/downloads");
            return;
          }
          const url = ctx.args[0];
          // Parse optional --to flag and fileName
          let fileName: string | undefined;
          let saveDir: string | undefined;
          for (let i = 1; i < ctx.args.length; i++) {
            if (ctx.args[i] === "--to" && ctx.args[i + 1]) {
              saveDir = ctx.args[i + 1];
              i++;
            } else if (!fileName) {
              fileName = ctx.args[i];
            }
          }
          try {
            const result = await ctx.bot.downloadMedia(url, saveDir, fileName);
            await ctx.reply(`✅ 下载完成: ${result.filePath} (${result.fileSize} bytes)`);
          } catch (err) {
            await ctx.reply(`❌ 下载失败: ${(err as Error).message}`);
          }
        },
      });
}
