/**
 * Handler index — imports and re-exports all command register functions.
 *
 * Organized by command metadata category. Each subfolder contains
 * one file per command, exporting `register(cmdSys: CommandSystem): void`.
 */

import type { CommandSystem } from "../registry.js";

import { register as registerAlias } from "./alias/alias.js";
import { register as registerBatch } from "./batch/batch.js";
import { register as registerAtall } from "./chat/atall.js";
import { register as registerChat } from "./chat/chat.js";
import { register as registerDm } from "./chat/dm.js";
import { register as registerGroup } from "./chat/group.js";
import { register as registerMention } from "./chat/mention.js";
import { register as registerReply } from "./chat/reply.js";
import { register as registerContacts } from "./contact/contacts.js";
import { register as registerGroupinfo } from "./group/groupinfo.js";
import { register as registerGroups } from "./group/groups.js";
import { register as registerJoin } from "./group/join.js";
import { register as registerMembers } from "./group/members.js";
import { register as registerSearch } from "./group/search.js";
import { register as registerSwitch } from "./group/switch.js";
import { register as registerHclear } from "./history/hclear.js";
import { register as registerHistory } from "./history/history.js";
import { register as registerHsearch } from "./history/hsearch.js";
import { register as registerLlm } from "./llm/llm.js";
import { register as registerNew } from "./llm/new.js";
import { register as registerDownload } from "./media/download.js";
import { register as registerFile } from "./media/file.js";
import { register as registerImg } from "./media/img.js";
import { register as registerTempfile } from "./media/tempfile.js";
import { register as registerUpload } from "./media/upload.js";
import { register as registerCalc } from "./misc/calc.js";
import { register as registerCommands } from "./misc/commands.js";
import { register as registerCron } from "./misc/cron.js";
import { register as registerEcho } from "./misc/echo.js";
import { register as registerHelp } from "./misc/help.js";
import { register as registerInspect } from "./misc/inspect.js";
import { register as registerIp } from "./misc/ip.js";
import { register as registerPing } from "./misc/ping.js";
import { register as registerRemind } from "./misc/remind.js";
import { register as registerStatus } from "./misc/status.js";
import { register as registerTime } from "./misc/time.js";
import { register as registerUptime } from "./misc/uptime.js";
import { register as registerVersion } from "./misc/version.js";
import { register as registerWhoami } from "./misc/whoami.js";
import { register as registerWhois } from "./misc/whois.js";
import { register as registerAccount } from "./multi-account/account.js";
import { register as registerSticker } from "./sticker/sticker.js";
import { register as registerStickers } from "./sticker/stickers.js";
import { register as registerBlock } from "./system/block.js";
import { register as registerConfig } from "./system/config.js";
import { register as registerDaemon } from "./system/daemon.js";
import { register as registerInit } from "./system/init.js";
import { register as registerLog } from "./system/log.js";
import { register as registerMyip } from "./system/myip.js";
import { register as registerShell } from "./system/shell.js";
import { register as registerTerm } from "./system/term.js";
import { register as registerTrust } from "./system/trust.js";
import { register as registerUnsafe } from "./system/unsafe.js";

export {
  registerAlias,
  registerBatch,
  registerAtall,
  registerChat,
  registerDm,
  registerGroup,
  registerMention,
  registerReply,
  registerContacts,
  registerGroupinfo,
  registerGroups,
  registerJoin,
  registerMembers,
  registerSearch,
  registerSwitch,
  registerHclear,
  registerHistory,
  registerHsearch,
  registerLlm,
  registerNew,
  registerDownload,
  registerFile,
  registerImg,
  registerTempfile,
  registerUpload,
  registerCalc,
  registerCommands,
  registerCron,
  registerEcho,
  registerHelp,
  registerInspect,
  registerIp,
  registerPing,
  registerRemind,
  registerStatus,
  registerTime,
  registerUptime,
  registerVersion,
  registerWhoami,
  registerWhois,
  registerAccount,
  registerSticker,
  registerStickers,
  registerBlock,
  registerConfig,
  registerDaemon,
  registerInit,
  registerLog,
  registerMyip,
  registerShell,
  registerTerm,
  registerTrust,
  registerUnsafe,
};

/** Register all built-in commands by calling each handler's register(). */
export function registerAll(cmdSys: CommandSystem): void {
  registerAlias(cmdSys);
  registerBatch(cmdSys);
  registerAtall(cmdSys);
  registerChat(cmdSys);
  registerDm(cmdSys);
  registerGroup(cmdSys);
  registerMention(cmdSys);
  registerReply(cmdSys);
  registerContacts(cmdSys);
  registerGroupinfo(cmdSys);
  registerGroups(cmdSys);
  registerJoin(cmdSys);
  registerMembers(cmdSys);
  registerSearch(cmdSys);
  registerSwitch(cmdSys);
  registerHclear(cmdSys);
  registerHistory(cmdSys);
  registerHsearch(cmdSys);
  registerLlm(cmdSys);
  registerNew(cmdSys);
  registerDownload(cmdSys);
  registerFile(cmdSys);
  registerImg(cmdSys);
  registerTempfile(cmdSys);
  registerUpload(cmdSys);
  registerCalc(cmdSys);
  registerCommands(cmdSys);
  registerCron(cmdSys);
  registerEcho(cmdSys);
  registerHelp(cmdSys);
  registerInspect(cmdSys);
  registerIp(cmdSys);
  registerPing(cmdSys);
  registerRemind(cmdSys);
  registerStatus(cmdSys);
  registerTime(cmdSys);
  registerUptime(cmdSys);
  registerVersion(cmdSys);
  registerWhoami(cmdSys);
  registerWhois(cmdSys);
  registerAccount(cmdSys);
  registerSticker(cmdSys);
  registerStickers(cmdSys);
  registerBlock(cmdSys);
  registerConfig(cmdSys);
  registerDaemon(cmdSys);
  registerInit(cmdSys);
  registerLog(cmdSys);
  registerMyip(cmdSys);
  registerShell(cmdSys);
  registerTerm(cmdSys);
  registerTrust(cmdSys);
  registerUnsafe(cmdSys);
}
