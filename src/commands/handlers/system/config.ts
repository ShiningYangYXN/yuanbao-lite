/**
 * /config command handler — extracted from registry.ts (lossless split).
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
        name: "config",
        aliases: ["配置"],
        description: "配置管理（查看/设置/导入/导出/档案）",
        usage: "/config [show | set <key> <value> | get <key> | profile list|switch|add|remove | export | import <json>]",
        category: "system" as CommandCategory,
        requireConnected: false,
        dmOnly: true,
        handler: async (ctx) => {
          const subCmd = ctx.args[0]?.toLowerCase();

          // Lazy-import the shared ConfigStore
          const { getGlobalConfigStore } = await import("../../../shared/config.js");
          const store = getGlobalConfigStore({ autoSave: true });

          switch (subCmd) {
            case undefined:
            case "show": {
              const active = store.getActiveProfileName();
              const pr = store.getActiveProfile();
              const lines = [
                "📋 当前配置:",
                `  档案: ${active}`,
                `  App Key: ${pr.appKey ? `***${pr.appKey.slice(-4)}` : "(未设置)"}`,
                `  App Secret: ${pr.appSecret ? "***" + pr.appSecret.slice(-4) : "(未设置)"}`,
                `  Token: ${pr.token ? "***" + pr.token.slice(-4) : "(未设置)"}`,
                `  API域名: ${pr.apiDomain || "(默认)"}`,
                `  WS地址: ${pr.wsUrl || "(默认)"}`,
                `  日志级别: ${pr.logLevel || "(默认)"}`,
                `  贴纸目录: ${pr.stickerDir || "(未设置)"}`,
                `  下载目录: ${pr.downloadDir || store.getGlobal("downloadDir") || "(默认)"}`,
                `  LLM供应商: ${pr.llmProvider || "(未设置)"}`,
                `  LLM模型: ${pr.llmModel || "(未设置)"}`,
                `  配置路径: ${store.getConfigDir()}`,
              ];
              await ctx.reply(lines.join("\n"));
              return;
            }

            case "get": {
              if (!ctx.args[1]) {
                await ctx.reply("用法: /config get <key>");
                return;
              }
              const key = ctx.args[1] as keyof import("../../../shared/config.js").CliProfile;
              const value = store.get(key);
              if (value === undefined) {
                await ctx.reply(`配置项 ${key} 未设置`);
              } else if (typeof value === "string" && (key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey")) {
                await ctx.reply(`${key} = ***${value.slice(-4)}`);
              } else {
                await ctx.reply(`${key} = ${String(value)}`);
              }
              return;
            }

            case "set": {
              if (ctx.args.length < 3) {
                await ctx.reply("用法: /config set <key> <value>");
                return;
              }
              const key = ctx.args[1] as keyof import("../../../shared/config.js").CliProfile;
              const value = ctx.args.slice(2).join(" ");
              const validKeys: Array<keyof import("../../../shared/config.js").CliProfile> = [
                "appKey", "appSecret", "token", "apiDomain", "wsUrl",
                "logLevel", "stickerDir", "downloadDir", "prompt",
                "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel",
                "llmSystemPrompt", "llmEnabled", "defaultTarget", "defaultChatMode",
              ];
              if (!validKeys.includes(key)) {
                await ctx.reply(`无效配置键: ${key}\n可选: ${validKeys.join(", ")}`);
                return;
              }
              store.set(key, value as never);
              await ctx.reply(`✅ 已设置 ${key} = ${key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey" ? "***" : value}`);
              return;
            }

            case "profile": {
              const profileSub = ctx.args[1]?.toLowerCase();
              if (profileSub === "list" || !profileSub) {
                const names = store.getProfileNames();
                const active = store.getActiveProfileName();
                if (names.length === 0) {
                  await ctx.reply("暂无配置档案");
                  return;
                }
                const lines = names.map(n => {
                  const p = store.getProfile(n);
                  const hasCreds = p && ((p.appKey && p.appSecret) || p.token);
                  return `  ${n === active ? "→" : " "} ${n} ${hasCreds ? "✓" : "✗"}`;
                });
                await ctx.reply(`📋 配置档案:\n${lines.join("\n")}`);
                return;
              }
              if (profileSub === "switch" && ctx.args[2]) {
                if (store.switchProfile(ctx.args[2])) {
                  await ctx.reply(`✅ 已切换到档案: ${ctx.args[2]}\n⚠️ 需要重启 daemon 让新档案生效`);
                } else {
                  await ctx.reply(`❌ 档案不存在: ${ctx.args[2]}`);
                }
                return;
              }
              if (profileSub === "add" && ctx.args[2]) {
                store.createProfile(ctx.args[2], {});
                await ctx.reply(`✅ 已创建档案: ${ctx.args[2]}`);
                return;
              }
              if (profileSub === "remove" && ctx.args[2]) {
                if (store.deleteProfile(ctx.args[2])) {
                  await ctx.reply(`✅ 已删除档案: ${ctx.args[2]}`);
                } else {
                  await ctx.reply(`❌ 无法删除档案: ${ctx.args[2]} (可能不存在或为活跃档案)`);
                }
                return;
              }
              await ctx.reply("用法: /config profile list|switch <name>|add <name>|remove <name>");
              return;
            }

            case "export": {
              const data = store.getData();
              await ctx.reply(`📦 配置导出 (JSON):\n${JSON.stringify(data, null, 2)}`);
              return;
            }

            case "import": {
              if (!ctx.args[1]) {
                await ctx.reply("用法: /config import <json>");
                return;
              }
              try {
                const json = ctx.args.slice(1).join(" ");
                const parsed = JSON.parse(json) as import("../../../shared/config.js").CliConfigData;
                // Merge into existing config
                if (parsed.profiles) {
                  for (const [name, profile] of Object.entries(parsed.profiles)) {
                    store.createProfile(name, profile);
                  }
                }
                if (parsed.activeProfile && store.getProfile(parsed.activeProfile)) {
                  store.switchProfile(parsed.activeProfile);
                }
                await ctx.reply("✅ 配置已导入");
              } catch (err) {
                await ctx.reply(`❌ 导入失败: ${(err as Error).message}`);
              }
              return;
            }

            default:
              await ctx.reply(
                "用法:\n" +
                "  /config                       显示当前配置\n" +
                "  /config show                  同上\n" +
                "  /config get <key>             查询单个配置项\n" +
                "  /config set <key> <value>     设置配置项\n" +
                "  /config profile list          列出所有档案\n" +
                "  /config profile switch <name> 切换档案\n" +
                "  /config profile add <name>    创建档案\n" +
                "  /config profile remove <name> 删除档案\n" +
                "  /config export                导出配置为 JSON\n" +
                "  /config import <json>         导入配置",
              );
          }
        },
      });
}
