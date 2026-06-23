/**
 * /init command handler — interactive configuration wizard.
 * Category: system
 *
 * The wizard session state is exposed on the CommandSystem instance as
 * `_initWizardSessions` (Map) and `_handleInitWizardInput` (function) so
 * that YuanbaoBot.handleDispatch can intercept non-slash messages and
 * route them to the wizard when a session is active.
 *
 * This mirrors the pattern used by /llm config (llm.ts).
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  // Per-user wizard session state
  type WizardSession = {
    step: "auth-method" | "appkey" | "appsecret" | "token" | "done";
    authMethod: "appkey" | "token";
    appKey?: string;
    appSecret?: string;
    token?: string;
    startedAt: number;
    lastActivity?: number;
  };
  const wizardSessions = new Map<string, WizardSession>();
  const WIZARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

  // ─── Expose wizard state on CommandSystem ───
  // This MUST be set up so YuanbaoBot.handleDispatch can find
  // _initWizardSessions and intercept non-slash messages for the wizard.
  (
    cmdSys as unknown as { _initWizardSessions: Map<string, unknown> }
  )._initWizardSessions = wizardSessions;

  (
    cmdSys as unknown as {
      _handleInitWizardInput: (
        bot: unknown,
        sessionKey: string,
        text: string,
        reply: (t: string) => Promise<void>,
      ) => Promise<boolean>;
    }
  )._handleInitWizardInput = async (
    _bot: unknown,
    sessionKey: string,
    text: string,
    reply: (t: string) => Promise<void>,
  ): Promise<boolean> => {
    const session = wizardSessions.get(sessionKey);
    if (!session) return false;

    // Update lastActivity on every input
    session.lastActivity = Date.now();

    const { getGlobalConfigStore } = await import("../../../shared/config.js");
    const store = getGlobalConfigStore({ autoSave: true });
    const input = text.trim();

    // Step: auth-method — choose appkey vs token
    if (session.step === "auth-method") {
      const lower = input.toLowerCase();
      if (lower === "appkey" || lower === "1" || lower === "1️⃣") {
        session.authMethod = "appkey";
        session.step = "appkey";
        await reply("请发送 App Key:");
      } else if (lower === "token" || lower === "2" || lower === "2️⃣") {
        session.authMethod = "token";
        session.step = "token";
        await reply("请发送 Token:");
      } else {
        await reply(
          '请回复 "appkey" 或 "token" 选择认证方式（或 /init cancel 取消）',
        );
      }
      return true;
    }

    // Step: appkey — collect App Key
    if (session.step === "appkey") {
      session.appKey = input;
      session.step = "appsecret";
      await reply("✅ App Key 已收到\n请发送 App Secret:");
      return true;
    }

    // Step: appsecret — collect App Secret, then save
    if (session.step === "appsecret") {
      session.appSecret = input;
      store.set("appKey", session.appKey as never);
      store.set("appSecret", input as never);
      session.step = "done";
      wizardSessions.delete(sessionKey);
      await reply(
        "✅ 配置完成！\n" +
          `  App Key: ***${(session.appKey ?? "").slice(-4)}\n` +
          `  App Secret: ***${input.slice(-4)}\n\n` +
          "发送 /daemon restart 让新配置生效",
      );
      return true;
    }

    // Step: token — collect Token, then save
    if (session.step === "token") {
      session.token = input;
      store.set("token", input as never);
      session.step = "done";
      wizardSessions.delete(sessionKey);
      await reply(
        "✅ 配置完成！\n" +
          `  Token: ***${input.slice(-4)}\n\n` +
          "发送 /daemon restart 让新配置生效",
      );
      return true;
    }

    return false;
  };

  cmdSys.register({
    name: "init",
    aliases: ["初始化", "setup", "配置向导"],
    description: "交互式配置向导（阻塞对话，引导设置认证信息）",
    usage:
      "/init [appkey|appsecret|token <值>]   (无参数启动向导，/init cancel 取消)",
    category: "system" as CommandCategory,
    requireConnected: false,
    elevated: true,
    handler: async (ctx) => {
      const { getGlobalConfigStore } =
        await import("../../../shared/config.js");
      const store = getGlobalConfigStore({ autoSave: true });
      const active = store.getActiveProfileName();
      const userId = ctx.message.fromUserId;
      const sessionKey =
        ctx.message.chatType === "group" && ctx.groupCode
          ? `${userId}:group:${ctx.groupCode}`
          : `${userId}:dm`;

      // Cancel sub-command
      if (ctx.args[0]?.toLowerCase() === "cancel") {
        wizardSessions.delete(sessionKey);
        await ctx.reply("✅ 配置向导已取消");
        return;
      }

      // If args provided, treat as direct field-set (non-interactive)
      const field = ctx.args[0]?.toLowerCase();
      const value = ctx.args.slice(1).join(" ").trim();
      if (
        field &&
        value &&
        field !== "appkey" &&
        field !== "appsecret" &&
        field !== "token" &&
        field !== "app-key" &&
        field !== "app-secret"
      ) {
        await ctx.reply(
          `❌ 无效字段: ${field}\n支持: appkey, appsecret, token`,
        );
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
              `配置完成。发送 /daemon restart 让新配置生效`,
          );
        }
        return;
      }

      // Start interactive wizard
      wizardSessions.set(sessionKey, {
        step: "auth-method",
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
