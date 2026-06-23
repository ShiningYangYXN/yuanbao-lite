/**
 * /search command handler — unified search dispatcher.
 * Category: group
 *
 * Sub-commands:
 *   - /search groups   <关键词> [群号1,群号2,...]  — 模糊搜索群组（远程 API）
 *   - /search members  <关键词> [群号]              — 模糊搜索群成员（远程 API）
 *   - /search history  <关键词>                     — 搜索消息历史（原 /hsearch, /history search）
 *   - /search stickers <关键词>                     — 搜索贴纸（原 /stickers search）
 *   - /search contacts <关键词>                     — 搜索已保存的联系人（原 /contacts search）
 *   - /search savedgroups <关键词>                  — 搜索已保存的群聊（原 /groups search）
 *
 * Back-compat aliases:
 *   /hsearch, /搜索历史, /histsearch → 等价于 /search history
 *
 * The history, stickers, contacts, and savedgroups sub-commands do not
 * require an active connection. The groups/members sub-commands perform
 * their own connection check.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory, CommandContext } from "../../types.js";
import { shortId, textOrDefault, truncate } from "../../../shared/helpers.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "search",
    aliases: ["搜索", "查找", "hsearch", "搜索历史", "histsearch"],
    description: "统一搜索：群组 / 群成员 / 消息历史 / 贴纸",
    usage:
      "/search <groups|members|history|stickers|contacts|savedgroups> <关键词> [参数]\n" +
      "  /search groups <关键词> [群号1,群号2,...]  — 远程群组\n" +
      "  /search members <关键词> [群号]             — 远程群成员\n" +
      "  /search history [--all] <关键词>            — 消息历史\n" +
      "  /search stickers <关键词>                   — 贴纸\n" +
      "  /search contacts <关键词>                   — 已保存的联系人\n" +
      "  /search savedgroups <关键词>                — 已保存的群聊",
    category: "group" as CommandCategory,
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
        case "stickers":
        case "sticker":
        case "贴纸": {
          await runStickersSearch(ctx, ctx.args.slice(1));
          break;
        }
        case "contacts":
        case "contact":
        case "联系人": {
          await runContactsSearch(ctx, ctx.args.slice(1));
          break;
        }
        case "savedgroups":
        case "savedgroup":
        case "saved群":
        case "已存群": {
          await runSavedGroupsSearch(ctx, ctx.args.slice(1));
          break;
        }
        default:
          await ctx.reply(
            "用法: /search <groups|members|history|stickers|contacts|savedgroups> <关键词> [参数]\n" +
              "  /search groups <关键词> [群号1,群号2,...]  — 远程群组\n" +
              "  /search members <关键词> [群号]             — 远程群成员\n" +
              "  /search history [--all] <关键词>            — 消息历史\n" +
              "  /search stickers <关键词>                   — 贴纸\n" +
              "  /search contacts <关键词>                   — 已保存的联系人\n" +
              "  /search savedgroups <关键词>                — 已保存的群聊",
          );
      }
    },
  });
}

// ─── groups ───

async function runGroupsSearch(ctx: SearchContext): Promise<void> {
  if (ctx.args.length < 2) {
    await ctx.reply("用法: /search groups <关键词> [群号1,群号2,...]");
    return;
  }

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
    await ctx.reply(`🔍 成员搜索结果 (${groupCode}):\n${lines.join("\n")}`);
  }
}

// ─── history (merged from /hsearch) ───

async function runHistorySearch(
  ctx: SearchContext,
  keywordArgs: string[],
): Promise<void> {
  if (keywordArgs.length === 0) {
    await ctx.reply(
      "用法: /search history <关键词>   (用 --all 显示全部及完整文本)",
    );
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
      const text = ctx.showAll
        ? textOrDefault(msg.text)
        : truncate(textOrDefault(msg.text), 50);
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

// ─── stickers (merged from /stickers search) ───

async function runStickersSearch(
  ctx: SearchContext,
  keywordArgs: string[],
): Promise<void> {
  if (keywordArgs.length === 0) {
    await ctx.reply("用法: /search stickers <关键词>");
    return;
  }

  const query = keywordArgs.join(" ");
  const { searchStickersUnified } = await import("../../../business/search.js");
  const results = await searchStickersUnified(query);

  if (results.length === 0) {
    await ctx.reply(`未找到匹配 "${query}" 的贴纸`);
    return;
  }

  const maxStickers = ctx.showAll ? results.length : 20;
  const display = results.slice(0, maxStickers);

  if (ctx.useTable) {
    const rows = display.map((s) => [
      s.id,
      s.name,
      s.description ? s.description.split(/\s+/).slice(0, 3).join(" ") : "",
    ]);
    await ctx.reply(
      `🎨 贴纸搜索结果 (${results.length} 个)\n${await ctx.formatTable(["编号", "名称", "描述"], rows)}`,
    );
  } else {
    const lines = display.map(
      (s) =>
        `  ${s.id} — ${s.name}${s.description ? ` (${s.description.split(/\s+/).slice(0, 3).join(" ")})` : ""}`,
    );
    const suffix =
      !ctx.showAll && results.length > 20
        ? `\n  ... 及其他 ${results.length - 20} 个 (用 /search stickers --all 查看全部)`
        : "";
    await ctx.reply(`🎨 贴纸搜索结果:\n${lines.join("\n")}${suffix}`);
  }
}

// ─── contacts (merged from /contacts search) ───

async function runContactsSearch(
  ctx: SearchContext,
  keywordArgs: string[],
): Promise<void> {
  if (keywordArgs.length === 0) {
    await ctx.reply("用法: /search contacts <关键词>");
    return;
  }
  const query = keywordArgs.join(" ");
  const store = ctx.bot.getContactStore();
  const results = store.search(query);
  if (results.length === 0) {
    await ctx.reply("未找到匹配的联系人");
    return;
  }
  const lines = results.map((c) => {
    const fav = c.favorite ? "⭐" : " ";
    return `  ${fav} ${c.name} -> ${c.id.substring(0, 30)}${c.tag ? ` [${c.tag}]` : ""}`;
  });
  await ctx.reply(`📇 联系人搜索结果:\n${lines.join("\n")}`);
}

// ─── savedgroups (merged from /groups search) ───

async function runSavedGroupsSearch(
  ctx: SearchContext,
  keywordArgs: string[],
): Promise<void> {
  if (keywordArgs.length === 0) {
    await ctx.reply("用法: /search savedgroups <关键词>");
    return;
  }
  const query = keywordArgs.join(" ");
  const store = ctx.bot.getGroupStore();
  const results = store.search(query);
  if (results.length === 0) {
    await ctx.reply("未找到匹配的群聊");
    return;
  }
  const lines = results.map((g) => {
    const fav = g.favorite ? "⭐" : " ";
    const displayName = g.name || g.groupName || "未知";
    return `  ${fav} ${g.groupCode} — ${displayName}${g.tag ? ` [${g.tag}]` : ""}`;
  });
  await ctx.reply(`📋 已保存群聊搜索结果:\n${lines.join("\n")}`);
}

// ─── helpers ───

type SearchContext = CommandContext;
