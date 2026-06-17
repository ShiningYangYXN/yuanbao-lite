/**
 * Daemon mode — runs the bot in the background, listens for messages,
 * optionally sends messages via HTTP or IPC.
 *
 * No interactive REPL. Just connects, stays alive, processes incoming
 * messages, and exposes a health check endpoint.
 */

import { createServer, Server } from "node:http";
import chalk from "chalk";
import { YuanbaoBot } from "../../index.js";
import { getVersion } from "../../version.js";
import { createLog, setLogLevel } from "../../logger.js";
import { loadConfig } from "./config-loader.js";

type DaemonOptions = {
  port?: number;
  healthCheck?: boolean;
  logLevel?: string;
};

export class Daemon {
  private bot: YuanbaoBot | null = null;
  private httpServer: Server | null = null;
  private log = createLog("daemon");
  private port: number;
  private healthCheck: boolean;

  constructor(options: DaemonOptions = {}) {
    this.port = options.port ?? 9090;
    this.healthCheck = options.healthCheck ?? true;
  }

  /**
   * Start the daemon: connect bot + optionally start HTTP server.
   */
  async start(): Promise<void> {
    setLogLevel(this.healthCheck ? "info" : "warn");

    const { profile, globalConfig } = loadConfig({});
    const logLevel = profile.logLevel ?? (globalConfig.logLevel as string) ?? "info";
    setLogLevel(logLevel as "debug" | "info" | "warn" | "error");

    // Create and start the bot
    const config: Record<string, unknown> = {
      appKey: profile.appKey,
      appSecret: profile.appSecret,
      token: profile.token,
      apiDomain: profile.apiDomain,
      wsUrl: profile.wsUrl,
      logLevel,
    };

    this.bot = new YuanbaoBot(config);

    // Set up handlers
    this.bot.on("ready", () => {
      this.log.info(`✅ 已连接 (v${getVersion()})`);
      this.printStartupBanner();
    });

    this.bot.on("directMessage", (msg) => {
      this.log.info(
        `[私聊] ${msg.fromNickname || msg.fromUserId}: ${msg.text}`,
      );
    });

    this.bot.on("groupMessage", (msg) => {
      this.log.info(
        `[${msg.groupName || msg.groupCode}] ${msg.fromNickname || msg.fromUserId}: ${msg.text}`,
      );
    });

    this.bot.on("error", (err) => {
      this.log.error(`❌ 错误: ${err.message}`);
    });

    // Start bot
    await this.bot.start();

    if (!this.bot.getState().connected) {
      this.log.error("连接失败，退出守护进程");
      process.exit(1);
    }

    // Optionally start HTTP server for health check
    if (this.healthCheck) {
      await this.startHttpServer();
    }

    // Graceful shutdown
    this.setupSignalHandlers();
  }

  /**
   * Stop the daemon.
   */
  async stop(): Promise<void> {
    this.log.info("正在停止守护进程...");

    if (this.httpServer) {
      this.httpServer.close();
    }

    if (this.bot) {
      this.bot.stop();
    }

    this.log.info("守护进程已停止");
    process.exit(0);
  }

  /**
   * Start a lightweight HTTP server for health checks.
   */
  private async startHttpServer(): Promise<void> {
    this.httpServer = createServer((_req, res) => {
      const state = this.bot?.getState() ?? { connected: false, status: "offline" };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          healthy: state.connected,
          status: state.status,
          version: getVersion(),
          connected: state.connected,
          botId: state.botId,
          uptime: process.uptime(),
        }),
      );
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, () => {
        this.log.info(`📡 健康检查端点: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  private setupSignalHandlers(): void {
    const handleShutdown = async (signal: string) => {
      this.log.info(`收到 ${signal}，正在关闭...`);
      await this.stop();
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private printStartupBanner(): void {
    console.log("");
    console.log(chalk.cyan.bold("  ╔═══════════════════════════════════════╗"));
    console.log(chalk.cyan.bold("  ║") + chalk.bold(" 🤖 Yuanbao Lite Daemon ") + chalk.cyan.bold("║"));
    console.log(chalk.cyan.bold("  ║") + ` v${getVersion()}` + " ".repeat(31 - getVersion().length) + chalk.cyan.bold("║"));
    console.log(chalk.cyan.bold("  ║") + " 模式: 守护进程 (daemon)" + " ".repeat(15) + chalk.cyan.bold("║"));
    console.log(chalk.cyan.bold("  ║") + ` 端口: ${this.port}` + " ".repeat(20) + chalk.cyan.bold("║"));
    console.log(chalk.cyan.bold("  ║") + " Ctrl+C 退出" + " ".repeat(28) + chalk.cyan.bold("║"));
    console.log(chalk.cyan.bold("  ╚═══════════════════════════════════════╝"));
    console.log("");
  }
}

/**
 * Run daemon mode from CLI.
 */
export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon(options);
  await daemon.start();
}
