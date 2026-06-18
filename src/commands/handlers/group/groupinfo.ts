/**
 * /groupinfo command handler — extracted from registry.ts (lossless split).
 * Category: group
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
        name: "groupinfo",
        aliases: ["gi", "info", "群信息"],
        description: "查询群组信息（群名、群主、成员数）",
        usage: "/groupinfo [群号]   (在群聊中可省略群号)",
        category: "group" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          const groupCode = ctx.args[0] || ctx.groupCode;
          if (!groupCode) {
            await ctx.reply("用法: /groupinfo <群号>");
            return;
          }
          try {
            const info = await ctx.bot.queryGroupInfo(groupCode);
            if (info.code === 0 && info.group_info) {
              const gi = info.group_info;
              const ownerDisplay = gi.group_owner_nickname
                ? `${gi.group_owner_nickname} (ID: ${gi.group_owner_user_id || "?"})`
                : gi.group_owner_user_id || "(未知)";
              await ctx.reply(`📋 群信息:\n  群号: ${groupCode}\n  群名: ${gi.group_name || "(未知)"}\n  👤 群主: ${ownerDisplay}\n  👥 成员数: ${gi.group_size || 0}`);
            } else {
              await ctx.reply(`📋 群信息: 查询成功但无详细数据 (code: ${info.code})`);
            }
          } catch (err) {
            await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
          }
        },
      });
}
