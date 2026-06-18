/**
 * /file command handler — extracted from registry.ts (lossless split).
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
        name: "file",
        aliases: ["文件", "发送文件"],
        description: "发送文件消息",
        usage: "/file <文件路径> [目标ID]   (目标默认为当前会话)",
        category: "media" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /file <文件路径> [目标ID]");
            return;
          }
          const filePath = ctx.args[0];
          const target = ctx.args[1] || (ctx.isGroup ? ctx.groupCode : ctx.message.fromUserId);
          if (!target) {
            await ctx.reply("❌ 请指定发送目标");
            return;
          }
          try {
            await ctx.bot.sendFile({
              to: target,
              filePath,
              isGroup: ctx.isGroup,
            });
            await ctx.reply(`✅ 文件已发送到 ${target}`);
          } catch (err) {
            await ctx.reply(`❌ 文件发送失败: ${(err as Error).message}`);
          }
        },
      });
}
