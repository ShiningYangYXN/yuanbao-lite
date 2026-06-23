/**
 * /stickers command handler — browse and list stickers.
 * Category: chat
 *
 * Sub-commands (search is now handled by /search stickers):
 *   - /stickers [emojis]  — list builtin emojis (default)
 *   - /stickers load <目录> — load custom sticker packs from directory
 *
 * Sticker SEARCH has been merged into /search:
 *   /search stickers <关键词>
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import {
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../../../business/sticker.js";
import { getNodeModules } from "../../../access/persistence/adapter.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "stickers",
    aliases: ["贴纸列表", "stickerlist"],
    description: "浏览贴纸列表（搜索请用 /search stickers <关键词>）",
    usage: "/stickers [--all] [emojis|load <目录>]   (--all/-a 显示全部)",
    category: "chat" as CommandCategory,
    handler: async (ctx) => {
      const subCmd = ctx.args[0]?.toLowerCase();
      const subArgs = ctx.args.slice(1);

      if (subCmd === "load" && subArgs[0]) {
        // `load` is Node-only — loadStickerPacksFromDir uses node:fs.readdirSync.
        // Under browser, it throws a clear error which we surface to the user.
        try {
          const path = getNodeModules().path;
          const dirArg = path ? path.resolve(subArgs[0]) : subArgs[0];
          const count = loadStickerPacksFromDir(dirArg);
          await ctx.reply(`✅ 加载了 ${count} 个贴纸包`);
        } catch (err) {
          await ctx.reply(`❌ 加载贴纸包失败: ${(err as Error).message}`);
        }
      } else if (subCmd === "emojis") {
        const emojis = getBuiltinEmojis();
        const maxEmojis = ctx.showAll ? emojis.length : 30;
        const display = emojis.slice(0, maxEmojis);
        if (ctx.useTable) {
          const rows = display.map((e) => [
            `emoji_${e.stickerId}`,
            e.name,
            e.description ? e.description.split(" ").slice(0, 3).join(" ") : "",
          ]);
          await ctx.reply(
            `🎨 内置表情 (${emojis.length} 个)\n${await ctx.formatTable(["编号", "名称", "描述"], rows)}`,
          );
        } else {
          const lines = display.map(
            (e) =>
              `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 3).join(" ")})` : ""}`,
          );
          const suffix =
            !ctx.showAll && emojis.length > 30
              ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers emojis --all 查看全部)`
              : "";
          await ctx.reply(
            `🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}`,
          );
        }
      } else {
        // Default: show builtin emojis list
        const emojis = getBuiltinEmojis();
        const maxEmojis = ctx.showAll ? emojis.length : 30;
        const display = emojis.slice(0, maxEmojis);
        if (ctx.useTable) {
          const rows = display.map((e) => [
            `emoji_${e.stickerId}`,
            e.name,
            e.description ? e.description.split(" ").slice(0, 2).join(" ") : "",
          ]);
          await ctx.reply(
            `🎨 内置表情 (${emojis.length} 个)\n${await ctx.formatTable(["编号", "名称", "描述"], rows)}`,
          );
        } else {
          const lines = display.map(
            (e) =>
              `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 2).join(" ")})` : ""}`,
          );
          const suffix =
            !ctx.showAll && emojis.length > 30
              ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers --all 查看全部)`
              : "";
          const packs = getStickerPacks();
          let packInfo = "";
          if (packs.length > 0) {
            packInfo = `\n📦 已加载 ${packs.length} 个自定义贴纸包`;
          }
          await ctx.reply(
            `🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}${packInfo}\n💡 使用 /search stickers <关键词> 搜索贴纸`,
          );
        }
      }
    },
  });
}
