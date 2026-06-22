/**
 * /init command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  // Per-user wizard session state
  type WizardSession = {
    step: "appkey" | "appsecret" | "token" | "done";
    authMethod: "appkey" | "token";
    appKey?: string;
    appSecret?: string;
    token?: string;
    startedAt: number;
  };
  const wizardSessions = new Map<string, WizardSession>();
  const WIZARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

  cmdSys.register({
    name: "init",
    aliases: ["初始化", "setup", "配置向导"],
    description: "交互式配置向导（阻塞对话，引导设置认证信息）",
    usage: "/init [appkey|appsecret|token <值>]   (无参数启动向导，/init cancel 取消)",
    category: "system" as CommandCategory,
    requireConnected: false,
    elevated: true,
    handler: async (ctx) => {
      const { getGlobalConfigStore } = await import("../../../shared/config.js");
      const store = getGlobalConfigStore({ autoSave: true });
      const active = store.getActiveProfileName();
      const userId = ctx.message.fromUserId;
      const sessionKey = ctx.message.chatType === "group" && ctx.groupCode ? `${userId}:group:${ctx.groupCode}` : `${userId}:dm`;

      // Cancel sub-command
      if (ctx.args[0]?.toLowerCase() === "cancel") {
        wizardSessions.delete(sessionKey);
        await ctx.reply("✅ 配置向导已取消");
        return;
      }

      // If args provided, treat as direct field-set (non-interactive)
      const field = ctx.args[0]?.toLowerCase();
      const value = ctx.args.slice(1).join(" ").trim();
      if (field && value && field !== "appkey" && field !== "appsecret" && field !== "token" && field !== "app-key" && field !== "app-secret") {
        await ctx.reply(`❌ 无效字段: ${field}\n支持: appkey, appsecret, token`);
        return;
      }
      if (field && value) {
        const validFields: Record<string, string> = {
          appkey: "appKey",
          "app-key": "appKey",
          appsecret: "appSecret",
          "app-secret": "appSecret",
          token: "token",
        };
        const configKey = validFields[field];
        if (configKey) {
          store.set(configKey as never, value as never);
          await ctx.reply(
            `✅ 已设置 ${configKey} = ***${value.slice(-4)}\n` +
            `档案: ${active}\n` +
            `配置完成。发送 /daemon restart (3次) 让新配置生效`,
          );
        }
        return;
      }

      // Start interactive wizard
      wizardSessions.set(sessionKey, {
        step: "appkey",
        authMethod: "appkey",
        startedAt: Date.now(),
      });

      await ctx.reply(
        `🤖 配置向导已启动（阻塞模式）\n\n` +
        `接下来的对话将被向导捕获，直到完成或取消。\n\n` +
        `请选择认证方式:\n` +
        `  1️⃣ 发送 "appkey" 使用 AppKey + AppSecret\n` +
        `  2️⃣ 发送 "token" 使用 Token\n\n` +
        `随时发送 /init cancel 取消`,
      );

      // Set a timeout to auto-cancel
      setTimeout(() => {
        const session = wizardSessions.get(sessionKey);
        if (session && Date.now() - session.startedAt > WIZARD_TIMEOUT_MS) {
          wizardSessions.delete(sessionKey);
        }
      }, WIZARD_TIMEOUT_MS);
    },
  });
}
