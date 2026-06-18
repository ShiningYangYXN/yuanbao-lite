/**
 * /block command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "block",
        aliases: ["封禁", "ban"],
        description: "封禁用户使用全部或部分功能（优先级高于unsafe，可禁用非受限命令）",
        usage: "/block [list|add <ID|*> <all|llm|command|命令名> [昵称]|remove <ID|*> [范围]|status]",
        category: "system" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const block = await import("../../../business/block.js");
          const { addBlock, removeBlock, listBlocks, getBlockEntry } = block;
          const subCmd = ctx.args[0]?.toLowerCase();

          // /block status — anyone can check their own block status
          if (subCmd === "status") {
            const userId = ctx.message.fromUserId;
            const entry = getBlockEntry(userId);
            if (!entry) {
              await ctx.reply(`📊 封禁状态:\n  你的ID: ${userId}\n  是否被封禁: 否`);
            } else {
              const scopeLines = entry.scopes.map(s => `  - ${s}`).join("\n");
              await ctx.reply(`📊 封禁状态:\n  你的ID: ${userId}\n  是否被封禁: 是\n  封禁范围:\n${scopeLines}`);
            }
            return;
          }

          // Only trusted users can manage blocks (master always can).
          // CLI source bypasses trust check (CLI is global highest privilege).
          if (ctx.source !== "cli") {
            const { isTrusted } = await import("../../../business/trust.js");
            if (!isTrusted(ctx.message.fromUserId)) {
              await ctx.reply("❌ 你不在信任列表中，无法管理封禁列表");
              return;
            }
          }

          if (!subCmd || subCmd === "list") {
            const entries = listBlocks();
            if (entries.length === 0) {
              await ctx.reply("📋 封禁列表为空");
              return;
            }
            const lines = entries.map(e =>
              `  ${e.userId === "*" ? "🌟" : "🚫"} ${e.userId}` +
              `${e.nickname ? ` (${e.nickname})` : ""}` +
              `${e.userId === "*" ? " [全局]" : ""}` +
              `  范围: ${e.scopes.join(", ")}` +
              `  封禁于 ${new Date(e.blockedAt).toLocaleString("zh-CN")}`,
            );
            await ctx.reply(`📋 封禁列表 (${entries.length} 条):\n${lines.join("\n")}`);
            return;
          }

          // /block add <ID|*> <[all]|[llm]|[command]|命令名> [昵称]
          if (subCmd === "add") {
            if (ctx.args.length < 3) {
              await ctx.reply(
                "用法: /block add <用户ID|*> <范围> [昵称]\n" +
                "范围可选值:\n" +
                "  [all]      — 封禁所有功能（命令+LLM）\n" +
                "  [llm]      — 封禁LLM自动回复\n" +
                "  [command]  — 封禁所有斜杠命令\n" +
                "  <命令名>   — 封禁特定命令（如 shell, unsafe, send 等，可禁用非受限命令，无需加/）\n" +
                "权限组必须加方括号以区分命令名\n" +
                "用 * 作为用户ID可封禁所有用户（全局）\n" +
                "多次对同一用户操作会附加范围",
              );
              return;
            }
            const targetId = ctx.args[1];
            const scope = ctx.args[2];
            const nickname = ctx.args.slice(3).join(" ");
            const result = await addBlock(targetId, scope, nickname);
            await ctx.reply(result.ok
              ? `✅ 已封禁 ${targetId} (${scope})${nickname ? ` 昵称: ${nickname}` : ""}`
              : `❌ ${result.reason}`,
            );
            return;
          }

          // /block remove <ID|*> [范围]
          if (subCmd === "remove" || subCmd === "rm") {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /block remove <用户ID|*> [范围]\n不指定范围则移除该用户的所有封禁");
              return;
            }
            const targetId = ctx.args[1];
            const scope = ctx.args[2];
            const result = removeBlock(targetId, scope);
            await ctx.reply(result.ok
              ? `✅ 已移除 ${targetId} 的封禁${scope ? ` (${scope})` : "（全部）"}`
              : `❌ ${result.reason}`,
            );
            return;
          }

          await ctx.reply(
            "用法:\n" +
            "  /block                          查看封禁列表\n" +
            "  /block list                     同上\n" +
            "  /block add <ID|*> <范围> [昵称] 添加封禁（附加到已有范围）\n" +
            "  /block remove <ID|*> [范围]     移除封禁（不指定范围则全部移除）\n" +
            "  /block status                   查看自己的封禁状态\n" +
            "范围: [all] | [llm] | [command] | <命令名>\n" +
            "权限组必须加方括号；命令名无需加/\n" +
            "优先级: block > trust > unsafe（被封禁用户不能被添加到信任列表）",
          );
        },
      });
}
