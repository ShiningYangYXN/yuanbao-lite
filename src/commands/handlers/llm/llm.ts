/**
 * /llm command handler — extracted from registry.ts (lossless split).
 * Category: llm
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "llm",
        aliases: ["ai"],
        description: "LLM 接管控制（开启/关闭AI自动回复，配置模型参数）",
        usage: "/llm <on|off|status|billing|chat|prompt|model|temp|history|clear|provider|config|customprovider|raw|im|group|merge|cooldown|iterate> [参数]",
        category: "llm" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          const engine = ctx.bot.getLlmEngine();
          const subCmd = ctx.args[0]?.toLowerCase();
          const subArgs = ctx.args.slice(1);

          // /llm help — show detailed subcommand help
          if (subCmd === "help" || subCmd === "?") {
            await ctx.replyDoc(
              "🤖 LLM 子命令帮助:\n\n" +
              "  /llm                    查看状态\n" +
              "  /llm status             同上\n" +
              "  /llm on                 开启LLM自动回复\n" +
              "  /llm off                关闭LLM自动回复\n" +
              "  /llm chat <文本>        与LLM对话（不触发自动回复）\n" +
              "  /llm config             启动交互式配置向导\n" +
              "  /llm config cancel      取消配置向导\n" +
              "  /llm provider [名称]    查看或切换活跃供应商\n" +
              "  /llm customprovider ... 管理自定义供应商\n" +
              "    list                  列出所有供应商\n" +
              "    add <名> <格式> <模型> <URL> [key]  添加供应商\n" +
              "    remove <名>           移除供应商\n" +
              "    use <名>              切换活跃供应商\n" +
              "    addkey <名> <key>     添加API密钥\n" +
              "    removekey <名> <key>  移除API密钥\n" +
              "  /llm model [名称]       查看或设置模型\n" +
              "  /llm temp [0-2]         查看或设置温度\n" +
              "  /llm prompt [文本]      查看或设置用户系统提示词\n" +
              "  /llm group on|off       开关群聊响应\n" +
              "  /llm group mention on|off  开关群聊需@\n" +
              "  /llm im on|off          开关私聊响应\n" +
              "  /llm merge [ms]         查看或设置消息合并窗口（0=关闭）\n" +
              "  /llm cooldown [ms]      查看或设置响应冷却（0=关闭）\n" +
              "  /llm iterate [轮数]     查看或设置最大迭代轮数（0=无限）\n" +
              "  /llm raw on|off         开关原始markdown模式\n" +
              "  /llm history            查看对话历史\n" +
              "  /llm clear              清空当前对话历史\n" +
              "  /llm billing            查看用量统计\n" +
              "  /llm reset              清空所有LLM配置（3次确认，CLI免确认）\n" +
              "  /llm help               显示此帮助\n\n" +
              "命令名无需加/前缀",
            );
            return;
          }

          if (!subCmd) {
            // Show LLM status
            const autoReply = ctx.bot.isLlmAutoReply();
            if (engine) {
              const config = engine.getConfig();
              const lines = [
                "🤖 LLM 接管状态:",
                `  已启用: ${config.enabled ? "✅" : "❌"}`,
                `  自动回复: ${autoReply ? "🟢 已开启" : "⚪ 未开启"}`,
                `  SDK就绪: ${engine.isReady ? "✅" : "❌"}`,
                `  供应商: ${config.provider}`,
                `  模型: ${config.model || "(默认)"}`,
                `  温度: ${config.temperature}`,
                `  Markdown模式: ${config.markdownRawMode ? "原始(raw)" : "IM格式化"}`,
                `  群聊响应: ${config.enableInGroup ? "✅" : "❌"}`,
                `  私聊响应: ${config.enableInDirect ? "✅" : "❌"}`,
                `  群聊需@: ${config.requireMentionInGroup ? "✅" : "❌"}`,
                `  消息合并窗口: ${config.mergeWindowMs}ms`,
                `  响应冷却时间: ${config.cooldownMs}ms`,
                `  最大迭代轮数: ${config.maxIterate === 0 ? "无限" : config.maxIterate}`,
                `  活跃对话: ${engine.getConversationManager().size}`,
                `  配置持久化: ${engine.getPersistencePath() ? "✅" : "❌"}`,
              ];
              await ctx.reply(lines.join("\n"));
            } else {
              await ctx.reply("🤖 LLM 未配置。请设置 llmConfig 后重启");
            }
            return;
          }

          if (!engine) {
            await ctx.reply("❌ LLM 引擎未初始化");
            return;
          }

          switch (subCmd) {
            case "on": {
              engine.updateConfig({ enabled: true });
              ctx.bot.setLlmAutoReply(true);
              await ctx.reply("🤖 LLM 自动回复已开启");
              break;
            }
            case "off": {
              engine.updateConfig({ enabled: false });
              ctx.bot.setLlmAutoReply(false);
              await ctx.reply("🤖 LLM 自动回复已关闭");
              break;
            }
            case "billing":
            case "用量":
            case "账单": {
              const usage = engine.getUsage();
              if (usage.totalCalls === 0) {
                await ctx.reply("📊 暂无用量记录");
                return;
              }
              const lines = [
                `📊 LLM 用量统计:`,
                `  总调用: ${usage.totalCalls} 次`,
                `  总Token: ${usage.totalTokens}`,
                ``,
                `按供应商:`,
              ];
              for (const [name, stats] of Object.entries(usage.byProvider)) {
                lines.push(`  ${name}: ${stats.calls} 次, ${stats.tokens} tokens`);
              }
              // Show recent 5 records
              const recent = usage.records.slice(-5).reverse();
              if (recent.length > 0) {
                lines.push("", "最近调用:");
                for (const r of recent) {
                  const time = new Date(r.timestamp).toLocaleString("zh-CN");
                  lines.push(`  ${time} — ${r.provider}/${r.model}: ${r.totalTokens} tokens (${r.promptTokens}+${r.completionTokens})`);
                }
              }
              await ctx.reply(lines.join("\n"));
              return;
            }
            case "status": {
              const config = engine.getConfig();
              const pool = engine.getPoolStatus();
              const activeProvider = config.customProviders?.[pool.activeProvider];
              const lines = [
                `🤖 LLM 状态:`,
                `  启用: ${config.enabled ? "是" : "否"}`,
                `  自动回复: ${ctx.bot.isLlmAutoReply() ? "是" : "否"}`,
                `  就绪: ${engine.isReady ? "是" : "否"}`,
                `  活跃供应商: ${pool.activeProvider || "(未设置)"}`,
                ...(activeProvider ? [
                  `  API格式: ${activeProvider.apiFormat}`,
                  `  模型: ${activeProvider.model}`,
                  `  端点: ${activeProvider.baseUrl}`,
                ] : []),
                `  密钥池: ${pool.keyPoolSize} 个 (${pool.keysInCooldown} 冷却中)`,
                `  供应商总数: ${pool.providerPoolSize} 个`,
                `  当前密钥索引: ${pool.activeKeyIndex}`,
                `  连续失败: ${pool.providerFailures}/${pool.maxFailuresBeforeSwitch}`,
              ];
              await ctx.reply(lines.join("\n"));
              break;
            }
            case "chat":
            case "ask":
            case "问": {
              if (subArgs.length === 0) {
                await ctx.reply("用法: /llm chat <消息>");
                return;
              }
              const prompt = subArgs.join(" ");
              try {
                const result = await engine.chat(prompt, "cmd:interactive");
                await ctx.reply(`🤖 回复:\n${result.processedText}`);
              } catch (err) {
                await ctx.reply(`❌ LLM调用失败: ${(err as Error).message}`);
              }
              break;
            }
            case "prompt":
            case "系统提示": {
              if (subArgs.length === 0) {
                const config = engine.getConfig();
                await ctx.reply(`当前系统提示词:\n${config.systemPrompt}`);
                return;
              }
              engine.updateConfig({ systemPrompt: subArgs.join(" ") });
              await ctx.reply(`✅ 系统提示词已更新`);
              break;
            }
            case "model":
            case "模型": {
              if (subArgs.length === 0) {
                const config = engine.getConfig();
                await ctx.reply(`当前模型: ${config.model || "(默认)"}`);
                return;
              }
              engine.updateConfig({ model: subArgs[0] });
              await ctx.reply(`✅ 模型已设为: ${subArgs[0]}`);
              break;
            }
            case "temp":
            case "温度": {
              if (subArgs.length === 0) {
                const config = engine.getConfig();
                await ctx.reply(`当前温度: ${config.temperature}`);
                return;
              }
              const temp = parseFloat(subArgs[0]);
              if (isNaN(temp) || temp < 0 || temp > 2) {
                await ctx.reply("温度范围: 0-2 (0=精确, 2=创意)");
                return;
              }
              engine.updateConfig({ temperature: temp });
              await ctx.reply(`✅ 温度已设为: ${temp}`);
              break;
            }
            case "history":
            case "历史": {
              const cm = engine.getConversationManager();
              const keys = Array.from(cm.keys);
              if (keys.length === 0) {
                await ctx.reply("暂无对话历史");
                return;
              }
              const lines = keys.map(key => {
                const history = cm.getHistory(key);
                const userMsgs = history.filter(h => h.role === "user").length;
                const botMsgs = history.filter(h => h.role === "assistant").length;
                return `  ${key}: ${userMsgs}条用户消息, ${botMsgs}条回复`;
              });
              await ctx.reply(`📜 对话历史 (${keys.length} 个对话):\n${lines.join("\n")}`);
              break;
            }
            case "clear":
            case "清除": {
              const cm = engine.getConversationManager();
              if (subArgs[0]) {
                cm.clearHistory(subArgs[0]);
                await ctx.reply(`✅ 已清除对话: ${subArgs[0]}`);
              } else {
                cm.clearAll();
                await ctx.reply("✅ 已清除所有对话历史");
              }
              break;
            }
            case "raw": {
              engine.updateConfig({ markdownRawMode: true });
              await ctx.reply("✅ 已切换为Markdown原始模式");
              break;
            }
            case "im": {
              engine.updateConfig({ markdownRawMode: false });
              await ctx.reply("✅ 已切换为IM格式化模式");
              break;
            }
            case "provider":
            case "供应商": {
              if (subArgs.length === 0) {
                const config = engine.getConfig();
                const names = Object.keys(config.customProviders ?? {});
                await ctx.reply(`当前供应商: ${config.provider || "(未设置)"}\n可用: ${names.join(", ") || "(无)"}`);
                return;
              }
              const config = engine.getConfig();
              const names = Object.keys(config.customProviders ?? {});
              if (!names.includes(subArgs[0])) {
                await ctx.reply(`无效供应商: ${subArgs[0]}\n可用: ${names.join(", ") || "(无)"}\n用 /llm customprovider add 添加自定义供应商`);
                return;
              }
              engine.updateConfig({ provider: subArgs[0] });
              await ctx.reply(`✅ 供应商已切换为: ${subArgs[0]}`);
              break;
            }
            case "apikey":
            case "密钥": {
              await ctx.reply("⚠️ API Key 管理已迁移到 customprovider 系统。\n用 /llm customprovider addkey <名称> <key> 添加密钥");
              break;
            }
            case "baseurl":
            case "基础url": {
              await ctx.reply("⚠️ Base URL 管理已迁移到 customprovider 系统。\n用 /llm customprovider add <名称> <apiFormat> <model> <baseUrl> 添加供应商");
              break;
            }
            case "keypool":
            case "密钥池": {
              await ctx.reply("⚠️ 密钥池已迁移到 customprovider 系统。\n用 /llm customprovider addkey/removekey 管理密钥");
              break;
            }
            case "providerpool":
            case "供应商池": {
              await ctx.reply("⚠️ 供应商池已迁移到 customprovider 系统。\n用 /llm customprovider list/add/remove 管理供应商");
              break;
            }
            case "customprovider":
            case "自定义供应商": {
              const config = engine.getConfig();
              const customProviders = { ...(config.customProviders ?? {}) };
              const action = subArgs[0];

              if (action === "help" || action === "?") {
                const { API_FORMATS } = await import("../../../business/llm-takeover.js");
                const formats = API_FORMATS.map(f => `  ${f.value}: ${f.label}`).join("\n");
                await ctx.replyDoc(
                  "📋 /llm customprovider 子命令帮助:\n\n" +
                  "  /llm customprovider list              列出所有供应商\n" +
                  "  /llm customprovider add <名> <格式> <模型> <URL> [key]\n" +
                  "                                        添加供应商\n" +
                  "  /llm customprovider remove <名>       移除供应商\n" +
                  "  /llm customprovider use <名>          切换活跃供应商\n" +
                  "  /llm customprovider addkey <名> <key> 添加API密钥\n" +
                  "  /llm customprovider removekey <名> <idx>  移除API密钥\n" +
                  "  /llm customprovider help              显示此帮助\n\n" +
                  `API格式:\n${formats}`,
                );
                return;
              }

              if (!action || action === "list") {
                const names = Object.keys(customProviders);
                if (names.length === 0) {
                  await ctx.reply("自定义供应商列表为空\n用法: /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]");
                  return;
                }
                const lines = names.map(name => {
                  const p = customProviders[name];
                  const keyCount = (p.apiKeys?.length ?? 0) || (p.apiKey ? 1 : 0);
                  return `  ${name}: ${p.apiFormat} / ${p.model} / keys=${keyCount} / ${p.baseUrl}`;
                });
                await ctx.reply(`自定义供应商 (${names.length} 个):\n${lines.join("\n")}`);
                return;
              }

              if (action === "add") {
                // /llm customprovider add <name> <apiFormat> <model> <baseUrl> [apiKey]
                if (subArgs.length < 5) {
                  const { API_FORMATS } = await import("../../../business/llm-takeover.js");
                  const formats = API_FORMATS.map(f => `  ${f.value}: ${f.label}`).join("\n");
                  await ctx.reply(`用法: /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]\n\nAPI格式:\n${formats}`);
                  return;
                }
                const name = subArgs[1];
                const { API_FORMATS } = await import("../../../business/llm-takeover.js");
                const apiFormat = subArgs[2] as typeof API_FORMATS[number]["value"];
                const validFormats = API_FORMATS.map(f => f.value);
                if (!validFormats.includes(apiFormat)) {
                  await ctx.reply(`❌ 无效 apiFormat: ${apiFormat}\n可选: ${validFormats.join(", ")}`);
                  return;
                }
                const model = subArgs[3];
                const baseUrl = subArgs[4];
                const apiKey = subArgs[5] ?? ""; // apiKey can also be added later via addkey
                customProviders[name] = {
                  apiFormat,
                  model,
                  baseUrl,
                  apiKey,
                  apiKeys: apiKey ? [apiKey] : [],
                };
                engine.updateConfig({ customProviders });
                // Auto-switch to new provider if none active
                if (!engine.getConfig().provider) {
                  engine.updateConfig({ provider: name });
                }
                await ctx.reply(`✅ 自定义供应商 "${name}" 已添加 (${apiFormat})\n用 /llm customprovider addkey ${name} <key> 添加更多密钥`);
                return;
              }

              if (action === "remove") {
                if (!subArgs[1]) { await ctx.reply("用法: /llm customprovider remove <名称>"); return; }
                if (!customProviders[subArgs[1]]) { await ctx.reply(`未找到: ${subArgs[1]}`); return; }
                delete customProviders[subArgs[1]];
                engine.updateConfig({ customProviders });
                await ctx.reply(`✅ 已移除: ${subArgs[1]}`);
                return;
              }

              if (action === "addkey") {
                if (subArgs.length < 3) { await ctx.reply("用法: /llm customprovider addkey <名称> <key>"); return; }
                const name = subArgs[1];
                if (!customProviders[name]) { await ctx.reply(`未找到: ${name}`); return; }
                const pool = customProviders[name].apiKeys ?? [];
                if (!pool.includes(subArgs[2])) pool.push(subArgs[2]);
                customProviders[name].apiKeys = pool;
                if (!customProviders[name].apiKey) customProviders[name].apiKey = subArgs[2];
                engine.updateConfig({ customProviders });
                await ctx.reply(`✅ 密钥已添加到 "${name}" (共 ${pool.length} 个)`);
                return;
              }

              if (action === "removekey") {
                if (subArgs.length < 3) { await ctx.reply("用法: /llm customprovider removekey <名称> <索引>"); return; }
                const name = subArgs[1];
                if (!customProviders[name]) { await ctx.reply(`未找到: ${name}`); return; }
                const pool = customProviders[name].apiKeys ?? [];
                const idx = parseInt(subArgs[2], 10);
                if (isNaN(idx) || idx < 0 || idx >= pool.length) { await ctx.reply(`无效索引 (0-${pool.length - 1})`); return; }
                pool.splice(idx, 1);
                customProviders[name].apiKeys = pool;
                engine.updateConfig({ customProviders });
                await ctx.reply(`✅ 已移除 (剩 ${pool.length} 个)`);
                return;
              }

              if (action === "use") {
                if (!subArgs[1]) { await ctx.reply("用法: /llm customprovider use <名称>"); return; }
                if (!customProviders[subArgs[1]]) { await ctx.reply(`未找到: ${subArgs[1]}`); return; }
                engine.updateConfig({ provider: subArgs[1] });
                await ctx.reply(`✅ 已切换到: ${subArgs[1]}`);
                return;
              }

              await ctx.reply(
                "用法:\n" +
                "  /llm customprovider list                                    列出\n" +
                "  /llm customprovider add <名称> <apiFormat> <model> <baseUrl> [apiKey]  添加\n" +
                "  /llm customprovider remove <名称>                           移除\n" +
                "  /llm customprovider addkey <名称> <key>                     添加密钥\n" +
                "  /llm customprovider removekey <名称> <索引>                 移除密钥\n" +
                "  /llm customprovider use <名称>                              切换\n\n" +
                "apiFormat: openai-chat-completions | anthropic-messages | google-gemini-rest | aws-bedrock-converse | azure-openai",
              );
              return;
            }
            case "config":
            case "配置": {
              // Interactive LLM config wizard (blocking, like /init)
              // Delegates to the same wizard session mechanism as /init
              const llmWizardSessions = (cmdSys as unknown as { _llmWizardSessions?: Map<string, unknown> })._llmWizardSessions;
              if (!llmWizardSessions) {
                await ctx.reply("❌ LLM 配置向导不可用");
                return;
              }
              const userId = ctx.message.fromUserId;
              const sessionKey = ctx.message.chatType === "group" && ctx.groupCode ? `${userId}:group:${ctx.groupCode}` : `${userId}:dm`;

              // Cancel
              if (subArgs[0]?.toLowerCase() === "cancel") {
                llmWizardSessions.delete(sessionKey);
                await ctx.reply("✅ LLM 配置向导已取消");
                return;
              }

              // Start wizard
              llmWizardSessions.set(sessionKey, {
                step: "apiFormat",
                startedAt: Date.now(),
              });

              await ctx.reply(
                `🤖 LLM 配置向导已启动（阻塞模式）\n\n` +
                `接下来的对话将被向导捕获。\n\n` +
                `请选择 API 格式 (发送编号或名称):\n` +
                `  1. openai-chat-completions (OpenAI/DeepSeek/Moonshot等)\n` +
                `  2. anthropic-messages (Claude)\n` +
                `  3. google-gemini-rest (Gemini)\n` +
                `  4. aws-bedrock-converse (Bedrock)\n` +
                `  5. azure-openai (Azure OpenAI)\n\n` +
                `随后需要提供: 供应商名称、模型名称、端点URL、API密钥\n` +
                `随时发送 /llm config cancel 取消`,
              );

              // Auto-cancel after 5 min
              setTimeout(() => {
                const session = llmWizardSessions.get(sessionKey) as { startedAt: number } | undefined;
                if (session && Date.now() - session.startedAt > 5 * 60 * 1000) {
                  llmWizardSessions.delete(sessionKey);
                }
              }, 5 * 60 * 1000);
              return;
            }
            case "group":
            case "群聊": {
              if (subArgs[0] === "on") {
                engine.updateConfig({ enableInGroup: true });
                await ctx.reply("✅ LLM 群聊响应已开启");
              } else if (subArgs[0] === "off") {
                engine.updateConfig({ enableInGroup: false });
                await ctx.reply("✅ LLM 群聊响应已关闭");
              } else if (subArgs[0] === "mention") {
                const val = subArgs[1];
                if (val === "on" || val === "true") {
                  engine.updateConfig({ requireMentionInGroup: true });
                  await ctx.reply("✅ 群聊需@才回复");
                } else if (val === "off" || val === "false") {
                  engine.updateConfig({ requireMentionInGroup: false });
                  await ctx.reply("✅ 群聊无需@即可回复");
                }
              } else {
                await ctx.reply("用法: /llm group <on|off|mention> [on|off]");
              }
              break;
            }
            case "merge":
            case "合并": {
              const cfg = engine.getConfig();
              if (subArgs.length === 0) {
                await ctx.reply(`当前合并窗口: ${cfg.mergeWindowMs}ms (0=不等待，立即响应)`);
              } else {
                const ms = parseInt(subArgs[0], 10);
                if (isNaN(ms) || ms < 0) {
                  await ctx.reply("用法: /llm merge <毫秒数> (0=不等待)");
                } else {
                  engine.updateConfig({ mergeWindowMs: ms });
                  await ctx.reply(`✅ 合并窗口已设为: ${ms}ms${ms === 0 ? " (立即响应)" : ""}`);
                }
              }
              break;
            }
            case "cooldown":
            case "冷却": {
              const cfg = engine.getConfig();
              if (subArgs.length === 0) {
                await ctx.reply(`当前冷却时间: ${cfg.cooldownMs}ms (0=无冷却)`);
              } else {
                const ms = parseInt(subArgs[0], 10);
                if (isNaN(ms) || ms < 0) {
                  await ctx.reply("用法: /llm cooldown <毫秒数> (0=无冷却)");
                } else {
                  engine.updateConfig({ cooldownMs: ms });
                  await ctx.reply(`✅ 冷却时间已设为: ${ms}ms${ms === 0 ? " (无冷却)" : ""}`);
                }
              }
              break;
            }
            case "iterate":
            case "迭代": {
              const cfg = engine.getConfig();
              if (subArgs.length === 0) {
                await ctx.reply(`当前最大迭代轮数: ${cfg.maxIterate === 0 ? "无限" : cfg.maxIterate} (0=无限)`);
              } else {
                const n = parseInt(subArgs[0], 10);
                if (isNaN(n) || n < 0) {
                  await ctx.reply("用法: /llm iterate <轮数> (0=无限)");
                } else {
                  engine.updateConfig({ maxIterate: n });
                  await ctx.reply(`✅ 最大迭代轮数已设为: ${n === 0 ? "无限" : n}`);
                }
              }
              break;
            }
            case "reset":
            case "重置": {
              // /llm reset — clear ALL LLM configuration
              // This is a destructive operation. CLI source executes immediately;
              // chat source requires 3x confirmation (same as /daemon restart).
              const fs = await import("node:fs");
              const pathMod = await import("node:path");
              const os = await import("node:os");
              const llmConfigPath = pathMod.join(os.homedir(), ".yuanbao-lite", "llm-config.json");

              const doReset = async (): Promise<void> => {
                try {
                  // Clear in-memory engine config (this re-persists the file
                  // with empty providers, so we delete the file AFTER)
                  engine.updateConfig({
                    provider: "",
                    customProviders: {},
                    enabled: true,
                  });
                  // Delete the persisted config file (after updateConfig re-created it)
                  if (fs.existsSync(llmConfigPath)) {
                    fs.unlinkSync(llmConfigPath);
                  }
                  await ctx.reply("✅ 已清空所有LLM配置\n发送 /llm config 重新配置供应商\n发送 /daemon restart (3次) 让更改生效");
                } catch (err) {
                  await ctx.reply(`❌ 清空LLM配置失败: ${(err as Error).message}`);
                }
              };

              // CLI executes immediately; chat requires 3x confirmation
              if (ctx.source === "cli") {
                await doReset();
              } else {
                const confirmations = (cmdSys as unknown as { _llmResetConfirmations?: Map<string, { count: number; firstAt: number }> })._llmResetConfirmations;
                if (!confirmations) {
                  await ctx.reply("❌ 确认机制不可用");
                  return;
                }
                const userId = ctx.message.fromUserId;
              const sessionKey = ctx.message.chatType === "group" && ctx.groupCode ? `${userId}:group:${ctx.groupCode}` : `${userId}:dm`;
                const now = Date.now();
                const entry = confirmations.get(userId);
                const WINDOW_MS = 60_000;
                const REQUIRED = 3;
                if (!entry || now - entry.firstAt > WINDOW_MS) {
                  confirmations.set(userId, { count: 1, firstAt: now });
                  await ctx.reply(`⚠️ 确认清空LLM配置 (1/${REQUIRED})\n请在 ${WINDOW_MS / 1000}s 内再发送 ${REQUIRED - 1} 次 /llm reset 以确认\n⚠️ 此操作将删除所有供应商配置，不可恢复`);
                  return;
                }
                entry.count++;
                if (entry.count < REQUIRED) {
                  await ctx.reply(`⚠️ 确认清空LLM配置 (${entry.count}/${REQUIRED})\n还需 ${REQUIRED - entry.count} 次确认`);
                  return;
                }
                // Confirmed — execute
                confirmations.delete(userId);
                await doReset();
              }
              break;
            }
            default:
              await ctx.reply(`未知LLM子命令: ${subCmd}。使用 /llm help 查看帮助`);
          }
        },
      });

  // ─── LLM interactive config wizard session setup ───
  // This MUST be set up so /llm config can find _llmWizardSessions.
  // The wizard input handler is called by YuanbaoBot.handleDispatch when a
  // user has an active session (intercepts non-slash messages).

  // Set up the /llm reset confirmation tracking map
  (cmdSys as unknown as { _llmResetConfirmations: Map<string, { count: number; firstAt: number }> })._llmResetConfirmations = new Map();

  type LlmWizardSession = {
    step: "apiFormat" | "name" | "model" | "baseUrl" | "apiKey" | "systemPrompt" | "done";
    apiFormat?: string;
    providerName?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    startedAt: number;
  };
  const llmWizardSessions = new Map<string, LlmWizardSession>();
  (cmdSys as unknown as { _llmWizardSessions: Map<string, unknown> })._llmWizardSessions = llmWizardSessions;

  (cmdSys as unknown as { _handleLlmWizardInput: (bot: unknown, sessionKey: string, text: string, reply: (t: string) => Promise<void>) => Promise<boolean> })._handleLlmWizardInput =
    async (bot: unknown, sessionKey: string, text: string, reply: (t: string) => Promise<void>): Promise<boolean> => {
      const session = llmWizardSessions.get(sessionKey);
      if (!session) return false;

      if (Date.now() - session.startedAt > 5 * 60 * 1000) {
        llmWizardSessions.delete(sessionKey);
        await reply("⏰ LLM 配置向导已超时（5分钟），请重新发送 /llm config");
        return true;
      }

      const engine = (bot as { getLlmEngine?: () => unknown }).getLlmEngine?.() as
        { updateConfig: (patch: Record<string, unknown>) => void; getConfig: () => Record<string, unknown> } | null;
      if (!engine) {
        llmWizardSessions.delete(sessionKey);
        await reply("❌ LLM 引擎未初始化");
        return true;
      }

      const input = text.trim();

      // Step 1: Choose API format
      if (session.step === "apiFormat") {
        const { API_FORMATS } = await import("../../../business/llm-takeover.js");
        const formatMap: Record<string, string> = {};
        API_FORMATS.forEach((f, i) => {
          formatMap[String(i + 1)] = f.value;
          formatMap[f.value] = f.value;
          if (f.value === "openai-chat-completions") { formatMap["openai"] = f.value; formatMap["1"] = f.value; }
          if (f.value === "anthropic-messages") { formatMap["anthropic"] = f.value; formatMap["claude"] = f.value; formatMap["2"] = f.value; }
          if (f.value === "google-gemini-rest") { formatMap["gemini"] = f.value; formatMap["google"] = f.value; formatMap["3"] = f.value; }
          if (f.value === "aws-bedrock-converse") { formatMap["bedrock"] = f.value; formatMap["aws"] = f.value; formatMap["4"] = f.value; }
          if (f.value === "azure-openai") { formatMap["azure"] = f.value; formatMap["5"] = f.value; }
        });
        const apiFormat = formatMap[input.toLowerCase()];
        if (!apiFormat) {
          await reply(`❌ 无效选择: ${input}\n请发送 1-5 或格式名称`);
          return true;
        }
        session.apiFormat = apiFormat;
        session.step = "name";
        await reply(`✅ API 格式: ${apiFormat}\n\n📝 请发送供应商名称 (如 my-openai, backup-claude):`);
        return true;
      }

      // Step 2: Provider name
      if (session.step === "name") {
        session.providerName = input;
        session.step = "model";
        await reply(`✅ 供应商名称: ${input}\n\n📝 请发送模型名称 (如 gpt-4o, claude-sonnet-4-20250514):`);
        return true;
      }

      // Step 3: Model name
      if (session.step === "model") {
        session.model = input;
        session.step = "baseUrl";
        const { API_FORMATS } = await import("../../../business/llm-takeover.js");
        const fmt = API_FORMATS.find(f => f.value === session.apiFormat);
        const hint = fmt?.defaultEndpoint ? `\n(默认: ${fmt.defaultEndpoint})` : "";
        await reply(`✅ 模型: ${input}\n\n📝 请发送端点 URL (baseUrl):${hint}`);
        return true;
      }

      // Step 4: Base URL
      if (session.step === "baseUrl") {
        session.baseUrl = input;
        session.step = "apiKey";
        await reply(`✅ 端点: ${input}\n\n📝 请发送 API Key:`);
        return true;
      }

      // Step 5: API Key
      if (session.step === "apiKey") {
        session.apiKey = input;
        const config = engine.getConfig() as { customProviders?: Record<string, unknown> };
        const customProviders = { ...(config.customProviders ?? {}) };
        customProviders[session.providerName!] = {
          apiFormat: session.apiFormat,
          model: session.model,
          baseUrl: session.baseUrl,
          apiKey: input,
          apiKeys: [input],
        };
        engine.updateConfig({ customProviders, provider: session.providerName });
        session.step = "systemPrompt";
        await reply(
          `✅ 供应商 "${session.providerName}" 已创建!\n` +
          `  API格式: ${session.apiFormat}\n` +
          `  模型: ${session.model}\n` +
          `  端点: ${session.baseUrl}\n` +
          `  密钥: ***${input.slice(-4)}\n\n` +
          `📝 请发送系统提示词 (或 skip 使用默认):`,
        );
        return true;
      }

      // Step 6: System prompt (optional)
      if (session.step === "systemPrompt") {
        if (input.toLowerCase() !== "skip" && input.toLowerCase() !== "done") {
          engine.updateConfig({ systemPrompt: input });
        }
        session.step = "done";
        llmWizardSessions.delete(sessionKey);
        await reply(
          `✅ LLM 配置完成!\n` +
          `  供应商: ${session.providerName} (${session.apiFormat})\n` +
          `  模型: ${session.model}\n\n` +
          `发送 /llm on 开启自动回复\n` +
          `发送 /llm status 查看状态`,
        );
        return true;
      }

      return true;
    };
}
