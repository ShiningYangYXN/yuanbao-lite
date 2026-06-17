/**
 * Daemon mode — runs the bot in the background, listens for messages,
 * optionally sends messages via HTTP or IPC.
 *
 * No interactive REPL. Just connects, stays alive, processes incoming
 * messages, and exposes a health check endpoint.
 */

import { createServer, type Server } from "node:http";
import chalk from "chalk";
import { YuanbaoBot } from "../index.js";
import { getVersion } from "../version.js";
import { createLog, setLogLevel } from "../logger.js";
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

  async start(): Promise<void> {
    setLogLevel(this.healthCheck ? "info" : "warn");

    const { profile, globalConfig } = loadConfig({});
    const logLevel = (profile.logLevel ?? (globalConfig.logLevel as string) ?? "info") as "debug" | "info" | "warn" | "error";
    setLogLevel(logLevel);

    const config: Record<string, unknown> = {
      appKey: profile.appKey,
      appSecret: profile.appSecret,
      token: profile.token,
      apiDomain: profile.apiDomain,
      wsUrl: profile.wsUrl,
      logLevel,
    };

    this.bot = new YuanbaoBot(config);

    this.bot.on("ready", () => {
      this.log.info(`✅ 已连接 (v${getVersion()})`);
      this.printStartupInfo();
    });

    this.bot.on("directMessage", (msg) => {
      this.log.info(`[私聊] ${msg.fromNickname || msg.fromUserId}: ${msg.text}`);
    });

    this.bot.on("groupMessage", (msg) => {
      this.log.info(`[${msg.groupName || msg.groupCode}] ${msg.fromNickname || msg.fromUserId}: ${msg.text}`);
    });

    this.bot.on("error", (err) => {
      this.log.error(`❌ 错误: ${err.message}`);
    });

    await this.bot.start();

    if (!this.bot.getState().connected) {
      this.log.error("连接失败，退出守护进程");
      process.exit(1);
    }

    if (this.healthCheck) {
      await this.startHttpServer();
    }

    this.setupSignalHandlers();
  }

  async stop(): Promise<void> {
    this.log.info("正在停止守护进程...");

    if (this.httpServer) this.httpServer.close();
    if (this.bot) this.bot.stop();

    this.log.info("守护进程已停止");
    process.exit(0);
  }

  private async startHttpServer(): Promise<void> {
    this.httpServer = createServer((_req, res) => {
      const st = this.bot?.getState() ?? { connected: false, status: "offline" as const, botId: undefined as string | undefined };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        healthy: st.connected,
        status: st.status,
        version: getVersion(),
        connected: st.connected,
        botId: st.botId,
        uptime: process.uptime(),
      }));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, () => {
        this.log.info(`📡 健康检查: http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  private setupSignalHandlers(): void {
    const handle = async (signal: string) => {
      this.log.info(`收到 ${signal}，正在关闭...`);
      await this.stop();
    };
    process.on("SIGINT", () => handle("SIGINT"));
    process.on("SIGTERM", () => handle("SIGTERM"));
  }

  private printStartupInfo(): void {
    console.log("");
    console.log(chalk.rgb(100, 180, 255).bold("  Yuanbao Lite Daemon"));
    console.log(chalk.dim(`  版本   ${getVersion()}`));
    console.log(chalk.dim(`  模式   守护进程 (后台运行)`));
    console.log(chalk.dim(`  端口   ${this.port}`));
    console.log(chalk.dim(`  信号   SIGINT / SIGTERM 退出`));
    console.log("");
  }
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const daemon = new Daemon(options);
  await daemon.start();
}
