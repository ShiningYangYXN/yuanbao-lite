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
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getVersion } from "../../version.js";
import { interpolate } from "../../business/interpolate.js";
import { getGlobalContactStore } from "../../business/contacts.js";
import {
  getGlobalConfigStore,
  type CliProfile,
} from "../config.js";
import {
  DaemonClient,
  getDefaultClient,
  DEFAULT_DAEMON_PORT,
  DEFAULT_DAEMON_HOST,
  type DaemonInfo,
} from "./daemon-client.js";
import { COLORS, printH1, printKV, printTable, printResult, printError, printWarn, printStatus, printSection, truncateToWidth } from "../theme.js";

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

  // ─── status ───
  program
    .command("status")
    .description("查看 bot 连接状态")
    .action(async () => {
      const client = await ensureClient(program);
      const info = await client.ping();
      if (!info) {
        printError("daemon 未运行");
        process.exit(1);
      }
      printDaemonInfo(info);
    });

  // ─── upload ───
  program
    .command("upload")
    .description("上传文件到媒体服务器")
    .argument("<filePath>", "本地文件路径")
    .option("--type <type>", "媒体类型 (image|file|video|audio)")
    .action(async (filePath: string, opts: Record<string, unknown>) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        printError(`文件不存在: ${resolved}`);
        process.exit(1);
      }
      const client = await ensureClient(program);
      const result = await client.upload(resolved, opts.type as string | undefined);
      printResult("上传成功");
      printKV([
        ["UUID", result.uuid],
        ["URL", result.url || "(pending)"],
        ["大小", `${result.fileSize} bytes`],
        ["类型", result.mediaType],
        ["文件名", result.fileName],
      ]);
    });

  // ─── download ───
  program
    .command("download")
    .description("下载媒体文件")
    .argument("<url>", "下载 URL")
    .argument("[fileName]", "保存的文件名")
    .option("--dir <directory>", "保存目录")
    .action(async (url: string, fileName: string | undefined, opts: Record<string, unknown>) => {
      const client = await ensureClient(program);
      const dir = typeof opts.dir === "string" ? (opts.dir as string) : undefined;
      const result = await client.download(url, dir, fileName);
      printResult("下载完成");
      printKV([
        ["路径", result.filePath],
        ["大小", `${result.fileSize} bytes`],
        ["类型", result.mediaType],
      ]);
    });

  // ─── config ───
  program
    .command("config")
    .description("配置管理")
    .addCommand(
      new Command("init")
        .description("初始化配置 (交互式向导)")
        .action(async () => {
          const { runInitWizard } = await import("./wizard.js");
          await runInitWizard();
        }),
    )
    .addCommand(
      new Command("show")
        .description("显示当前配置")
        .action(async () => {
          const store = getGlobalConfigStore({ autoSave: true });
          const active = store.getActiveProfileName();
          const pr = store.getProfile(active);
          printH1("当前配置");
          printKV([
            ["档案", active],
            ["App Key", pr?.appKey ? `***${pr.appKey.slice(-4)}` : "(未设置)"],
            ["App Secret", pr?.appSecret ? `***${pr.appSecret.slice(-4)}` : "(未设置)"],
            ["Token", pr?.token ? `***${pr.token.slice(-4)}` : "(未设置)"],
            ["API域名", pr?.apiDomain || "(默认)"],
            ["WS地址", pr?.wsUrl || "(默认)"],
            ["日志级别", pr?.logLevel || "(默认)"],
            ["贴纸目录", pr?.stickerDir || "(未设置)"],
            ["下载目录", pr?.downloadDir || store.getGlobal("downloadDir") || "(默认)"],
            ["LLM供应商", pr?.llmProvider || "(未设置)"],
            ["LLM模型", pr?.llmModel || "(未设置)"],
            ["配置路径", store.getConfigDir()],
          ]);
        }),
    )
    .addCommand(
      new Command("set")
        .description("设置配置项")
        .argument("<key>", "配置键名")
        .argument("<value>", "配置值")
        .action(async (key: string, value: string) => {
          const validKeys: Array<keyof CliProfile> = [
            "name", "appKey", "appSecret", "token", "apiDomain", "wsUrl",
            "logLevel", "stickerDir", "downloadDir", "prompt",
            "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel",
            "llmSystemPrompt", "llmEnabled",
          ];
          if (!validKeys.includes(key as keyof CliProfile)) {
            printError(`无效配置键: ${key}`);
            console.log(COLORS.dim(`可选: ${validKeys.join(", ")}`));
            process.exit(1);
          }
          getGlobalConfigStore({ autoSave: true }).set(key as keyof CliProfile, value);
          printResult(`已设置 ${key}`);
        }),
    )
    .addCommand(
      new Command("profile")
        .description("配置档案管理")
        .addCommand(
          new Command("list")
            .description("列出所有配置档案")
            .action(() => {
              const store = getGlobalConfigStore({ autoSave: true });
              const names = store.getProfileNames();
              const active = store.getActiveProfileName();
              if (names.length === 0) {
                printWarn("暂无配置档案。运行 yb-cli config init 创建");
                return;
              }
              printSection("配置档案");
              printTable(
                [
                  { header: "", width: 2 },
                  { header: "名称", width: 16 },
                  { header: "凭证", width: 6 },
                ],
                names.map((name) => {
                  const p = store.getProfile(name);
                  const hasCreds = p && ((p.appKey && p.appSecret) || p.token);
                  return [
                    name === active ? COLORS.accent("→") : " ",
                    chalk.bold(name),
                    hasCreds ? COLORS.success("✓") : COLORS.error("✗"),
                  ];
                }),
              );
            }),
        )
        .addCommand(
          new Command("switch")
            .description("切换活跃配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              const store = getGlobalConfigStore({ autoSave: true });
              if (store.switchProfile(name)) {
                printResult(`已切换到档案: ${name}`);
                printWarn("如需让 daemon 应用新配置，请重启 daemon");
              } else {
                printError(`档案不存在: ${name}`);
                process.exit(1);
              }
            }),
        )
        .addCommand(
          new Command("add")
            .description("添加配置档案")
            .argument("<name>", "档案名称")
            .option("--app-key <key>", "App Key")
            .option("--app-secret <secret>", "App Secret")
            .option("--token <token>", "Token")
            .action((name: string, opts: Record<string, string>) => {
              getGlobalConfigStore({ autoSave: true }).createProfile(name, {
                appKey: opts.appKey,
                appSecret: opts.appSecret,
                token: opts.token,
              });
              printResult(`已创建档案: ${name}`);
            }),
        )
        .addCommand(
          new Command("remove")
            .description("删除配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              if (getGlobalConfigStore({ autoSave: true }).deleteProfile(name)) {
                printResult(`已删除档案: ${name}`);
              } else {
                printError(`无法删除档案: ${name} (可能不存在或为活跃档案)`);
                process.exit(1);
              }
            }),
        ),
    );

  // ─── contacts ───
  program
    .command("contacts")
    .description("联系人管理")
    .addCommand(
      new Command("list")
        .description("列出所有联系人")
        .action(() => {
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const all = store.getAll("name");
          if (all.length === 0) {
            printWarn("暂无联系人。运行 yb-cli contacts add <id> <name> 添加");
            return;
          }
          printSection("联系人列表");
          printTable(
            [
              { header: "", width: 2 },
              { header: "名称", width: 20 },
              { header: "用户ID", width: 30 },
              { header: "标签", width: 12 },
            ],
            all.map((c) => [
              c.favorite ? COLORS.success("⭐") : " ",
              chalk.bold(c.name),
              COLORS.dim(truncateToWidth(c.id, 30)),
              c.tag ? COLORS.accent(`[${c.tag}]`) : "",
            ]),
          );
          printStatus(`共 ${all.length} 个联系人`);
        }),
    )
    .addCommand(
      new Command("add")
        .description("添加联系人")
        .argument("<id>", "用户 ID")
        .argument("<name>", "显示名称")
        .argument("[tag]", "标签")
        .action((id: string, name: string, tag: string | undefined) => {
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          store.add(id, name, tag);
          printResult(`联系人已添加: ${name} -> ${id}${tag ? ` [${tag}]` : ""}`);
        }),
    )
    .addCommand(
      new Command("remove")
        .description("删除联系人")
        .argument("<nameOrId>", "联系人名称或 ID")
        .action((nameOrId: string) => {
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const removed = store.remove(nameOrId);
          if (removed) printResult("联系人已删除");
          else {
            printError(`未找到联系人: ${nameOrId}`);
            process.exit(1);
          }
        }),
    )
    .addCommand(
      new Command("dm")
        .description("给联系人发送私聊消息")
        .argument("<nameOrId>", "联系人名称或 ID")
        .argument("<message>", "消息内容")
        .action(async (nameOrId: string, message: string) => {
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const entry = store.get(nameOrId) ?? store.get(store.resolve(nameOrId));
          // Fall back to using the input as a raw user ID
          const userId = entry?.id ?? nameOrId;
          const displayName = entry?.name ?? nameOrId;
          const client = await ensureClient(program);
          const processed = interpolate(message);
          await client.sendDm(userId, processed);
          printResult(`已发送给 ${chalk.bold(displayName)} (${userId})`);
        }),
    );

  // ─── daemon ───
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

  return program;
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
