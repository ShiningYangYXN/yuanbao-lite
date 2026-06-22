/**
 * /chat command handler — unified message sending.
 * Category: chat
 *
 * Auto-detects the target type:
 *   - 9-digit pure number (regex /^\d{9}$/) → group message
 *   - Otherwise → direct message (resolved via contact store + @-reference)
 *
 * Examples:
 *   /chat 707881071 大家好       → 群消息
 *   /chat @张三 你好              → 私聊（@-reference）
 *   /chat u_abc123 你好           → 私聊（用户ID）
 *   /chat alice 你好              → 私聊（联系人名/别名）
 *
 * IMPORTANT: This handler ONLY sends messages. It does NOT switch sessions.
 * Session switching (entering a focused chat context) is a CLI-only feature
 * implemented in interactive.ts. When a user on the Yuanbao IM platform
 * (DM or group) calls /chat, they can only send a one-off message — they
 * cannot enter a session. The CLI intercepts /chat <target> (no message)
 * locally before it reaches the daemon; if the daemon handler receives
 * /chat with no message, it replies with usage (session switch not
 * available on IM platform).
 *
 * Backward compatibility: /dm and /group are now aliases of /chat. They
 * dispatch to this same handler — no separate code paths.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

const USAGE =
  "/chat <目标> <消息>\n" +
  "  目标为 9 位纯数字 → 群聊\n" +
  "  目标为用户ID/@提及/联系人名 → 私聊\n" +
  "  (仅发送消息，不切换会话。会话切换仅 CLI 支持)";

const GROUP_CODE_RE = /^\d{9}$/;

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "chat",
    aliases: ["聊天", "dm", "私聊", "group", "群发"],
    description:
      "发送消息（自动识别群聊/私聊：9位纯数字=群，其他=私聊）",
    usage: USAGE,
    category: "chat" as CommandCategory,
    requireConnected: true,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply(`用法: ${USAGE}`);
        return;
      }

      const rawTarget = ctx.args[0];

      // Case 1: 9-digit pure number → group message
      if (GROUP_CODE_RE.test(rawTarget.trim())) {
        if (ctx.args.length < 2) {
          await ctx.reply(`用法: /chat <群号> <消息>`);
          return;
        }
        const groupCode = rawTarget.trim();
        const text = ctx.args.slice(1).join(" ");
        try {
          await ctx.bot.sendGroupMessage(groupCode, text);
          await ctx.reply(`✅ 已发送群聊消息到 ${groupCode}`);
        } catch (err) {
          await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
        }
        return;
      }

      // Case 2: direct message (resolve @-reference, then contact store)
      if (ctx.args.length < 2) {
        await ctx.reply(`用法: /chat <用户ID或别名> <消息>`);
        return;
      }
      const rawUserId = await ctx.resolveAtReference(rawTarget);
      const userId = ctx.bot.getContactStore().resolve(rawUserId);
      const text = ctx.args.slice(1).join(" ");
      ctx.bot.getContactStore().touch(rawUserId);
      try {
        await ctx.bot.sendDirectMessage(userId, text);
        await ctx.reply(
          `✅ 已发送私聊消息给 ${rawUserId === userId ? userId : `${rawUserId} (${userId})`}`,
        );
      } catch (err) {
        await ctx.reply(`❌ 发送失败: ${(err as Error).message}`);
      }
    },
  });
}
