/**
 * Interactive CLI — the main REPL loop using Clack prompts.
 *
 * Replaces the hand-written readline REPL from src/cli/index.ts.
 *
 * Command definitions are shared via src/commands/registry.ts (CommandSystem).
 * No command handlers are duplicated.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { YuanbaoBot } from "../../index.js";
import { CommandSystem } from "../../commands/registry.js";
import { getVersion } from "../../version.js";
import { createLog } from "../../logger.js";
import {
  loadConfig,
  printWelcome,
  printStatus,
  printResult,
  printError,
  printSection,
  printBlock,
} from "./index.js";
import type { CliProfile } from "../../cli/config.js";

// ─── State ───

interface CliState {
  chatMode: "none" | "dm" | "group";
  chatTarget: string;
  history: string[];
  historyIndex: number;
}

const STATE: CliState = {
  chatMode: "none",
  chatTarget: "",
  history: [],
  historyIndex: -1,
};

// ─── Helpers ───

function getToken(promptText: string): string {
  // Simple token format: appId:secret or just the secret
  return promptText.trim();
}

function getProfileConfig(
  store: ReturnType<typeof getProfileStore>,
): { profile: CliProfile; globalConfig: Record<string, unknown> } {
  const active = store.getActiveProfileName();
  const profile = store.getProfile(active)!;
  return { profile, globalConfig: store.getData().global ?? {} };
}

function getProfileStore() {
  // Lazy load to avoid circular deps
  const { getGlobalConfigStore } = require("../../cli/config.js");
  return getGlobalConfigStore();
}

function showAvailableCommands(bot: YuanbaoBot): void {
  const cmdSys = bot.getCommandSystem();
  if (!cmdSys) {
    printError("未注册命令系统");
    return;
  }

  const defs = cmdSys.getDefinitions?.() || [];
  const categories = new Map<string, typeof defs>();

  for (const def of defs) {
    const cat = def.category || "其他";
    if (!categories.has(cat)) categories.set(cat, []);
    categories.get(cat)!.push(def);
  }

  // Use Table library to render
  const Table = require("table");

  const rows: string[][] = [];
  const sectionSeparator = chalk.dim("  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─");

  for (const [cat, cmds] of categories.entries()) {
    printSection(cat);
    for (const def of cmds) {
      const line = `  ${chalk.cyan.bold(`/ ${def.name}`)}${def.aliases?.length ? chalk.dim(` (${def.aliases.join(", ")})`) : ""}  ${chalk.dim(def.description)}`;
      console.log(line);
    }
    console.log(sectionSeparator);
  }
}

// ─── Interactive Prompts ───

async function promptLogin(
  bot: YuanbaoBot,
): Promise<boolean> {
  p.intro(chalk.cyan("🤖 Yuanbao Lite CLI"));
  p.outro(chalk.dim("需要认证才能登录"));

  const appKey = await p.text({
    message: "App Key:",
    placeholder: "",
  });

  if (p.isCancel(appKey)) return false;

  const appSecret = await p.text({
    message: "App Secret:",
    placeholder: "",
  });

  if (p.isCancel(appSecret)) return false;

  // Store the credentials in the profile store for reuse
  const store = getProfileStore();
  const name = await p.text({
    message: "配置名称 (回车使用 default):",
    placeholder: "default",
  });

  if (p.isCancel(name)) return false;

  store.applySetupAnswers({
    appKey,
    appSecret,
    name: name || "default",
  });

  // Also update the bot config directly for immediate use
  const configDir = store.getConfigDir();
  // Save immediately
  store.save();

  return true;
}

// ─── Interactive Loop ───

async function interactiveLoop(
  bot: YuanbaoBot,
  profile: CliProfile,
  globalConfig: Record<string, unknown>,
): Promise<void> {
  const cmdSys = new CommandSystem({ prefix: "/" });
  const log = createLog("cli-new");

  printWelcome(getVersion());
  printStatus("连接中...");

  // Set up command handlers via CommandSystem (shared!)
  const commandSystem = bot.getCommandSystem();
  if (commandSystem) {
    commandSystem.register({
      name: "help",
      description: "显示命令帮助",
      category: "misc" as never,
      handler: async (ctx) => {
        // Delegate to default help from CommandSystem
        await commandSystem.dispatch(bot, ctx.message, ctx.reply);
      },
    });
  }

  // Main REPL using Clack's loop
  let running = true;

  while (running) {
    const prompt = (() => {
      if (STATE.chatMode === "dm") return chalk.cyan.bold(`👤 ${STATE.chatTarget}> `);
      if (STATE.chatMode === "group") return chalk.cyan.bold(`👥 ${STATE.chatTarget}> `);
      return chalk.cyan.bold("yuanbao> ");
    })();

    const input = await p.text({
      message: prompt,
      placeholder: "输入 /help 查看命令",
    });

    if (p.isCancel(input)) {
      break;
    }

    const line = (input as string).trim();
    if (!line) continue;

    // History
    STATE.history.push(line);
    STATE.historyIndex = STATE.history.length;

    // Handle /exit
    if (line === "/exit" || line === "/quit" || line === "/q") {
      running = false;
      printStatus("正在退出...");
      continue;
    }

    // Handle /chat
    if (line.startsWith("/chat")) {
      const parts = line.split(/\s+/);
      if (parts.length > 1) {
        if (parts[1] === "group" && parts[2]) {
          STATE.chatMode = "group";
          STATE.chatTarget = parts[2];
          printStatus(`切换到群聊模式: ${parts[2]}`);
        } else if (parts[1] !== "group") {
          STATE.chatMode = "dm";
          STATE.chatTarget = parts[1];
          printStatus(`切换到私聊模式: ${parts[1]}`);
        } else {
          STATE.chatMode = "none";
          STATE.chatTarget = "";
          printStatus("已退出聊天模式");
        }
      } else {
        printStatus("用法: /chat [dm|group <id>] (留空退出)");
      }
      continue;
    }

    // Handle /groups, /contacts, /config etc. via Clack menus
    if (line.startsWith("/")) {
      // Delegate to CommandSystem dispatch
      const msg = {
        id: `cli-${Date.now()}`,
        fromUserId: "cli",
        chatType: "direct",
        text: line,
        timestamp: Date.now(),
        rawBody: null,
        elements: [],
        extFields: {},
      };

      const replies: string[] = [];
      const mockCtx = {
        bot,
        message: msg,
        command: line.split(/\s+/)[0]?.slice(1) || "",
        args: line.split(/\s+/).slice(1),
        reply: async (text: string) => {
          replies.push(text);
          printResult(text);
        },
        replyRaw: async () => { },
        replyDirect: async () => { },
        isGroup: false,
        showAll: false,
      };

      // Try to execute via CommandSystem
      try {
        await commandSystem.dispatch(bot, msg, mockCtx.reply);
      } catch (err) {
        printError(`命令执行失败: ${(err as Error).message}`);
      }
      continue;
    }

    // Normal message → send as chat
    if (STATE.chatMode !== "none" && bot.getState().connected) {
      try {
        const target = STATE.chatTarget;
        if (STATE.chatMode === "dm") {
          await bot.sendDirectMessage(target, line);
          printResult(`已发送给 ${target}`);
        } else {
          await bot.sendGroupMessage(target, line);
          printResult(`已发送到群 ${target}`);
        }
      } catch (err) {
        printError(`发送失败: ${(err as Error).message}`);
      }
      continue;
    }

    printError("未连接聊天目标，使用 /chat <id> 或 /chat group <groupCode> 进入聊天模式");
  }

  printStatus("再见 👋");
  bot.stop();
}

// ─── Main Entry Point ───

export async function runInteractive(
  options?: {
    configPath?: string;
    profile?: string;
  },
): Promise<void> {
  try {
    const { profile, globalConfig } = loadConfig(options ?? {});

    // Create bot
    const botConfig: Record<string, unknown> = {
      appKey: profile.appKey,
      appSecret: profile.appSecret,
      token: profile.token,
      apiDomain: profile.apiDomain,
      wsUrl: profile.wsUrl,
      logLevel: profile.logLevel || "info",
    };

    const bot = new YuanbaoBot(botConfig);

    await bot.start();

    if (!bot.getState().connected) {
      printError("连接失败，请检查配置");
      bot.stop();
      process.exit(1);
    }

    printStatus("已连接");

    await interactiveLoop(bot, profile, globalConfig);
  } catch (err) {
    printError(`启动失败: ${(err as Error).message}`);
    process.exit(1);
  }
}
