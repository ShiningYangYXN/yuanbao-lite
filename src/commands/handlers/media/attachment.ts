/**
 * /attachment command handler — view and download attachments from chat messages.
 *
 * Subcommands:
 *   /attachment list [消息ID或#尾号]   — list attachments in a message
 *                                        (default: most recent message with media)
 *   /attachment download <消息ID或#尾号> [索引]  — download attachment by index
 *                                        (index from /attachment list output)
 *   /attachment recent [数量]          — list recent messages with attachments
 *
 * Attachments are extracted from the message's rawBody (msg_body elements):
 *   - TIMImageElem  → images
 *   - TIMFileElem   → files
 *   - TIMVideoFileElem → videos
 *   - TIMSoundElem  → voice clips
 *
 * Category: media
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";

type AttachmentInfo = {
  index: number;
  type: "image" | "file" | "video" | "voice";
  url?: string;
  uuid?: string;
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
};

function extractAttachments(msgBody: YuanbaoMsgBodyElement[] | undefined): AttachmentInfo[] {
  if (!msgBody || !Array.isArray(msgBody)) return [];
  const attachments: AttachmentInfo[] = [];
  let idx = 0;
  for (const el of msgBody) {
    const c = el.msg_content as Record<string, unknown> | undefined;
    if (!c) continue;
    if (el.msg_type === "TIMImageElem") {
      const infoArray = c.image_info_array as Array<Record<string, unknown>> | undefined;
      const selected = infoArray?.[1] ?? infoArray?.[0];
      const url = typeof selected?.url === "string" ? selected.url : undefined;
      const uuid = typeof c.uuid === "string" ? c.uuid : undefined;
      if (url || uuid) {
        attachments.push({
          index: idx++,
          type: "image",
          url,
          uuid,
          width: typeof selected?.width === "number" ? selected.width : undefined,
          height: typeof selected?.height === "number" ? selected.height : undefined,
        });
      }
    } else if (el.msg_type === "TIMFileElem") {
      const url = typeof c.url === "string" ? c.url : undefined;
      const uuid = typeof c.uuid === "string" ? c.uuid : undefined;
      const fileName = typeof c.file_name === "string" ? c.file_name : undefined;
      const fileSize = typeof c.file_size === "number" ? c.file_size : undefined;
      if (url || uuid) {
        attachments.push({ index: idx++, type: "file", url, uuid, fileName, fileSize });
      }
    } else if (el.msg_type === "TIMVideoFileElem") {
      const url = typeof c.video_url === "string" ? c.video_url : undefined;
      const uuid = typeof c.uuid === "string" ? c.uuid : undefined;
      if (url || uuid) {
        attachments.push({ index: idx++, type: "video", url, uuid });
      }
    } else if (el.msg_type === "TIMSoundElem") {
      const url = typeof c.url === "string" ? c.url : undefined;
      const uuid = typeof c.uuid === "string" ? c.uuid : undefined;
      if (url || uuid) {
        attachments.push({ index: idx++, type: "voice", url, uuid });
      }
    }
  }
  return attachments;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "?";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function findMessageByIdOrSuffix(
  ctx: { bot: { getHistoryStore(): { getHistory(): Array<{ id: string; rawBody?: YuanbaoMsgBodyElement[]; fromNickname?: string; timestamp?: number }> } } },
  id: string,
): { id: string; rawBody?: YuanbaoMsgBodyElement[]; fromNickname?: string; timestamp?: number } | undefined {
  const store = ctx.bot.getHistoryStore();
  const all = store.getHistory();
  const normalized = id.trim().replace(/^#/, "");
  // Try exact ID match
  let msg = all.find(m => m.id === normalized);
  if (msg) return msg;
  // Try suffix match (last 8+ chars)
  const suffix = normalized.slice(-8);
  if (suffix.length >= 3) {
    msg = all.find(m => m.id && (m.id.endsWith(suffix) || m.id.includes(normalized)));
    if (msg) return msg;
  }
  return undefined;
}

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "attachment",
    aliases: ["附件", "attach"],
    description: "查看和下载聊天消息中的附件（图片/文件/视频/语音，支持自定义下载路径）",
    usage: "/attachment list [消息ID或#尾号]\n/attachment download <消息ID或#尾号> <索引> [--to <保存路径>]\n/attachment url <消息ID或#尾号> [索引]\n/attachment recent [数量]",
    category: "media" as CommandCategory,
    elevated: true,
    handler: async (ctx) => {
      const subCmd = ctx.args[0]?.toLowerCase();

      // /attachment recent [数量] — list recent messages with attachments
      if (subCmd === "recent") {
        const count = parseInt(ctx.args[1] ?? "10", 10) || 10;
        const store = ctx.bot.getHistoryStore();
        const all = store.getHistory();
        // Find messages with attachments
        const withAttachments = all
          .filter(m => m.rawBody && extractAttachments(m.rawBody).length > 0)
          .slice(-count);
        if (withAttachments.length === 0) {
          await ctx.reply("📋 最近没有包含附件的消息");
          return;
        }
        if (ctx.useTable) {
          const rows = withAttachments.map(m => {
            const atts = extractAttachments(m.rawBody);
            return [
              m.id.slice(-8),
              new Date(m.timestamp).toLocaleString("zh-CN"),
              m.fromNickname ?? m.fromUserId,
              String(atts.length),
              atts.map(a => a.type).join(","),
            ];
          });
          await ctx.reply(`📋 最近 ${withAttachments.length} 条含附件消息:\n${await ctx.formatTable(["消息ID", "时间", "发送者", "附件数", "类型"], rows)}`);
        } else {
          const lines = withAttachments.map(m => {
            const atts = extractAttachments(m.rawBody);
            const time = new Date(m.timestamp).toLocaleString("zh-CN");
            const sender = m.fromNickname ?? m.fromUserId;
            return `  ${m.id.slice(-8)} [${time}] ${sender}: ${atts.length} 个附件 (${atts.map(a => a.type).join(", ")})`;
          });
          await ctx.reply(`📋 最近 ${withAttachments.length} 条含附件消息:\n${lines.join("\n")}`);
        }
        return;
      }

      // /attachment list [消息ID或#尾号]
      if (subCmd === "list" || !subCmd) {
        const targetId = ctx.args[1];
        let msg: { id: string; rawBody?: YuanbaoMsgBodyElement[]; fromNickname?: string; timestamp?: number } | undefined;
        if (targetId) {
          msg = findMessageByIdOrSuffix(ctx, targetId);
          if (!msg) {
            await ctx.reply(`❌ 未找到消息: ${targetId}`);
            return;
          }
        } else {
          // Default: most recent message with attachments
          const store = ctx.bot.getHistoryStore();
          const all = store.getHistory();
          msg = [...all].reverse().find(m => m.rawBody && extractAttachments(m.rawBody).length > 0);
          if (!msg) {
            await ctx.reply("📋 没有找到包含附件的消息\n用法: /attachment list <消息ID或#尾号>");
            return;
          }
        }
        const atts = extractAttachments(msg.rawBody);
        if (atts.length === 0) {
          await ctx.reply(`消息 ${msg.id.slice(-8)} 没有附件`);
          return;
        }
        const lines = atts.map(a => {
          const sizeStr = a.fileSize ? ` (${formatSize(a.fileSize)})` : "";
          const dimStr = a.width && a.height ? ` ${a.width}x${a.height}` : "";
          const nameStr = a.fileName ?? a.uuid ?? "(no name)";
          return `  [${a.index}] ${a.type}: ${nameStr}${dimStr}${sizeStr}`;
        });
        const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString("zh-CN") : "?";
        await ctx.reply(
          `📋 消息 ${msg.id.slice(-8)} 的附件 (${atts.length} 个):\n` +
          `时间: ${time}\n` +
          `发送者: ${msg.fromNickname ?? "?"}\n\n${lines.join("\n")}\n\n` +
          `下载: /attachment download ${msg.id.slice(-8)} <索引>`,
        );
        return;
      }

      // /attachment url <消息ID或#尾号> [索引] — view attachment URLs
      if (subCmd === "url") {
        if (ctx.args.length < 2) {
          await ctx.reply("用法: /attachment url <消息ID或#尾号> [索引]\n无索引=显示所有附件URL");
          return;
        }
        const msg = findMessageByIdOrSuffix(ctx, ctx.args[1]);
        if (!msg) {
          await ctx.reply(`❌ 未找到消息: ${ctx.args[1]}`);
          return;
        }
        const atts = extractAttachments(msg.rawBody);
        if (atts.length === 0) {
          await ctx.reply(`消息 ${msg.id.slice(-8)} 没有附件`);
          return;
        }
        const idxArg = ctx.args[2];
        if (idxArg !== undefined) {
          const idx = parseInt(idxArg, 10);
          if (isNaN(idx) || idx < 0 || idx >= atts.length) {
            await ctx.reply(`❌ 无效索引 ${idxArg}，该消息有 ${atts.length} 个附件 (0-${atts.length - 1})`);
            return;
          }
          const att = atts[idx];
          await ctx.reply(`📎 附件 [${idx}] ${att.type}:\nURL: ${att.url ?? "(无URL)"}\nUUID: ${att.uuid ?? "?"}`);
        } else {
          const lines = atts.map(a => `  [${a.index}] ${a.type}: ${a.url ?? "(无URL)"}`);
          await ctx.reply(`📎 消息 ${msg.id.slice(-8)} 的附件URL (${atts.length} 个):\n${lines.join("\n")}`);
        }
        return;
      }

      // /attachment download <消息ID或#尾号> <索引> [--to <保存路径>]
      if (subCmd === "download" || subCmd === "dl") {
        if (ctx.args.length < 3) {
          await ctx.reply("用法: /attachment download <消息ID或#尾号> <索引> [--to <保存路径>]\n先用 /attachment list 查看索引");
          return;
        }
        const msg = findMessageByIdOrSuffix(ctx, ctx.args[1]);
        if (!msg) {
          await ctx.reply(`❌ 未找到消息: ${ctx.args[1]}`);
          return;
        }
        const atts = extractAttachments(msg.rawBody);
        const idx = parseInt(ctx.args[2], 10);
        if (isNaN(idx) || idx < 0 || idx >= atts.length) {
          await ctx.reply(`❌ 无效索引 ${ctx.args[2]}，该消息有 ${atts.length} 个附件 (0-${atts.length - 1})`);
          return;
        }
        // Parse optional --to flag for custom save path
        let saveDir: string | undefined;
        for (let i = 3; i < ctx.args.length; i++) {
          if (ctx.args[i] === "--to" && ctx.args[i + 1]) {
            saveDir = ctx.args[i + 1];
            i++;
          }
        }
        const att = atts[idx];
        if (!att.url) {
          await ctx.reply(`❌ 该附件没有可下载的 URL (uuid: ${att.uuid ?? "?"})`);
          return;
        }
        try {
          const fileName = att.fileName ?? att.uuid ?? `attachment_${idx}`;
          await ctx.reply(`⏳ 正在下载 ${att.type}: ${fileName}...`);
          const result = await ctx.bot.downloadMedia(att.url, saveDir, fileName);
          await ctx.reply(`✅ 下载完成: ${result.filePath} (${formatSize(result.fileSize)})`);
        } catch (err) {
          await ctx.reply(`❌ 下载失败: ${(err as Error).message}`);
        }
        return;
      }

      await ctx.reply(
        "用法:\n" +
        "  /attachment list [消息ID或#尾号]              — 列出消息附件 (无参数=最近)\n" +
        "  /attachment download <ID> <索引> [--to <路径>] — 下载指定附件\n" +
        "  /attachment url <ID> [索引]                    — 查看附件URL\n" +
        "  /attachment recent [数量]                      — 列出最近含附件的消息",
      );
    },
  });
}
