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
import { generateColoredHelp } from "../../help-text.js";
import {
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../../../business/sticker.js";
import {
  uploadToLitterbox,
  uploadAndFormatLink as tempfileFormatLink,
} from "../../../access/http/tempfile.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "download",
        aliases: ["下载"],
        description: "下载媒体文件到本地",
        usage: "/download <URL> [文件名]",
        category: "media" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /download <URL> [文件名]");
            return;
          }
          const url = ctx.args[0];
          const fileName = ctx.args[1];
          try {
            const result = await ctx.bot.downloadMedia(url, undefined, fileName);
            await ctx.reply(`✅ 下载完成: ${result.filePath} (${result.fileSize} bytes)`);
          } catch (err) {
            await ctx.reply(`❌ 下载失败: ${(err as Error).message}`);
          }
        },
      });
}
