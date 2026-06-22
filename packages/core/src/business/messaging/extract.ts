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
import { storeContent } from "../content-store.js";
import {
  parseForwardMsgData,
  buildForwardRecordsText,
} from "./forward-records.js";

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

/**
 * Sanitize a nickname for safe injection into the @[nick](id) syntax.
 * The mention parser regex `@\[([^\]]*)\]` stops at the first `]`.
 * If a user's nickname contains `]`, the mention would be truncated.
 *
 * We replace `]` and `[` with full-width equivalents (】 and 【) which are
 * visually similar and never appear in the syntax delimiters. This is a
 * display-only transformation — the userId is kept verbatim in the `(id)`
 * part (see note below), so @-notification still works correctly via the
 * TIMCustomElem user_id field.
 *
 * Note: userId is NOT sanitized here. Real Yuanbao user IDs are base64 or
 * hex strings that never contain `)` or `]`. If a malformed userId did
 * contain `)`, that single mention would fail to parse, but it would not
 * pollute other mentions or the text stream.
 */
function sanitizeNickname(s: string): string {
  return s.replace(/]/g, "】").replace(/\[/g, "【");
}

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
        // IMPORTANT: Tencent IM sometimes bundles TIMCustomElem data INSIDE a
        // TIMTextElem's `content.data` field (instead of sending a separate
        // TIMCustomElem). This happens with elem_type=1013 (bot reply marker),
        // elem_type=1002 (@mention), and others. We must check `data` here
        // and process it the same way as a TIMCustomElem, otherwise @mention
        // information is silently lost.
        const embeddedData =
          typeof content.data === "string" ? content.data : undefined;
        if (embeddedData) {
          try {
            const parsed = JSON.parse(embeddedData) as Record<string, unknown>;
            const elemType =
              typeof parsed.elem_type === "number"
                ? parsed.elem_type
                : typeof parsed.elemType === "number"
                  ? parsed.elemType
                  : undefined;
            if (elemType === 1002) {
              // Embedded @mention — inject @[nick](id) syntax in-place
              hasAnyMention = true;
              const userId =
                parsed.user_id != null ? String(parsed.user_id) : undefined;
              const mentionText =
                typeof parsed.text === "string" ? parsed.text : undefined;
              const displayName = mentionText
                ? mentionText.replace(/^@/, "")
                : (userId ?? "");
              if (userId && displayName) {
                textParts.push(
                  `@[${sanitizeNickname(displayName)}](${userId}) `,
                );
              }
            }
          } catch {
            // data is not JSON — ignore
          }
        }
        break;
      }

      case "TIMImageElem": {
        // Image info is in image_info_array
        // Original project logic: prefer index 1 (medium/thumbnail) over
        // index 0 (original) to save bandwidth. Fall back to index 0.
        // type field: 1=original, 2=thumbnail, 3=large (IM convention)
        const infoArray = content.image_info_array as
          | Array<Record<string, unknown>>
          | undefined;
        const selected = infoArray?.[1] ?? infoArray?.[0];
        const uuid =
          typeof content.uuid === "string" ? content.uuid : undefined;
        const url =
          typeof selected?.url === "string" ? selected.url : undefined;
        const width =
          typeof selected?.width === "number" ? selected.width : undefined;
        const height =
          typeof selected?.height === "number" ? selected.height : undefined;
        if (uuid || url) {
          medias.push({ type: "image", uuid, url, width, height });
          // Build media name: {uuid}_{w}_{h} if dimensions available
          const uuidStem = uuid
            ? uuid.replace(/\.[^.]+$/, "")
            : `image${medias.filter((m) => m.type === "image").length}`;
          const ext = uuid
            ? (uuid.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)?.[0] ?? "")
            : "";
          const name =
            width && height
              ? `${uuidStem}_${width}_${height}${ext}`
              : (uuid ??
                `image${medias.filter((m) => m.type === "image").length}`);
          textParts.push(`[image:${name}]`);
        }
        break;
      }

      case "TIMFileElem": {
        const uuid =
          typeof content.uuid === "string" ? content.uuid : undefined;
        const url = typeof content.url === "string" ? content.url : undefined;
        const fileName =
          typeof content.file_name === "string" ? content.file_name : undefined;
        const fileSize =
          typeof content.file_size === "number" ? content.file_size : undefined;
        if (uuid || url) {
          medias.push({ type: "file", uuid, url, fileName, fileSize });
          textParts.push(`[file:${fileName ?? uuid ?? "unknown"}]`);
        }
        break;
      }

      case "TIMVideoFileElem": {
        const uuid =
          typeof content.uuid === "string" ? content.uuid : undefined;
        const url =
          typeof content.video_url === "string" ? content.video_url : undefined;
        medias.push({ type: "video", uuid, url });
        textParts.push("[video]");
        break;
      }

      case "TIMSoundElem": {
        const uuid =
          typeof content.uuid === "string" ? content.uuid : undefined;
        const url = typeof content.url === "string" ? content.url : undefined;
        medias.push({ type: "voice", uuid, url });
        textParts.push("[voice]");
        break;
      }

      case "TIMFaceElem": {
        // Face element: emoji_index + possible sticker data
        const emojiIndex =
          typeof content.emoji_index === "number"
            ? content.emoji_index
            : undefined;
        const data =
          typeof content.data === "string" ? content.data : undefined;
        let emojiName = `emoji:${emojiIndex ?? "?"}`;
        if (data) {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (typeof parsed.name === "string") emojiName = parsed.name;
            else if (typeof parsed.emoji_name === "string")
              emojiName = parsed.emoji_name;
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
        // IMPORTANT: elem_type lives INSIDE content.data (a JSON string), not directly
        // on content. Reading content.elem_type returns undefined and causes @mentions
        // to be misclassified as "[custom:unknown]" — which then breaks slash-command
        // dispatch (text becomes "[custom:unknown]/status" instead of "/status").
        const customData =
          typeof content.data === "string" ? content.data : undefined;
        let elemType: number | undefined = content.elem_type as
          | number
          | undefined;
        // If elem_type not directly on content, parse it from data JSON
        if (elemType === undefined && customData) {
          try {
            const parsed = JSON.parse(customData) as Record<string, unknown>;
            if (typeof parsed.elem_type === "number") {
              elemType = parsed.elem_type;
            } else if (typeof parsed.elemType === "number") {
              elemType = parsed.elemType;
            }
          } catch {
            // data is not JSON — leave elemType undefined
          }
        }

        if (elemType === 1002) {
          // @mention — mark and inject @[nick](id) syntax IN-PLACE so the
          // LLM context preserves the mention position and identity.
          // The TIMCustomElem elem_type=1002 data contains:
          //   { elem_type: 1002, text: "@nickname", user_id: "..." }
          // We inject @[displayName](userId) at this element's position in the
          // text stream, so downstream consumers (LLM context, wizard input)
          // see the mention exactly where it appeared in the original message.
          hasAnyMention = true;
          if (customData) {
            try {
              const parsed = JSON.parse(customData) as Record<string, unknown>;
              const userId =
                parsed.user_id != null ? String(parsed.user_id) : undefined;
              const mentionText: string | undefined =
                typeof parsed.text === "string" ? parsed.text : undefined;
              // displayName: strip leading @ from text, or fallback to userId
              const displayName = mentionText
                ? mentionText.replace(/^@/, "")
                : (userId ?? "");
              if (userId && displayName) {
                // Inject @[displayName](userId) syntax in-place
                // Sanitize ] and ) in displayName/userId to prevent breaking
                // the @[]() syntax (user nicknames can contain these chars)
                textParts.push(
                  `@[${sanitizeNickname(displayName)}](${userId}) `,
                );
              }
            } catch {
              // data is not JSON — can't extract mention info, skip
            }
          }
        } else if (elemType === 1007 || elemType === 1010) {
          // Link card — extract the URL and include it in the text so the
          // recipient (e.g. the LLM config wizard) sees the actual URL, not
          // a useless "[link card]" placeholder. This is critical: when users
          // type a URL in the IM client, Tencent auto-converts it to a link
          // card. If we push "[link card]" to textParts, the wizard receives
          // "[link card]" instead of the real URL, breaking configuration.
          //
          // IMPORTANT: Tencent IM often sends BOTH a TIMTextElem (with the URL
          // as plain text) AND a TIMCustomElem link card (the preview). If we
          // push the URL again from the link card, the wizard receives the URL
          // TWICE (e.g. "https://x.comhttps://x.com"). To avoid this, we only
          // push the URL if it's NOT already present in textParts.
          //
          // GUARD: Only treat as a real link card if the extracted URL looks
          // like an actual URL (starts with http://, https://, or a domain).
          // Tencent sometimes sends elem_type=1007/1010 for non-URL content
          // (e.g. when the user typed @[nick](id) and the platform misparsed
          // it as a markdown link). In that case, the "url" field is actually
          // a user ID, and we should NOT push it as a URL — instead, try to
          // reconstruct the @[nick](id) mention syntax from the title + url.
          let extractedUrl: string | undefined;
          let extractedText: string | undefined;
          if (customData) {
            // Try XML format first (Tencent often uses XML for link cards)
            const urlMatch =
              customData.match(/<url[^>]*>([^<]+)<\/url>/i) ??
              customData.match(/<link[^>]*>([^<]+)<\/link>/i);
            if (urlMatch) extractedUrl = urlMatch[1];
            // Try to extract title/text/desc from XML
            const titleMatch = customData.match(
              /<title[^>]*>([^<]+)<\/title>/i,
            );
            if (titleMatch) extractedText = titleMatch[1];
            if (!extractedText) {
              const descMatch = customData.match(/<desc[^>]*>([^<]+)<\/desc>/i);
              if (descMatch) extractedText = descMatch[1];
            }
            if (!extractedText) {
              const textMatch = customData.match(/<text[^>]*>([^<]+)<\/text>/i);
              if (textMatch) extractedText = textMatch[1];
            }
            // Also try JSON format
            try {
              const parsed = JSON.parse(customData) as Record<string, unknown>;
              if (!extractedUrl && typeof parsed.url === "string")
                extractedUrl = parsed.url;
              if (!extractedUrl && typeof parsed.link === "string")
                extractedUrl = parsed.link;
              if (!extractedText && typeof parsed.text === "string")
                extractedText = parsed.text;
              if (!extractedText && typeof parsed.title === "string")
                extractedText = parsed.title;
              if (!extractedText && typeof parsed.desc === "string")
                extractedText = parsed.desc;
              if (!extractedText && typeof parsed.description === "string")
                extractedText = parsed.description;
              if (!extractedText && typeof parsed.name === "string")
                extractedText = parsed.name;
            } catch {
              // Not JSON — XML already handled above
            }
          }
          // Check if extractedUrl is a real URL (http/https scheme or domain-like)
          const isRealUrl =
            extractedUrl && /^(https?:\/\/|[\w-]+\.[\w-]+)/i.test(extractedUrl);
          if (isRealUrl) {
            linkUrls.push(extractedUrl!);
            // Keep the original URL in text (don't use contentId for web pages).
            // The LLM can use /visit <URL> to fetch and inject cleaned content.
            const alreadyPresent = textParts.some(
              (tp) =>
                tp.includes(extractedUrl!) || extractedUrl!.includes(tp.trim()),
            );
            if (!alreadyPresent) {
              textParts.push(extractedUrl!);
            }
          } else if (extractedText && extractedUrl) {
            // Not a real URL — likely a misparsed @[nick](id) mention.
            // Reconstruct the mention syntax so downstream mention parser
            // can handle it correctly.
            const nick = extractedText.replace(/^@/, "");
            textParts.push(`@[${nick}](${extractedUrl}) `);
            hasAnyMention = true;
          } else if (extractedText) {
            // No URL but has title — only push if not a duplicate
            const alreadyPresent = textParts.some((tp) =>
              tp.includes(extractedText!),
            );
            if (!alreadyPresent) {
              textParts.push(extractedText);
            }
          }
          // If we couldn't extract anything, DON'T push "[link]" — that's the
          // "garbage text" the user complained about. Just skip silently.
        } else if (elemType === 1009) {
          // Forwarded chat records (微信转发聊天记录)
          // Full content is in msg_content.ext_map as base64-encoded protobuf ForwardMsgData.
          // Also try customData JSON for text summary fallback.
          let summary: string | undefined;
          if (customData) {
            try {
              const parsed = JSON.parse(customData) as Record<string, unknown>;
              if (typeof parsed.text === "string") summary = parsed.text;
              else if (typeof parsed.desc === "string") summary = parsed.desc;
            } catch {
              // Not JSON
            }
          }

          // Try to decode full ForwardMsgData from ext_map
          let fullContent = summary ?? "[转发聊天记录]";
          const extMap = content.ext_map as Record<string, unknown> | undefined;
          if (extMap) {
            try {
              const forwardData = parseForwardMsgData(extMap);
              if (forwardData) {
                const built = buildForwardRecordsText(
                  forwardData,
                  forwardData.nick_name,
                );
                if (built) {
                  fullContent = built.text;
                  // Collect media URLs from forwarded records
                  for (const mediaUrl of built.mediaUrls) {
                    medias.push({ type: "file", url: mediaUrl });
                  }
                  for (const linkUrl of built.linkUrls) {
                    if (!linkUrls.includes(linkUrl)) linkUrls.push(linkUrl);
                  }
                }
              }
            } catch {
              // forward-records decode failed — use summary fallback
            }
          }

          const contentId = storeContent(
            "forwarded_records",
            fullContent,
            `forwarded_${Date.now()}`,
          );
          textParts.push(`[content:${contentId} 转发聊天记录]`);
        } else if (customData) {
          // Unknown custom element — try to extract any text content from data
          // before falling back. If nothing can be extracted, skip silently
          // (don't push "[custom:...]" placeholder — that's garbage text that
          // pollutes wizard input and LLM context).
          //
          // GUARD: If the data looks like a misparsed @[nick](id) mention
          // (has text+url but url is not a real URL), reconstruct the mention
          // syntax instead of pushing the url as plain text.
          let extractedText: string | undefined;
          let extractedUrl: string | undefined;
          try {
            const parsed = JSON.parse(customData) as Record<string, unknown>;
            if (typeof parsed.text === "string") extractedText = parsed.text;
            if (typeof parsed.url === "string") extractedUrl = parsed.url;
            else if (typeof parsed.link === "string")
              extractedUrl = parsed.link;
            if (!extractedText && typeof parsed.title === "string")
              extractedText = parsed.title;
            if (!extractedText && typeof parsed.content === "string")
              extractedText = parsed.content;
            if (!extractedText && typeof parsed.desc === "string")
              extractedText = parsed.desc;
            if (!extractedText && typeof parsed.name === "string")
              extractedText = parsed.name;
          } catch {
            // Not JSON — try XML extraction
            const xmlUrlMatch =
              customData.match(/<url[^>]*>([^<]+)<\/url>/i) ??
              customData.match(/<link[^>]*>([^<]+)<\/link>/i);
            if (xmlUrlMatch) extractedUrl = xmlUrlMatch[1];
            const xmlTextMatch =
              customData.match(/<title[^>]*>([^<]+)<\/title>/i) ??
              customData.match(/<text[^>]*>([^<]+)<\/text>/i) ??
              customData.match(/<desc[^>]*>([^<]+)<\/desc>/i);
            if (xmlTextMatch) extractedText = xmlTextMatch[1];
          }
          // Check if this is a misparsed @[nick](id) mention
          const isRealUrl =
            extractedUrl && /^(https?:\/\/|[\w-]+\.[\w-]+)/i.test(extractedUrl);
          if (extractedText && extractedUrl && !isRealUrl) {
            // Reconstruct mention syntax
            const nick = extractedText.replace(/^@/, "");
            textParts.push(`@[${nick}](${extractedUrl}) `);
            hasAnyMention = true;
          } else if (extractedText && extractedText.trim()) {
            // Only push if we extracted real text; skip if empty or just placeholder
            const alreadyPresent = textParts.some((tp) =>
              tp.includes(extractedText!),
            );
            if (!alreadyPresent) {
              textParts.push(extractedText);
            }
          }
          // If no text could be extracted, skip silently — no [custom:...] garbage
        }
        break;
      }

      default: {
        // Unknown element type — try desc fallback
        const desc =
          typeof content.desc === "string" ? content.desc : undefined;
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
export function extractTextFromMsgBody(
  msgBody: YuanbaoMsgBodyElement[] | undefined,
): string {
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
  const mentions = extractMentionsFromMsgBody(
    msg.msg_body,
    msg.cloud_custom_data,
  );
  return mentions.length > 0;
}

/**
 * Extract quote/reply information from a YuanbaoInboundMessage.
 *
 * In the Yuanbao IM protocol, quote/reply info can be found in:
 * - cloud_custom_data: JSON string containing a "quote" object with
 *   { id, seq, type, desc, sender_id, sender_nickname } — this is the
 *   PRIMARY format used by Tencent Yuanbao IM clients.
 * - cloud_custom_data: alternative patterns (replyMsgId, ref_msg_id)
 * - msg_body elements with TIMRelayElem type
 *
 * @returns Quote info if present, undefined otherwise
 */
function extractQuoteInfo(msg: YuanbaoInboundMessage): {
  quoteMsgId?: string;
  quoteMsgSeq?: number;
} {
  // Try cloud_custom_data first
  if (msg.cloud_custom_data) {
    try {
      const customData = JSON.parse(msg.cloud_custom_data) as Record<
        string,
        unknown
      >;

      // PRIMARY format: { quote: { id, seq, type, desc, sender_id, sender_nickname } }
      // This is the standard Tencent Yuanbao IM quote format.
      const quote = customData.quote as Record<string, unknown> | undefined;
      if (quote) {
        const id = quote.id ?? quote.msgId ?? quote.ref_msg_id ?? quote.uuid;
        const seq = quote.seq ?? quote.msgSeq ?? quote.ref_msg_seq;
        if (id !== undefined) {
          return {
            quoteMsgId: String(id),
            quoteMsgSeq: typeof seq === "number" ? seq : undefined,
          };
        }
      }

      // Alternative patterns: replyMsgId, ref_msg_id, msgId at top level
      const id =
        customData.replyMsgId ?? customData.ref_msg_id ?? customData.msgId;
      if (id !== undefined) {
        const seq =
          customData.replyMsgSeq ?? customData.ref_msg_seq ?? customData.msgSeq;
        return {
          quoteMsgId: String(id),
          quoteMsgSeq: typeof seq === "number" ? seq : undefined,
        };
      }

      // Alternative: nested under "reply" key
      const reply = customData.reply as Record<string, unknown> | undefined;
      if (reply) {
        const replyId =
          reply.id ?? reply.msgId ?? reply.ref_msg_id ?? reply.uuid;
        const replySeq = reply.seq ?? reply.msgSeq ?? reply.ref_msg_seq;
        if (replyId !== undefined) {
          return {
            quoteMsgId: String(replyId),
            quoteMsgSeq: typeof replySeq === "number" ? replySeq : undefined,
          };
        }
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
          const id = content.msg_id ?? content.ref_msg_id ?? content.uuid;
          const seq = content.msg_seq ?? content.ref_msg_seq;
          if (id !== undefined) {
            return {
              quoteMsgId: String(id),
              quoteMsgSeq: typeof seq === "number" ? seq : undefined,
            };
          }
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
  const isGroup =
    Boolean(msg.group_code) ||
    Boolean(msg.callback_command?.startsWith("Group.")) ||
    msg.claw_msg_type === 1;

  const extracted = extractContentFromMsgBody(msg.msg_body);
  const quoteInfo = extractQuoteInfo(msg);

  // Extract mention info from cloud_custom_data and msg_body
  const rawMentions = extractMentionsFromMsgBody(
    msg.msg_body,
    msg.cloud_custom_data,
  );
  const mentions: MentionInfo[] | undefined =
    rawMentions.length > 0
      ? rawMentions.map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          explicitNickname: m.explicitNickname,
        }))
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
