/**
 * /join command handler — extracted from registry.ts (lossless split).
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
        name: "join",
        aliases: ["加入"],
        description: "加入群聊会话并跟踪活动",
        usage: "/join <群号>",
        category: "group" as CommandCategory,
        requireConnected: true,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /join <群号>");
            return;
          }
          const groupCode = ctx.args[0];
          const store = ctx.bot.getGroupStore();
          if (!store.get(groupCode)) {
            store.add(groupCode);
          }
          try {
            const info = await ctx.bot.queryGroupInfo(groupCode);
            const groupName = info.group_info?.group_name || groupCode;
            store.trackActivity(groupCode, groupName);
            await ctx.reply(`✅ 已加入群聊: ${groupName} (${groupCode})`);
          } catch (err) {
            store.trackActivity(groupCode);
            await ctx.reply(`✅ 已加入群聊: ${groupCode} (信息获取失败)`);
          }
        },
      });
}
