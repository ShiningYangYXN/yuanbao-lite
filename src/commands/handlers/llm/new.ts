/**
 * /new command handler — extracted from registry.ts (lossless split).
 * Category: llm
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
        name: "new",
        aliases: ["clear", "清空", "新对话"],
        description: "清空当前或指定会话的LLM上下文历史（受限命令）",
        usage: "/new [dm <用户ID> | group <群号>]   (无参数=当前会话)",
        category: "llm" as CommandCategory,
        handler: async (ctx) => {
          const engine = ctx.bot.getLlmEngine();
          if (!engine) {
            await ctx.reply("❌ LLM 引擎未初始化");
            return;
          }
          // Determine target conversation key
          let targetKey: string;
          const subArg = ctx.args[0]?.toLowerCase();
          if (!subArg) {
            // Default: current session
            targetKey = engine.getConversationManager().getKey(ctx.message);
          } else if (subArg === "dm" && ctx.args[1]) {
            targetKey = `dm:${ctx.args[1]}`;
          } else if (subArg === "group" && ctx.args[1]) {
            targetKey = `group:${ctx.args[1]}`;
          } else {
            await ctx.reply("用法: /new [dm <用户ID> | group <群号>]\n无参数=清空当前会话上下文");
            return;
          }
          const sizeBefore = engine.getConversationManager().getHistory(targetKey).length;
          engine.getConversationManager().clearHistory(targetKey);
          await ctx.reply(`✅ 已清空会话上下文 (${targetKey})\n清除了 ${sizeBefore} 条历史消息`);
        },
      });
}
