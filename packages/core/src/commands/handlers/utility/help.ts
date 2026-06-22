/**
 * /help command handler — extracted from registry.ts (lossless split).
 * Category: utility
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { generateColoredHelp } from "../../help-text.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "help",
    aliases: ["h", "?", "帮助"],
    description: "显示命令帮助信息",
    usage: "/help [命令名]   (查看指定命令详细用法)",
    category: "utility" as CommandCategory,
    handler: async (ctx) => {
      if (ctx.args.length > 0) {
        // Show help for specific command
        const cmdName = ctx.args[0];
        const def = cmdSys.get(cmdName);
        if (!def) {
          await ctx.reply(`未知命令: ${cmdName}\n输入 /help 查看所有命令`);
          return;
        }
        const kv: [string, string][] = [
          ["命令", `${cmdSys.config.prefix}${def.name}`],
          ["描述", def.description],
        ];
        if (def.usage) kv.push(["用法", def.usage]);
        if (def.aliases?.length) kv.push(["别名", def.aliases.join(", ")]);
        if (def.category) kv.push(["分类", def.category]);
        const flags: string[] = [];
        if (def.elevated) flags.push("高权限");
        if (def.requireConnected) flags.push("需连接");
        if (def.hidden) flags.push("隐藏");
        if (flags.length > 0) kv.push(["标记", flags.join(", ")]);
        if (ctx.useTable) {
          await ctx.replyDoc(
            `📖 命令帮助\n${await ctx.formatTable(["属性", "值"], kv)}`,
          );
        } else {
          const lines = ["📖 命令帮助:", ...kv.map(([k, v]) => `  ${k}: ${v}`)];
          await ctx.replyDoc(lines.join("\n"));
        }
        return;
      }

      // Show all commands
      const visible = cmdSys.getAll().filter((c) => !c.hidden);
      if (visible.length === 0) {
        await ctx.reply("暂无可用命令");
        return;
      }

      if (ctx.useTable) {
        // Table mode: group by category with icon + Chinese name
        const categoryLabels: Record<string, string> = {
          info: "ℹ️ 信息",
          system: "🔐 安全",
          chat: "💬 聊天",
          group: "👥 群聊",
          media: "📎 媒体",
          history: "📜 历史",
          llm: "🤖 LLM",
          utility: "🛠️ 工具",
        };
        const categoryOrder = [
          "info",
          "chat",
          "group",
          "media",
          "history",
          "llm",
          "system",
          "utility",
        ];
        const categories = new Map<string, typeof visible>();
        for (const cmd of visible) {
          const cat = cmd.category || "utility";
          if (!categories.has(cat)) categories.set(cat, []);
          categories.get(cat)!.push(cmd);
        }
        const sections: string[] = [`📖 命令帮助 (${visible.length} 个命令)`];
        for (const cat of categoryOrder) {
          const cmds = categories.get(cat);
          if (!cmds) continue;
          const label = categoryLabels[cat] || cat;
          const rows = cmds.map((cmd) => [
            `${cmdSys.config.prefix}${cmd.name}`,
            cmd.aliases?.length ? cmd.aliases.join(", ") : "",
            cmd.description || "",
            cmd.elevated ? "仅私聊" : "",
          ]);
          sections.push(
            `\n### ${label}\n${await ctx.formatTable(["命令", "别名", "描述", "标记"], rows)}`,
          );
        }
        await ctx.replyDoc(sections.join("\n"));
      } else {
        // Plain text mode: use generated colored help
        const helpText = generateColoredHelp(visible, {
          prefix: cmdSys.config.prefix,
          footer: cmdSys.config.helpFooter,
        });
        await ctx.replyDoc(helpText);
      }
    },
  });
}
