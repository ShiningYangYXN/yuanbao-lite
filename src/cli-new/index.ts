#!/usr/bin/env node
/**
 * New CLI — unified entry point.
 *
 * Routes between three modes:
 *   1. `interactive` / `repl` — interactive REPL (Clack prompts)
 *   2. `daemon` — background bot with HTTP health check
 *   3. Anything else — delegated to Commander (non-interactive commands)
 *
 * Business logic is shared via:
 *   - src/commands/registry.ts  (CommandSystem)
 *   - src/cli/config.ts         (ConfigStore)
 *   - src/index.ts              (YuanbaoBot)
 */

import chalk from "chalk";
import { runInteractive } from "./interactive.js";
import { runDaemon } from "./daemon.js";
import { buildProgram } from "./non-interactive.js";
import { getVersion } from "../version.js";


async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── Mode routing ───

  // No args or "interactive" subcommand → interactive REPL
  if (args.length === 0 || args[0] === "interactive" || args[0] === "repl") {
    console.log(chalk.dim(`\n🚀 Yuanbao Lite CLI (new) v${getVersion()}`));
    await runInteractive();
    return;
  }

  // "daemon" subcommand → daemon mode
  if (args[0] === "daemon") {
    const portMatch = args.findIndex((a) => a === "--port" || a === "-p");
    const port =
      portMatch >= 0 && args[portMatch + 1]
        ? parseInt(args[portMatch + 1], 10)
        : 9090;

    const hcMatch = args.findIndex((a) => a === "--no-health-check");
    const healthCheck = hcMatch < 0; // true unless explicitly disabled

    console.log(chalk.dim(`\n🦾 Yuanbao Lite Daemon v${getVersion()}`));
    await runDaemon({ port, healthCheck });
    return;
  }

  // Everything else → Commander subcommands
  const program = buildProgram();

  program
    .command("interactive", { isDefault: true })
    .alias("repl")
    .description("启动交互式模式 (默认)")
    .action(async () => {
      await runInteractive();
    });

  program
    .command("daemon")
    .description("启动守护进程模式")
    .option("-p, --port <number>", "HTTP 端口", "9090")
    .option("--no-health-check", "禁用健康检查端点")
    .action(async (opts: Record<string, unknown>) => {
      await runDaemon({
        port: parseInt(opts.port as string, 10),
        healthCheck: opts.healthCheck !== false,
      });
    });

  await program.parseAsync(args, { from: "user" });
}

main().catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
