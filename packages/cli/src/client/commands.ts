/**
 * Non-interactive CLI — Commander program.
 *
 * Every subcommand is a thin wrapper around `DaemonClient`. The daemon owns
 * the bot, so each invocation is a single HTTP round-trip — no WebSocket
 * reconnect per command.
 *
 * Subcommand surface mirrors the old `yb-cli` (src/cli/non-interactive.ts):
 *   send dm / send group      (with --mention)
 *   status
 *   upload
 *   download
 *   config init / show / set / profile list|switch|add|remove
 *   contacts list / add / remove / dm
 *
 * Plus daemon management:
 *   daemon start / stop / status
 *
 * IMPORTANT: `config` is registered STATICALLY (not via registerDynamicCommands)
 * because users need to run `yb-cli config init` BEFORE the daemon can start
 * (the daemon requires credentials). If config were dynamic, the daemon
 * wouldn't be running yet, and Commander would fall back to the default
 * `interactive` command, producing "too many arguments for 'interactive'".
 */

import { Command } from "commander";
import chalk from "chalk";
import { getVersion } from "@yuanbao-lite/core/version";
import { interpolate } from "@yuanbao-lite/core/business/interpolate";
import {
  DaemonClient,
  getDefaultClient,
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  type DaemonInfo,
} from "@yuanbao-lite/core/access/daemon/client";
import { runInitWizard } from "./wizard.js";
import { getGlobalConfigStore } from "../config.js";
import { COLORS, printH1, printKV, printResult, printError, printWarn } from "../theme.js";

// ─── Top-level program ───

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("yb-cli")
    .description("Yuanbao Lite — 现代化 CLI (daemon-first)")
    .version(getVersion())
    .option("--profile <name>", "使用指定配置档案", "default")
    .option("--config <path>", "配置文件所在目录")
    .option("--port <number>", "daemon 端口", String(DEFAULT_DAEMON_PORT))
    .option("--host <addr>", "daemon 监听地址", DEFAULT_DAEMON_HOST)
    .option("--no-daemon", "本次不尝试连接/启动 daemon (仅 config 子命令)");

  // ─── send ───
  program
    .command("send")
    .description("发送消息")
    .addCommand(
      new Command("dm")
        .description("发送私聊消息")
        .argument("<userId>", "目标用户 ID")
        .argument("<message>", "消息内容 (支持 ${} 插值)")
        .option("--mention <text>", "附带 @提及 (仅 cloud_custom_data)")
        .action(async (userId: string, message: string, opts: Record<string, unknown>) => {
          const client = await ensureClient(program);
          const processed = interpolate(message);
          await client.sendDm(userId, processed);
          printResult(`已发送私聊给 ${chalk.bold(userId)} (${processed.length} 字)`);
          if (opts.mention) {
            printWarn(`提及文本: ${opts.mention} (由 CommandSystem 处理)`);
          }
        }),
    )
    .addCommand(
      new Command("group")
        .description("发送群聊消息")
        .argument("<groupCode>", "目标群号")
        .argument("<message>", "消息内容 (支持 ${} 插值)")
        .option("--mention <text>", "附带 @提及 (仅 cloud_custom_data)")
        .action(async (groupCode: string, message: string, opts: Record<string, unknown>) => {
          const client = await ensureClient(program);
          const processed = interpolate(message);
          await client.sendGroup(groupCode, processed);
          printResult(`已发送群聊到 ${chalk.bold(groupCode)} (${processed.length} 字)`);
          if (opts.mention) {
            printWarn(`提及文本: ${opts.mention} (由 CommandSystem 处理)`);
          }
        }),
    );

  // ─── daemon ───
  // (upload, download, config, contacts are now dynamically registered
  //  from the Registry — no need for static duplication)
  program
    .command("daemon")
    .description("daemon 进程管理")
    .addCommand(
      new Command("start")
        .description("启动 daemon (后台运行)")
        .option("--port <number>", "HTTP 端口", String(DEFAULT_DAEMON_PORT))
        .option("--host <addr>", "监听地址", DEFAULT_DAEMON_HOST)
        .action(async (opts: Record<string, string>) => {
          const port = parseInt(opts.port, 10);
          const client = new DaemonClient(port, opts.host);
          const info = await client.ensureDaemon({ port });
          printResult(`daemon 已就绪 (pid=${info.pid}, port=${port})`);
        }),
    )
    .addCommand(
      new Command("stop")
        .description("停止 daemon")
        .action(async () => {
          const client = await ensureClient(program);
          await client.shutdown();
          printResult("已发送关闭指令");
        }),
    )
    .addCommand(
      new Command("status")
        .description("查看 daemon 状态")
        .action(async () => {
          const client = getDefaultClient(getProgramPort(program), getProgramHost(program));
          const info = await client.ping();
          if (!info) {
            printError("daemon 未运行");
            process.exit(1);
          }
          printDaemonInfo(info);
        }),
    );

  // ─── config (static — must work without daemon) ───
  // Registered statically because `yb-cli config init` must work BEFORE the
  // daemon can start (the daemon requires credentials). All other config
  // subcommands (show/set/get/profile) also operate directly on the shared
  // ConfigStore file, so they don't need the daemon either.
  program
    .command("config")
    .description("配置管理 (查看/设置/初始化/档案)")
    .addCommand(
      new Command("init")
        .description("交互式配置向导 (首次使用必填)")
        .action(async () => {
          await runInitWizard();
        }),
    )
    .addCommand(
      new Command("show")
        .description("显示当前配置")
        .action(async () => {
          const store = getGlobalConfigStore({ autoSave: true });
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
          console.log(lines.join("\n"));
        }),
    )
    .addCommand(
      new Command("get")
        .description("获取配置项")
        .argument("<key>", "配置键名")
        .action(async (key: string) => {
          const store = getGlobalConfigStore({ autoSave: true });
          const value = store.get(key as keyof import("@yuanbao-lite/core/shared/config").CliProfile);
          if (value === undefined) {
            printWarn(`配置项 ${key} 未设置`);
            return;
          }
          if (typeof value === "string" && (key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey")) {
            console.log(`${key} = ***${value.slice(-4)}`);
          } else {
            console.log(`${key} = ${String(value)}`);
          }
        }),
    )
    .addCommand(
      new Command("set")
        .description("设置配置项")
        .argument("<key>", "配置键名")
        .argument("<value>", "配置值")
        .action(async (key: string, value: string) => {
          const store = getGlobalConfigStore({ autoSave: true });
          const validKeys = [
            "appKey", "appSecret", "token", "apiDomain", "wsUrl",
            "logLevel", "stickerDir", "downloadDir", "prompt",
            "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel",
            "llmSystemPrompt", "llmEnabled", "defaultTarget", "defaultChatMode",
          ];
          if (!validKeys.includes(key)) {
            printError(`无效配置键: ${key}\n可选: ${validKeys.join(", ")}`);
            process.exit(1);
          }
          store.set(key as never, value as never);
          const masked = (key === "appKey" || key === "appSecret" || key === "token" || key === "llmApiKey") ? "***" : value;
          printResult(`已设置 ${key} = ${masked}`);
          printWarn("提示: 如需让新配置生效，请重启 daemon (yb-cli daemon restart)");
        }),
    )
    .addCommand(
      new Command("profile")
        .description("配置档案管理")
        .addCommand(
          new Command("list")
            .description("列出所有档案")
            .action(async () => {
              const store = getGlobalConfigStore({ autoSave: true });
              const active = store.getActiveProfileName();
              const names = store.getProfileNames();
              if (names.length === 0) {
                printWarn("无配置档案。运行 yb-cli config init 创建。");
                return;
              }
              const lines = names.map(n => `  ${n === active ? "▶" : " "} ${n}`);
              console.log(`📋 配置档案 (共 ${names.length} 个):\n${lines.join("\n")}`);
            }),
        )
        .addCommand(
          new Command("switch")
            .description("切换激活档案")
            .argument("<name>", "档案名称")
            .action(async (name: string) => {
              const store = getGlobalConfigStore({ autoSave: true });
              if (!store.getProfile(name)) {
                printError(`档案不存在: ${name}`);
                process.exit(1);
              }
              store.switchProfile(name);
              printResult(`已切换到档案: ${name}`);
              printWarn("提示: 请重启 daemon 让新档案生效 (yb-cli daemon restart)");
            }),
        )
        .addCommand(
          new Command("add")
            .description("添加新档案")
            .argument("<name>", "档案名称")
            .action(async (name: string) => {
              const store = getGlobalConfigStore({ autoSave: true });
              if (store.getProfile(name)) {
                printError(`档案已存在: ${name}`);
                process.exit(1);
              }
              store.createProfile(name, { name });
              printResult(`已创建档案: ${name} (空配置，请用 yb-cli config set 设置 appKey/appSecret)`);
            }),
        )
        .addCommand(
          new Command("remove")
            .description("删除档案")
            .argument("<name>", "档案名称")
            .action(async (name: string) => {
              const store = getGlobalConfigStore({ autoSave: true });
              if (!store.getProfile(name)) {
                printError(`档案不存在: ${name}`);
                process.exit(1);
              }
              if (name === store.getActiveProfileName()) {
                printError(`不能删除当前激活的档案: ${name} (先 switch 到其他档案)`);
                process.exit(1);
              }
              store.deleteProfile(name);
              printResult(`已删除档案: ${name}`);
            }),
        ),
    );

  // ─── Dynamic commands from Registry ───
  // Register a special "rc" (run-command) subcommand that delegates to the
  // daemon's /command endpoint. Also register each registry command as a
  // top-level alias for convenience.
  //
  // Usage:  yb-cli rc /help        (explicit)
  //         yb-cli help            (dynamic alias, same effect)
  //
  // The dynamic aliases are fetched lazily on first invocation to avoid
  // blocking program construction on a daemon round-trip.

  program
    .command("rc <command...>")
    .description("通过 daemon 执行任意 / 斜杠命令 (共享 CommandSystem)")
    .allowUnknownOption(true)
    .action(async (cmdParts: string[]) => {
      const client = await ensureClient(program);
      const fullCmd = cmdParts.join(" ");
      const text = fullCmd.startsWith("/") ? fullCmd : `/${fullCmd}`;
      const result = await client.runCommand(text, { source: "cli" });
      if (!result.ok) {
        printError(`命令执行失败: ${result.error ?? "unknown"}`);
        return;
      }
      if (!result.handled) {
        printWarn(`未知命令: ${text}`);
        return;
      }
      for (const reply of result.replies) {
        console.log(reply);
      }
    });

  return program;
}

/**
 * Fetch commands from the daemon's CommandSystem registry and register them
 * as top-level Commander subcommands. Each dynamically-registered command
 * delegates to `rc` (which calls the daemon's /command endpoint).
 *
 * This is called lazily (after ensureDaemon) so that the registry is
 * available. Falls back gracefully if the daemon is not running.
 */
export async function registerDynamicCommands(program: Command): Promise<void> {
  let commands: Array<{
    name: string;
    aliases: string[];
    description: string;
    usage: string;
    category: string;
    dmOnly: boolean;
    requireConnected: boolean;
    hidden: boolean;
  }>;
  try {
    const client = getDefaultClient(
      getProgramPort(program),
      getProgramHost(program),
    );
    await client.ensureDaemon({});
    commands = await client.fetchCommands();
  } catch {
    // Daemon not available — skip dynamic registration
    return;
  }

  // Commands that are already statically registered (avoid duplicates)
  const existingNames = new Set<string>();
  program.commands.forEach(c => existingNames.add(c.name()));

  for (const cmd of commands) {
    if (cmd.hidden) continue;
    if (existingNames.has(cmd.name)) continue;

    // Build a dynamic command that passes all args through to the daemon
    const dynamicCmd = new Command(cmd.name)
      .description(cmd.description)
      .allowUnknownOption(true)
      .argument("[args...]", "命令参数")
      .action(async (args: string[] | undefined) => {
        const client = getDefaultClient(
          getProgramPort(program),
          getProgramHost(program),
        );
        const fullCmd = args && args.length > 0 ? `${cmd.name} ${args.join(" ")}` : cmd.name;
        const result = await client.runCommand(`/${fullCmd}`, { source: "cli" });
        if (!result.ok) {
          printError(`命令执行失败: ${result.error ?? "unknown"}`);
          return;
        }
        if (!result.handled) {
          printWarn(`未知命令: /${cmd.name}`);
          return;
        }
        for (const reply of result.replies) {
          console.log(reply);
        }
      });

    // Add aliases if they don't conflict
    for (const alias of cmd.aliases) {
      if (!existingNames.has(alias)) {
        try {
          dynamicCmd.alias(alias);
        } catch {
          // alias conflict — skip
        }
      }
    }

    try {
      program.addCommand(dynamicCmd);
      existingNames.add(cmd.name);
    } catch {
      // command name conflict — skip
    }
  }
}

// ─── Helpers ───

function getProgramPort(program: Command): number {
  const opts = program.opts();
  return parseInt(String(opts.port ?? DEFAULT_DAEMON_PORT), 10);
}

function getProgramHost(program: Command): string {
  const opts = program.opts();
  return String(opts.host ?? DEFAULT_DAEMON_HOST);
}

async function ensureClient(program: Command): Promise<DaemonClient> {
  const opts = program.opts();
  if (opts.daemon === false) {
    printError("--no-daemon 模式下此命令不可用");
    process.exit(1);
  }
  const port = parseInt(String(opts.port ?? DEFAULT_DAEMON_PORT), 10);
  const host = String(opts.host ?? DEFAULT_DAEMON_HOST);
  const client = getDefaultClient(port, host);
  try {
    await client.ensureDaemon({ port });
  } catch (err) {
    printError(`无法连接/启动 daemon: ${(err as Error).message}`);
    process.exit(1);
  }
  return client;
}

function printDaemonInfo(info: DaemonInfo): void {
  printH1("Yuanbao Lite Daemon");
  printKV([
    ["PID", String(info.pid)],
    ["版本", info.version],
    ["端口", String(info.port)],
    ["地址", info.host],
    ["运行时长", formatUptime(info.uptime)],
    ["Bot状态", info.bot?.status ?? "(未连接)"],
    ["Bot ID", info.bot?.botId ?? "(未设置)"],
    ["已连接", info.bot?.connected ? COLORS.success("是") : COLORS.error("否")],
  ]);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
