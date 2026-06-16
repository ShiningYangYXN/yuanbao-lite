/**
 * Command system type definitions.
 *
 * Provides a standalone command registration and dispatch framework,
 * inspired by the original openclaw-plugin-yuanbao command system
 * but fully independent.
 */

import type { ChatMessage, YuanbaoMsgBodyElement } from "../types.js";
import type { YuanbaoBot } from "../index.js";

// ─── Command Context ───

export type CommandContext = {
  /** The bot instance that received the message */
  bot: YuanbaoBot;
  /** The original chat message that triggered the command */
  message: ChatMessage;
  /** Command name (without prefix) */
  command: string;
  /** Arguments after the command name (flags like --all/-a are stripped) */
  args: string[];
  /** Reply with text (auto-splits long messages) */
  reply: (text: string) => Promise<void>;
  /** Reply with a raw msg_body (for rich messages like stickers/images) */
  replyRaw: (msgBody: YuanbaoMsgBodyElement[]) => Promise<void>;
  /** Send a direct message to the sender */
  replyDirect: (text: string) => Promise<void>;
  /** Whether this is a group message */
  isGroup: boolean;
  /** Group code if group message */
  groupCode?: string;
  /** Whether --all/-a flag was specified (disable truncation for long-output commands) */
  showAll: boolean;
};

// ─── Command Definition ───

export type CommandDefinition = {
  /** Command name (without prefix, e.g. "help") */
  name: string;
  /** Aliases for the command (e.g. ["h", "?"]) */
  aliases?: string[];
  /** Short description for help listing */
  description: string;
  /** Usage string (e.g. "/echo <text>") */
  usage?: string;
  /** Whether this command is hidden from help listing */
  hidden?: boolean;
  /** Whether this command requires the bot to be connected */
  requireConnected?: boolean;
  /** Whether this command can only be used in direct messages (not groups) */
  dmOnly?: boolean;
  /** The handler function */
  handler: (ctx: CommandContext) => Promise<void> | void;
};

// ─── Command Result ───

export type CommandResult = {
  /** Whether the command was handled */
  handled: boolean;
  /** Optional error if the command failed */
  error?: Error;
};

// ─── Command System Config ───

export type CommandSystemConfig = {
  /** Command prefix (default: "/") */
  prefix?: string;
  /** Whether commands are case-sensitive (default: false) */
  caseSensitive?: boolean;
  /** Whether to handle commands in group messages (default: true) */
  enableInGroup?: boolean;
  /** Whether to handle commands in direct messages (default: true) */
  enableInDirect?: boolean;
  /** Whether the bot must be @mentioned in groups to trigger commands (default: true) */
  requireMentionInGroup?: boolean;
  /** Custom help header text */
  helpHeader?: string;
  /** Custom help footer text */
  helpFooter?: string;
};
