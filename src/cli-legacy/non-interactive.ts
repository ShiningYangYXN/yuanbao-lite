#!/usr/bin/env node
/**
 * Non-interactive CLI for Yuanbao Lite — send-and-exit mode using Commander.
 *
 * Supports:
 *   - Send DM/group messages and exit
 *   - Upload/download media files
 *   - Query bot status
 *   - Auto-read config from ~/.yuanbao-lite/config.json or --config flag
 *   - Guide creation when no config exists
 *   - Full $ interpolation and @mention support
 *
 * Usage:
 *   yb-cli send dm <userId> <message>
 *   yb-cli send group <groupCode> <message>
 *   yb-cli status
 *   yb-cli upload <filePath>
 *   yb-cli download <url> [fileName]
 *   yb-cli config init
 *   yb-cli config show
 *   yb-cli config set <key> <value>
 */

import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { YuanbaoBot } from "../index.js";
import { getVersion } from "../version.js";
import { ConfigStore, getGlobalConfigStore, normalizeDir } from "./config.js";
import type { CliProfile } from "./config.js";
import { interpolate, buildMessageContext } from "../business/interpolate.js";
import { createLog, setLogLevel } from "../logger.js";

// ─── Helper: create bot from config ───

function createBotFromProfile(profile: CliProfile, globalConfig?: { logLevel?: string; downloadDir?: string; stickerDir?: string }): YuanbaoBot {
  const logLevel = (profile.logLevel || globalConfig?.logLevel || "info") as "debug" | "info" | "warn" | "error";
  setLogLevel(logLevel);

  const botConfig: Record<string, unknown> = {
    appKey: profile.appKey,
    appSecret: profile.appSecret,
    token: profile.token,
    apiDomain: profile.apiDomain,
    wsUrl: profile.wsUrl,
    logLevel,
  };

  return new YuanbaoBot(botConfig);
}

// ─── Helper: connect, execute, disconnect ───

async function withBot<T>(
  profile: CliProfile,
  globalConfig: { logLevel?: string; downloadDir?: string; stickerDir?: string } | undefined,
  fn: (bot: YuanbaoBot) => Promise<T>,
): Promise<T> {
  const bot = createBotFromProfile(profile, globalConfig);

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      bot.stop();
      reject(new Error("Connection timeout (30s)"));
    }, 30_000);

    bot.on("ready", async () => {
      clearTimeout(timeout);
      try {
        const result = await fn(bot);
        bot.stop();
        resolve(result);
      } catch (err) {
        bot.stop();
        reject(err);
      }
    });

    bot.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    bot.start().catch(reject);
  });
}

// ─── Helper: prompt for input ───

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Guided config creation ───

async function guidedSetup(store: ConfigStore): Promise<void> {
  console.log(chalk.cyan("\n🤖 Yuanbao Lite 配置向导"));
  console.log(chalk.dim("首次使用需要配置认证信息\n"));

  const appKey = await prompt(chalk.yellow("App Key: "));
  if (!appKey) {
    console.log(chalk.red("App Key 不能为空"));
    process.exit(1);
  }

  const appSecret = await prompt(chalk.yellow("App Secret: "));
  if (!appSecret) {
    console.log(chalk.red("App Secret 不能为空"));
    process.exit(1);
  }

  const name = await prompt(chalk.yellow("配置名称 (回车使用 default): "));

  store.applySetupAnswers({
    appKey,
    appSecret,
    name: name || "default",
  });

  console.log(chalk.green("\n✅ 配置已保存到: " + store.getConfigDir() + "/config.json"));
  console.log(chalk.dim("你可以随时使用 yb-cli config set 修改配置\n"));
}

// ─── Build the Commander program ───

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("yb-cli")
    .description("Yuanbao Lite — 轻量级元宝机器人客户端 CLI")
    .version(getVersion())
    .option("--config <path>", "指定配置文件路径")
    .option("--profile <name>", "使用指定配置档案", "default")
    .option("--app-key <key>", "覆盖 App Key")
    .option("--app-secret <secret>", "覆盖 App Secret")
    .option("--token <token>", "使用预签名 token (格式: appKey:appSecret)")
    .option("--api-domain <domain>", "覆盖 API 域名")
    .option("--ws-url <url>", "覆盖 WebSocket URL")
    .option("--log-level <level>", "日志级别 (debug|info|warn|error)")
    .option("--no-color", "禁用颜色输出");

  // ─── send command ───

  program
    .command("send")
    .description("发送消息 (非交互模式)")
    .addCommand(
      new Command("dm")
        .description("发送私聊消息")
        .argument("<userId>", "目标用户 ID")
        .argument("<message>", "消息内容 (支持 ${} 插值和 @[]() 提及)")
        .option("--mention <text>", "附带 @提及 (仅 cloud_custom_data)")
        .action(async (userId: string, message: string, opts: Record<string, unknown>) => {
          await executeWithConfig(async (profile, globalCfg) => {
            const processed = interpolate(message, buildMessageContext());
            await withBot(profile, globalCfg, async (bot) => {
              await bot.sendDirectMessage(userId, processed);
              console.log(chalk.green(`✅ 已发送私聊消息给 ${userId}`));
            });
          });
        }),
    )
    .addCommand(
      new Command("group")
        .description("发送群聊消息")
        .argument("<groupCode>", "目标群号")
        .argument("<message>", "消息内容 (支持 ${} 插值和 @[]() 提及)")
        .option("--mention <text>", "附带 @提及 (仅 cloud_custom_data)")
        .action(async (groupCode: string, message: string, opts: Record<string, unknown>) => {
          await executeWithConfig(async (profile, globalCfg) => {
            const processed = interpolate(message, buildMessageContext());
            await withBot(profile, globalCfg, async (bot) => {
              await bot.sendGroupMessage(groupCode, processed);
              console.log(chalk.green(`✅ 已发送群聊消息到 ${groupCode}`));
            });
          });
        }),
    );

  // ─── status command ───

  program
    .command("status")
    .description("查看连接状态")
    .action(async () => {
      await executeWithConfig(async (profile, globalCfg) => {
        await withBot(profile, globalCfg, async (bot) => {
          const state = bot.getState();
          const account = bot.getAccount();
          console.log(chalk.cyan("\n📊 机器人状态:"));
          console.log(`  连接: ${state.connected ? chalk.green("✅") : chalk.red("❌")} ${state.status}`);
          if (state.botId) console.log(`  Bot ID: ${chalk.yellow(state.botId)}`);
          console.log(`  API域名: ${account.apiDomain}`);
          console.log(`  配置完整: ${account.configured ? chalk.green("✅") : chalk.red("❌")}`);
          console.log();
        });
      });
    });

  // ─── upload command ───

  program
    .command("upload")
    .description("上传文件到媒体服务器")
    .argument("<filePath>", "本地文件路径")
    .option("--type <type>", "媒体类型 (image|file|video|audio)")
    .action(async (filePath: string, opts: Record<string, unknown>) => {
      await executeWithConfig(async (profile, globalCfg) => {
        const resolvedPath = resolve(filePath);
        if (!existsSync(resolvedPath)) {
          console.log(chalk.red(`❌ 文件不存在: ${resolvedPath}`));
          process.exit(1);
        }
        await withBot(profile, globalCfg, async (bot) => {
          const result = await bot.uploadMedia(resolvedPath, opts.type as "image" | "file" | "video" | "audio" | undefined);
          console.log(chalk.green("✅ 上传成功:"));
          console.log(`  UUID: ${result.uuid}`);
          console.log(`  URL:  ${result.url || "(pending)"}`);
          console.log(`  大小: ${result.fileSize} bytes`);
        });
      });
    });

  // ─── download command ───

  program
    .command("download")
    .description("下载媒体文件")
    .argument("<url>", "下载 URL")
    .argument("[fileName]", "保存的文件名")
    .option("--dir <directory>", "保存目录")
    .action(async (url: string, fileName: string | undefined, opts: Record<string, unknown>) => {
      await executeWithConfig(async (profile, globalCfg) => {
        const saveDir = normalizeDir(opts.dir as string) || globalCfg?.downloadDir;
        const result = await bot_download(url, saveDir, fileName);
        console.log(chalk.green("✅ 下载完成:"));
        console.log(`  路径: ${result.filePath}`);
        console.log(`  大小: ${result.fileSize} bytes`);
      });
    });

  // ─── config command ───

  program
    .command("config")
    .description("配置管理")
    .addCommand(
      new Command("init")
        .description("初始化配置 (交互式)")
        .action(async () => {
          const store = getGlobalConfigStore();
          await guidedSetup(store);
        }),
    )
    .addCommand(
      new Command("show")
        .description("显示当前配置")
        .action(async () => {
          const store = getGlobalConfigStore();
          const profile = store.getActiveProfile();
          console.log(chalk.cyan("\n📋 当前配置:"));
          console.log(`  档案: ${chalk.yellow(store.getActiveProfileName())}`);
          console.log(`  App Key: ${profile.appKey ? chalk.dim("***" + profile.appKey.slice(-4)) : chalk.red("(未设置)")}`);
          console.log(`  App Secret: ${profile.appSecret ? chalk.dim("***" + profile.appSecret.slice(-4)) : chalk.red("(未设置)")}`);
          console.log(`  API域名: ${profile.apiDomain || "(默认)"}`);
          console.log(`  日志级别: ${profile.logLevel || "(默认)"}`);
          console.log(`  贴纸目录: ${profile.stickerDir || "(未设置)"}`);
          console.log(`  下载目录: ${profile.downloadDir || store.getGlobal("downloadDir") || "(默认)"}`);
          if (profile.llmProvider) {
            console.log(`  LLM供应商: ${profile.llmProvider}`);
          }
          console.log(`  配置路径: ${chalk.dim(store.getConfigDir())}`);
          console.log();
        }),
    )
    .addCommand(
      new Command("set")
        .description("设置配置项")
        .argument("<key>", "配置键名")
        .argument("<value>", "配置值")
        .action(async (key: string, value: string) => {
          const store = getGlobalConfigStore();
          const validKeys: Array<keyof CliProfile> = [
            "appKey", "appSecret", "token", "apiDomain", "wsUrl",
            "logLevel", "stickerDir", "downloadDir", "prompt",
            "llmProvider", "llmApiKey", "llmBaseUrl", "llmModel",
            "llmSystemPrompt", "defaultTarget", "defaultChatMode",
          ];
          if (!validKeys.includes(key as keyof CliProfile)) {
            console.log(chalk.red(`❌ 无效配置键: ${key}`));
            console.log(chalk.dim(`可选: ${validKeys.join(", ")}`));
            process.exit(1);
          }
          store.set(key as keyof CliProfile, value);
          console.log(chalk.green(`✅ 已设置 ${key}`));
        }),
    )
    .addCommand(
      new Command("profile")
        .description("配置档案管理")
        .addCommand(
          new Command("list")
            .description("列出所有配置档案")
            .action(() => {
              const store = getGlobalConfigStore();
              const names = store.getProfileNames();
              const activeName = store.getActiveProfileName();
              console.log(chalk.cyan("\n📋 配置档案:"));
              for (const name of names) {
                const profile = store.getProfile(name)!;
                const marker = name === activeName ? chalk.green("→") : " ";
                const hasCreds = (profile.appKey && profile.appSecret) || profile.token;
                console.log(`  ${marker} ${name} ${hasCreds ? chalk.green("✅") : chalk.red("❌")}`);
              }
              console.log();
            }),
        )
        .addCommand(
          new Command("switch")
            .description("切换活跃配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              const store = getGlobalConfigStore();
              if (store.switchProfile(name)) {
                console.log(chalk.green(`✅ 已切换到档案: ${name}`));
              } else {
                console.log(chalk.red(`❌ 档案不存在: ${name}`));
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
              const store = getGlobalConfigStore();
              store.createProfile(name, {
                appKey: opts.appKey,
                appSecret: opts.appSecret,
                token: opts.token,
              });
              console.log(chalk.green(`✅ 已创建档案: ${name}`));
            }),
        )
        .addCommand(
          new Command("remove")
            .description("删除配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              const store = getGlobalConfigStore();
              if (store.deleteProfile(name)) {
                console.log(chalk.green(`✅ 已删除档案: ${name}`));
              } else {
                console.log(chalk.red(`❌ 无法删除档案: ${name} (不存在或是活跃档案)`));
                process.exit(1);
              }
            }),
        ),
    );

  // ─── contacts command ───

  program
    .command("contacts")
    .description("联系人管理")
    .addCommand(
      new Command("list")
        .description("列出所有联系人")
        .action(async () => {
          const { getGlobalContactStore } = await import("../business/contacts.js");
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const all = store.getAll("name");
          if (all.length === 0) {
            console.log(chalk.dim("暂无联系人。使用 contacts add 添加"));
          } else {
            console.log(chalk.cyan("\n📇 联系人列表:"));
            for (const c of all) {
              const fav = c.favorite ? "⭐" : " ";
              console.log(`  ${fav} ${chalk.bold(c.name)} -> ${chalk.dim(c.id.substring(0, 30))}${c.tag ? chalk.cyan(` [${c.tag}]`) : ""}`);
            }
            console.log(chalk.dim(`\n  共 ${all.length} 个联系人\n`));
          }
        }),
    )
    .addCommand(
      new Command("add")
        .description("添加联系人")
        .argument("<id>", "用户 ID")
        .argument("<name>", "显示名称")
        .argument("[tag]", "标签")
        .action(async (id: string, name: string, tag: string | undefined) => {
          const { getGlobalContactStore } = await import("../business/contacts.js");
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          store.add(id, name, tag);
          console.log(chalk.green(`✅ 联系人已添加: ${name} -> ${id.substring(0, 20)}...${tag ? ` [${tag}]` : ""}`));
        }),
    )
    .addCommand(
      new Command("remove")
        .description("删除联系人")
        .argument("<nameOrId>", "联系人名称或 ID")
        .action(async (nameOrId: string) => {
          const { getGlobalContactStore } = await import("../business/contacts.js");
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const removed = store.remove(nameOrId);
          console.log(removed ? chalk.green("✅ 联系人已删除") : chalk.red(`未找到联系人: ${nameOrId}`));
        }),
    )
    .addCommand(
      new Command("dm")
        .description("发送私聊消息给联系人")
        .argument("<nameOrId>", "联系人名称或 ID")
        .argument("<message>", "消息内容")
        .action(async (nameOrId: string, message: string) => {
          await executeWithConfig(async (profile, globalCfg) => {
            await withBot(profile, globalCfg, async (bot) => {
              const store = bot.getContactStore();
              const resolved = store.resolve(nameOrId);
              store.touch(nameOrId);
              await bot.sendDirectMessage(resolved, message);
              console.log(chalk.green(`✅ 已发送私聊消息给 ${nameOrId === resolved ? resolved : `${nameOrId} (${resolved})`}`));
            });
          });
        }),
    );

  return program;
}

// ─── Download helper (no bot needed) ───

async function bot_download(url: string, saveDir?: string, fileName?: string) {
  const { downloadMedia } = await import("../access/http/media.js");
  return downloadMedia(url, saveDir, fileName);
}

// ─── Execute with config resolution ───

type ConfigAction = (
  profile: CliProfile,
  globalCfg: { logLevel?: string; downloadDir?: string; stickerDir?: string } | undefined,
) => Promise<void>;

async function executeWithConfig(action: ConfigAction): Promise<void> {
  const store = getGlobalConfigStore();
  const profile = { ...store.getActiveProfile() };

  // Check credentials
  const hasCreds = (profile.appKey && profile.appSecret) || profile.token;
  if (!hasCreds) {
    console.log(chalk.yellow("\n⚠️  未配置认证信息"));
    console.log(chalk.dim("请运行 yb-cli config init 进行配置"));
    console.log(chalk.dim("或使用 --app-key 和 --app-secret 参数\n"));
    process.exit(1);
  }

  const globalCfg = store.getData().global;

  try {
    await action(profile, globalCfg);
  } catch (err) {
    console.error(chalk.red(`❌ 错误: ${(err as Error).message}`));
    process.exit(1);
  }
}

// ─── Main entry point for non-interactive mode ───

export function runNonInteractive(): void {
  const program = buildProgram();

  // Check if there are subcommands; if not, fall through to interactive mode
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "interactive" || args[0] === "repl") {
    return; // Signal to fall through to interactive mode
  }

  program.parseAsync(args).catch((err) => {
    console.error(chalk.red(`❌ 命令执行失败: ${(err as Error).message}`));
    process.exit(1);
  });
}
