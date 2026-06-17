/**
 * Message extraction and conversion utilities.
 *
 * Converts raw YuanbaoInboundMessage into simplified ChatMessage
 * and provides helper functions for message body extraction.
 *
 * Supports all message element types:
 *   - TIMTextElem      → plain text
 *   - TIMImageElem     → [image:{uuid}] placeholder + media URL
 *   - TIMFileElem      → [file:{name}] placeholder + media URL
 *   - TIMVideoFileElem → [video] placeholder
 *   - TIMSoundElem     → [voice] placeholder
 *   - TIMFaceElem      → [EMOJI: name] or sticker info
 *   - TIMCustomElem    → @mention (1002), link card (1007/1010), forwarded records (1009)
 */

import type {
  YuanbaoInboundMessage,
  YuanbaoMsgBodyElement,
  ChatMessage,
  MentionInfo,
} from "../../types.js";
import { extractMentionsFromMsgBody } from "../mention.js";

// ─── Structured extraction result ───

export type MediaItem = {
  type: "image" | "file" | "video" | "voice";
  uuid?: string;
  url?: string;
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
};

export type ExtractResult = {
  /** Concatenated text with placeholders for non-text elements */
  text: string;
  /** Extracted media items (images, files, videos, voices) */
  medias: MediaItem[];
  /** Detected link URLs from custom elements (link cards) */
  linkUrls: string[];
  /** Whether the bot is mentioned (any mention, not bot-specific) */
  hasAnyMention: boolean;
};

/**
 * Extract structured content from a YuanbaoMsgBodyElement array.
 *
 * Returns text with placeholders for non-text elements, plus arrays of
 * media items and link URLs. This is the recommended API for new code;
 * extractTextFromMsgBody() is kept for backward compatibility.
 */
export function extractContentFromMsgBody(
  msgBody: YuanbaoMsgBodyElement[] | undefined,
): ExtractResult {
  if (!msgBody || !Array.isArray(msgBody) || msgBody.length === 0) {
    return { text: "", medias: [], linkUrls: [], hasAnyMention: false };
  }

  const textParts: string[] = [];
  const medias: MediaItem[] = [];
  const linkUrls: string[] = [];
  let hasAnyMention = false;

  for (const el of msgBody) {
    const content = el.msg_content as Record<string, unknown> | undefined;
    if (!content) continue;

    switch (el.msg_type) {
      case "TIMTextElem": {
        const text = typeof content.text === "string" ? content.text : "";
        if (text) textParts.push(text);
        break;
      }

      case "TIMImageElem": {
        // Image info is in image_info_array
        const infoArray = content.image_info_array as Array<Record<string, unknown>> | undefined;
        const first = infoArray?.[0];
        const uuid = typeof first?.uuid === "string" ? first.uuid : undefined;
        const url = typeof first?.url === "string" ? first.url : undefined;
        const width = typeof first?.width === "number" ? first.width : undefined;
        const height = typeof first?.height === "number" ? first.height : undefined;
        if (uuid || url) {
          medias.push({ type: "image", uuid, url, width, height });
          textParts.push(`[image:${uuid ?? "unknown"}]`);
        }
        break;
      }

      case "TIMFileElem": {
        const uuid = typeof content.uuid === "string" ? content.uuid : undefined;
        const url = typeof content.url === "string" ? content.url : undefined;
        const fileName = typeof content.file_name === "string" ? content.file_name : undefined;
        const fileSize = typeof content.file_size === "number" ? content.file_size : undefined;
        if (uuid || url) {
          medias.push({ type: "file", uuid, url, fileName, fileSize });
          textParts.push(`[file:${fileName ?? uuid ?? "unknown"}]`);
        }
        break;
      }

      case "TIMVideoFileElem": {
        const uuid = typeof content.uuid === "string" ? content.uuid : undefined;
        const url = typeof content.video_url === "string" ? content.video_url : undefined;
        medias.push({ type: "video", uuid, url });
        textParts.push("[video]");
        break;
      }

      case "TIMSoundElem": {
        const uuid = typeof content.uuid === "string" ? content.uuid : undefined;
        const url = typeof content.url === "string" ? content.url : undefined;
        medias.push({ type: "voice", uuid, url });
        textParts.push("[voice]");
        break;
      }

      case "TIMFaceElem": {
        // Face element: emoji_index + possible sticker data
        const emojiIndex = typeof content.emoji_index === "number" ? content.emoji_index : undefined;
        const data = typeof content.data === "string" ? content.data : undefined;
        let emojiName = `emoji:${emojiIndex ?? "?"}`;
        if (data) {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (typeof parsed.name === "string") emojiName = parsed.name;
            else if (typeof parsed.emoji_name === "string") emojiName = parsed.emoji_name;
          } catch {
            // Not JSON — use raw data as name if short
            if (data.length < 50) emojiName = data;
          }
        }
        textParts.push(`[EMOJI: ${emojiName}]`);
        break;
      }

      case "TIMCustomElem": {
        // Custom element: @mention (1002), link card (1007/1010), forwarded records (1009)
        const elemType = content.elem_type as number | undefined;
        const customData = typeof content.data === "string" ? content.data : undefined;

        if (elemType === 1002) {
          // @mention — mark and let extractMentionsFromMsgBody handle the details
          hasAnyMention = true;
          // Don't add text placeholder — mention info is in mentions[] separately
        } else if (elemType === 1007 || elemType === 1010) {
          // Link card — try to extract URL from XML
          if (customData) {
            const urlMatch = customData.match(/<url[^>]*>([^<]+)<\/url>/i)
              ?? customData.match(/<link[^>]*>([^<]+)<\/link>/i);
            if (urlMatch) {
              linkUrls.push(urlMatch[1]);
            }
            // Also try to extract from JSON
            try {
              const parsed = JSON.parse(customData) as Record<string, unknown>;
              const url = typeof parsed.url === "string" ? parsed.url : undefined;
              if (url) linkUrls.push(url);
            } catch {
              // Not JSON — XML already handled above
            }
          }
          textParts.push("[link card]");
        } else if (elemType === 1009) {
          // Forwarded chat records — would need protobuf decoding for full content
          // For now, just add a placeholder
          textParts.push("[forwarded records]");
        } else if (customData) {
          // Unknown custom element — add as opaque placeholder
          textParts.push(`[custom:${elemType ?? "unknown"}]`);
        }
        break;
      }

      default: {
        // Unknown element type — try desc fallback
        const desc = typeof content.desc === "string" ? content.desc : undefined;
        if (desc) textParts.push(desc);
        break;
      }
    }
  }

  // If no text parts but desc exists in any element, fall back to desc
  if (textParts.length === 0) {
    for (const el of msgBody) {
      const desc = el.msg_content?.desc;
      if (typeof desc === "string" && desc) {
        textParts.push(desc);
      }
    }
  }

  return {
    text: textParts.join(""),
    medias,
    linkUrls,
    hasAnyMention,
  };
}

/**
 * Extract plain text content from a YuanbaoMsgBodyElement array.
 *
 * @deprecated Use extractContentFromMsgBody() for structured access to media/links.
 * This function returns only the text portion (with placeholders for non-text elements).
 */
export function extractTextFromMsgBody(msgBody: YuanbaoMsgBodyElement[] | undefined): string {
  return extractContentFromMsgBody(msgBody).text;
}

/**
 * Check if the message contains any @mention.
 *
 * NOTE: This returns true if ANY user is mentioned, not specifically the bot.
 * For bot-specific mention detection, pass the botId to the caller and check
 * `chatMessage.mentions.some(m => m.userId === botId)` instead.
 *
 * @deprecated Use extractContentFromMsgBody().hasAnyMention or check
 *             chatMessage.mentions directly with the bot's ID.
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

  const extracted = extractContentFromMsgBody(msg.msg_body);
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
    text: extracted.text,
    rawBody: msg.msg_body,
    timestamp: (msg.msg_time || msg.event_time || 0) * 1000,
    isMentioned: extracted.hasAnyMention || rawMentions.length > 0,
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
