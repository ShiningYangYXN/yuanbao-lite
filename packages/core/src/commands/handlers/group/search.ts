/**
 * /search command handler — unified search dispatcher.
 * Category: group
 *
 * Sub-commands:
 *   - /search groups   <关键词> [群号1,群号2,...]  — 模糊搜索群组
 *   - /search members  <关键词> [群号]              — 模糊搜索群成员
 *   - /search history  <关键词>                     — 搜索消息历史（原 /hsearch）
 *
 * Back-compat aliases:
 *   /hsearch, /搜索历史, /histsearch → 等价于 /search history
 *
 * The history sub-command does not require an active connection (it reads
 * from the local MessageHistoryStore), so `requireConnected` is NOT set on
 * this command. The groups/members sub-commands perform their own
 * connection check and emit a friendly error if the bot is offline.
 *
 * Bug fixes folded in during the hsearch ↔ search merge (v12.0.3):
 *   - In table mode, --all now disables the 50-char text truncation
 *     (previously --all was ignored for table rows).
 *   - History results without an `id` no longer render "undefined" — we
 *     fall back to "?" and short-fragment safely.
 *   - The history branch handles empty `msg.text` consistently between
 *     table and plain mode ("(非文本)").
 *   - Empty keyword for history search now prints usage instead of
 *     silently returning "未找到".
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory, CommandContext } from "../../types.js";
import type { ChatMessage } from "../../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "search",
    aliases: ["搜索", "查找", "hsearch", "搜索历史", "histsearch"],
    description:
      "统一搜索：群组 / 群成员 / 消息历史（history 子命令支持 --all 显示完整文本）",
    usage:
      "/search <groups|members|history> <关键词> [参数]\n" +
      "  /search groups <关键词> [群号1,群号2,...]\n" +
      "  /search members <关键词> [群号]\n" +
      "  /search history [--all] <关键词>   (--all/-a 显示全部结果及完整文本)",
    category: "group" as CommandCategory,
    // NOTE: requireConnected intentionally NOT set — the history sub-command
    // works offline. The groups/members branches check connection themselves.
    handler: async (ctx) => {
      // Back-compat: when invoked via /hsearch alias (or its Chinese aliases),
      // there is no sub-command — the entire arg list is the keyword.
      const invokedAs = ctx.command.toLowerCase();
      const isHistoryAlias =
        invokedAs === "hsearch" ||
        invokedAs === "搜索历史" ||
        invokedAs === "histsearch";

      const subCmd = ctx.args[0]?.toLowerCase();

      if (isHistoryAlias) {
        await runHistorySearch(ctx, ctx.args);
        return;
      }

      switch (subCmd) {
        case "groups":
        case "群":
        case "群组": {
          await runGroupsSearch(ctx);
          break;
        }
        case "members":
        case "member":
        case "成员": {
          await runMembersSearch(ctx);
          break;
        }
        case "history":
        case "hist":
        case "历史":
        case "搜索历史":
        case "histsearch": {
          await runHistorySearch(ctx, ctx.args.slice(1));
          break;
        }
        default:
          await ctx.reply(
            "用法: /search <groups|members|history> <关键词> [参数]\n" +
              "  /search groups <关键词> [群号1,群号2,...]\n" +
              "  /search members <关键词> [群号]\n" +
              "  /search history [--all] <关键词>",
          );
      }
    },
  });
}

// ─── groups ───

async function runGroupsSearch(ctx: SearchContext): Promise<void> {
  // args[0] is the sub-command itself
  if (ctx.args.length < 2) {
    await ctx.reply("用法: /search groups <关键词> [群号1,群号2,...]");
    return;
  }

  // Connection check (was previously enforced by requireConnected).
  if (!ctx.bot.getState().connected) {
    await ctx.reply("⚠️ 机器人尚未连接，无法搜索群组");
    return;
  }

  const query = ctx.args[1];
  const groupCodes = ctx.args[2]?.split(",");

  const { SearchEngine } = await import("../../../business/search.js");
  const engine = new SearchEngine(ctx.bot);
  const results = await engine.searchGroups(query, groupCodes);

  if (results.length === 0) {
    await ctx.reply(`未找到匹配 "${query}" 的群组`);
    return;
  }

  if (ctx.useTable) {
    const rows = results.map((r) => [
      r.groupCode,
      r.groupName || "(未知)",
      `${r.groupSize}人`,
      r.matchType,
    ]);
    await ctx.reply(
      `🔍 群组搜索结果 (${results.length} 个)\n${await ctx.formatTable(["群号", "群名", "人数", "匹配类型"], rows)}`,
    );
  } else {
    const lines = results.map(
      (r) =>
        `  ${r.groupCode} — ${r.groupName || "(未知)"} (${r.groupSize}人) [${r.matchType}]`,
    );
    await ctx.reply(`🔍 群组搜索结果:\n${lines.join("\n")}`);
  }
}

// ─── members ───

async function runMembersSearch(ctx: SearchContext): Promise<void> {
  if (ctx.args.length < 2) {
    await ctx.reply("用法: /search members <关键词> [群号]");
    return;
  }

  if (!ctx.bot.getState().connected) {
    await ctx.reply("⚠️ 机器人尚未连接，无法搜索群成员");
    return;
  }

  const query = ctx.args[1];
  const groupCode = ctx.args[2] || ctx.groupCode;
  if (!groupCode) {
    await ctx.reply("请指定群号: /search members <关键词> <群号>");
    return;
  }

  const { SearchEngine } = await import("../../../business/search.js");
  const engine = new SearchEngine(ctx.bot);
  const results = await engine.searchGroupMembers(groupCode, query);

  if (results.length === 0) {
    await ctx.reply(`未在群 ${groupCode} 中找到匹配 "${query}" 的成员`);
    return;
  }

  if (ctx.useTable) {
    const rows = results.map((r) => [
      r.userId,
      r.nickName,
      r.userType === 1
        ? "人类"
        : r.userType === 2
          ? "元宝"
          : r.userType === 3
            ? "龙虾"
            : "?",
      r.matchType,
    ]);
    await ctx.reply(
      `🔍 成员搜索结果 (${groupCode}, ${results.length} 个)\n${await ctx.formatTable(["用户ID", "昵称", "类型", "匹配类型"], rows)}`,
    );
  } else {
    const lines = results.map((r) => {
      const typeLabel =
        r.userType === 1
          ? "[人类]"
          : r.userType === 2
            ? "[元宝]"
            : r.userType === 3
              ? "[龙虾]"
              : "";
      return `  ${r.userId} — ${r.nickName} ${typeLabel} [${r.matchType}]`;
    });
    await ctx.reply(
      `🔍 成员搜索结果 (${groupCode}):\n${lines.join("\n")}`,
    );
  }
}

// ─── history (merged from /hsearch) ───

async function runHistorySearch(
  ctx: SearchContext,
  keywordArgs: string[],
): Promise<void> {
  if (keywordArgs.length === 0) {
    await ctx.reply("用法: /search history <关键词>   (用 --all 显示全部及完整文本)");
    return;
  }

  const keyword = keywordArgs.join(" ");
  const store = ctx.bot.getHistoryStore();
  const results = store.search(
    { keyword, searchNickname: true },
    1,
    ctx.showAll ? 1000 : 20,
  );

  if (results.total === 0) {
    await ctx.reply(`未找到包含 "${keyword}" 的历史消息`);
    return;
  }

  const maxResults = ctx.showAll ? results.messages.length : 15;
  const display = results.messages.slice(0, maxResults);

  if (ctx.useTable) {
    // --all disables the 50-char truncation (was a bug pre-12.0.3).
    const textLimit = ctx.showAll ? undefined : 50;
    const rows = display.map((msg) => [
      shortId(msg),
      new Date(msg.timestamp).toLocaleString("zh-CN"),
      msg.fromNickname || msg.fromUserId,
      truncate(textOrDefault(msg.text), textLimit),
    ]);
    await ctx.reply(
      `🔍 历史搜索结果 (${results.total} 条)\n${await ctx.formatTable(["消息ID", "时间", "发送者", "内容"], rows)}`,
    );
  } else {
    const lines = display.map((msg) => {
      const time = new Date(msg.timestamp).toLocaleString("zh-CN");
      const sender = msg.fromNickname || msg.fromUserId;
      const short = shortId(msg);
      // --all disables the 50-char truncation in plain mode too.
      const text = ctx.showAll ? textOrDefault(msg.text) : truncate(textOrDefault(msg.text), 50);
      return `  [${time}] ${sender}(${msg.fromUserId}) #${short}: ${text}`;
    });
    const suffix =
      !ctx.showAll && results.messages.length > 15
        ? `\n  ... 及其他 ${results.messages.length - 15} 条 (用 /search history --all 查看全部)`
        : "";
    await ctx.reply(
      `🔍 历史搜索结果:\n${lines.join("\n")}${suffix}\n共 ${results.total} 条结果`,
    );
  }
}

// ─── helpers ───

// Use the real CommandContext type from the command system. The history
// branch only needs bot.getHistoryStore(); groups/members branches need
// bot.getState().connected and bot (passed to SearchEngine).
type SearchContext = CommandContext;

function shortId(msg: ChatMessage): string {
  if (!msg.id) return "?";
  return msg.id.length > 8 ? msg.id.slice(-8) : msg.id;
}

function textOrDefault(text: string | undefined): string {
  return text && text.length > 0 ? text : "(非文本)";
}

function truncate(text: string, limit: number | undefined): string {
  if (limit === undefined || text.length <= limit) return text;
  return text.substring(0, limit);
}
