/**
 * Core type definitions for Yuanbao Lite.
 *
 * Simplified from the original openclaw-plugin-yuanbao types,
 * removing OpenClaw-specific types and Agent-related structures.
 */

// ─── Account & Config ───

export type YuanbaoDmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
};

export type YuanbaoOverflowPolicy = "stop" | "split";
export type YuanbaoReplyToMode = "off" | "first" | "all";
export type YuanbaoConnectionMode = "websocket";

export type YuanbaoAccountConfig = {
  name?: string;
  enabled?: boolean;

  appKey?: string;
  appSecret?: string;
  apiDomain?: string;
  wsUrl?: string;
  /** Skips automatic ticket signing if provided */
  token?: string;

  dm?: YuanbaoDmConfig;
  overflowPolicy?: YuanbaoOverflowPolicy;
  replyToMode?: YuanbaoReplyToMode;
  routeEnv?: string;

  /** Default 20 */
  mediaMaxMb?: number;

  /** 0=disabled, defaults to 100 */
  historyLimit?: number;

  /** Default false */
  disableBlockStreaming?: boolean;
  /** Default true */
  requireMention?: boolean;
  /** Fallback reply when AI returns no content */
  fallbackReply?: string;
  /** Default true; prevents model from wrapping entire reply in ```markdown fences */
  markdownHintEnabled?: boolean;
  debugBotIds?: string[];
};

export type ResolvedYuanbaoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appKey?: string;
  appSecret?: string;
  botId?: string;
  botOwnerId?: string;
  apiDomain: string;
  wsUrl?: string;
  token?: string;
  wsGatewayUrl: string;
  wsHeartbeatInterval?: number;
  wsMaxReconnectAttempts: number;
  overflowPolicy: YuanbaoOverflowPolicy;
  replyToMode: YuanbaoReplyToMode;
  mediaMaxMb: number;
  historyLimit: number;
  disableBlockStreaming: boolean;
  requireMention: boolean;
  fallbackReply: string;
  markdownHintEnabled: boolean;
  config: YuanbaoAccountConfig;
};

// ─── IM Message Types ───

export type ImImageInfoArrayItem = {
  type?: number;
  size?: number;
  width?: number;
  height?: number;
  url?: string;
};

export type YuanbaoMsgBodyElement = {
  msg_type: string;
  msg_content: {
    text?: string;
    uuid?: string;
    image_format?: number;
    data?: string;
    desc?: string;
    ext?: string;
    sound?: string;
    image_info_array?: ImImageInfoArrayItem[];
    index?: number;
    url?: string;
    file_size?: number;
    file_name?: string;
    ext_map?: Record<string, string>;
    [key: string]: unknown;
  };
};

export type ImMsgSeq = {
  msg_seq?: number;
  msg_id?: string;
  msgId?: string;
};

export type YuanbaoLogInfoExt = {
  trace_id?: string;
};

export enum EnumCLawMsgType {
  CLAW_MSG_UNKNOWN = 0,
  CLAW_MSG_GROUP = 1,
  CLAW_MSG_PRIVATE = 2,
}

export type YuanbaoInboundMessage = {
  callback_command?: string;
  from_account?: string;
  to_account?: string;
  sender_nickname?: string;
  group_id?: string;
  group_code?: string;
  group_name?: string;
  msg_seq?: number;
  msg_random?: number;
  msg_time?: number;
  msg_key?: string;
  msg_id?: string;
  online_only_flag?: number;
  send_msg_result?: number;
  error_info?: string;
  msg_body?: YuanbaoMsgBodyElement[];
  cloud_custom_data?: string;
  event_time?: number;
  bot_owner_id?: string;
  recall_msg_seq_list?: ImMsgSeq[];
  claw_msg_type?: EnumCLawMsgType;
  private_from_group_code?: string;
  trace_id?: string;
  seq_id?: string;
};

// ─── Chat Message (simplified for consumers) ───

export type MentionInfo = {
  /** The mentioned user ID */
  userId: string;
  /** Display name for the mention */
  displayName: string;
  /** Whether the nickname was explicitly provided */
  explicitNickname: boolean;
};

export type ChatMessage = {
  /** Unique message ID */
  id: string;
  /** Sender user ID */
  fromUserId: string;
  /** Sender nickname */
  fromNickname?: string;
  /** Chat type: direct message or group */
  chatType: "direct" | "group";
  /** Group code (only for group messages) */
  groupCode?: string;
  /** Group name (only for group messages) */
  groupName?: string;
  /** Text content (extracted from msg_body) */
  text: string;
  /** Raw message body elements */
  rawBody?: YuanbaoMsgBodyElement[];
  /** Message timestamp (Unix ms) */
  timestamp: number;
  /** Whether this message mentions the bot */
  isMentioned?: boolean;
  /** List of users mentioned in this message */
  mentions?: MentionInfo[];
  /** Original inbound message (for advanced usage) */
  raw?: YuanbaoInboundMessage;
  /** Quoted/referenced message ID (for reply messages) */
  quoteMsgId?: string;
  /** Quoted/referenced message seq (for reply messages) */
  quoteMsgSeq?: number;
};

// ─── Outbound Message ───

export type SendTextMessageParams = {
  /** Target user ID (for DM) or group code (for group) */
  to: string;
  /** Text content to send */
  text: string;
  /** Whether this is a group message (default: auto-detect) */
  isGroup?: boolean;
  /** Quote message ID (for reply) */
  quoteMsgId?: string;
  /** Quote message seq (for reply) */
  quoteMsgSeq?: number;
  /** Skip ${...} interpolation (use when caller already interpolated, e.g. batch) */
  skipInterpolation?: boolean;
};

// ─── Bot Status ───

export type BotStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

export type BotState = {
  status: BotStatus;
  connected: boolean;
  connectId?: string;
  lastConnectedAt?: number;
  lastError?: string;
  botId?: string;
};
