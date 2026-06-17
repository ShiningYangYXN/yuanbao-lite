/**
 * Non-interactive CLI — commander-based subcommands.
 *
 * Reuses YuanbaoBot from src/index.ts.
 * No command handler logic duplicated.
 */

import { Command } from "commander";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import chalk from "chalk";
import Table from "table";
import { getVersion } from "../version.js";
import { interpolate } from "../business/interpolate.js";
import { loadConfig } from "./config-loader.js";
import { withBot } from "./bot-helper.js";
import {
  getProfileNames,
  getProfile,
  getActiveProfileName,
  switchProfile,
  createProfile,
  deleteProfile,
  setConfigKey,
  type CliProfile,
} from "./config-loader.js";

function renderTable(headers: string[], rows: string[][], colWidths?: number[]): string {
  const config: Record<string, unknown> = {
    columns: {},
    border: Table.getBorderCharacters("none"),
    drawHorizontal: () => false,
    drawVertical: () => false,
  };
  if (colWidths) {
    colWidths.forEach((w, i) => {
      config[`column_${i}`] = { width: w };
    });
  }
  return Table.table([headers, ...rows], config);
}

async function withProfile<T>(
  fn: (pr: CliProfile, gc: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const { profile, globalConfig } = loadConfig({});
  return fn(profile, globalConfig);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("yb-cli-new")
    .description("Yuanbao Lite — 全新交互式/非交互式 CLI")
    .version(getVersion())
    .option("--profile <name>", "使用指定配置档案", "default")
    .option("--config <path>", "配置文件所在目录");

  // ─── send ───

  program
    .command("send")
    .description("发送消息")
    .addCommand(
      new Command("dm")
        .description("发送私聊消息")
        .argument("<userId>", "目标用户 ID")
        .argument("<message>", "消息内容 (支持 ${} 插值)")
        .action(async (userId: string, message: string) => {
          await withProfile(async (profile, globalConfig) => {
            const processed = interpolate(message);
            await withBot(profile, undefined, async (bot) => {
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
        .action(async (groupCode: string, message: string) => {
          await withProfile(async (profile, globalConfig) => {
            const processed = interpolate(message);
            await withBot(profile, undefined, async (bot) => {
              await bot.sendGroupMessage(groupCode, processed);
              console.log(chalk.green(`✅ 已发送群聊消息到 ${groupCode}`));
            });
          });
        }),
    );

  // ─── status ───

  program
    .command("status")
    .description("查看连接状态")
    .action(async () => {
      await withProfile(async (profile, globalConfig) => {
        await withBot(profile, undefined, async (bot) => {
          const state = bot.getState();
          const account = bot.getAccount();

          const headers = ["属性", "值"];
          const rows: string[][] = [
            [chalk.cyan("连接"), state.connected ? chalk.green("✅") : chalk.red("❌")],
            ["状态", state.status],
            ["Bot ID", state.botId || "(无)"],
            ["API域名", account.apiDomain || "(未设置)"],
            ["配置完整", account.configured ? chalk.green("✅") : chalk.red("❌")],
          ];
          console.log(renderTable(headers, rows, [14, 60]));
        });
      });
    });

  // ─── upload ───

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
        await withBot(profile, undefined, async (bot) => {
          const result = await bot.uploadMedia(resolved, opts.type as "image" | "file" | "video" | "audio" | undefined);
          console.log(chalk.green("✅ 上传成功:"));
          console.log(`  UUID: ${result.uuid}`);
          console.log(`  URL:  ${result.url || "(pending)"}`);
          console.log(`  大小: ${result.fileSize} bytes`);
        });
      });
    });

  // ─── config ───

  program
    .command("config")
    .description("配置管理")
    .addCommand(
      new Command("show")
        .description("显示当前配置")
        .action(() => {
          // Use self-contained config loader
          const names = getProfileNames();
          const active = getActiveProfileName();
          const p = getProfile(active)!;

          console.log(chalk.cyan.bold("\n📋 当前配置:"));
          console.log(`  档案:    ${chalk.yellow(active)}`);
          console.log(`  App Key: ${p.appKey ? chalk.dim("***" + p.appKey.slice(-4)) : chalk.red("(未设置)")}`);
          console.log(`  App Secret: ${p.appSecret ? chalk.dim("***" + p.appSecret.slice(-4)) : chalk.red("(未设置)")}`);
          console.log(`  API域名: ${p.apiDomain || "(默认)"}`);
          console.log(`  日志级别: ${p.logLevel || "(默认)"}`);
          console.log(`  LLM供应商: ${p.llmProvider || "(未设置)"}`);
        }),
    )
    .addCommand(
      new Command("set")
        .description("设置配置项")
        .argument("<key>", "配置键名")
        .argument("<value>", "配置值")
        .action(async (key: string, value: string) => {
          setConfigKey(key, value);
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
              const names = getProfileNames();
              const active = getActiveProfileName();

              const headers = ["", "名称", "凭证"];
              const rows: string[][] = names.map((name: string) => {
                const p = getProfile(name)!;
                const marker = name === active ? "→" : " ";
                const hasCreds = (p.appKey && p.appSecret) || p.token;
                return [
                  chalk.rgb(100, 200, 255)(marker),
                  chalk.bold(name),
                  hasCreds ? chalk.green("✅") : chalk.red("❌"),
                ];
              });

              console.log(renderTable(headers, rows, [4, 20, 6]));
            }),
        )
        .addCommand(
          new Command("switch")
            .description("切换活跃配置档案")
            .argument("<name>", "档案名称")
            .action((name: string) => {
              if (switchProfile(name)) {
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
              createProfile(name, {
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
              if (deleteProfile(name)) {
                console.log(chalk.green(`✅ 已删除档案: ${name}`));
              } else {
                console.log(chalk.red(`❌ 无法删除档案: ${name}`));
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
        .action(async () => {
          const { getGlobalContactStore } = await import("../business/contacts.js");
          const store = getGlobalContactStore({
            persistencePath: join(homedir(), ".yuanbao-lite", "contacts.json"),
            autoSave: true,
          });
          const all = store.getAll("name");

          if (all.length === 0) {
            console.log(chalk.dim("暂无联系人。使用 contacts add 添加"));
            return;
          }

          const headers = ["", "名称", "用户ID", "标签"];
          const rows: string[][] = all.map((c: { id: string; name: string; tag?: string; favorite?: boolean }) => [
            c.favorite ? "⭐" : "  ",
            chalk.bold(c.name),
            chalk.dim(c.id.substring(0, 30)),
            c.tag ? chalk.cyan(`[${c.tag}]`) : "",
          ]);

          console.log(renderTable(headers, rows, [4, 20, 30, 15]));
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
          const { getGlobalContactStore } = await import("../business/contacts.js");
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
          const { getGlobalContactStore } = await import("../business/contacts.js");
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
