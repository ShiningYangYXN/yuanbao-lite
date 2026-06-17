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
 */

import { Command } from "commander";
import chalk from "chalk";
import { getVersion } from "../../version.js";
import { interpolate } from "../../business/interpolate.js";
import {
  DaemonClient,
  getDefaultClient,
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  type DaemonInfo,
} from "./daemon-client.js";
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
