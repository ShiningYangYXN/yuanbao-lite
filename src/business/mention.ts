/**
 * @mention support — parsing and building mention syntax.
 *
 * Syntax:
 *   @[昵称](id)    — mention with explicit nickname and ID
 *   @[](id)        — mention with platform/auto-resolved nickname
 *   @[昵称]()      — auto-resolve ID by nickname in group (requires nicknameResolver)
 *                    If multiple members match, all are @mentioned
 *   @[所有人]()    — @all: auto-expand to every group member (requires groupMembersResolver)
 *   @[](all)       — @all: same as above, alternate syntax
 *   \@             — escaped @, not treated as mention
 *
 * Protocol: In the Tencent IM (Yuanbao) protocol, @ mentions are encoded as:
 *   1. TIMCustomElem with elem_type=1002 in the msg_body
 *      Contains user_id and text (e.g. "@nickname")
 *   2. Additionally, cloud_custom_data can include groupAtInfo for group notifications
 *
 * The TIMCustomElem approach is the PRIMARY mechanism for @ mentions.
 * The cloud_custom_data groupAtInfo is a SECONDARY mechanism for notification triggers.
 * Both should be used together for reliable @ mention functionality.
 */

import { getGlobalAliasStore } from "./alias.js";
import type { AliasStore } from "./alias.js";
import type { YuanbaoMsgBodyElement } from "../types.js";

// ─── Types ───

export type NicknameMatch = {
  /** The resolved user ID */
  userId: string;
  /** The display nickname */
  nickname: string;
};

/**
 * Resolver function for @[昵称]() auto-matching.
 * Given a nickname, returns matching user IDs.
 * In a group context, this searches group members.
 * Multiple matches are returned so all can be @mentioned.
 */
export type NicknameResolver = (nickname: string) => Promise<NicknameMatch[]>;

/**
 * Resolver function for @all syntax (@[所有人]() or @[](all)).
 * Returns all group members for @all expansion.
 */
export type AllMembersResolver = () => Promise<NicknameMatch[]>;

/**
 * Resolver function for @[](id) auto-nickname fetch.
 * Given a userId, returns the member's nickname (or null if not found).
 * Used when @[](id) is used without an explicit nickname — the resolver
 * fetches the member's display name from the group member list.
 */
export type UserIdResolver = (userId: string) => Promise<string | null>;

export type MentionInfo = {
  /** The resolved user ID */
  userId: string;
  /** Display name for the mention (from syntax or alias nickname) */
  displayName: string;
  /** Whether the nickname was explicitly provided (vs. auto-resolved) */
  explicitNickname: boolean;
  /** Start position in the original text */
  startIndex: number;
  /** End position in the original text */
  endIndex: number;
};

export type ParsedMentions = {
  /** The processed text with @mentions converted to IM format */
  text: string;
  /** List of parsed mention information */
  mentions: MentionInfo[];
  /** List of mentioned user IDs (for cloud_custom_data) */
  mentionedUserIds: string[];
  /** Whether @all was requested (for the bot to send groupAtInfo "ALL" flag) */
  atAll: boolean;
};

export type GroupAtInfo = {
  /** The mentioned user ID */
  userId: string;
  /** The display nickname for this mention */
  nickname?: string;
};

// ─── Mention Parser ───

/**
 * Parse @mention syntax from text.
 *
 * Supports:
 *   @[昵称](id)    — mention with explicit nickname and ID
 *   @[](id)        — mention with platform/auto-resolved nickname
 *   @[昵称]()      — auto-resolve ID by nickname (requires nicknameResolver)
 *   @[所有人]()    — @all (requires allMembersResolver)
 *   @[](all)       — @all (alternate syntax, requires allMembersResolver)
 *   \@             — escaped @, not treated as mention
 *
 * When @[昵称]() is used (empty parentheses), the nicknameResolver callback
 * is called to find matching user IDs. If multiple members match the nickname,
 * all of them are @mentioned. This is useful in group chats where you want to
 * @ someone by their display name without knowing their ID.
 *
 * When @[所有人]() or @[](all) is used, the allMembersResolver callback is
 * called to fetch all group members, and each one is @mentioned individually.
 * The returned `atAll` flag is also set to true so the caller can attach the
 * "ALL" groupAtInfo flag for the IM protocol's @all notification.
 */
export async function parseMentions(
  text: string,
  aliasStore?: AliasStore,
  nicknameResolver?: NicknameResolver,
  allMembersResolver?: AllMembersResolver,
  userIdResolver?: UserIdResolver,
): Promise<ParsedMentions> {
  const store = aliasStore ?? getGlobalAliasStore();
  const mentions: MentionInfo[] = [];
  const mentionedUserIds: string[] = [];
  let atAll = false;

  // Regex to match @[nickname](id) or @[](id) or @[nickname]()
  const mentionRegex = /(?<!\\)@\[([^\]]*)\]\(([^)]*)\)/g;

  let match: RegExpExecArray | null;

  // Collect all matches first
  const matches: Array<{
    full: string;
    nickname: string;
    id: string;
    index: number;
  }> = [];

  while ((match = mentionRegex.exec(text)) !== null) {
    matches.push({
      full: match[0],
      nickname: match[1],
      id: match[2],
      index: match.index,
    });
  }

  // Process matches in reverse order to preserve indices
  // For @[昵称]() (empty id), resolve nickname to user IDs
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];

    // ─── @all detection ───
    // @[所有人]()    → nickname="所有人", id=""
    // @[](all)       → nickname="", id="all"
    // @[所有人](all) → nickname="所有人", id="all"  (also valid)
    // @all           → nickname="all", id=""
    const isAtAllSyntax =
      (m.nickname === "所有人" && (m.id === "" || m.id === "all")) ||
      (m.id === "all" && (m.nickname === "" || m.nickname === "所有人")) ||
      (m.nickname === "all" && m.id === "") ||
      (m.id === "所有人" && m.nickname === "");

    if (isAtAllSyntax) {
      if (allMembersResolver) {
        try {
          const allMembers = await allMembersResolver();
          atAll = true;
          // Expand @[所有人]() into individual @nickname tokens for EVERY
          // group member. Each token will later be matched by
          // buildMentionMsgBody's splitRegex and converted into a separate
          // TIMCustomElem (elem_type=1002) so every member actually receives
          // an @ mention notification — not just a single "@所有人" text.
          const displayParts: string[] = [];
          for (const user of allMembers) {
            const mention: MentionInfo = {
              userId: user.userId,
              displayName: user.nickname || user.userId,
              explicitNickname: true,
              startIndex: m.index,
              endIndex: m.index + m.full.length,
            };
            mentions.unshift(mention);
            if (!mentionedUserIds.includes(user.userId)) {
              mentionedUserIds.push(user.userId);
            }
            displayParts.push(`@${user.nickname || user.userId}`);
          }
          // Replace @[所有人]() / @[](all) with "@张三 @李四 ... @王五"
          // (space-separated @displayName tokens). If the group is empty,
          // fall back to a single "@所有人" so the message still reads naturally.
          const replacement = displayParts.length > 0
            ? displayParts.join(" ")
            : `@所有人`;
          text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
          const diff = replacement.length - m.full.length;
          for (let j = 0; j < i; j++) {
            matches[j].index += diff;
          }
        } catch {
          // Resolver failed — leave as plain text
          const replacement = `@所有人`;
          text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
          const diff = replacement.length - m.full.length;
          for (let j = 0; j < i; j++) {
            matches[j].index += diff;
          }
        }
      } else {
        // No resolver — leave as plain text (still mark atAll for caller)
        atAll = true;
        const replacement = `@所有人`;
        text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
        const diff = replacement.length - m.full.length;
        for (let j = 0; j < i; j++) {
          matches[j].index += diff;
        }
      }
      continue;
    }

    // Case 1: @[昵称]() — auto-resolve by nickname
    // First check if it's an alias, then try nicknameResolver (group member search)
    if (m.id === "" && m.nickname) {
      // Try alias store first — aliases can be used as nicknames too
      const aliasEntry = store.get(m.nickname);
      if (aliasEntry) {
        const mention: MentionInfo = {
          userId: aliasEntry.id,
          displayName: aliasEntry.nickname ?? aliasEntry.alias,
          explicitNickname: true,
          startIndex: m.index,
          endIndex: m.index + m.full.length,
        };
        mentions.unshift(mention);
        if (!mentionedUserIds.includes(aliasEntry.id)) {
          mentionedUserIds.push(aliasEntry.id);
        }
        const replacement = `@${aliasEntry.nickname ?? aliasEntry.alias}`;
        text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
        const diff = replacement.length - m.full.length;
        for (let j = 0; j < i; j++) {
          matches[j].index += diff;
        }
        continue;
      }

      // Fall through to nicknameResolver (group member search)
      if (nicknameResolver) {
        try {
          const matchedUsers = await nicknameResolver(m.nickname);
          if (matchedUsers.length > 0) {
            // Multiple matches: expand into multiple mentions, all @mentioned
            // Replace the @[昵称]() with @昵称1 @昵称2 ... in text
            const displayParts: string[] = [];

            for (const user of matchedUsers) {
              const mention: MentionInfo = {
                userId: user.userId,
                displayName: user.nickname || user.userId,
                explicitNickname: true,
                startIndex: m.index, // approximate
                endIndex: m.index + m.full.length, // approximate
              };
              mentions.unshift(mention);
              if (!mentionedUserIds.includes(user.userId)) {
                mentionedUserIds.push(user.userId);
              }
              displayParts.push(`@${user.nickname || user.userId}`);
            }

            const replacement = displayParts.join(" ");
            text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);

            // Adjust subsequent match indices
            const diff = replacement.length - m.full.length;
            for (let j = 0; j < i; j++) {
              matches[j].index += diff;
            }
          } else {
            // No match found — leave as plain text
            const replacement = `@${m.nickname}`;
            text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
            const diff = replacement.length - m.full.length;
            for (let j = 0; j < i; j++) {
              matches[j].index += diff;
            }
          }
        } catch {
          // Resolver failed — leave as plain text
          const replacement = `@${m.nickname}`;
          text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
          const diff = replacement.length - m.full.length;
          for (let j = 0; j < i; j++) {
            matches[j].index += diff;
          }
        }
      } else {
        // No resolver — leave as plain text
        const replacement = `@${m.nickname}`;
        text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);
        const diff = replacement.length - m.full.length;
        for (let j = 0; j < i; j++) {
          matches[j].index += diff;
        }
      }
      continue;
    }

    // Case 3: @[](id) or @[昵称](id) — normal mention with explicit ID
    if (m.id === "") continue; // @[]() with no nickname — skip

    // Resolve alias to actual ID
    const resolvedId = store.resolve(m.id);
    const aliasNickname = store.getNickname(m.id) ?? store.getNickname(resolvedId);

    // Determine display name
    let displayName: string;
    let explicitNickname: boolean;

    if (m.nickname) {
      // @[昵称](id) — explicit nickname provided
      displayName = m.nickname;
      explicitNickname = true;
    } else if (aliasNickname) {
      // @[](id) — no nickname, but alias has one
      displayName = aliasNickname;
      explicitNickname = false;
    } else {
      // @[](id) — no nickname, no alias nickname
      // Try to fetch nickname from group members via userIdResolver
      // (reverse lookup: find member by userId)
      if (userIdResolver) {
        try {
          const fetchedNickname = await userIdResolver(resolvedId);
          if (fetchedNickname) {
            displayName = fetchedNickname;
            explicitNickname = false;
          } else {
            displayName = resolvedId;
            explicitNickname = false;
          }
        } catch {
          displayName = resolvedId;
          explicitNickname = false;
        }
      } else {
        displayName = resolvedId;
        explicitNickname = false;
      }
    }

    const mention: MentionInfo = {
      userId: resolvedId,
      displayName,
      explicitNickname,
      startIndex: m.index,
      endIndex: m.index + m.full.length,
    };

    mentions.unshift(mention);
    if (!mentionedUserIds.includes(resolvedId)) {
      mentionedUserIds.push(resolvedId);
    }

    // Replace the mention syntax with "@displayName" in the text
    const replacement = `@${displayName}`;
    text = text.slice(0, m.index) + replacement + text.slice(m.index + m.full.length);

    // Adjust subsequent match indices
    const diff = replacement.length - m.full.length;
    for (let j = 0; j < i; j++) {
      matches[j].index += diff;
    }
  }

  // Handle escaped \@ -> @
  text = text.replace(/\\@/g, "@");

  return {
    text,
    mentions,
    mentionedUserIds,
    atAll,
  };
}

/**
 * Build TIMCustomElem msg_body elements for @mentioning users.
 *
 * In the Yuanbao IM protocol, @ mentions are sent as TIMCustomElem with:
 *   elem_type: 1002
 *   text: "@displayName"
 *   user_id: "the_user_id"
 *
 * This is the correct protocol format from the original openclaw-plugin-yuanbao.
 * Each mentioned user gets their own TIMCustomElem element.
 */
export function buildMentionMsgBodyElements(mentions: MentionInfo[]): YuanbaoMsgBodyElement[] {
  return mentions.map(m => ({
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({
        elem_type: 1002,
        text: `@${m.displayName}`,
        user_id: m.userId,
      }),
    },
  }));
}

/**
 * Build the cloud_custom_data JSON string with group at info.
 *
 * The cloud_custom_data groupAtInfo triggers notification for mentioned users.
 * This complements the TIMCustomElem elem_type=1002 approach.
 */
export function buildCloudCustomDataWithMentions(
  existingCloudData: string | undefined,
  mentionInfo: ParsedMentions,
): string {
  let customData: Record<string, unknown> = {};

  if (existingCloudData) {
    try {
      customData = JSON.parse(existingCloudData);
    } catch {
      // Not valid JSON, start fresh
    }
  }

  if (mentionInfo.mentionedUserIds.length > 0) {
    const existingGroupAtInfo = customData.groupAtInfo as Record<string, unknown> | undefined;

    const existingUserIds = (existingGroupAtInfo?.groupAtUserIds as string[]) || [];
    const existingNicknames = (existingGroupAtInfo?.groupAtNicknames as string[]) || [];

    const mergedUserIds = [...new Set([...existingUserIds, ...mentionInfo.mentionedUserIds])];

    const mergedNicknames: string[] = [];
    for (const uid of mergedUserIds) {
      const mention = mentionInfo.mentions.find(m => m.userId === uid);
      if (mention) {
        mergedNicknames.push(mention.explicitNickname ? mention.displayName : "");
      } else {
        const existingIdx = existingUserIds.indexOf(uid);
        mergedNicknames.push(existingIdx >= 0 && existingNicknames[existingIdx] ? existingNicknames[existingIdx] : "");
      }
    }

    customData.groupAtInfo = {
      groupAtUserIds: mergedUserIds,
      ...(mergedNicknames.some(n => n) ? { groupAtNicknames: mergedNicknames } : {}),
      // @all flag — when true, the IM protocol notifies ALL group members
      ...(mentionInfo.atAll ? { atAll: true } : {}),
    };
  } else if (mentionInfo.atAll) {
    // @all with no individual mentions — still set the atAll flag
    customData.groupAtInfo = {
      ...(customData.groupAtInfo as Record<string, unknown> | undefined ?? {}),
      atAll: true,
    };
  }

  return JSON.stringify(customData);
}

/**
 * Build msg_body elements that include mention information.
 *
 * IMPORTANT: In the Yuanbao protocol, TIMCustomElem (elem_type=1002) for @mentions
 * must be interleaved with TIMTextElem elements at the correct text positions.
 * Simply appending all mention elements after the text does NOT work correctly —
 * the protocol expects the @mention element to appear at the position where
 * the @nickname appears in the text flow.
 *
 * This function splits the processed text at each @displayName boundary,
 * inserting a TIMCustomElem between text segments, matching the original project's
 * approach (see openclaw-plugin-yuanbao/src/business/messaging/handlers/index.ts
 * resolveAtMentions()).
 */
export async function buildMentionMsgBody(
  text: string,
  aliasStore?: AliasStore,
  nicknameResolver?: NicknameResolver,
  allMembersResolver?: AllMembersResolver,
  userIdResolver?: UserIdResolver,
): Promise<{
  msgBody: YuanbaoMsgBodyElement[];
  cloudCustomData?: string;
  mentions: MentionInfo[];
  atAll: boolean;
}> {
  const parsed = await parseMentions(text, aliasStore, nicknameResolver, allMembersResolver, userIdResolver);

  const msgBody: YuanbaoMsgBodyElement[] = [];

  if (parsed.mentions.length > 0) {
    // Build a map of displayName -> mention for quick lookup
    // We need to interleave TIMTextElem and TIMCustomElem at the correct positions
    const mentionMap = new Map<string, MentionInfo[]>();
    for (const m of parsed.mentions) {
      const key = `@${m.displayName}`;
      if (!mentionMap.has(key)) {
        mentionMap.set(key, []);
      }
      mentionMap.get(key)!.push(m);
    }

    // Split text at @displayName boundaries
    // We use a regex that matches @displayName from the mentions
    const displayNamePattern = parsed.mentions
      .map(m => `@${m.displayName}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
      .join("|");
    const splitRegex = new RegExp(`(${displayNamePattern})`, "g");

    const parts = parsed.text.split(splitRegex);

    // Track which mentions we've already inserted (for duplicate displayNames)
    const usedMentions = new Map<string, number>(); // displayName -> next index to use

    for (const part of parts) {
      const mentionList = mentionMap.get(part);
      if (mentionList) {
        // This part is an @displayName — insert TIMCustomElem for it
        const idx = usedMentions.get(part) ?? 0;
        const mention = mentionList[Math.min(idx, mentionList.length - 1)];
        usedMentions.set(part, idx + 1);

        msgBody.push({
          msg_type: "TIMCustomElem",
          msg_content: {
            data: JSON.stringify({
              elem_type: 1002,
              text: `@${mention.displayName}`,
              user_id: mention.userId,
            }),
          },
        });
      } else if (part) {
        // Regular text segment. Use truthy check (not part.trim()) so that
        // whitespace BETWEEN consecutive @mentions is preserved as a
        // TIMTextElem — otherwise "@张三 @李四 @王五" would collapse into
        // "@张三@李四@王五" and render incorrectly in the IM client.
        // Empty strings (from split boundaries) are still skipped.
        msgBody.push({
          msg_type: "TIMTextElem",
          msg_content: { text: part },
        });
      }
    }
  } else {
    // No mentions — just text
    if (parsed.text.trim()) {
      msgBody.push({
        msg_type: "TIMTextElem",
        msg_content: { text: parsed.text },
      });
    }
  }

  // Also set cloud_custom_data for notification triggers
  let cloudCustomData: string | undefined;
  if (parsed.mentionedUserIds.length > 0 || parsed.atAll) {
    cloudCustomData = buildCloudCustomDataWithMentions(undefined, parsed);
  }

  return {
    msgBody,
    cloudCustomData,
    mentions: parsed.mentions,
    atAll: parsed.atAll,
  };
}

/**
 * Build a single @mention TIMCustomElem element for a user.
 *
 * This is the equivalent of buildAtUserMsgBodyItem() in the original project.
 */
export function buildAtUserMsgBodyItem(userId: string, displayName?: string): YuanbaoMsgBodyElement {
  return {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({
        elem_type: 1002,
        text: `@${displayName ?? ""}`,
        user_id: userId,
      }),
    },
  };
}

/**
 * Extract mention information from an inbound message's msg_body and cloud_custom_data.
 */
export function extractMentionsFromMsgBody(
  msgBody: YuanbaoMsgBodyElement[] | undefined,
  cloudCustomData?: string,
): MentionInfo[] {
  const mentions: MentionInfo[] = [];

  // Extract from TIMCustomElem elem_type=1002 (primary mechanism)
  if (msgBody) {
    for (const el of msgBody) {
      if (el.msg_type !== "TIMCustomElem") continue;
      const rawData = el.msg_content?.data;
      if (!rawData || typeof rawData !== "string") continue;

      try {
        const customContent = JSON.parse(rawData);
        if (customContent?.elem_type === 1002) {
          // Use String() conversion since user_id may be a number from JSON
          const userId = customContent.user_id != null ? String(customContent.user_id) : undefined;
          const text: string | undefined = customContent.text;

          if (userId) {
            mentions.push({
              userId,
              displayName: text?.replace(/^@/, "") ?? userId,
              explicitNickname: Boolean(text),
              startIndex: -1,
              endIndex: -1,
            });
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  // Try cloud_custom_data (secondary mechanism)
  // Always check cloud_custom_data even if TIMCustomElem found mentions,
  // because groupAtInfo may contain mentions that TIMCustomElem missed.
  if (cloudCustomData) {
    try {
      const customData = JSON.parse(cloudCustomData) as Record<string, unknown>;
      const groupAtInfo = customData.groupAtInfo;

      if (groupAtInfo && typeof groupAtInfo === "object") {
        const gai = groupAtInfo as Record<string, unknown>;
        const userIds = gai.groupAtUserIds;
        const nicknames = gai.groupAtNicknames;

        if (Array.isArray(userIds)) {
          for (let i = 0; i < userIds.length; i++) {
            const uid = String(userIds[i] || "");
            const nick = Array.isArray(nicknames) && nicknames[i] ? String(nicknames[i]) : undefined;
            if (uid && !mentions.some(m => String(m.userId) === uid)) {
              mentions.push({
                userId: uid,
                displayName: nick || uid,
                explicitNickname: Boolean(nick),
                startIndex: -1,
                endIndex: -1,
              });
            }
          }
        }

        // Legacy format: array of { userId, nickname }
        if (Array.isArray(groupAtInfo) && mentions.length === 0) {
          for (const info of groupAtInfo) {
            const gai = info as Record<string, unknown>;
            const uid = String(gai.userId || "");
            if (uid && !mentions.some(m => String(m.userId) === uid)) {
              mentions.push({
                userId: uid,
                displayName: String(gai.nickname || gai.userId || ""),
                explicitNickname: Boolean(gai.nickname),
                startIndex: -1,
                endIndex: -1,
              });
            }
          }
        }
      }
    } catch {
      // Not valid JSON
    }
  }

  // Text-based fallback
  if (msgBody && mentions.length === 0) {
    const text = msgBody
      .filter(el => el.msg_type === "TIMTextElem" && el.msg_content?.text)
      .map(el => el.msg_content.text!)
      .join("");

    const atPattern = /@(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = atPattern.exec(text)) !== null) {
      const name = match[1];
      if (!mentions.some(m => m.displayName === name)) {
        mentions.push({
          userId: "",
          displayName: name,
          explicitNickname: false,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }
  }

  return mentions;
}

/**
 * Check if a specific user ID is mentioned in the message.
 */
export function isUserMentioned(
  userId: string,
  msgBody: YuanbaoMsgBodyElement[] | undefined,
  cloudCustomData?: string,
): boolean {
  const mentions = extractMentionsFromMsgBody(msgBody, cloudCustomData);
  return mentions.some(m => m.userId === userId);
}
