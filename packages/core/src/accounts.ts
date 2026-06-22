/**
 * Account resolver — simplified standalone version.
 *
 * Resolves YuanbaoAccountConfig into a fully resolved ResolvedYuanbaoAccount
 * with defaults and validation, without OpenClaw SDK dependencies.
 */

import { createLog } from "./logger.js";
import type {
  ResolvedYuanbaoAccount,
  YuanbaoAccountConfig,
  YuanbaoOverflowPolicy,
  YuanbaoReplyToMode,
} from "./types.js";

const DEFAULT_API_DOMAIN = "bot.yuanbao.tencent.com";
const DEFAULT_WS_GATEWAY_URL = "wss://bot-wss.yuanbao.tencent.com/wss/connection";

function resolveOverflowPolicy(raw: string | undefined): YuanbaoOverflowPolicy {
  return raw === "stop" ? "stop" : "split";
}

function resolveReplyToMode(raw: string | undefined): YuanbaoReplyToMode {
  if (raw === "off" || raw === "all") {
    return raw;
  }
  return "first";
}

/**
 * Resolve a YuanbaoAccountConfig into a fully defaulted ResolvedYuanbaoAccount.
 *
 * This function merges user-provided config with sensible defaults and
 * validates that required fields (appKey, appSecret) are present.
 *
 * @param config - User-provided account configuration
 * @param accountId - Account identifier (defaults to "default")
 * @returns Fully resolved account configuration
 */
export function resolveAccount(
  config: YuanbaoAccountConfig,
  accountId = "default",
): ResolvedYuanbaoAccount {
  // Extract and normalize fields
  let appKey = config.appKey?.trim() || undefined;
  let appSecret = config.appSecret?.trim() || undefined;
  const apiDomain = config.apiDomain?.trim() || DEFAULT_API_DOMAIN;
  let token = config.token?.trim() || undefined;
  const overflowPolicy = resolveOverflowPolicy(config.overflowPolicy);
  const replyToMode = resolveReplyToMode(config.replyToMode);

  // Compatibility: if appKey/appSecret missing but token is in "appKey:appSecret" format, auto-parse
  if ((!appKey || !appSecret) && token) {
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const parsedKey = token.slice(0, colonIdx).trim();
      const parsedSecret = token.slice(colonIdx + 1).trim();
      if (parsedKey && parsedSecret) {
        if (!appKey) appKey = parsedKey;
        if (!appSecret) appSecret = parsedSecret;
        token = undefined; // Parsed; clear to avoid using as pre-signed WS token
      }
    }
  }

  const wsGatewayUrl = config.wsUrl?.trim() || DEFAULT_WS_GATEWAY_URL;
  const wsMaxReconnectAttempts = 100;
  const mediaMaxMb = config.mediaMaxMb && config.mediaMaxMb >= 1 ? config.mediaMaxMb : 20;
  const historyLimit = config.historyLimit !== undefined && config.historyLimit >= 0 ? config.historyLimit : 100;
  const disableBlockStreaming = config.disableBlockStreaming !== undefined ? config.disableBlockStreaming : false;
  const requireMention = config.requireMention !== undefined ? config.requireMention : true;
  const fallbackReply = config.fallbackReply?.trim() || "暂时无法解答，你可以换个问题问问我哦";
  const markdownHintEnabled = config.markdownHintEnabled !== false;
  const enabled = config.enabled !== false;
  const configured = Boolean(appKey && appSecret);

  if (!configured) {
    const log = createLog("accounts");
    const missing: string[] = [];
    if (!appKey) missing.push("appKey");
    if (!appSecret) missing.push("appSecret");
    log.warn("incomplete config", { missing: missing.join(", ") });
  }

  return {
    accountId,
    name: config.name?.trim() || undefined,
    enabled,
    configured,
    appKey,
    appSecret,
    apiDomain,
    ...(token ? { token } : {}),
    wsGatewayUrl,
    wsHeartbeatInterval: undefined,
    wsMaxReconnectAttempts,
    overflowPolicy,
    replyToMode,
    mediaMaxMb,
    historyLimit,
    disableBlockStreaming,
    requireMention,
    fallbackReply,
    markdownHintEnabled,
    config,
  };
}
