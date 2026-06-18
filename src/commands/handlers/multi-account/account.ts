/**
 * /account command handler — extracted from registry.ts (lossless split).
 * Category: multi-account
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
        name: "account",
        aliases: ["账号", "acc"],
        description: "多账号管理（添加、切换、启停多个机器人账号）",
        usage: "/account <add|remove|list|switch|start|stop> [参数]",
        category: "multi-account" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();
          const subArgs = ctx.args.slice(1);

          switch (subCmd) {
            case "add": {
              if (subArgs.length < 3) {
                await ctx.reply("用法: /account add <ID> <appKey> <appSecret> [名称]");
                return;
              }
              const id = subArgs[0];
              const appKey = subArgs[1];
              const appSecret = subArgs[2];
              const name = subArgs[3];
              try {
                const manager = ctx.bot.getMultiAccountManager();
                manager.addAccount(id, { appKey, appSecret }, name);
                await ctx.reply(`✅ 账号已添加: ${id} (${name || "未命名"})`);
              } catch (err) {
                await ctx.reply(`❌ 添加账号失败: ${(err as Error).message}`);
              }
              break;
            }
            case "remove":
            case "rm": {
              if (subArgs.length < 1) {
                await ctx.reply("用法: /account remove <ID>");
                return;
              }
              try {
                const manager = ctx.bot.getMultiAccountManager();
                const removed = manager.removeAccount(subArgs[0]);
                await ctx.reply(removed ? `✅ 账号 ${subArgs[0]} 已移除` : `未找到账号: ${subArgs[0]}`);
              } catch (err) {
                await ctx.reply(`❌ 移除账号失败: ${(err as Error).message}`);
              }
              break;
            }
            case "list":
            case "ls": {
              try {
                const manager = ctx.bot.getMultiAccountManager();
                const accounts = manager.getAllAccounts();
                const activeId = manager.getActiveAccountId();
                if (accounts.length === 0) {
                  await ctx.reply("暂无账号。使用 /account add 添加账号");
                  return;
                }
                const lines = accounts.map(a => {
                  const marker = a.id === activeId ? "→" : " ";
                  const state = a.state.connected ? "✅" : "❌";
                  return `  ${marker} ${a.id} — ${a.name || "未命名"} ${state} (${a.state.status})`;
                });
                await ctx.reply(`📋 账号列表:\n${lines.join("\n")}`);
              } catch (err) {
                await ctx.reply(`❌ 获取账号列表失败: ${(err as Error).message}`);
              }
              break;
            }
            case "switch": {
              if (subArgs.length < 1) {
                await ctx.reply("用法: /account switch <ID>");
                return;
              }
              try {
                const manager = ctx.bot.getMultiAccountManager();
                const switched = manager.switchAccount(subArgs[0]);
                if (switched) {
                  const entry = manager.getAccount(subArgs[0]);
                  await ctx.reply(`✅ 已切换到账号: ${subArgs[0]} (${entry?.name || "未命名"})`);
                } else {
                  await ctx.reply(`未找到账号: ${subArgs[0]}`);
                }
              } catch (err) {
                await ctx.reply(`❌ 切换账号失败: ${(err as Error).message}`);
              }
              break;
            }
            case "start": {
              if (subArgs.length < 1) {
                await ctx.reply("用法: /account start <ID>");
                return;
              }
              try {
                const manager = ctx.bot.getMultiAccountManager();
                await manager.startAccount(subArgs[0]);
                await ctx.reply(`✅ 账号 ${subArgs[0]} 已启动`);
              } catch (err) {
                await ctx.reply(`❌ 启动账号失败: ${(err as Error).message}`);
              }
              break;
            }
            case "stop": {
              if (subArgs.length < 1) {
                await ctx.reply("用法: /account stop <ID>");
                return;
              }
              try {
                const manager = ctx.bot.getMultiAccountManager();
                manager.stopAccount(subArgs[0]);
                await ctx.reply(`✅ 已停止账号: ${subArgs[0]}`);
              } catch (err) {
                await ctx.reply(`❌ 停止账号失败: ${(err as Error).message}`);
              }
              break;
            }
            default:
              await ctx.reply("用法: /account <add|remove|list|switch|start|stop> [参数]");
          }
        },
      });
}
