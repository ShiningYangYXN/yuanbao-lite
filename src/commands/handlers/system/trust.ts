/**
 * /trust command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "trust",
        aliases: ["信任", "受信"],
        description: "管理受信用户列表和单命令授权（主人自动受信，不可移除）",
        usage: "/trust [list|add <ID> [昵称]|remove <ID>|grant <ID> <命令> [分钟|forever]|revoke <ID> <命令>|grants [ID]|status|help]",
        category: "system" as CommandCategory,
        handler: async (ctx) => {
          const trust = await import("../../../business/trust.js");
          const { isTrusted, addTrust, removeTrust, listTrust, getMasterUserId, grantCommand, revokeCommand, listCommandGrants, getTrustEntry } = trust;
          const subCmd = ctx.args[0]?.toLowerCase();
          const userId = ctx.message.fromUserId;

          // /trust help — show detailed subcommand help (globally open)
          if (subCmd === "help" || subCmd === "?") {
            await ctx.replyDoc(
              "📋 /trust 子命令帮助:\n\n" +
              "  /trust                    查看信任列表\n" +
              "  /trust list               同上\n" +
              "  /trust add <ID> [昵称]    添加受信用户\n" +
              "  /trust remove <ID>        移除受信用户（主人不可移除）\n" +
              "  /trust grant <ID> <命令> [分钟|forever]\n" +
              "                            授权单命令给单用户（默认5分钟）\n" +
              "  /trust revoke <ID> <命令> 撤销单用户单命令授权\n" +
              "  /trust grants [ID]        查看单命令授权（默认自己）\n" +
              "  /trust status             查看自己的信任状态\n" +
              "  /trust help               显示此帮助\n\n" +
              "命令名无需加/前缀（如 shell, 不是 /shell）\n" +
              "不可授权命令: unsafe, trust, block, config, init, daemon\n" +
              "被封禁用户不能被添加到信任列表",
            );
            return;
          }

          // /trust status is globally open — anyone can check their own status
          if (subCmd === "status") {
            const trusted = isTrusted(userId);
            const master = getMasterUserId();
            const grants = listCommandGrants(userId);
            const grantLines = grants.length > 0
              ? grants.map(g => `    ${g.command} — ${g.forever ? "永久" : `${Math.ceil((g.expiresAt - Date.now()) / 60000)}分钟后过期`}`).join("\n")
              : "    (无)";
            await ctx.reply(
              `📊 信任状态:\n` +
              `  你的ID: ${userId}\n` +
              `  是否受信: ${trusted ? "是" : "否"}\n` +
              `  是否主人: ${userId === master ? "是" : "否"}\n` +
              `  主人ID: ${master ?? "(未设置)"}\n` +
              `  单命令授权:\n${grantLines}`,
            );
            return;
          }

          // list/add/remove/grant/revoke require dmOnly (system management operations).
          // CLI source bypasses dmOnly + trust check (CLI is global highest privilege).
          // Unsafe mode also bypasses dmOnly + trust check (trusted user enabled it).
          const bypassChecks = ctx.source === "cli" || cmdSys.isUnsafeMode();
          if (!bypassChecks && ctx.message.chatType === "group") {
            await ctx.reply("⚠️ 此操作仅限私聊使用。请私聊机器人发送此命令。\n或在群聊中开启危险模式：/unsafe on");
            return;
          }

          // Only trusted users can manage trust (master always can).
          // CLI source and unsafe mode bypass trust check.
          if (!bypassChecks && !isTrusted(userId)) {
            await ctx.reply(
              `❌ 权限不足：你需要受信才能管理信任列表。\n` +
              `你的用户ID: ${userId}\n` +
              `请联系主人发送: /trust add ${userId}\n` +
              `或由主人开启危险模式后在群聊中执行`,
            );
            return;
          }

          if (!subCmd || subCmd === "list") {
            const entries = listTrust();
            const master = getMasterUserId();
            if (entries.length === 0) {
              await ctx.reply("📋 信任列表为空");
              return;
            }
            const lines = entries.map(e => {
              const crown = e.isMaster || e.userId === master ? "👑" : "👤";
              const nick = e.nickname ? ` (${e.nickname})` : "";
              const masterTag = e.isMaster ? " [主人]" : "";
              const grantCount = e.commandGrants ? Object.keys(e.commandGrants).length : 0;
              const grantTag = grantCount > 0 ? ` [${grantCount}个授权]` : "";
              return `  ${crown} ${e.userId}${nick}${masterTag}${grantTag}  受信于 ${new Date(e.trustedAt).toLocaleString("zh-CN")}`;
            });
            await ctx.reply(`📋 信任列表 (${entries.length} 人):\n${lines.join("\n")}`);
            return;
          }

          if (subCmd === "add") {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /trust add <ID> [昵称]");
              return;
            }
            const targetId = ctx.args[1];
            const nickname = ctx.args.slice(2).join(" ");
            const result = await addTrust(targetId, nickname);
            if (result.ok) {
              await ctx.reply(`✅ 已将 ${targetId}${nickname ? ` (${nickname})` : ""} 加入信任列表`);
            } else if (result.reason === "already") {
              await ctx.reply(`${targetId} 已在信任列表中（昵称已更新）`);
            } else {
              await ctx.reply(`❌ ${result.reason}`);
            }
            return;
          }

          if (subCmd === "remove" || subCmd === "rm") {
            if (ctx.args.length < 2) {
              await ctx.reply("用法: /trust remove <ID>");
              return;
            }
            const targetId = ctx.args[1];
            const result = removeTrust(targetId);
            await ctx.reply(result.ok
              ? `✅ 已将 ${targetId} 移出信任列表`
              : `❌ ${result.reason}`,
            );
            return;
          }

          // /trust grant <userID> /command [minutes|forever]
          // Grants a specific command to a specific user (time-limited or forever).
          // The user does NOT need to be trusted first — this is a standalone grant.
          if (subCmd === "grant") {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /trust grant <用户ID> <命令名> [分钟|forever]\n默认: 5分钟, forever=永久\n命令名可加/也可不加，支持别名（如 sh = shell）\n不可授权命令: unsafe, trust, block, config, init, daemon");
              return;
            }
            const targetId = ctx.args[1];
            // Resolve command name: accepts "shell", "/shell", "sh" (alias) → "shell"
            const resolved = cmdSys.resolveCommandName(ctx.args[2]);
            if (!resolved) {
              await ctx.reply(`❌ 未知命令: ${ctx.args[2]}\n提示: 可用 /commands 查看所有命令和别名`);
              return;
            }
            const cmdName = resolved;
            let durationMs = 5 * 60 * 1000;
            if (ctx.args[3]?.toLowerCase() === "forever") {
              durationMs = 0;
            } else {
              const minutes = parseInt(ctx.args[3], 10);
              if (!isNaN(minutes) && minutes > 0) durationMs = minutes * 60 * 1000;
            }
            if (CommandSystem.UNAUTHORIZABLE_COMMANDS.has(cmdName.toLowerCase())) {
              await ctx.reply(`❌ 命令 ${cmdName} 不支持被授权`);
              return;
            }
            const result = await grantCommand(targetId, cmdName, durationMs);
            const expiryStr = durationMs === 0 ? "永久" : `${durationMs / 60000}分钟`;
            await ctx.reply(result.ok
              ? `✅ 已授权 ${cmdName} 给 ${targetId} (${expiryStr})`
              : `❌ ${result.reason}`,
            );
            return;
          }

          // /trust revoke <userID> /command
          if (subCmd === "revoke") {
            if (ctx.args.length < 3) {
              await ctx.reply("用法: /trust revoke <用户ID> <命令名>\n命令名可加/也可不加，支持别名");
              return;
            }
            const targetId = ctx.args[1];
            // Resolve command name: accepts "shell", "/shell", "sh" (alias) → "shell"
            const resolved = cmdSys.resolveCommandName(ctx.args[2]);
            if (!resolved) {
              await ctx.reply(`❌ 未知命令: ${ctx.args[2]}`);
              return;
            }
            const cmdName = resolved;
            const result = revokeCommand(targetId, cmdName);
            await ctx.reply(result.ok
              ? `✅ 已撤销 ${targetId} 的 ${cmdName} 授权`
              : `❌ ${result.reason}`,
            );
            return;
          }

          // /trust grants <userID> — list a user's command grants
          if (subCmd === "grants") {
            const targetId = ctx.args[1] ?? userId;
            const grants = listCommandGrants(targetId);
            const entry = getTrustEntry(targetId);
            const name = entry?.nickname ?? targetId;
            if (grants.length === 0) {
              await ctx.reply(`📋 ${name} 的单命令授权: (无)`);
              return;
            }
            const lines = grants.map(g => `  ${g.command} — ${g.forever ? "永久" : `${Math.ceil((g.expiresAt - Date.now()) / 60000)}分钟后过期`}`);
            await ctx.reply(`📋 ${name} 的单命令授权 (${grants.length} 个):\n${lines.join("\n")}`);
            return;
          }

          await ctx.reply(
            "用法:\n" +
            "  /trust                          查看信任列表\n" +
            "  /trust list                     同上\n" +
            "  /trust add <ID> [昵称]          添加受信用户\n" +
            "  /trust remove <ID>              移除受信用户（主人不可移除）\n" +
            "  /trust grant <ID> /命令 [分钟]  授权单命令给单用户（默认5分钟）\n" +
            "  /trust revoke <ID> /命令        撤销单用户单命令授权\n" +
            "  /trust grants [ID]              查看单命令授权（默认自己）\n" +
            "  /trust status                   查看自己的信任状态",
          );
        },
      });
}
