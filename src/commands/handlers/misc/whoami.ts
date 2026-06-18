/**
 * /whoami command handler — extracted from registry.ts (lossless split).
 * Category: misc
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
        name: "whoami",
        aliases: ["我是谁", "我的信息"],
        description: "查看当前发送者的信息（用户ID、昵称、聊天类型等）",
        usage: "/whoami",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          const msg = ctx.message;
          let trusted = false;
          try {
            const { isTrusted } = await import("../../../business/trust.js");
            trusted = isTrusted(msg.fromUserId);
          } catch { /* ignore */ }

          const lines = [
            `👤 你的信息:`,
            `  用户ID: ${msg.fromUserId}`,
            `  昵称: ${msg.fromNickname || "(未知)"}`,
            `  聊天类型: ${msg.chatType === "group" ? "群聊" : "私聊"}`,
            ...(msg.chatType === "group" ? [
              `  群号: ${msg.groupCode || "(未知)"}`,
              `  群名: ${msg.groupName || "(未知)"}`,
            ] : []),
            `  是否受信: ${trusted ? "✅ 是" : "❌ 否"}`,
            ...(trusted ? [`  (可使用 /unsafe on 开启危险模式)`] : []),
          ];
          await ctx.reply(lines.join("\n"));
        },
      });
}
