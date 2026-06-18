/**
 * /hclear command handler — extracted from registry.ts (lossless split).
 * Category: history
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
        name: "hclear",
        aliases: ["清除历史"],
        description: "清除消息历史（不可恢复）",
        usage: "/hclear",
        category: "history" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const store = ctx.bot.getHistoryStore();
          store.clear();
          await ctx.reply("✅ 消息历史已清除");
        },
      });
}
