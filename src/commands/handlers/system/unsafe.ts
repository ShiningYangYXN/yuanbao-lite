/**
 * /unsafe command handler — extracted from registry.ts (lossless split).
 * Category: system
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
        name: "unsafe",
        aliases: ["危险模式"],
        description: "管理危险模式和单命令授权（需受信）",
        usage: "/unsafe [on [分钟|forever] | off | status | allow <命令> [分钟|forever] | disallow <命令>]",
        category: "system" as CommandCategory,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();

          // /unsafe status is globally open — no trust check, no dmOnly
          if (subCmd === "status") {
            const lines: string[] = [];
            if (cmdSys.isUnsafeMode()) {
              if (cmdSys.isUnsafeForever()) {
                lines.push("🔓 危险模式: 已永久开启");
              } else {
                lines.push("🔓 危险模式: 已开启");
              }
            } else {
              lines.push("🔒 危险模式: 已关闭");
            }

            // Show authorized commands whitelist
            const allowed = cmdSys.getAllowedCommands();
            if (allowed.length > 0) {
              const now = Date.now();
              lines.push("", `📋 已授权命令 (${allowed.length}):`);
              for (const a of allowed) {
                const expiry = a.forever ? "永久" : `${Math.ceil((a.expiresAt - now) / 60000)}分钟后过期`;
                lines.push(`  /${a.name} — ${expiry}`);
              }
            } else {
              lines.push("", "📋 已授权命令: (无)");
            }

            await ctx.reply(lines.join("\n"));
            return;
          }

          // on/off require trust check
          let trusted: boolean;
          try {
            const { isTrusted } = await import("../../../business/trust.js");
            trusted = isTrusted(ctx.message.fromUserId);
          } catch {
            // trust module optional — default to allowing if module missing
            trusted = true;
          }

          if (!trusted) {
            await ctx.reply(
              `❌ 你不在信任列表中，无法开启危险模式。\n你的用户ID: ${ctx.message.fromUserId}\n请联系主人发送: /trust add ${ctx.message.fromUserId}`,
            );
            return;
          }

          const subCmd2 = ctx.args[0]?.toLowerCase();

          if (subCmd2 === "allow") {
            // /unsafe allow [command] [minutes|forever]
            // No command: list currently authorized
            if (!ctx.args[1]) {
              const allowed = cmdSys.getAllowedCommands();
              const now = Date.now();
              const lines = allowed.map(a => {
                const expiry = a.forever ? "永久" : `${Math.ceil((a.expiresAt - now) / 60000)}分钟后过期`;
                return `  /${a.name} — ${expiry}`;
              });
              await ctx.reply(
                `📋 已授权命令 (${allowed.length}):\n${lines.length > 0 ? lines.join("\n") : "  (无)"}\n\n` +
                `用法: /unsafe allow <命令名> [分钟数|forever]\n` +
                `默认: 5分钟, forever=永久\n` +
                `/unsafe disallow <命令名> — 取消授权\n` +
                `不可授权: unsafe, trust, config, init, daemon`,
              );
              return;
            }
            // Parse duration: minutes number, "forever", or default 5min
            const cmdName = ctx.args[1];
            let durationMs = 5 * 60 * 1000; // default 5 min
            if (ctx.args[2]?.toLowerCase() === "forever") {
              durationMs = 0;
            } else {
              const minutes = parseInt(ctx.args[2], 10);
              if (!isNaN(minutes) && minutes > 0) {
                durationMs = minutes * 60 * 1000;
              }
            }
            const result = cmdSys.allowCommand(cmdName, durationMs);
            const expiryStr = durationMs === 0 ? "永久" : `${durationMs / 60000}分钟`;
            await ctx.reply(result.ok
              ? `✅ 已授权 /${cmdName} 在群聊中使用 (${expiryStr})`
              : `❌ ${result.reason}`,
            );
            return;
          }

          if (subCmd2 === "disallow") {
            // /unsafe disallow <command> — revoke authorization
            if (!ctx.args[1]) {
              await ctx.reply("用法: /unsafe disallow <命令名>");
              return;
            }
            const result = cmdSys.disallowCommand(ctx.args[1]);
            await ctx.reply(result.ok ? `✅ 已取消授权 /${ctx.args[1]}` : `❌ ${result.reason}`);
            return;
          }

          if (!subCmd2 || subCmd2 === "on") {
            // Check for "forever" keyword
            if (ctx.args[1]?.toLowerCase() === "forever") {
              cmdSys.enableUnsafeMode(0); // 0 = forever
              await ctx.reply(
                `🔓 危险模式已永久开启\n` +
                `  效果: 所有dmOnly命令可在群聊中使用\n` +
                `  关闭: /unsafe off\n` +
                `⚠️ 请注意安全`,
              );
              return;
            }
            // Default: 5 minutes
            const minutes = parseInt(ctx.args[1], 10);
            const durationMs = (isNaN(minutes) || minutes <= 0) ? 5 * 60 * 1000 : minutes * 60 * 1000;
            cmdSys.enableUnsafeMode(durationMs);
            const mins = durationMs / 60000;
            await ctx.reply(
              `🔓 危险模式已开启\n` +
              `  有效期: ${mins}分钟\n` +
              `  效果: 所有dmOnly命令可在群聊中使用\n` +
              `  关闭: /unsafe off\n` +
              `⚠️ 请注意安全，用完及时关闭\n` +
              `永久开启: /unsafe on forever`,
            );
          } else if (subCmd2 === "off") {
            cmdSys.disableUnsafeMode();
            await ctx.reply("🔒 危险模式已关闭，dmOnly限制已恢复");
          } else {
            await ctx.reply(
              "用法: /unsafe [on|off|status|allow|disallow] [参数]\n" +
              "  /unsafe              — 开启5分钟\n" +
              "  /unsafe 10           — 开启10分钟\n" +
              "  /unsafe on forever   — 永久开启\n" +
              "  /unsafe off          — 关闭\n" +
              "  /unsafe status       — 查看状态\n" +
              "  /unsafe allow <命令> — 授权单个命令在群聊使用\n" +
              "  /unsafe disallow <命令> — 取消授权",
            );
          }
        },
      });
}
