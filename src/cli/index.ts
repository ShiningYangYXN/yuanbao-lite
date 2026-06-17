#!/usr/bin/env node
/**
 * Yuanbao Lite CLI (new) — daemon-first entry point.
 *
 * Routing rules:
 *   - `daemon start`            → spawn daemon in-process and block
 *   - `daemon stop`             → POST /shutdown to running daemon
 *   - `daemon status`           → GET /health
 *   - `interactive` / `repl`    → ensure daemon, then REPL
 *   - (no args)                 → same as `interactive`
 *   - any other subcommand      → ensure daemon, then Commander
 *
 * "Ensure daemon" means: ping /health; if no response, spawn a detached
 * daemon child process and wait up to 30s for it to become ready.
 *
 * Business logic (command handlers, bot lifecycle, stores) lives in:
 *   - src/commands/registry.ts   (CommandSystem — used by daemon /command)
 *   - src/cli/config.ts          (ConfigStore — shared config singleton)
 *   - src/index.ts               (YuanbaoBot — held by daemon)
 *
 * This file contains zero business logic.
 */

import chalk from "chalk";
import { runDaemon } from "./daemon/server.js";
import { buildProgram, registerDynamicCommands } from "./client/commands.js";
import { runInteractive } from "./client/interactive.js";
import { getVersion } from "../version.js";
import {
  getDefaultClient,
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
} from "./client/daemon-client.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── `daemon start` runs the server in-process ───
  if (args[0] === "daemon" && (args[1] === "start" || args[1] === "run")) {
    const portMatch = args.findIndex((a) => a === "--port" || a === "-p");
    const port =
      portMatch >= 0 && args[portMatch + 1] ? parseInt(args[portMatch + 1], 10) : DEFAULT_DAEMON_PORT;
    const hostMatch = args.findIndex((a) => a === "--host");
    const host = hostMatch >= 0 && args[hostMatch + 1] ? args[hostMatch + 1] : DEFAULT_DAEMON_HOST;

    console.log(chalk.dim(`\n🦾 Yuanbao Lite Daemon v${getVersion()}`));
    await runDaemon({ port, host });
    return;
  }

  // ─── `daemon stop` — POST /shutdown ───
  if (args[0] === "daemon" && args[1] === "stop") {
    const client = getDefaultClient();
    const info = await client.ping();
    if (!info) {
      console.log(chalk.yellow("daemon 未在运行"));
      process.exit(0);
    }
    await client.shutdown();
    console.log(chalk.green(`✓ 已发送关闭指令 (pid=${info.pid})`));
    process.exit(0);
  }

  // ─── `daemon restart` — spawn fresh daemon (kills old via PID file) ───
  if (args[0] === "daemon" && args[1] === "restart") {
    const client = getDefaultClient();
    const oldInfo = await client.ping();
    if (!oldInfo) {
      // No daemon running — just start one fresh
      console.log(chalk.yellow("daemon 未在运行，直接启动新 daemon..."));
      const info = await client.ensureDaemon({});
      console.log(chalk.green(`✓ daemon 已启动 (pid=${info.pid})`));
      process.exit(0);
    }
    console.log(chalk.dim(`重启 daemon (旧 pid=${oldInfo.pid})...`));
    try {
      const newInfo = await client.restart();
      console.log(chalk.green(`✓ daemon 已重启 (新 pid=${newInfo.pid})`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`✗ 重启失败: ${(err as Error).message}`));
      process.exit(1);
    }
  }

  // ─── `daemon status` — GET /health ───
  if (args[0] === "daemon" && args[1] === "status") {
    const client = getDefaultClient();
    const info = await client.ping();
    if (!info) {
      console.log(chalk.yellow("daemon 未在运行"));
      process.exit(1);
    }
    console.log(chalk.cyan(`\n📊 daemon 运行中`));
    console.log(`  PID:     ${info.pid}`);
    console.log(`  版本:    ${info.version}`);
    console.log(`  端口:    ${info.port}`);
    console.log(`  地址:    ${info.host}`);
    console.log(`  运行:    ${info.uptime}s`);
    console.log(`  Bot:     ${info.bot?.connected ? chalk.green("✓ 已连接") : chalk.red("✗ 未连接")}`);
    if (info.bot?.botId) console.log(`  Bot ID:  ${info.bot.botId}`);
    console.log();
    process.exit(0);
  }

  // ─── Build the Commander program ───
  const program = buildProgram();

  // Register `interactive` / `repl` as a Commander subcommand (default).
  // `daemon` start/stop/status fast paths are handled above before we get here.
  program
    .command("interactive", { isDefault: true })
    .alias("repl")
    .description("启动交互式 REPL (默认)")
    .action(async () => {
      await runInteractive();
    });

  // Dynamically register commands from the daemon's CommandSystem registry.
  // This makes every / slash command available as a CLI subcommand, sharing
  // the exact same handler code. Skipped if daemon is not available.
  // Only do this for non-interactive invocations (when args are present).
  if (args.length > 0 && args[0] !== "interactive" && args[0] !== "repl" && !(args[0] === "daemon" && (args[1] === "start" || args[1] === "stop" || args[1] === "restart" || args[1] === "status"))) {
    await registerDynamicCommands(program);
  }

  await program.parseAsync(args, { from: "user" });
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
