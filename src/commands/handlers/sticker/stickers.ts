/**
 * /stickers command handler — extracted from registry.ts (lossless split).
 * Category: sticker
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { searchStickers, getStickerPacks, loadStickerPacksFromDir, getBuiltinEmojis } from "../../../business/sticker.js";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "stickers",
        aliases: ["贴纸列表", "stickerlist"],
        description: "浏览和搜索贴纸（支持模糊搜索，默认30条，--all显示全部）",
        usage: "/stickers [--all] [search <关键词>|emojis|load <目录>]   (--all/-a 显示全部)",
        category: "sticker" as CommandCategory,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const subArgs = ctx.args.slice(1);

          if (subCmd === "search" && subArgs.length > 0) {
            const query = subArgs.join(" ");
            const results = searchStickers(query);
            if (results.length === 0) {
              await ctx.reply(`未找到匹配 "${query}" 的贴纸`);
            } else {
              const maxStickers = ctx.showAll ? results.length : 20;
              const lines = results.slice(0, maxStickers).map(s =>
                `  emoji_${s.stickerId} — ${s.name}${s.description ? ` (${s.description.split(/\s+/).slice(0, 3).join(" ")})` : ""}`
              );
              const suffix = !ctx.showAll && results.length > 20 ? `\n  ... 及其他 ${results.length - 20} 个 (用 /stickers search --all 查看全部)` : "";
              await ctx.reply(`🎨 搜索结果:\n${lines.join("\n")}${suffix}`);
            }
          } else if (subCmd === "load" && subArgs[0]) {
            try {
              const count = loadStickerPacksFromDir(resolve(subArgs[0]));
              await ctx.reply(`✅ 加载了 ${count} 个贴纸包`);
            } catch (err) {
              await ctx.reply(`❌ 加载贴纸包失败: ${(err as Error).message}`);
            }
          } else if (subCmd === "emojis") {
            const emojis = getBuiltinEmojis();
            const maxEmojis = ctx.showAll ? emojis.length : 30;
            const lines = emojis.slice(0, maxEmojis).map(e =>
              `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 3).join(" ")})` : ""}`
            );
            const suffix = !ctx.showAll && emojis.length > 30 ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers emojis --all 查看全部)` : "";
            await ctx.reply(`🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}`);
          } else {
            // Default: show builtin emojis list
            const emojis = getBuiltinEmojis();
            const maxEmojis = ctx.showAll ? emojis.length : 30;
            const lines = emojis.slice(0, maxEmojis).map(e =>
              `  emoji_${e.stickerId} — ${e.name}${e.description ? ` (${e.description.split(" ").slice(0, 2).join(" ")})` : ""}`
            );
            const suffix = !ctx.showAll && emojis.length > 30 ? `\n  ... 及其他 ${emojis.length - 30} 个 (用 /stickers --all 查看全部)` : "";
            const packs = getStickerPacks();
            let packInfo = "";
            if (packs.length > 0) {
              packInfo = `\n📦 已加载 ${packs.length} 个自定义贴纸包`;
            }
            await ctx.reply(`🎨 内置表情 (用 /sticker emoji_编号 发送):\n${lines.join("\n")}${suffix}${packInfo}\n💡 使用 /stickers search <关键词> 模糊搜索贴纸`);
          }
        },
      });
}
