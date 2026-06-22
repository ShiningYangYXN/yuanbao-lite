/**
 * /mention command handler — extracted from registry.ts (lossless split).
 * Category: chat
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "mention",
    aliases: ["at", "提及"],
    description: "发送含@提及的消息（支持 @[昵称](id), @[所有人]() 内联语法）",
    usage:
      "/mention <目标> <消息>   消息中可用 @[昵称](id), @[](id), @[昵称](), @[所有人]()",
    category: "chat" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length < 2) {
        await ctx.reply(
          "用法: /mention <目标> <消息>\n消息中可用 @语法:\n  \\@[昵称](id) — 用指定昵称@指定用户\n  \\@[](id) — 用默认昵称@指定用户\n  \\@[昵称]() — 群聊中按昵称自动匹配ID\n  \\@[所有人]() — @所有群成员（逐个展开）",
        );
        return;
      }
      const { targetId: target, isGroup: targetIsGroup } =
        await ctx.resolveTarget(ctx.args[0]);
      const text = ctx.args.slice(1).join(" ");
      try {
        // sendText handles parseMentions internally, including all resolvers
        // for @[昵称]() and @[所有人]() auto-expansion in group contexts
        await ctx.bot.sendText({
          to: target,
          text,
          isGroup: targetIsGroup,
        });

        // Parse mentions from the original text for the confirmation message
        const { parseMentions } = await import("../../../business/mention.js");
        const nicknameResolver =
          targetIsGroup && target
            ? async (nickname: string) => {
                const { SearchEngine } =
                  await import("../../../business/search.js");
                const searchEngine = new SearchEngine(ctx.bot);
                const results = await searchEngine.searchGroupMembers(
                  String(target),
                  nickname,
                );
                return results
                  .filter((r) => r.score >= 0.8)
                  .map((r) => ({ userId: r.userId, nickname: r.nickName }));
              }
            : undefined;
        const allMembersResolver =
          targetIsGroup && target
            ? async () => {
                try {
                  const resp = await ctx.bot.getGroupMemberList(String(target));
                  const members = resp?.member_list ?? [];
                  return members.map((m) => ({
                    userId: m.user_id,
                    nickname: m.nick_name,
                    userType: m.user_type,
                  }));
                } catch {
                  return [];
                }
              }
            : undefined;
        const selfIds = new Set(ctx.bot.getSelfUserIds());
        const parsed = await parseMentions(
          text,
          ctx.bot.getAliasStore(),
          nicknameResolver,
          allMembersResolver,
          undefined,
          selfIds,
        );
        if (parsed.mentions.length > 0) {
          const mentionNames = parsed.mentions
            .map((m) => `@${m.displayName}(${m.userId})`)
            .join(", ");
          const atAllSuffix = parsed.atAll
            ? `（含@所有人，共 ${parsed.mentions.length} 个提及）`
            : "";
          await ctx.reply(
            `✅ 消息已发送，提及了: ${mentionNames}${atAllSuffix}`,
          );
        } else {
          await ctx.reply(`✅ 消息已发送到 ${target}`);
        }
      } catch (err) {
        await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
      }
    },
  });
}
