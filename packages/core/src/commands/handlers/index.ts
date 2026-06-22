/**
 * Handler index.
 */

import type { CommandSystem } from "../registry.js";

import { register as registerChat } from "./chat/chat.js";
import { register as registerReply } from "./chat/reply.js";
import { register as registerSticker } from "./chat/sticker.js";
import { register as registerStickers } from "./chat/stickers.js";
import { register as registerGroupinfo } from "./group/groupinfo.js";
import { register as registerGroups } from "./group/groups.js";
import { register as registerMembers } from "./group/members.js";
import { register as registerSearch } from "./group/search.js";
import { register as registerHistory } from "./history/history.js";
import { register as registerInspect } from "./history/inspect.js";
import { register as registerCalc } from "./utility/calc.js";
import { register as registerEcho } from "./utility/echo.js";
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
import { register as registerAttachment } from "./media/attachment.js";
import { register as registerFile } from "./media/file.js";
import { register as registerImg } from "./media/img.js";
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
import { register as registerBatch } from "./chat/batch.js";
import { register as registerCommands } from "./utility/commands.js";
import { register as registerContacts } from "./utility/contacts.js";
import { register as registerCron } from "./chat/cron.js";
import { register as registerHelp } from "./utility/help.js";
import { register as registerRemind } from "./chat/remind.js";
import { register as registerQuery } from "./utility/query.js";
import { register as registerVisit } from "./utility/visit.js";

export {
  registerChat,
  registerReply,
  registerSticker,
  registerStickers,
  registerGroupinfo,
  registerGroups,
  registerMembers,
  registerSearch,
  registerHistory,
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
  registerAttachment,
  registerFile,
  registerImg,
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
  registerQuery,
  registerVisit,
};

export function registerAll(cmdSys: CommandSystem): void {
  registerChat(cmdSys);
  registerReply(cmdSys);
  registerSticker(cmdSys);
  registerStickers(cmdSys);
  registerGroupinfo(cmdSys);
  registerGroups(cmdSys);
  registerMembers(cmdSys);
  registerSearch(cmdSys);
  registerHistory(cmdSys);
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
  registerAttachment(cmdSys);
  registerFile(cmdSys);
  registerImg(cmdSys);
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
  registerQuery(cmdSys);
  registerVisit(cmdSys);
}
