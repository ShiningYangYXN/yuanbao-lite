/**
 * /inspect command handler — extracted from registry.ts (lossless split).
 * Category: history
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "inspect",
    aliases: ["检查", "inspect-msg"],
    description: "输出消息在Bot上下文内部的表示法（escape过）",
    usage: "/inspect [消息ID或#尾号]   (无参数=使用被引用的消息)",
    category: "history" as CommandCategory,
    handler: async (ctx) => {
      // Determine target message ID
      let targetMsgId: string | undefined;
      const arg = ctx.args[0];
      if (arg) {
        // Strip leading # if present
        targetMsgId = arg.replace(/^#/, "");
      } else {
        // No args — use the message that THIS command message quoted
        targetMsgId = ctx.message.quoteMsgId;
        if (!targetMsgId) {
          await ctx.reply(
            "用法: /inspect [消息ID或#尾号]\n无参数时需要引用一条消息（回复该消息后执行 /inspect）",
          );
          return;
        }
      }

      // Search history for the message by full ID or suffix (last 8 chars)
      const historyStore = ctx.bot.getHistoryStore();
      const allHistory = historyStore.getHistory();
      // Normalize: strip leading # and any whitespace
      const normalizedTarget = targetMsgId.trim();
      let foundMsg = allHistory.find((m) => m.id === normalizedTarget);
      if (!foundMsg) {
        // Try suffix match (last 8+ chars of the ID)
        // The Yuanbao message ID format is like "144115441903907777-1781854337-65638922"
        // Users may provide just the last segment or last 8 chars.
        const suffix = normalizedTarget.slice(-8);
        if (suffix.length >= 3) {
          // require at least 3 chars for suffix match
          foundMsg = allHistory.find(
            (m) =>
              m.id &&
              (m.id.endsWith(suffix) || m.id.includes(normalizedTarget)),
          );
        }
      }
      if (!foundMsg) {
        await ctx.reply(
          `❌ 未找到消息: ${normalizedTarget}\n提示: 消息ID可在历史记录中查看（/history）\n可使用完整ID或ID尾号（至少3位）`,
        );
        return;
      }

      // Build the internal representation (same format as feedLlmContext)
      const { formatChatMessageForContext } =
        await import("../../../business/llm-takeover.js");
      const internalRep = formatChatMessageForContext(foundMsg);
      // Also include raw field dump for debugging
      const rawDump = JSON.stringify(
        {
          id: foundMsg.id,
          fromUserId: foundMsg.fromUserId,
          fromNickname: foundMsg.fromNickname,
          chatType: foundMsg.chatType,
          groupCode: foundMsg.groupCode,
          groupName: foundMsg.groupName,
          timestamp: foundMsg.timestamp,
          isMentioned: foundMsg.isMentioned,
          mentions: foundMsg.mentions,
          quoteMsgId: foundMsg.quoteMsgId,
          quoteMsgSeq: foundMsg.quoteMsgSeq,
          text: foundMsg.text,
        },
        null,
        2,
      );

      // Escape the output so @mention syntax in the message is not interpreted
      const { escapeMentionSyntax } =
        await import("../../../business/mention.js");
      const escapedRep = escapeMentionSyntax(internalRep);
      const escapedDump = escapeMentionSyntax(rawDump);

      // Wrap in ```yuanbao-lite code block
      const output =
        "```yuanbao-lite\n" +
        `# 内部表示法 (context format)\n${escapedRep}\n\n` +
        `# 原始字段 dump\n${escapedDump}\n` +
        "```";
      await ctx.reply(output);
    },
  });
}
