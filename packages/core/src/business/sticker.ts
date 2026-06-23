/**
 * Sticker (表情/贴纸) functionality.
 *
 * Provides sticker sending, receiving, and management capabilities,
 * restored from the original openclaw-plugin-yuanbao sticker module.
 *
 * Stickers in the Yuanbao IM ecosystem are:
 * - QQ built-in stickers (identified by sticker_id + package_id, sent as TIMFaceElem)
 *   The TIMFaceElem has index=0 and data=JSON{sticker_id, package_id, width, height, formats, name}
 * - Custom stickers can also be sent as TIMFaceElem with the same format
 *
 * IMPORTANT: The correct protocol for sending stickers is TIMFaceElem with:
 *   msg_content.index = 0
 *   msg_content.data = JSON.stringify({sticker_id, package_id, width, height, formats, name})
 *
 * This is different from QQ numeric emoji indices. The TIMFaceElem "index" field
 * is always 0 for custom stickers; the actual sticker identity is in the "data" JSON.
 */

import { createLog } from "../logger.js";
import type { YuanbaoMsgBodyElement, ImImageInfoArrayItem } from "../types.js";
import { uploadMediaToCos } from "../access/http/media.js";
import type { ResolvedYuanbaoAccount } from "../types.js";
import type { PersistenceAdapter } from "../access/persistence/adapter.js";
import {
  getDefaultPersistenceAdapter,
  getDefaultPersistenceDir,
  getNodeModules,
  joinPath,
} from "../access/persistence/adapter.js";

// ─── Types ───

export type StickerType = "emoji" | "custom" | "gif" | "webp";

export type StickerInfo = {
  /** Unique sticker identifier */
  id: string;
  /** Sticker display name */
  name: string;
  /** Sticker type */
  type: StickerType;
  /** For emoji: the emoji index */
  emojiIndex?: number;
  /** For custom/GIF: the file path or URL */
  source?: string;
  /** Description text */
  description?: string;
  /** Sticker pack name */
  pack?: string;
  /** Sticker ID (protocol-level, e.g. "278") */
  stickerId?: string;
  /** Package ID (protocol-level, e.g. "1003") */
  packageId?: string;
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Format string (e.g. "png") */
  formats?: string;
};

export type StickerPack = {
  /** Pack name */
  name: string;
  /** Pack description */
  description?: string;
  /** Stickers in this pack */
  stickers: StickerInfo[];
};

export type SendStickerResult = {
  /** Whether the sticker was sent successfully */
  success: boolean;
  /** Message body that was sent */
  msgBody: YuanbaoMsgBodyElement[];
  /** Error message if failed */
  error?: string;
};

// ─── Sticker Registry ───

const stickerRegistry = new Map<string, StickerInfo>();
const stickerPacks = new Map<string, StickerPack>();

// ─── Built-in sticker data (from original project's builtin-stickers.json) ───

type BuiltinStickerEntry = {
  emoji_id: string;
  emoji_pack_id: string;
  name: string;
  description?: string;
  width: number;
  height: number;
  formats: string;
};

const BUILTIN_STICKERS: BuiltinStickerEntry[] = [
  {
    emoji_id: "278",
    emoji_pack_id: "1003",
    name: "六六六",
    description: "666 厉害 牛 棒 绝了 好强 awesome",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "262",
    emoji_pack_id: "1003",
    name: "我想开了",
    description: "想开 佛系 释怀 顿悟 看淡了 无所谓",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "130",
    emoji_pack_id: "1003",
    name: "害羞",
    description: "腼腆 不好意思 脸红 娇羞 羞涩 捂脸",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "252",
    emoji_pack_id: "1003",
    name: "比心",
    description: "笔芯 爱你 爱心手势 love heart 喜欢你",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "125",
    emoji_pack_id: "1003",
    name: "委屈",
    description: "难过 想哭 可怜巴巴 瘪嘴 受伤 被欺负",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "146",
    emoji_pack_id: "1003",
    name: "亲亲",
    description: "么么 mua 亲一下 kiss 飞吻 啵",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "131",
    emoji_pack_id: "1003",
    name: "酷",
    description: "帅 墨镜 cool 高冷 有型 swagger",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "145",
    emoji_pack_id: "1003",
    name: "睡",
    description: "睡觉 困 zzZ 打盹 躺平 休眠 sleepy",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "152",
    emoji_pack_id: "1003",
    name: "发呆",
    description: "懵 愣住 放空 呆滞 出神 脑子空白",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "157",
    emoji_pack_id: "1003",
    name: "可怜",
    description: "卖萌 求饶 委屈巴巴 弱小 拜托 眼巴巴",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "200",
    emoji_pack_id: "1003",
    name: "摊手",
    description: "无奈 没办法 耸肩 随便 那咋整 whatever",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "213",
    emoji_pack_id: "1003",
    name: "头大",
    description: "头疼 烦恼 郁闷 难搞 崩溃 一团乱",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "256",
    emoji_pack_id: "1003",
    name: "吓",
    description: "害怕 惊恐 震惊 吓一跳 恐怖 怂",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "203",
    emoji_pack_id: "1003",
    name: "吐血",
    description: "无语 崩溃 被雷 内伤 一口老血 屮",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "185",
    emoji_pack_id: "1003",
    name: "哼",
    description: "傲娇 生气 不满 撇嘴 不理 赌气",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "220",
    emoji_pack_id: "1003",
    name: "嘿嘿",
    description: "坏笑 猥琐笑 偷笑 憨笑 得意 你懂的",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "218",
    emoji_pack_id: "1003",
    name: "头秃",
    description: "程序员 加班 焦虑 没头发 秃了 肝爆",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "221",
    emoji_pack_id: "1003",
    name: "暗中观察",
    description: "窥屏 潜水 偷偷看 角落 围观 屏住呼吸",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "224",
    emoji_pack_id: "1003",
    name: "我酸了",
    description: "嫉妒 柠檬精 羡慕 吃柠檬 眼红 恰柠檬",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "246",
    emoji_pack_id: "1003",
    name: "打call",
    description: "应援 加油 支持 喝彩 助威 call",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "251",
    emoji_pack_id: "1003",
    name: "庆祝",
    description: "祝贺 开心 耶 party 胜利 干杯",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "151",
    emoji_pack_id: "1003",
    name: "奋斗",
    description: "努力 加油 拼搏 冲 干劲 卷起来",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "143",
    emoji_pack_id: "1003",
    name: "惊讶",
    description: "震惊 哇 不敢相信 OMG 居然 这么离谱",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "144",
    emoji_pack_id: "1003",
    name: "疑问",
    description: "问号 不懂 啥 为什么 啥情况 懵逼问",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "248",
    emoji_pack_id: "1003",
    name: "仔细分析",
    description: "思考 推敲 认真 研究 琢磨 让我想想",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "184",
    emoji_pack_id: "1003",
    name: "撅嘴",
    description: "嘟嘴 卖萌 不高兴 撒娇 嘴翘",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "199",
    emoji_pack_id: "1003",
    name: "泪奔",
    description: "大哭 伤心 破防 感动哭 泪流满面 呜呜",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "276",
    emoji_pack_id: "1003",
    name: "尊嘟假嘟",
    description: "真的假的 真假 可爱问 你骗我 是不是",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "113",
    emoji_pack_id: "1003",
    name: "略略略",
    description: "调皮 吐舌 不服 略 气死你 鬼脸",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "180",
    emoji_pack_id: "1003",
    name: "困",
    description: "想睡 倦 打哈欠 睁不开眼 好困啊 sleepy",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "181",
    emoji_pack_id: "1003",
    name: "折磨",
    description: "难受 痛苦 煎熬 蚌埠住了 受不了 要命",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "182",
    emoji_pack_id: "1003",
    name: "抠鼻",
    description: "不屑 无聊 淡定 无所谓 鄙视 挖鼻",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "183",
    emoji_pack_id: "1003",
    name: "鼓掌",
    description: "拍手 叫好 赞同 666 喝彩 掌声",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "204",
    emoji_pack_id: "1003",
    name: "斜眼笑",
    description: "滑稽 坏笑 doge 意味深长 阴阳怪气 嘿嘿嘿",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "215",
    emoji_pack_id: "1003",
    name: "泪奔",
    description: "流泪 大哭 崩溃哭 嚎啕 伤心欲绝 撑不住",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "216",
    emoji_pack_id: "1003",
    name: "辣眼睛",
    description: "看不下去 cringe 毁三观 太丑了 瞎了",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "217",
    emoji_pack_id: "1003",
    name: "哦哟",
    description: "惊讶 起哄 哇哦 有戏 不简单 哟",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "222",
    emoji_pack_id: "1003",
    name: "吃瓜",
    description: "围观 看戏 八卦 路人 看热闹 板凳",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "225",
    emoji_pack_id: "1003",
    name: "狗头",
    description: "doge 保命 开玩笑 滑稽 反讽 懂的都懂",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "227",
    emoji_pack_id: "1003",
    name: "敬礼",
    description: "salute 尊重 收到 遵命 致敬 报告",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "231",
    emoji_pack_id: "1003",
    name: "哦",
    description: "知道了 明白 敷衍 嗯 这样啊 收到",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "236",
    emoji_pack_id: "1003",
    name: "拿到红包",
    description: "红包 谢谢老板 发财 开心 抢到了 欧气",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "239",
    emoji_pack_id: "1003",
    name: "牛吖",
    description: "牛 厉害 强 666 佩服 大佬",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "272",
    emoji_pack_id: "1003",
    name: "贴贴",
    description: "抱抱 亲昵 蹭蹭 亲密 靠靠 撒娇贴",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "138",
    emoji_pack_id: "1003",
    name: "爱心",
    description: "心 love 喜欢你 红心 示爱 么么哒",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "170",
    emoji_pack_id: "1003",
    name: "晚安",
    description: "好梦 睡了 night 早点休息 安啦 moon",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "176",
    emoji_pack_id: "1003",
    name: "太阳",
    description: "晴天 早上好 阳光 morning 好天气 日",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "266",
    emoji_pack_id: "1003",
    name: "柠檬",
    description: "酸 嫉妒 柠檬精 羡慕 我酸 恰柠檬",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "267",
    emoji_pack_id: "1003",
    name: "大冤种",
    description: "倒霉 吃亏 自嘲 好心没好报 背锅 工具人",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "132",
    emoji_pack_id: "1003",
    name: "吐了",
    description: "恶心 yue 受不了 嫌弃 想吐 生理不适",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "134",
    emoji_pack_id: "1003",
    name: "怒",
    description: "生气 愤怒 火大 暴躁 气炸 怼",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "165",
    emoji_pack_id: "1003",
    name: "玫瑰",
    description: "花 示爱 表白 浪漫 送你花 情人节",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "119",
    emoji_pack_id: "1003",
    name: "凋谢",
    description: "花谢 失恋 难过 枯萎 心碎 凉了",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "159",
    emoji_pack_id: "1003",
    name: "点赞",
    description: "赞 认同 好棒 good like 大拇指 顶",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "164",
    emoji_pack_id: "1003",
    name: "握手",
    description: "合作 你好 商务 hello deal 成交 友好",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "163",
    emoji_pack_id: "1003",
    name: "抱拳",
    description: "谢谢 失敬 江湖 承让 拜托 有礼",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "169",
    emoji_pack_id: "1003",
    name: "ok",
    description: "好的 收到 没问题 okay 行 可以 懂了",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "174",
    emoji_pack_id: "1003",
    name: "拳头",
    description: "加油 干 冲 fight 力量 击拳 硬气",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "191",
    emoji_pack_id: "1003",
    name: "鞭炮",
    description: "过年 喜庆 爆竹 春节 噼里啪啦 红",
    width: 128,
    height: 128,
    formats: "png",
  },
  {
    emoji_id: "258",
    emoji_pack_id: "1003",
    name: "烟花",
    description: "庆典 漂亮 新年 嘭 绽放 节日快乐",
    width: 128,
    height: 128,
    formats: "png",
  },
];

// Name-to-sticker lookup map
const stickerByName = new Map<string, BuiltinStickerEntry>();

// Initialize name lookup from BUILTIN_STICKERS
for (const s of BUILTIN_STICKERS) {
  stickerByName.set(s.name, s);
  // Also index by description keywords
  if (s.description) {
    const keywords = s.description.split(/\s+/);
    for (const kw of keywords) {
      if (kw && kw.length >= 2) {
        stickerByName.set(kw, s);
      }
    }
  }
}

// ─── Sticker Cache (file-based persistence) ───

type CachedSticker = {
  sticker_id: string;
  package_id: string;
  name: string;
  description: string;
  cachedAt: string;
  source?: "builtin" | "received";
  width?: number;
  height?: number;
  formats?: string;
};

type StickerCache = {
  version: number;
  stickers: Record<string, CachedSticker>;
};

// ─── Sticker cache persistence (lazy, adapter-backed) ───

let stickerCachePersistencePath: string | null = null;
let stickerCachePersistenceAdapter: PersistenceAdapter | null = null;

/**
 * Configure the sticker cache's persistence backend.
 *
 * - Node callers can omit `persistencePath` to use the default
 *   `~/.yuanbao-lite/sticker-cache.json`.
 * - Browser callers MUST provide both `persistencePath` and `persistenceAdapter`.
 */
export function initStickerCacheStore(config?: {
  persistencePath?: string;
  persistenceAdapter?: PersistenceAdapter;
}): void {
  stickerCachePersistencePath = config?.persistencePath ?? null;
  stickerCachePersistenceAdapter = config?.persistenceAdapter ?? null;
  stickerCache = null; // reset cache so next getStickerCache() reloads
}

function getCachePath(): string {
  if (stickerCachePersistencePath) return stickerCachePersistencePath;
  // Under Node, getDefaultPersistenceDir() returns ~/.yuanbao-lite (uses node:os + node:path).
  // Under browser, it throws — caller must pass persistencePath explicitly.
  return joinPath(getDefaultPersistenceDir(), "sticker-cache.json");
}

function getCacheAdapter(): PersistenceAdapter {
  if (stickerCachePersistenceAdapter) return stickerCachePersistenceAdapter;
  return getDefaultPersistenceAdapter();
}

let stickerCache: StickerCache | null = null;

function getStickerCache(): StickerCache {
  if (!stickerCache) {
    stickerCache = loadStickerCache();
    // Populate with builtin stickers (don't overwrite received ones)
    for (const s of BUILTIN_STICKERS) {
      if (
        !stickerCache.stickers[s.emoji_id] ||
        stickerCache.stickers[s.emoji_id].source === "builtin"
      ) {
        stickerCache.stickers[s.emoji_id] = {
          sticker_id: s.emoji_id,
          package_id: s.emoji_pack_id,
          name: s.name,
          description: s.description || "",
          cachedAt: new Date().toISOString(),
          source: "builtin",
          width: s.width,
          height: s.height,
          formats: s.formats,
        };
      }
    }
    saveStickerCache();
  }
  return stickerCache;
}

function loadStickerCache(): StickerCache {
  try {
    const filePath = getCachePath();
    const adapter = getCacheAdapter();
    if (adapter.exists(filePath)) {
      const raw = adapter.read(filePath);
      return JSON.parse(raw) as StickerCache;
    }
  } catch {
    // Ignore parse errors
  }
  return { version: 1, stickers: {} };
}

function saveStickerCache(): void {
  if (!stickerCache) return;
  try {
    const filePath = getCachePath();
    const adapter = getCacheAdapter();
    adapter.write(filePath, JSON.stringify(stickerCache, null, 2));
  } catch {
    // Ignore write errors
  }
}

/**
 * Add a received sticker to the cache.
 */
export function cacheReceivedSticker(data: {
  sticker_id: string;
  package_id: string;
  name?: string;
  width?: number;
  height?: number;
  formats?: string;
}): void {
  const cache = getStickerCache();
  const existing = cache.stickers[data.sticker_id];
  // Don't overwrite builtin entries with received data
  if (existing && existing.source === "builtin") return;

  cache.stickers[data.sticker_id] = {
    sticker_id: data.sticker_id,
    package_id: data.package_id,
    name: data.name || data.sticker_id,
    description: "",
    cachedAt: new Date().toISOString(),
    source: "received",
    width: data.width,
    height: data.height,
    formats: data.formats,
  };
  saveStickerCache();
}

/**
 * Build a TIMFaceElem msg_body for sending a sticker.
 *
 * In the Tencent IM protocol, stickers are sent as TIMFaceElem with:
 *   index: 0
 *   data: JSON string with sticker_id, package_id, width, height, formats, name
 *
 * This is the correct protocol format discovered from the original openclaw-plugin-yuanbao.
 * The previous implementation used TIMCustomElem or TIMImageElem, which was incorrect.
 */
export function buildStickerMsgBody(
  sticker: CachedSticker,
): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMFaceElem",
      msg_content: {
        index: 0,
        data: JSON.stringify({
          sticker_id: sticker.sticker_id,
          package_id: sticker.package_id,
          width: sticker.width ?? 0,
          height: sticker.height ?? 0,
          formats: sticker.formats ? [sticker.formats] : [],
          name: sticker.name,
        }),
      },
    },
  ];
}

/**
 * Build a TIMFaceElem msg_body for sending a sticker by its components.
 */
export function buildStickerMsgBodyFromParts(params: {
  stickerId: string;
  packageId: string;
  name: string;
  width?: number;
  height?: number;
  formats?: string;
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMFaceElem",
      msg_content: {
        index: 0,
        data: JSON.stringify({
          sticker_id: params.stickerId,
          package_id: params.packageId,
          width: params.width ?? 0,
          height: params.height ?? 0,
          formats: params.formats ? [params.formats] : [],
          name: params.name,
        }),
      },
    },
  ];
}

/**
 * Legacy: Build a TIMFaceElem for QQ built-in numeric emoji index.
 * NOTE: This is for the old-style QQ numeric emojis only (index 0-31).
 * For actual sticker sending, use buildStickerMsgBody() instead.
 */
export function buildEmojiMsgBody(emojiIndex: number): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMFaceElem",
      msg_content: {
        index: emojiIndex,
        text: "\u{1F600}",
      },
    },
  ];
}

/**
 * Build a TIMCustomElem msg_body for sending a custom sticker.
 * NOTE: This is a fallback for custom image stickers, not the primary protocol.
 */
export function buildCustomStickerMsgBody(params: {
  uuid: string;
  url: string;
  width?: number;
  height?: number;
  name?: string;
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMCustomElem",
      msg_content: {
        data: JSON.stringify({
          stickerId: params.uuid,
          stickerUrl: params.url,
          stickerWidth: params.width || 200,
          stickerHeight: params.height || 200,
        }),
        desc: params.name || "sticker",
        ext: JSON.stringify({
          emojiType: 2,
          stickerId: params.uuid,
          stickerUrl: params.url,
          stickerWidth: params.width || 200,
          stickerHeight: params.height || 200,
        }),
      },
    },
  ];
}

/**
 * Build a TIMImageElem msg_body for sending a sticker as an image.
 */
export function buildStickerImageMsgBody(params: {
  uuid: string;
  url: string;
  width?: number;
  height?: number;
  size?: number;
}): YuanbaoMsgBodyElement[] {
  const imageInfoArray: ImImageInfoArrayItem[] = [
    {
      type: 0, // Original
      size: params.size,
      width: params.width,
      height: params.height,
      url: params.url,
    },
    {
      type: 1, // Thumbnail
      width: Math.min(params.width || 200, 200),
      height: Math.min(params.height || 200, 200),
      url: params.url,
    },
  ];

  return [
    {
      msg_type: "TIMImageElem",
      msg_content: {
        uuid: params.uuid,
        image_format: params.url?.endsWith(".gif") ? 0 : 1,
        image_info_array: imageInfoArray,
      },
    },
  ];
}

// ─── Sticker detection from incoming messages ───

/**
 * Check if a message body contains a sticker and extract its info.
 */
export function detectSticker(
  msgBody: YuanbaoMsgBodyElement[],
): StickerInfo | null {
  for (const el of msgBody) {
    const content = el.msg_content;
    if (!content) continue;

    // TIMFaceElem — sticker (new protocol: index=0 + data JSON)
    if (el.msg_type === "TIMFaceElem") {
      const rawData = content.data;
      if (rawData && typeof rawData === "string") {
        try {
          const faceData = JSON.parse(rawData) as {
            sticker_id?: string;
            package_id?: string;
            name?: string;
            width?: number;
            height?: number;
            formats?: string | string[];
          };

          if (faceData.sticker_id) {
            // This is a proper sticker with sticker_id
            const formatsStr = Array.isArray(faceData.formats)
              ? faceData.formats[0] || "png"
              : faceData.formats || "png";

            // Cache this received sticker
            cacheReceivedSticker({
              sticker_id: faceData.sticker_id,
              package_id: faceData.package_id || "1003",
              name: faceData.name,
              width: faceData.width,
              height: faceData.height,
              formats: formatsStr,
            });

            return {
              id: `sticker_${faceData.sticker_id}`,
              name: faceData.name || `Sticker ${faceData.sticker_id}`,
              type: "emoji",
              stickerId: faceData.sticker_id,
              packageId: faceData.package_id,
              width: faceData.width,
              height: faceData.height,
              formats: formatsStr,
            };
          }
        } catch {
          // JSON parse failed
        }
      }

      // Old-style numeric emoji (index field only, no data)
      const idx = content.index;
      if (idx !== undefined && idx !== null) {
        return {
          id: `emoji_${idx}`,
          name: `Emoji ${idx}`,
          type: "emoji",
          emojiIndex: typeof idx === "number" ? idx : parseInt(String(idx), 10),
        };
      }
    }

    // TIMCustomElem with sticker data
    if (el.msg_type === "TIMCustomElem") {
      try {
        const ext = content.ext ? JSON.parse(content.ext) : null;
        const data = content.data ? JSON.parse(content.data) : null;

        // elem_type=1002 is @mention, not a sticker
        if (data?.elem_type === 1002) continue;

        if (ext?.emojiType === 1 && ext.emojiIndex !== undefined) {
          return {
            id: `emoji_${ext.emojiIndex}`,
            name: `Emoji ${ext.emojiIndex}`,
            type: "emoji",
            emojiIndex: ext.emojiIndex,
          };
        }

        if (ext?.emojiType === 2 || data?.stickerId) {
          return {
            id: data?.stickerId || ext?.stickerId || "unknown",
            name: content.desc || "Custom Sticker",
            type: "custom",
            source: data?.stickerUrl || ext?.stickerUrl,
          };
        }
      } catch {
        // Not valid JSON
      }
    }

    // TIMImageElem that might be a sticker (typically small GIF/WebP)
    if (el.msg_type === "TIMImageElem") {
      const url = content.image_info_array?.[0]?.url;
      if (url && (url.includes(".gif") || url.includes(".webp"))) {
        return {
          id: content.uuid || "img_sticker",
          name: "Image Sticker",
          type: url.includes(".gif") ? "gif" : "webp",
          source: url,
          description: content.desc,
        };
      }
    }
  }

  return null;
}

// ─── Sticker Pack Management ───

export function registerStickerPack(pack: StickerPack): void {
  stickerPacks.set(pack.name, pack);
  for (const sticker of pack.stickers) {
    stickerRegistry.set(sticker.id, sticker);
  }
  createLog("sticker").info(
    `registered sticker pack: ${pack.name} (${pack.stickers.length} stickers)`,
  );
}

export function unregisterStickerPack(packName: string): boolean {
  const pack = stickerPacks.get(packName);
  if (!pack) return false;

  for (const sticker of pack.stickers) {
    stickerRegistry.delete(sticker.id);
  }
  stickerPacks.delete(packName);
  return true;
}

export function getSticker(id: string): StickerInfo | undefined {
  return stickerRegistry.get(id);
}

export function getStickerPacks(): StickerPack[] {
  return [...stickerPacks.values()];
}

// ─── Fuzzy sticker search (ported from openclaw-plugin-yuanbao sticker-cache.ts) ───

/** Normalize case/compat chars for mixed CJK+ASCII name matching */
function normalizeStickerMatchText(raw: string): string {
  return (raw ?? "").normalize("NFKC").trim().toLowerCase();
}

/** Strip whitespace and common punctuation to handle "打 call" vs "打call", fullwidth spaces, etc. */
function compactStickerMatchText(s: string): string {
  return normalizeStickerMatchText(s).replace(
    /[\s\u3000\-_·.,，。!！?？"""'''、/\\]+/g,
    "",
  );
}

function bigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/** Bigram Jaccard — helps when CJK word boundaries are weak or substring not contiguous */
function stickerBigramJaccard(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigramSet(a);
  const B = bigramSet(b);
  let inter = 0;
  for (const x of A) {
    if (B.has(x)) inter++;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Query char multiset hit ratio in name (repeated chars need multiple hits) */
function multisetCharHitRatio(
  needleCompact: string,
  hayCompact: string,
): number {
  if (!needleCompact.length) return 0;
  const bag = new Map<string, number>();
  for (const ch of hayCompact) {
    bag.set(ch, (bag.get(ch) ?? 0) + 1);
  }
  let hits = 0;
  for (const ch of needleCompact) {
    const n = bag.get(ch) ?? 0;
    if (n > 0) {
      hits++;
      bag.set(ch, n - 1);
    }
  }
  return hits / needleCompact.length;
}

/** Longest subsequence ratio of needle in haystack */
function longestSubsequenceRatio(needle: string, haystack: string): number {
  if (!needle.length) return 0;
  let j = 0;
  for (let i = 0; i < haystack.length && j < needle.length; i++) {
    if (haystack[i] === needle[j]) j++;
  }
  return j / needle.length;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from<number>({ length: n + 1 });
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

/** Short pure-ASCII fragment (e.g. call, ok) fuzzy match against name's ASCII portion */
function asciiFuzzyStickerScore(needleNorm: string, hayNorm: string): number {
  if (needleNorm.length < 2 || needleNorm.length > 14) return 0;
  if (!needleNorm.split("").every((ch) => ch.charCodeAt(0) <= 0x7f)) return 0;
  const h = hayNorm.replace(/[^a-z0-9]/g, "");
  if (h.length < needleNorm.length - 1 || h.length > 36) return 0;
  const slice =
    h.length > needleNorm.length + 6 ? h.slice(0, needleNorm.length + 6) : h;
  const d = levenshtein(needleNorm, slice);
  const maxL = Math.max(needleNorm.length, slice.length, 1);
  return Math.max(0, (1 - d / maxL) * 38);
}

/**
 * Similarity score (0~100+) of a single field against the full query,
 * combining CJK substring, char coverage, bigram overlap, and lightweight fuzzy.
 */
function scoreStickerFieldAgainstQuery(
  haystack: string,
  rawQuery: string,
): number {
  const hay = normalizeStickerMatchText(haystack);
  const q = normalizeStickerMatchText(rawQuery);
  if (!hay || !q) return 0;

  const hayC = compactStickerMatchText(haystack);
  const qC = compactStickerMatchText(rawQuery);

  let best = 0;

  if (hay === q) best = Math.max(best, 100);
  if (hay.includes(q)) best = Math.max(best, 92 + Math.min(6, q.length));
  if (q.length >= 2 && hay.startsWith(q)) best = Math.max(best, 88);
  if (qC.length > 0 && hayC.includes(qC)) best = Math.max(best, 86);

  const charR = multisetCharHitRatio(qC, hayC);
  best = Math.max(best, charR * 62);

  const jac = stickerBigramJaccard(qC, hayC);
  best = Math.max(best, jac * 58);

  const sub = longestSubsequenceRatio(qC, hayC);
  best = Math.max(best, sub * 52);

  best = Math.max(best, asciiFuzzyStickerScore(q, hay));

  if (q.length === 1 && hay.includes(q)) best = Math.max(best, 68);

  return best;
}

function scoreStickerFieldAgainstTokens(
  haystack: string,
  tokens: string[],
): number {
  if (tokens.length === 0) return 0;
  const parts = tokens.map((t) => scoreStickerFieldAgainstQuery(haystack, t));
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  const weakest = Math.min(...parts);
  return weakest * 0.35 + mean * 0.65;
}

function tokenizeStickerQuery(raw: string): string[] {
  const q = normalizeStickerMatchText(raw);
  return q.split(/\s+/).filter(Boolean);
}

/**
 * Merge "full phrase" and "tokenized" scores: multi-word queries like "暗中 观察" match "暗中观察"-style names better.
 */
function scoreStickerTextAgainstQuery(
  haystack: string,
  rawQuery: string,
): number {
  const full = scoreStickerFieldAgainstQuery(haystack, rawQuery);
  const tokens = tokenizeStickerQuery(rawQuery);
  if (tokens.length <= 1) return full;
  const multi = scoreStickerFieldAgainstTokens(haystack, tokens);
  return Math.max(full, multi);
}

/**
 * Search stickers using fuzzy matching (ported from openclaw-plugin-yuanbao).
 *
 * Scoring: NFKC normalization + punctuation-stripped substring match, CJK char multiset coverage,
 * bigram Jaccard, subsequence ratio, short ASCII edit distance; name weighted higher than description,
 * id used for exact id search.
 */
export function searchStickers(query: string, limit = 20): StickerInfo[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 20));
  const q = normalizeStickerMatchText(query);
  if (!q) {
    // Return all builtin stickers when no query
    return BUILTIN_STICKERS.slice(0, safeLimit).map((s) => ({
      id: `emoji_${s.emoji_id}`,
      name: s.name,
      type: "emoji" as StickerType,
      stickerId: s.emoji_id,
      packageId: s.emoji_pack_id,
      width: s.width,
      height: s.height,
      formats: s.formats,
      description: s.description,
    }));
  }

  // Build a combined pool: builtin stickers + registry stickers
  type ScoredEntry = { sticker: StickerInfo; score: number };
  const scored: ScoredEntry[] = [];
  const seen = new Set<string>();

  // Score builtin stickers
  for (const s of BUILTIN_STICKERS) {
    const id = `emoji_${s.emoji_id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const nameS = scoreStickerTextAgainstQuery(s.name, query);
    const descS = s.description
      ? scoreStickerTextAgainstQuery(s.description, query) * 0.88
      : 0;
    const idNorm = normalizeStickerMatchText(s.emoji_id);
    const idQ = normalizeStickerMatchText(query);
    let idS = 0;
    if (idNorm && idQ) {
      if (idNorm === idQ) idS = 100;
      else if (idNorm.includes(idQ)) idS = 84;
    }

    const score = Math.max(nameS, descS, idS);
    if (score > 0) {
      scored.push({
        sticker: {
          id,
          name: s.name,
          type: "emoji",
          stickerId: s.emoji_id,
          packageId: s.emoji_pack_id,
          width: s.width,
          height: s.height,
          formats: s.formats,
          description: s.description,
        },
        score,
      });
    }
  }

  // Score registry stickers (loaded sticker packs)
  for (const sticker of stickerRegistry.values()) {
    if (seen.has(sticker.id)) continue;
    seen.add(sticker.id);

    const nameS = scoreStickerTextAgainstQuery(sticker.name, query);
    const descS = sticker.description
      ? scoreStickerTextAgainstQuery(sticker.description, query) * 0.88
      : 0;
    const idS = scoreStickerTextAgainstQuery(sticker.id, query) * 0.7;
    const score = Math.max(nameS, descS, idS);
    if (score > 0) {
      scored.push({ sticker, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply floor threshold
  const top = scored[0]?.score ?? 0;
  if (top > 0) {
    let floor: number;
    if (top >= 22) floor = 18;
    else if (top >= 12) floor = Math.max(10, top * 0.5);
    else floor = Math.max(6, top * 0.35);
    const filtered = scored.filter((s) => s.score >= floor);
    if (filtered.length > 0) {
      return filtered.slice(0, safeLimit).map((s) => s.sticker);
    }
  }

  // Fallback: return top results even if below threshold
  return scored.slice(0, safeLimit).map((s) => s.sticker);
}

/**
 * Load sticker packs from a local directory.
 *
 * Node-only — uses `node:fs.readdirSync` / `statSync` to scan a directory.
 * Browser callers should use `registerStickerPack()` directly with sticker
 * sources that are URLs (the bot will fetch + upload via `uploadMediaToCos`).
 *
 * Throws synchronously if called in a browser/edge runtime (no `node:fs`
 * available) OR if called before the Node module preload has completed
 * (caller should `await nodeModulesReady` from adapter.ts first).
 *
 * @param dirPath - Absolute path to the sticker packs root directory.
 *                  Each subdirectory becomes a sticker pack; each image
 *                  file in a subdirectory becomes a sticker.
 * @returns Number of sticker packs loaded.
 */
export function loadStickerPacksFromDir(dirPath: string): number {
  const log = createLog("sticker");
  const { fs, path } = getNodeModules();
  if (!fs || !path) {
    throw new Error(
      "loadStickerPacksFromDir is Node-only — it requires node:fs and node:path. " +
        "If calling at app startup, `await nodeModulesReady` first (from access/persistence/adapter.ts). " +
        "Browser callers should use registerStickerPack() with URL-based sticker sources.",
    );
  }
  let packCount = 0;

  if (!fs.existsSync(dirPath)) {
    log.warn(`sticker directory not found: ${dirPath}`);
    return 0;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const packDir = path.join(dirPath, entry.name);
    const stickers: StickerInfo[] = [];
    const files = fs.readdirSync(packDir);

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (![".gif", ".webp", ".png", ".jpg", ".jpeg"].includes(ext)) continue;

      const filePath = path.join(packDir, file);
      const name = path.basename(file, ext);
      const _stat = fs.statSync(filePath);

      stickers.push({
        id: `${entry.name}:${name}`,
        name,
        type: ext === ".gif" ? "gif" : ext === ".webp" ? "webp" : "custom",
        source: filePath,
        description: name,
        pack: entry.name,
      });
    }

    if (stickers.length > 0) {
      registerStickerPack({
        name: entry.name,
        description: `Sticker pack: ${entry.name}`,
        stickers,
      });
      packCount++;
    }
  }

  log.info(`loaded ${packCount} sticker packs from ${dirPath}`);
  return packCount;
}

// ─── Send sticker ───

/**
 * Send a sticker by its ID or name.
 *
 * Protocol: Uses TIMFaceElem with index=0 and data=JSON(sticker_id, package_id, ...)
 * This is the correct protocol format from the original openclaw-plugin-yuanbao.
 */
export async function prepareStickerMsgBody(
  account: ResolvedYuanbaoAccount,
  stickerId: string,
): Promise<YuanbaoMsgBodyElement[]> {
  const log = createLog("sticker");
  const cache = getStickerCache();

  // 1. Try direct cache lookup by sticker_id
  const cached = cache.stickers[stickerId];
  if (cached) {
    log.info(
      `sticker cache hit: ${cached.name} (sticker_id=${cached.sticker_id}, package_id=${cached.package_id})`,
    );
    return buildStickerMsgBody(cached);
  }

  // 2. Try prefix "sticker_" removal
  if (stickerId.startsWith("sticker_")) {
    const rawId = stickerId.replace("sticker_", "");
    const cachedRaw = cache.stickers[rawId];
    if (cachedRaw) {
      log.info(`sticker cache hit (raw): ${cachedRaw.name}`);
      return buildStickerMsgBody(cachedRaw);
    }
  }

  // 3. Try prefix "emoji_" — builtin sticker lookup by emoji_id
  if (stickerId.startsWith("emoji_")) {
    const rawEmojiId = stickerId.replace("emoji_", "");
    // First, check if this is a known builtin sticker (has sticker_id + package_id)
    const cachedEmoji = cache.stickers[rawEmojiId];
    if (cachedEmoji && cachedEmoji.package_id) {
      log.info(
        `sticker builtin lookup: emoji_${rawEmojiId} -> ${cachedEmoji.name} (sticker_id=${cachedEmoji.sticker_id}, package_id=${cachedEmoji.package_id})`,
      );
      return buildStickerMsgBody(cachedEmoji);
    }
    // Otherwise, treat as old-style numeric emoji index (0-31)
    const idx = parseInt(rawEmojiId, 10);
    if (!isNaN(idx)) {
      return buildEmojiMsgBody(idx);
    }
  }

  // 4. Try name lookup in builtin stickers
  const byName = stickerByName.get(stickerId);
  if (byName) {
    const cachedByName = cache.stickers[byName.emoji_id];
    if (cachedByName) {
      log.info(`sticker name lookup: "${stickerId}" -> ${cachedByName.name}`);
      return buildStickerMsgBody(cachedByName);
    }
  }

  // 5. Fuzzy name search across all cached stickers
  const q = stickerId.toLowerCase();
  for (const [id, s] of Object.entries(cache.stickers)) {
    if (
      s.name.toLowerCase().includes(q) ||
      (s.description && s.description.toLowerCase().includes(q))
    ) {
      log.info(
        `sticker fuzzy match: "${stickerId}" -> ${s.name} (sticker_id=${id})`,
      );
      return buildStickerMsgBody(s);
    }
  }

  // 6. Look up in registry (for loaded sticker packs)
  const regSticker = stickerRegistry.get(stickerId);
  if (regSticker) {
    // For GIF/WebP stickers, upload and send as image
    // Check if the source is a readable local file — only under Node
    // (browser stickers should use URL sources, which don't need this check)
    const nodeFs = getNodeModules().fs;
    const sourceIsLocalFile =
      regSticker.source && nodeFs && nodeFs.existsSync(regSticker.source);
    if (sourceIsLocalFile && regSticker.source) {
      log.info(
        `uploading sticker: ${regSticker.name} from ${regSticker.source}`,
      );
      try {
        const uploadResult = await uploadMediaToCos(
          account,
          regSticker.source,
          {
            mediaType: "image",
          },
        );

        if (regSticker.type === "gif" || regSticker.type === "webp") {
          return buildStickerImageMsgBody({
            uuid: uploadResult.uuid,
            url: uploadResult.url,
          });
        }

        return buildCustomStickerMsgBody({
          uuid: uploadResult.uuid,
          url: uploadResult.url,
          name: regSticker.name,
        });
      } catch (err) {
        log.warn(
          `sticker upload failed: ${(err as Error).message}, falling back to TIMFaceElem`,
        );
      }
    }

    // If source is a URL, use it directly
    if (regSticker.source?.startsWith("http")) {
      if (regSticker.type === "gif" || regSticker.type === "webp") {
        return buildStickerImageMsgBody({
          uuid: regSticker.id,
          url: regSticker.source,
        });
      }
      return buildCustomStickerMsgBody({
        uuid: regSticker.id,
        url: regSticker.source,
        name: regSticker.name,
      });
    }
  }

  throw new Error(
    `Sticker not found: ${stickerId}. Use /stickers to see available stickers, or /search stickers <keyword> to search.`,
  );
}

/**
 * Get the built-in emoji list.
 */
export function getBuiltinEmojis(): Array<{
  stickerId: string;
  packageId: string;
  name: string;
  description?: string;
}> {
  return BUILTIN_STICKERS.map((s) => ({
    stickerId: s.emoji_id,
    packageId: s.emoji_pack_id,
    name: s.name,
    description: s.description,
  }));
}

/**
 * Get all builtin stickers raw data.
 */
export function getBuiltinStickersData(): BuiltinStickerEntry[] {
  return [...BUILTIN_STICKERS];
}
