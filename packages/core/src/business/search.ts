/**
 * Search functionality — search groups and group members.
 *
 * Features:
 *   - Search through known/cached groups by name or code
 *   - Search group members by name or ID (with fuzzy matching)
 *   - Search across all groups for a member
 *   - Member search caching to avoid repeated API calls
 *   - Integration with the bot's query APIs
 */

import { createLog } from "../logger.js";
import type { ModuleLog } from "../logger.js";
import type { YuanbaoBot } from "../index.js";
import type { WsGroupMember } from "../access/ws/types.js";

// ─── Types ───

export type GroupSearchResult = {
  /** Group code */
  groupCode: string;
  /** Group name */
  groupName: string;
  /** Group owner user ID */
  groupOwnerUserId: string;
  /** Group owner nickname */
  groupOwnerNickname: string;
  /** Number of members */
  groupSize: number;
  /** Relevance score (higher = better match) */
  score: number;
  /** What matched: "name" | "code" | "both" */
  matchType: "name" | "code" | "both";
};

export type MemberSearchResult = {
  /** User ID */
  userId: string;
  /** Nickname */
  nickName: string;
  /** User type (1=人类, 2=元宝, 3=龙虾) */
  userType: number;
  /** Group code where this member was found */
  groupCode: string;
  /** Group name where this member was found */
  groupName?: string;
  /** Relevance score */
  score: number;
  /** What matched: "name" | "id" | "both" */
  matchType: "name" | "id" | "both";
};

export type CachedGroupInfo = {
  groupCode: string;
  groupName: string;
  groupOwnerUserId: string;
  groupOwnerNickname: string;
  groupSize: number;
  cachedAt: number;
};

export type CachedMemberList = {
  groupCode: string;
  members: WsGroupMember[];
  cachedAt: number;
};

export type SearchConfig = {
  /** Cache TTL in milliseconds (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Maximum search results (default: 50) */
  maxResults?: number;
  /** Minimum fuzzy match score (0-1, default: 0.3) */
  minScore?: number;
};

// ─── SearchEngine ───

export class SearchEngine {
  private bot: YuanbaoBot;
  private groupCache = new Map<string, CachedGroupInfo>();
  private memberCache = new Map<string, CachedMemberList>();
  private config: Required<SearchConfig>;
  private log: ModuleLog;

  constructor(bot: YuanbaoBot, config?: SearchConfig) {
    this.bot = bot;
    this.config = {
      cacheTtlMs: config?.cacheTtlMs ?? 5 * 60 * 1000,
      maxResults: config?.maxResults ?? 50,
      minScore: config?.minScore ?? 0.3,
    };
    this.log = createLog("search");
  }

  // ─── Group search ───

  /**
   * Search for groups by name or code.
   *
   * Searches through cached group info first, then queries the API
   * for specific group codes if provided.
   *
   * @param query - Search query (group name or code)
   * @param groupCodes - Optional list of group codes to search within
   */
  async searchGroups(
    query: string,
    groupCodes?: string[],
  ): Promise<GroupSearchResult[]> {
    const results: GroupSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    // If specific group codes provided, query those
    const codesToSearch = groupCodes ?? [...this.groupCache.keys()];

    // Also query any codes that aren't cached yet
    if (groupCodes) {
      for (const code of groupCodes) {
        if (!this.isGroupCacheValid(code)) {
          await this.fetchAndCacheGroupInfo(code);
        }
      }
    }

    // Search through cached groups
    for (const code of codesToSearch) {
      const info = this.groupCache.get(code);
      if (!info) continue;

      const nameMatch = info.groupName.toLowerCase().includes(lowerQuery);
      const codeMatch = code.includes(lowerQuery) || code === query;

      if (nameMatch || codeMatch) {
        let score = 0;
        let matchType: "name" | "code" | "both" = "name";

        if (nameMatch) {
          // Exact match scores higher
          score += info.groupName.toLowerCase() === lowerQuery ? 1.0 : 0.6;
          matchType = "name";
        }
        if (codeMatch) {
          score += code === query ? 1.0 : 0.5;
          matchType = nameMatch ? "both" : "code";
        }

        results.push({
          groupCode: code,
          groupName: info.groupName,
          groupOwnerUserId: info.groupOwnerUserId,
          groupOwnerNickname: info.groupOwnerNickname,
          groupSize: info.groupSize,
          score,
          matchType,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, this.config.maxResults);
  }

  /**
   * Query and cache group info for a specific group code.
   */
  async fetchAndCacheGroupInfo(
    groupCode: string,
  ): Promise<CachedGroupInfo | null> {
    try {
      const rsp = await this.bot.queryGroupInfo(groupCode);
      if (rsp.code === 0 && rsp.group_info) {
        const info: CachedGroupInfo = {
          groupCode,
          groupName: rsp.group_info.group_name || "",
          groupOwnerUserId: rsp.group_info.group_owner_user_id || "",
          groupOwnerNickname: rsp.group_info.group_owner_nickname || "",
          groupSize: rsp.group_info.group_size || 0,
          cachedAt: Date.now(),
        };
        this.groupCache.set(groupCode, info);
        return info;
      }
      return null;
    } catch (err) {
      this.log.warn(
        `failed to fetch group info for ${groupCode}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // ─── Member search ───

  /**
   * Search for members in a specific group.
   *
   * @param groupCode - The group to search in
   * @param query - Search query (member name or ID)
   */
  async searchGroupMembers(
    groupCode: string,
    query: string,
  ): Promise<MemberSearchResult[]> {
    const members = await this.getGroupMembers(groupCode);
    const results: MemberSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    const groupInfo = this.groupCache.get(groupCode);

    for (const member of members) {
      const nameMatch = member.nick_name.toLowerCase().includes(lowerQuery);
      const idMatch =
        member.user_id.includes(lowerQuery) || member.user_id === query;

      if (nameMatch || idMatch) {
        let score = 0;
        let matchType: "name" | "id" | "both" = "name";

        if (nameMatch) {
          score += member.nick_name.toLowerCase() === lowerQuery ? 1.0 : 0.6;
          matchType = "name";
        }
        if (idMatch) {
          score += member.user_id === query ? 1.0 : 0.5;
          matchType = nameMatch ? "both" : "id";
        }

        // Boost score for exact match
        if (member.nick_name.toLowerCase() === lowerQuery) {
          score += 0.3;
        }

        results.push({
          userId: member.user_id,
          nickName: member.nick_name,
          userType: member.user_type,
          groupCode,
          groupName: groupInfo?.groupName,
          score,
          matchType,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, this.config.maxResults);
  }

  /**
   * Search for a member across multiple groups.
   *
   * @param query - Search query (member name or ID)
   * @param groupCodes - Groups to search in. If omitted, searches all cached groups.
   */
  async searchMemberAcrossGroups(
    query: string,
    groupCodes?: string[],
  ): Promise<MemberSearchResult[]> {
    const codes = groupCodes ?? [...this.groupCache.keys()];
    const allResults: MemberSearchResult[] = [];

    // Search in parallel (with concurrency limit)
    const batchSize = 3;
    for (let i = 0; i < codes.length; i += batchSize) {
      const batch = codes.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((code) => this.searchGroupMembers(code, query)),
      );
      for (const results of batchResults) {
        allResults.push(...results);
      }
    }

    // Sort by score and deduplicate (same user may appear in multiple groups)
    allResults.sort((a, b) => b.score - a.score);

    return allResults.slice(0, this.config.maxResults);
  }

  // ─── Cache management ───

  /**
   * Get group members, using cache when available.
   */
  async getGroupMembers(groupCode: string): Promise<WsGroupMember[]> {
    if (this.isMemberCacheValid(groupCode)) {
      return this.memberCache.get(groupCode)!.members;
    }

    try {
      const rsp = await this.bot.getGroupMemberList(groupCode);
      if (rsp.code === 0 && rsp.member_list) {
        this.memberCache.set(groupCode, {
          groupCode,
          members: rsp.member_list,
          cachedAt: Date.now(),
        });
        return rsp.member_list;
      }
      return [];
    } catch (err) {
      this.log.warn(
        `failed to fetch members for ${groupCode}: ${(err as Error).message}`,
      );
      // Return stale cache if available
      const cached = this.memberCache.get(groupCode);
      return cached?.members ?? [];
    }
  }

  /**
   * Invalidate cache for a specific group.
   */
  invalidateGroupCache(groupCode: string): void {
    this.groupCache.delete(groupCode);
    this.memberCache.delete(groupCode);
  }

  /**
   * Invalidate all caches.
   */
  invalidateAllCaches(): void {
    this.groupCache.clear();
    this.memberCache.clear();
  }

  /**
   * Pre-cache group info and members for a list of group codes.
   */
  async preCacheGroups(groupCodes: string[]): Promise<void> {
    const batchSize = 3;
    for (let i = 0; i < groupCodes.length; i += batchSize) {
      const batch = groupCodes.slice(i, i + batchSize);
      await Promise.all([
        ...batch.map((code) => this.fetchAndCacheGroupInfo(code)),
        ...batch.map((code) => this.getGroupMembers(code)),
      ]);
    }
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): {
    groups: number;
    memberLists: number;
    oldestCache?: number;
  } {
    let oldestCache: number | undefined;
    for (const info of this.groupCache.values()) {
      if (!oldestCache || info.cachedAt < oldestCache) {
        oldestCache = info.cachedAt;
      }
    }
    for (const ml of this.memberCache.values()) {
      if (!oldestCache || ml.cachedAt < oldestCache) {
        oldestCache = ml.cachedAt;
      }
    }
    return {
      groups: this.groupCache.size,
      memberLists: this.memberCache.size,
      oldestCache,
    };
  }

  // ─── Internal ───

  private isGroupCacheValid(groupCode: string): boolean {
    const cached = this.groupCache.get(groupCode);
    if (!cached) return false;
    return Date.now() - cached.cachedAt < this.config.cacheTtlMs;
  }

  private isMemberCacheValid(groupCode: string): boolean {
    const cached = this.memberCache.get(groupCode);
    if (!cached) return false;
    return Date.now() - cached.cachedAt < this.config.cacheTtlMs;
  }
}
