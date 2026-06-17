/**
 * Interactive CLI — REPL loop using Clack prompts.
 *
 * Command definitions are shared via src/commands/registry.ts (CommandSystem).
 * No command handlers are duplicated.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { YuanbaoBot } from "../index.js";
import { getVersion } from "../version.js";
import {
  loadConfig,
  initConfig,
  getProfileNames,
  getProfile,
  getActiveProfileName,
  switchProfile,
  createProfile,
  deleteProfile,
  setConfigKey,
} from "./config-loader.js";
import {
  printWelcome,
  printStatus,
  printResult,
  printError,
  printWarn,
  printSection,
  printPair,
} from "./render.js";
import Table from "table";

// ─── State ───

const state = { chatMode: "none" as "none" | "dm" | "group", chatTarget: "" };

// ─── Table renderer (no borders) ───

function renderList(header: string[], rows: string[][]): string {

  const t: Record<string, unknown> = {
    columns: {},
    border: Table.getBorderCharacters("none"),
    drawHorizontal: () => false,
    drawVertical: () => false,
  };
  return Table.table([header, ...rows], t);
}

// ─── Interactive REPL ───

async function interactiveLoop(bot: YuanbaoBot): Promise<void> {
  printWelcome(getVersion());
  printStatus("连接中...");

  let running = true;

  while (running) {
    const prompt = (() => {
      if (state.chatMode === "dm") return chalk.rgb(100, 220, 180).bold(`👤 ${state.chatTarget}> `);
      if (state.chatMode === "group") return chalk.rgb(180, 140, 255).bold(`👥 ${state.chatTarget}> `);
      return chalk.rgb(100, 180, 255).bold("yuanbao> ");
    })();

    const input = await p.text({
      message: prompt,
      placeholder: "输入 /help 查看命令",
    });

    if (p.isCancel(input)) break;

    const line = (input as string).trim();
    if (!line) continue;

    // /exit
    if (line === "/exit" || line === "/quit" || line === "/q") {
      running = false;
      printStatus("再见 👋");
      continue;
    }

    // /chat
    if (line.startsWith("/chat")) {
      const parts = line.split(/\s+/);
      if (parts.length > 1) {
        if (parts[1] === "group" && parts[2]) {
          state.chatMode = "group";
          state.chatTarget = parts[2];
          printStatus(`切换到群聊模式: ${parts[2]}`);
        } else if (parts[1] !== "group") {
          state.chatMode = "dm";
          state.chatTarget = parts[1];
          printStatus(`切换到私聊模式: ${parts[1]}`);
        } else {
          state.chatMode = "none";
          state.chatTarget = "";
          printStatus("已退出聊天模式");
        }
      } else {
        printStatus("用法: /chat [dm|group <id>] (留空退出)");
      }
      continue;
    }

    // /config init
    if (line === "/config init") {
      await initConfig();
      continue;
    }

    // /config show
    if (line === "/config show") {
      const gs = loadConfig();
      const pr = gs.profile;
      printSection("配置信息");
      printPair("档案", pr.name || "");
      printPair("App Key", pr.appKey ? `****${pr.appKey.slice(-4)}` : "(未设置)");
      printPair("API域名", pr.apiDomain || "(默认)");
      printPair("日志级别", pr.logLevel || "(默认)");
      continue;
    }

    // /config set <key> <value>
    if (line.startsWith("/config set ")) {
      const parts = line.slice(14).split(/\s+/);
      if (parts.length >= 2) {
        setConfigKey(parts[0], parts[1]);
        printResult(`已设置 ${parts[0]}`);
      } else {
        printWarn("用法: /config set <key> <value>");
      }
      continue;
    }

    // /config profile list
    if (line === "/config profile list") {
      const names = getProfileNames();
      const active = getActiveProfileName();
      const rows = names.map((name: string) => {
        const marker = name === active ? "→" : " ";
        const pr = getProfile(name)!;
        const hasCreds = (pr.appKey && pr.appSecret) || pr.token;
        return [
          chalk.rgb(100, 200, 255)(marker),
          chalk.bold(name),
          hasCreds ? chalk.green("✅") : chalk.red("❌"),
        ];
      });
      console.log(renderList(["", "名称", "凭证"], rows));
      continue;
    }

    // /config profile switch <name>
    if (line.startsWith("/config profile switch ")) {
      const name = line.slice(26);
      if (switchProfile(name)) {
        printResult(`已切换到档案: ${name}`);
      } else {
        printError(`档案不存在: ${name}`);
      }
      continue;
    }

    // /config profile add <name>
    if (line.startsWith("/config profile add ")) {
      const name = line.slice(24);
      createProfile(name, {});
      printResult(`已创建档案: ${name}`);
      continue;
    }

    // /config profile remove <name>
    if (line.startsWith("/config profile remove ")) {
      const name = line.slice(27);
      if (deleteProfile(name)) {
        printResult(`已删除档案: ${name}`);
      } else {
        printError(`无法删除档案: ${name}`);
      }
      continue;
    }

    // /groups list
    if (line === "/groups" || line === "/groups list" || line === "/groups ls") {
      const store = bot.getGroupStore();
      const entries = store.getAll("lastActive");
      if (entries.length === 0) {
        printWarn("暂无收藏群组。使用 /groups add <群号> 添加");
      } else {
        printSection("群组列表");
        const rows = entries.map((g: { name?: string; groupCode: string; favorite?: boolean; unreadCount?: number }) => [
          g.favorite ? chalk.green("⭐") : chalk.dim("  "),
          chalk.bold(g.name || "未知"),
          chalk.dim(g.groupCode),
          g.unreadCount && g.unreadCount > 0 ? chalk.yellow(`${g.unreadCount} unread`) : chalk.dim("0"),
        ]);
        console.log(renderList(["", "名称", "群号", "未读"], rows));
      }
      continue;
    }

    // /contacts list
    if (line === "/contacts" || line === "/contacts list" || line === "/contacts ls") {
      const store = bot.getContactStore() as { getAll: (s?: string) => { id: string; name: string; tag?: string; favorite?: boolean }[] };
      const entries = store.getAll("name");
      if (entries.length === 0) {
        printWarn("暂无联系人。使用 /contacts add <id> <name> 添加");
      } else {
        printSection("联系人列表");
        const rows = entries.map((c: { id: string; name: string; tag?: string; favorite?: boolean }) => [
          c.favorite ? chalk.green("⭐") : chalk.dim("  "),
          chalk.bold(c.name),
          chalk.dim(c.id.length > 30 ? c.id.substring(0, 30) + "..." : c.id),
          c.tag ? chalk.cyan(`[${c.tag}]`) : "",
        ]);
        console.log(renderList(["", "名称", "ID", "标签"], rows));
      }
      continue;
    }

    // /contacts add <id> <name> [tag]
    if (line.startsWith("/contacts add ")) {
      const parts = line.slice(16).split(/\s+/);
      if (parts.length >= 2) {
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const { getGlobalContactStore } = await import("../business/contacts.js");
        const store = getGlobalContactStore({
          persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
          autoSave: true,
        });
        store.add(parts[0], parts[1], parts[2]);
        printResult(`联系人已添加: ${parts[1]}`);
      } else {
        printWarn("用法: /contacts add <id> <name> [tag]");
      }
      continue;
    }

    // Any other /command → delegate to CommandSystem dispatch
    if (line.startsWith("/")) {
      const msg = {
        id: `cli-${Date.now()}`,
        fromUserId: "cli",
        chatType: "direct" as const,
        text: line,
        timestamp: Date.now(),
      };

      const cmdSys = bot.getCommandSystem();
      try {
        await cmdSys!.dispatch(bot, msg, async (text: string) => {
          console.log("");
          console.log(text);
          console.log("");
        });
      } catch (err) {
        printError(`命令执行失败: ${(err as Error).message}`);
      }
      continue;
    }

    // Normal message → send as chat
    if (state.chatMode !== "none" && bot.getState().connected) {
      try {
        const target = state.chatTarget;
        if (state.chatMode === "dm") {
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

  bot.stop();
}

// ─── Main Entry Point ───

export async function runInteractive(): Promise<void> {
  try {
    const { profile, globalConfig } = loadConfig({});

    // Sync to shared config store
    const { ConfigStore, getGlobalConfigStore } = await import("../cli/config.js");
    const store = new ConfigStore({ autoSave: false });

    if (store.exists()) {
      if (profile.appKey && profile.appSecret) {
        store.mergeActiveProfile({ appKey: profile.appKey, appSecret: profile.appSecret });
      }
      if (profile.token) {
        store.mergeActiveProfile({ token: profile.token });
      }
      if (profile.apiDomain) {
        store.mergeActiveProfile({ apiDomain: profile.apiDomain });
      }
      if (profile.wsUrl) {
        store.mergeActiveProfile({ wsUrl: profile.wsUrl });
      }
      if (globalConfig.logLevel) {
        //store.setGlobal("logLevel", globalConfig.logLevel);
      }
      if (globalConfig.downloadDir) {
        //store.setGlobal("downloadDir", globalConfig.downloadDir);
      }
      store.save();
    } else {
      const defaultStore = getGlobalConfigStore({ autoSave: true });
      defaultStore.mergeActiveProfile({
        appKey: profile.appKey,
        appSecret: profile.appSecret,
      });
    }

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
    await interactiveLoop(bot);
  } catch (err) {
    printError(`启动失败: ${(err as Error).message}`);
    process.exit(1);
  }
}
