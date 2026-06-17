/**
 * Non-interactive CLI — commander-based subcommands.
 *
 * Shares business logic with src/commands/registry.ts (CommandSystem).
 * This file only defines CLI argument parsing and output formatting.
 */

import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import Table from "table";
import { YuanbaoBot } from "../../index.js";
import { getVersion } from "../../version.js";
import { interpolate } from "../../business/interpolate.js";
import {
  loadConfig,
  initConfig,
  createBotFromProfile,
  withBot,
  printStatus,
  printResult,
  printError,
  printSection,
  printBlock,
  printWelcome,
} from "../core/index.js";
import type { CliProfile } from "../../cli/config.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("yb-cli-new")
    .description("Yuanbao Lite — 全新交互式/非交互式 CLI")
    .version(getVersion())
    .option("--profile <name>", "使用指定配置档案", "default")
    .option("--config <path>", "配置文件所在目录");

  // ─── send command ───

  program
    .command("send")
    .description("发送消息")
    .addCommand(
      new Command("dm")
        .description("发送私聊消息")
        .argument("<userId>", "目标用户 ID")
        .argument("<message>", "消息内容 (支持 ${} 插值)")
        .action(async (userId: string, message: string, opts: Record<string, unknown>) => {
          await withProfile(async (profile, globalConfig) => {
            const processed = interpolate(message);
            await withBot(profile, globalConfig, async (bot) => {
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
        .argument("<message>", "消息内容 (支持 ${} 插值)")
        .action(async (groupCode: string, message: string, opts: Record<string, unknown>) => {
          await withProfile(async (profile, globalConfig) => {
            const processed = interpolate(message);
            await withBot(profile, globalConfig, async (bot) => {
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
      await withProfile(async (profile, globalConfig) => {
        await withBot(profile, globalConfig, async (bot) => {
          const state = bot.getState();
          const account = bot.getAccount();

          const headers = ["属性", "值"];
          const rows = [
            [
              chalk.cyan("连接"),
              state.connected
                ? chalk.green("✅")
                : chalk.red("❌"),
            ],
            ["状态", state.status],
            ["Bot ID", state.botId || "(无)"],
            ["API域名", account.apiDomain || "(未设置)"],
            ["配置完整", account.configured ? chalk.green("✅") : chalk.red("❌")],
          ];

          const table = renderTable(headers, rows, { colWidths: [14, 60] });
          console.log(table);
        });
      });
    });

  // ─── upload command ───

  program
    .command("upload")
    .description("上传文件")
    .argument("<filePath>", "本地文件路径")
    .option("--type <type>", "媒体类型 (image|file|video|audio)")
    .action(async (filePath: string, opts: Record<string, unknown>) => {
      await withProfile(async (profile, globalConfig) => {
        const resolved = resolve(filePath);
        if (!existsSync(resolved)) {
          console.log(chalk.red(`❌ 文件不存在: ${resolved}`));
          process.exit(1);
        }
        await withBot(profile, globalConfig, async (bot) => {
          const result = await bot.uploadMedia(resolved, opts.type as string | undefined);
          console.log(chalk.green("✅ 上传成功:"));
          console.log(`  UUID: ${result.uuid}`);
          console.log(`  URL:  ${result.url || "(pending)"}`);
          console.log(`  大小: ${result.fileSize} bytes`);
        });
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
          await initConfig();
        }),
    )
    .addCommand(
      new Command("show")
        .description("显示当前配置")
        .action(() => {
          const store = require("../../cli/config.js").getGlobalConfigStore();
          const profile = store.getActiveProfile();
          const global = store.getData().global ?? {};

          const headers = ["属性", "值"];
          const rows = [
            ["档案", profile.name],
            ["App Key", profile.appKey ? "****" + profile.appKey.slice(-4) : "(未设置)"],
            ["App Secret", profile.appSecret ? "****" + profile.appSecret.slice(-4) : "(未设置)"],
            ["API域名", profile.apiDomain || "(默认)"],
            ["日志级别", profile.logLevel || "(默认)"],
            ["LLM 供应商", profile.llmProvider || "(未设置)"],
            ["下载目录", profile.downloadDir || global.downloadDir || "(默认)"],
          ];

          const table = renderTable(headers, rows, { colWidths: [14, 60] });
          console.log(table);
        }),
    )
    .addCommand(
      new Command("set")
        .description("设置配置项")
        .argument("<key>", "配置键名")
        .argument("<value>", "配置值")
        .action(async (key: string, value: string) => {
          const store = require("../../cli/config.js").getGlobalConfigStore();
          store.set(key as never, value);
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
              const store = require("../../cli/config.js").getGlobalConfigStore();
              const names = store.getProfileNames();
              const active = store.getActiveProfileName();

              const headers = ["标识", "名称", "凭证"];
              const rows = names.map((name: string) => {
                const profile = store.getProfile(name)!;
                const marker = name === active ? "→" : " ";
                const hasCreds =
                  (profile.appKey && profile.appSecret) || profile.token;
                const status = hasCreds ? chalk.green("✅") : chalk.red("❌");
                return [
                  chalk.cyan(marker),
                  chalk.bold(name),
                  status,
                ];
              });

              const table = renderTable(headers, rows, { colWidths: [4, 20, 6] });
              console.log(table);
            }),
        )
        .addCommand(
          new Command("switch")
            .description("切换活跃配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              const store = require("../../cli/config.js").getGlobalConfigStore();
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
              const store = require("../../cli/config.js").getGlobalConfigStore();
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
              const store = require("../../cli/config.js").getGlobalConfigStore();
              if (store.deleteProfile(name)) {
                console.log(chalk.green(`✅ 已删除档案: ${name}`));
              } else {
                console.log(chalk.red(`❌ 无法删除档案: ${name}`));
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
          const { getGlobalContactStore } = await import(
            "../../business/contacts.js"
          );
          const { join, homedir } = await import("node:path", { assert: { type: "json" } }) as any;
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const all = store.getAll("name");

          if (all.length === 0) {
            console.log(chalk.dim("暂无联系人。使用 contacts add 添加"));
            return;
          }

          const headers = ["星标", "名称", "用户ID", "标签"];
          const rows = all.map((c: any) => [
            c.favorite ? "⭐" : "  ",
            chalk.bold(c.name),
            chalk.dim(c.id.substring(0, 30)),
            c.tag ? chalk.cyan(`[${c.tag}]`) : "",
          ]);

          const table = renderTable(headers, rows, {
            colWidths: [4, 20, 30, 15],
          });
          console.log(table);
          console.log(chalk.dim(`\n  共 ${all.length} 个联系人\n`));
        }),
    )
    .addCommand(
      new Command("add")
        .description("添加联系人")
        .argument("<id>", "用户 ID")
        .argument("<name>", "显示名称")
        .argument("[tag]", "标签")
        .action(async (id: string, name: string, tag: string | undefined) => {
          const { getGlobalContactStore } = await import(
            "../../business/contacts.js"
          );
          const { join, homedir } = await import("node:path", { assert: { type: "json" } }) as any;
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          store.add(id, name, tag);
          console.log(chalk.green(`✅ 联系人已添加: ${name} -> ${id.substring(0, 20)}${tag ? ` [${tag}]` : ""}`));
        }),
    )
    .addCommand(
      new Command("remove")
        .description("删除联系人")
        .argument("<nameOrId>", "联系人名称或 ID")
        .action(async (nameOrId: string) => {
          const { getGlobalContactStore } = await import(
            "../../business/contacts.js"
          );
          const { join, homedir } = await import("node:path", { assert: { type: "json" } }) as any;
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const removed = store.remove(nameOrId);
          console.log(removed ? chalk.green("✅ 联系人已删除") : chalk.red(`未找到联系人: ${nameOrId}`));
        }),
    );

  return program;
}

/**
 * Render a flat text table using the `table` library.
 */
function renderTable(
  headers: string[],
  rows: string[][],
  options: { colWidths?: number[] } = {},
): string {
  const { colWidths } = options;

  const config: Table.TableOptions = {
    columns: {},
    border: Table.getBorderCharacters("none"),
    drawHorizontal: () => false,
    drawVertical: () => false,
  };

  if (colWidths) {
    colWidths.forEach((w, i) => {
      config.columns[i] = { width: w };
    });
  }

  const data = [headers, ...rows];
  return Table.table(data, config);
}

/**
 * Load config, run callback with profile + globalConfig.
 */
async function withProfile<T>(
  fn: (
    profile: CliProfile,
    globalConfig: Record<string, unknown>,
  ) => Promise<void>,
): Promise<void> {
  const { profile, globalConfig } = loadConfig({});
  await fn(profile, globalConfig);
}
