/**
 * Handler index — imports and re-exports all command register functions.
 *
 * Organized by command metadata category. Each subfolder contains
 * one file per command, exporting `register(cmdSys: CommandSystem): void`.
 */

import type { CommandSystem } from "../registry.js";

import { register as registerAtall } from "./chat/atall.js";
import { register as registerChat } from "./chat/chat.js";
import { register as registerDm } from "./chat/dm.js";
import { register as registerGroup } from "./chat/group.js";
import { register as registerMention } from "./chat/mention.js";
import { register as registerReply } from "./chat/reply.js";
import { register as registerSticker } from "./chat/sticker.js";
import { register as registerStickers } from "./chat/stickers.js";
import { register as registerGroupinfo } from "./group/groupinfo.js";
import { register as registerGroups } from "./group/groups.js";
import { register as registerJoin } from "./group/join.js";
import { register as registerMembers } from "./group/members.js";
import { register as registerSearch } from "./group/search.js";
import { register as registerSwitch } from "./group/switch.js";
import { register as registerHclear } from "./history/hclear.js";
import { register as registerHistory } from "./history/history.js";
import { register as registerHsearch } from "./history/hsearch.js";
import { register as registerInspect } from "./history/inspect.js";
import { register as registerCalc } from "./info/calc.js";
import { register as registerEcho } from "./info/echo.js";
import { register as registerIp } from "./info/ip.js";
import { register as registerMyip } from "./info/myip.js";
import { register as registerPing } from "./info/ping.js";
import { register as registerStatus } from "./info/status.js";
import { register as registerTime } from "./info/time.js";
import { register as registerUptime } from "./info/uptime.js";
import { register as registerVersion } from "./info/version.js";
import { register as registerWhoami } from "./info/whoami.js";
import { register as registerWhois } from "./info/whois.js";
import { register as registerLlm } from "./llm/llm.js";
import { register as registerNew } from "./llm/new.js";
import { register as registerDownload } from "./media/download.js";
import { register as registerFile } from "./media/file.js";
import { register as registerImg } from "./media/img.js";
import { register as registerTempfile } from "./media/tempfile.js";
import { register as registerUpload } from "./media/upload.js";
import { register as registerBlock } from "./system/block.js";
import { register as registerConfig } from "./system/config.js";
import { register as registerDaemon } from "./system/daemon.js";
import { register as registerInit } from "./system/init.js";
import { register as registerLog } from "./system/log.js";
import { register as registerShell } from "./system/shell.js";
import { register as registerTerm } from "./system/term.js";
import { register as registerTrust } from "./system/trust.js";
import { register as registerUnsafe } from "./system/unsafe.js";
import { register as registerAccount } from "./utility/account.js";
import { register as registerAlias } from "./utility/alias.js";
import { register as registerBatch } from "./utility/batch.js";
import { register as registerCommands } from "./utility/commands.js";
import { register as registerContacts } from "./utility/contacts.js";
import { register as registerCron } from "./utility/cron.js";
import { register as registerHelp } from "./utility/help.js";
import { register as registerRemind } from "./utility/remind.js";

export {
  registerAtall,
  registerChat,
  registerDm,
  registerGroup,
  registerMention,
  registerReply,
  registerSticker,
  registerStickers,
  registerGroupinfo,
  registerGroups,
  registerJoin,
  registerMembers,
  registerSearch,
  registerSwitch,
  registerHclear,
  registerHistory,
  registerHsearch,
  registerInspect,
  registerCalc,
  registerEcho,
  registerIp,
  registerMyip,
  registerPing,
  registerStatus,
  registerTime,
  registerUptime,
  registerVersion,
  registerWhoami,
  registerWhois,
  registerLlm,
  registerNew,
  registerDownload,
  registerFile,
  registerImg,
  registerTempfile,
  registerUpload,
  registerBlock,
  registerConfig,
  registerDaemon,
  registerInit,
  registerLog,
  registerShell,
  registerTerm,
  registerTrust,
  registerUnsafe,
  registerAccount,
  registerAlias,
  registerBatch,
  registerCommands,
  registerContacts,
  registerCron,
  registerHelp,
  registerRemind,
};

/** Register all built-in commands by calling each handler's register(). */
export function registerAll(cmdSys: CommandSystem): void {
  registerAtall(cmdSys);
  registerChat(cmdSys);
  registerDm(cmdSys);
  registerGroup(cmdSys);
  registerMention(cmdSys);
  registerReply(cmdSys);
  registerSticker(cmdSys);
  registerStickers(cmdSys);
  registerGroupinfo(cmdSys);
  registerGroups(cmdSys);
  registerJoin(cmdSys);
  registerMembers(cmdSys);
  registerSearch(cmdSys);
  registerSwitch(cmdSys);
  registerHclear(cmdSys);
  registerHistory(cmdSys);
  registerHsearch(cmdSys);
  registerInspect(cmdSys);
  registerCalc(cmdSys);
  registerEcho(cmdSys);
  registerIp(cmdSys);
  registerMyip(cmdSys);
  registerPing(cmdSys);
  registerStatus(cmdSys);
  registerTime(cmdSys);
  registerUptime(cmdSys);
  registerVersion(cmdSys);
  registerWhoami(cmdSys);
  registerWhois(cmdSys);
  registerLlm(cmdSys);
  registerNew(cmdSys);
  registerDownload(cmdSys);
  registerFile(cmdSys);
  registerImg(cmdSys);
  registerTempfile(cmdSys);
  registerUpload(cmdSys);
  registerBlock(cmdSys);
  registerConfig(cmdSys);
  registerDaemon(cmdSys);
  registerInit(cmdSys);
  registerLog(cmdSys);
  registerShell(cmdSys);
  registerTerm(cmdSys);
  registerTrust(cmdSys);
  registerUnsafe(cmdSys);
  registerAccount(cmdSys);
  registerAlias(cmdSys);
  registerBatch(cmdSys);
  registerCommands(cmdSys);
  registerContacts(cmdSys);
  registerCron(cmdSys);
  registerHelp(cmdSys);
  registerRemind(cmdSys);
}
