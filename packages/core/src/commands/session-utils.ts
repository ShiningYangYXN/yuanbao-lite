/**
 * Session key utilities for blocking sessions.
 *
 * All blocking sessions (init wizard, llm config wizard, term, switch) use
 * a session key that combines userId + chatType + groupCode to ensure that:
 *   1. Only messages from the SAME user in the SAME conversation are captured
 *   2. A wizard started in DM does NOT capture group messages (and vice versa)
 *   3. A wizard started in group A does NOT capture messages in group B
 *
 * Format:
 *   DM:    "<userId>:dm"
 *   Group: "<userId>:group:<groupCode>"
 */

/**
 * Compute the session key for a given user + conversation context.
 */
export function sessionKey(userId: string, chatType: "group" | "direct", groupCode?: string): string {
  return chatType === "group" && groupCode
    ? `${userId}:group:${groupCode}`
    : `${userId}:dm`;
}

/**
 * Compute the session key from a ChatMessage.
 */
export function sessionKeyFromMessage(msg: { fromUserId: string; chatType: "group" | "direct"; groupCode?: string }): string {
  return sessionKey(msg.fromUserId, msg.chatType, msg.groupCode);
}

/**
 * All blocking sessions auto-expire after this many milliseconds of inactivity.
 */
export const BLOCKING_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if a blocking session has expired based on lastActivity timestamp.
 * Returns true if expired (caller should clean up).
 */
export function isExpired(lastActivity: number): boolean {
  return Date.now() - lastActivity > BLOCKING_SESSION_TIMEOUT_MS;
}
