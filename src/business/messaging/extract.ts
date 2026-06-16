/**
 * Message extraction and conversion utilities.
 *
 * Converts raw YuanbaoInboundMessage into simplified ChatMessage
 * and provides helper functions for message body extraction.
 */

import type {
  YuanbaoInboundMessage,
  YuanbaoMsgBodyElement,
  ChatMessage,
  MentionInfo,
} from "../../types.js";
import { extractMentionsFromMsgBody } from "../mention.js";

/**
 * Extract plain text content from a YuanbaoMsgBodyElement array.
 *
 * Concatenates all TIMTextElem elements into a single string.
 * Falls back to desc or other text-like fields when no text element is found.
 */
export function extractTextFromMsgBody(msgBody: YuanbaoMsgBodyElement[] | undefined): string {
  if (!msgBody || !Array.isArray(msgBody) || msgBody.length === 0) {
    return "";
  }

  const textParts: string[] = [];
  for (const el of msgBody) {
    if (el.msg_type === "TIMTextElem" && el.msg_content?.text) {
      textParts.push(el.msg_content.text);
    }
  }

  if (textParts.length > 0) {
    return textParts.join("");
  }

  // Fallback: try desc or other fields
  for (const el of msgBody) {
    if (el.msg_content?.desc) {
      textParts.push(el.msg_content.desc);
    }
  }

  return textParts.join("");
}

/**
 * Check if the message mentions the bot by looking at the msg_body for @mention patterns.
 *
 * In the Yuanbao IM protocol, mentions are typically represented as:
 * - TIMCustomElem with elem_type=1002 containing user_id
 * - cloud_custom_data with groupAtInfo containing groupAtUserIds
 *
 * Since we don't have the bot ID here, we check if ANY mention exists.
 * The caller (handleDispatch) will refine this by checking if the bot's
 * specific ID is in the mentions list.
 */
export function isBotMentioned(msg: YuanbaoInboundMessage): boolean {
  const mentions = extractMentionsFromMsgBody(msg.msg_body, msg.cloud_custom_data);
  return mentions.length > 0;
}

/**
 * Extract quote/reply information from a YuanbaoInboundMessage.
 *
 * In the Yuanbao IM protocol, quote/reply info can be found in:
 * - cloud_custom_data: JSON string containing reply message reference
 * - msg_body elements with TIMRelayElem type
 *
 * @returns Quote info if present, undefined otherwise
 */
function extractQuoteInfo(msg: YuanbaoInboundMessage): { quoteMsgId?: string; quoteMsgSeq?: number } {
  // Try cloud_custom_data first
  if (msg.cloud_custom_data) {
    try {
      const customData = JSON.parse(msg.cloud_custom_data) as Record<string, unknown>;
      // Common patterns for reply info in cloud_custom_data
      const id = customData.replyMsgId || customData.ref_msg_id || customData.msgId;
      if (id && typeof id === "string") {
        const seq = customData.replyMsgSeq || customData.ref_msg_seq || customData.msgSeq;
        return {
          quoteMsgId: id,
          quoteMsgSeq: typeof seq === "number" ? seq : undefined,
        };
      }
      // Some platforms nest it under a "reply" key
      const reply = customData.reply as Record<string, unknown> | undefined;
      if (reply) {
        const replyId = reply.msgId || reply.ref_msg_id;
        const replySeq = reply.msgSeq || reply.ref_msg_seq;
        return {
          quoteMsgId: typeof replyId === "string" ? replyId : undefined,
          quoteMsgSeq: typeof replySeq === "number" ? replySeq : undefined,
        };
      }
    } catch {
      // Not valid JSON, ignore
    }
  }

  // Try msg_body for relay/reply elements
  if (msg.msg_body && Array.isArray(msg.msg_body)) {
    for (const el of msg.msg_body) {
      if (el.msg_type === "TIMRelayElem" || el.msg_type === "TIMReplyElem") {
        const content = el.msg_content as Record<string, unknown> | undefined;
        if (content) {
          const id = content.msg_id || content.ref_msg_id || content.uuid;
          const seq = content.msg_seq || content.ref_msg_seq;
          return {
            quoteMsgId: typeof id === "string" ? id : undefined,
            quoteMsgSeq: typeof seq === "number" ? seq : undefined,
          };
        }
      }
    }
  }

  return {};
}

/**
 * Convert a YuanbaoInboundMessage to a simplified ChatMessage.
 *
 * This is the primary interface for consumers who want a clean,
 * easy-to-use message structure without dealing with the raw IM protocol.
 */
export function toChatMessage(msg: YuanbaoInboundMessage): ChatMessage {
  const isGroup = Boolean(msg.group_code) ||
    Boolean(msg.callback_command?.startsWith("Group.")) ||
    msg.claw_msg_type === 1;

  const text = extractTextFromMsgBody(msg.msg_body);
  const quoteInfo = extractQuoteInfo(msg);

  // Extract mention info from cloud_custom_data and msg_body
  const rawMentions = extractMentionsFromMsgBody(msg.msg_body, msg.cloud_custom_data);
  const mentions: MentionInfo[] | undefined = rawMentions.length > 0
    ? rawMentions.map(m => ({ userId: m.userId, displayName: m.displayName, explicitNickname: m.explicitNickname }))
    : undefined;

  return {
    id: msg.msg_id || msg.msg_key || "",
    fromUserId: msg.from_account || "",
    fromNickname: msg.sender_nickname,
    chatType: isGroup ? "group" : "direct",
    groupCode: msg.group_code,
    groupName: msg.group_name,
    text,
    rawBody: msg.msg_body,
    timestamp: (msg.msg_time || msg.event_time || 0) * 1000,
    isMentioned: isBotMentioned(msg),
    mentions,
    raw: msg,
    quoteMsgId: quoteInfo.quoteMsgId,
    quoteMsgSeq: quoteInfo.quoteMsgSeq,
  };
}

/**
 * Build a text msg_body element for outbound messages.
 */
export function buildTextMsgBody(text: string): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMTextElem",
      msg_content: { text },
    },
  ];
}

/**
 * Split long text into chunks respecting the Yuanbao character limit.
 *
 * Uses a simple strategy: split at the character limit, preferring
 * natural break points (newlines, spaces) when near the limit.
 */
export function splitTextChunks(text: string, maxChars = 3000): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    // Try to find a natural break point near the limit
    let splitAt = maxChars;

    // Look for newline within the last 200 chars
    const searchRange = remaining.slice(Math.max(0, maxChars - 200), maxChars);
    const lastNewline = searchRange.lastIndexOf("\n");
    if (lastNewline >= 0) {
      splitAt = maxChars - 200 + lastNewline + 1;
    } else {
      // Look for space within the last 100 chars
      const lastSpace = searchRange.lastIndexOf(" ");
      if (lastSpace >= 0) {
        splitAt = maxChars - 200 + lastSpace + 1;
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
