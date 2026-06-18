/**
 * /help command handler — extracted from registry.ts (lossless split).
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
        name: "help",
        aliases: ["h", "?", "帮助"],
        description: "显示命令帮助信息",
        usage: "/help [命令名]   (查看指定命令详细用法)",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length > 0) {
            // Show help for specific command
            const cmdName = ctx.args[0];
            const def = cmdSys.get(cmdName);
            if (!def) {
              await ctx.reply(`未知命令: ${cmdName}\n输入 /help 查看所有命令`);
              return;
            }
            const lines = [
              `📖 命令: ${cmdSys.config.prefix}${def.name}`,
              `描述: ${def.description}`,
            ];
            if (def.usage) lines.push(`用法: ${def.usage}`);
            if (def.aliases?.length) lines.push(`别名: ${def.aliases.join(", ")}`);
            if (def.category) lines.push(`分类: ${def.category}`);
            const flags: string[] = [];
            if (def.dmOnly) flags.push("仅私聊");
            if (def.requireConnected) flags.push("需连接");
            if (def.hidden) flags.push("隐藏");
            if (flags.length > 0) lines.push(`标记: ${flags.join(", ")}`);
            // Use replyDoc: command descriptions/usage may contain literal
            // @mention syntax (e.g. "/mention ... @[所有人]()") that must NOT
            // be interpreted as real mentions when sent to a group.
            await ctx.replyDoc(lines.join("\n"));
            return;
          }

          // Show all commands — auto-generated colored help
          const visible = cmdSys.getAll().filter(c => !c.hidden);
          if (visible.length === 0) {
            await ctx.reply("暂无可用命令");
            return;
          }

          // Generate colored help from command definitions
          const helpText = generateColoredHelp(visible, {
            prefix: cmdSys.config.prefix,
            footer: cmdSys.config.helpFooter,
          });
          // Use replyDoc: help text contains command descriptions that may
          // include literal @mention syntax (e.g. the /mention command
          // description says "支持 @[昵称](id), @[所有人]() 内联语法").
          // Without escaping, parseMentions would interpret these as real
          // mentions when sent to a group, producing garbage TIMCustomElem
          // elements and confusing the IM client.
          await ctx.replyDoc(helpText);
        },
      });
}
