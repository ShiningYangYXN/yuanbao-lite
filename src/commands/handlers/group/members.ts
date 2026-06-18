/**
 * /members command handler — extracted from registry.ts (lossless split).
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
        name: "members",
        aliases: ["成员", "群成员", "member"],
        description: "查看群成员（支持模糊搜索，默认50人，--all显示全部）",
        usage: "/members [--all] [群号]   (--all/-a 显示全部成员)",
        category: "group" as CommandCategory,
        requireConnected: true,
        handler: async (ctx) => {
          const groupCode = ctx.args[0] || ctx.groupCode;
          if (!groupCode) {
            await ctx.reply("用法: /members <群号>");
            return;
          }
          try {
            const members = await ctx.bot.getGroupMemberList(groupCode);
            if (members.code === 0 && members.member_list && members.member_list.length > 0) {
              const maxMembers = ctx.showAll ? members.member_list.length : 50;
              const lines = members.member_list.slice(0, maxMembers).map(m => {
                const typeLabel = m.user_type === 1 ? "[人类]" : m.user_type === 2 ? "[元宝]" : m.user_type === 3 ? "[龙虾]" : "";
                const displayName = m.nick_name || m.user_id;
                return `  ${displayName} ${typeLabel}\n    ID: ${m.user_id}`;
              });
              const suffix = !ctx.showAll && members.member_list.length > 50 ? `\n  ... 及其他 ${members.member_list.length - 50} 人 (用 /members --all 查看全部)` : "";
              await ctx.reply(`👥 群成员 (${members.member_list.length}人):\n${lines.join("\n")}${suffix}`);
            } else {
              await ctx.reply(`👥 群成员: 群 ${groupCode} 暂无成员数据`);
            }
          } catch (err) {
            await ctx.reply(`❌ 查询失败: ${(err as Error).message}`);
          }
        },
      });
}
