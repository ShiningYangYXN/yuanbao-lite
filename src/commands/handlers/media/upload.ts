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
        name: "upload",
        aliases: ["上传"],
        description: "上传文件到媒体服务器",
        usage: "/upload <文件路径>   (返回 uuid 和 url)",
        category: "media" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /upload <文件路径>");
            return;
          }
          const filePath = ctx.args[0];
          try {
            const result = await ctx.bot.uploadMedia(filePath);
            await ctx.reply(`✅ 上传成功: uuid=${result.uuid}, url=${result.url || "(pending)"}`);
          } catch (err) {
            await ctx.reply(`❌ 上传失败: ${(err as Error).message}`);
          }
        },
      });
}
