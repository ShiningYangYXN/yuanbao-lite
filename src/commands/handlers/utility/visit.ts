/**
 * /visit command — fetch a web page and inject cleaned content into LLM context.
 *
 * Usage:
 *   /visit <URL>   — fetch URL, clean HTML, inject into LLM context
 *
 * Cleaning strategy (in priority order):
 *   1. Jina Reader (https://r.jina.ai/) — cloud service, returns clean markdown
 *   2. defuddle (local) — fallback if Jina fails
 *
 * The cleaned content is stored in the content-store AND injected directly
 * into the LLM conversation as a user message.
 *
 * Category: utility
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

const MAX_CONTENT_LENGTH = 8000;
const JINA_READER_URL = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 15000;

/**
 * Try Jina Reader to fetch and clean a URL.
 * Returns clean markdown text, or null on failure.
 */
async function tryJinaReader(url: string): Promise<{ title: string; content: string } | null> {
  try {
    const response = await fetch(`${JINA_READER_URL}${url}`, {
      headers: {
        "Accept": "text/markdown",
        "X-Return-Format": "markdown",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    if (!text || !text.trim()) {
      return null;
    }
    // Jina Reader returns markdown. First line is often the title.
    // Format: "Title: xxx\n\nURL Source: ...\n\nMarkdown Content:\n\n..."
    // Or just the page title as H1: "# Title\n\ncontent..."
    let title = "";
    let content = text;
    // Try to extract title from first H1
    const h1Match = text.match(/^#\s+(.+)$/m);
    if (h1Match) {
      title = h1Match[1].trim();
    }
    // Try to extract from "Title:" prefix
    const titlePrefix = text.match(/^Title:\s*(.+)$/m);
    if (titlePrefix && !title) {
      title = titlePrefix[1].trim();
    }
    // Remove Jina metadata headers (Title:, URL Source:, Markdown Content:)
    content = text
      .replace(/^Title:\s*.+\n?/m, "")
      .replace(/^URL Source:\s*.+\n?/m, "")
      .replace(/^Markdown Content:\s*\n?/m, "")
      .trim();
    return { title: title || "(无标题)", content };
  } catch {
    return null;
  }
}

/**
 * Fallback: use defuddle to clean HTML locally.
 * Uses linkedom for DOM parsing (Node.js environment).
 */
async function tryDefuddle(url: string): Promise<{ title: string; content: string } | null> {
  try {
    const { parseHTML } = await import("linkedom");
    const Defuddle = (await import("defuddle/node")).Defuddle;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; yuanbao-lite/11.3)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const html = await response.text();
    const { document } = parseHTML(html);
    const result = await Defuddle(document, url, { markdown: true });
    const title = result.title || "(无标题)";
    const content = result.content || "";
    if (!content.trim()) {
      return null;
    }
    return { title, content };
  } catch {
    return null;
  }
}

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "visit",
    aliases: ["访问", "fetch"],
    description: "访问网页并清洗内容注入上下文（Jina Reader 优先，defuddle 兜底）",
    usage: "/visit <URL>",
    category: "utility" as CommandCategory,
    handler: async (ctx) => {
      if (!ctx.args[0]) {
        await ctx.reply("用法: /visit <URL>");
        return;
      }
      const url = ctx.args[0];
      if (!/^https?:\/\//i.test(url)) {
        await ctx.reply("❌ URL 必须以 http:// 或 https:// 开头");
        return;
      }
      await ctx.reply(`⏳ 正在访问 ${url} ...`);

      // 1. Try Jina Reader first
      let result = await tryJinaReader(url);
      let method = "";

      if (result) {
        method = "Jina Reader";
      } else {
        // 2. Fallback to defuddle
        result = await tryDefuddle(url);
        if (result) {
          method = "defuddle";
        }
      }

      if (!result) {
        await ctx.reply(`❌ 无法提取网页内容（Jina Reader 和 defuddle 均失败）`);
        return;
      }

      const { title } = result;
      let content = result.content;

      // Trim to max length
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.substring(0, MAX_CONTENT_LENGTH) + "\n\n...(内容已截断，完整内容请访问原始URL)";
      }

      // Store in content-store for /query reference
      const { storeContent } = await import("../../../business/content-store.js");
      const fullContent = `标题: ${title}\nURL: ${url}\n\n${content}`;
      const contentId = storeContent("web_page", fullContent, url);

      // Inject into LLM context
      const engine = ctx.bot.getLlmEngine();
      if (engine) {
        const convKey = ctx.isGroup && ctx.groupCode
          ? `group:${ctx.groupCode}`
          : `dm:${ctx.message.fromUserId}`;
        engine.getConversationManager().addUserMessage(
          convKey,
          `[网页内容 ${contentId}] ${url}\n${fullContent}`,
        );
      }

      const preview = content.substring(0, 200).replace(/\n/g, " ");
      await ctx.reply(
        `✅ 网页内容已注入上下文 [${contentId}] (via ${method})\n` +
        `标题: ${title}\n` +
        `URL: ${url}\n` +
        `内容长度: ${content.length} 字符\n` +
        `预览: ${preview}${content.length > 200 ? "..." : ""}\n\n` +
        `LLM 现在可以基于此内容回复。使用 /query ${contentId} 查看完整内容。`,
      );
    },
  });
}
