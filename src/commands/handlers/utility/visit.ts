/**
 * /visit command — fetch a web page and inject cleaned content into LLM context.
 *
 * Usage:
 *   /visit <URL>   — fetch URL, clean HTML, inject into LLM context
 *
 * The cleaned content (title + main text) is stored in the content-store
 * and also injected directly into the LLM conversation as a user message,
 * so the LLM can reference it in its reply.
 *
 * HTML cleaning strategy (no external deps):
 *   1. fetch URL
 *   2. extract <title>
 *   3. remove <script>, <style>, <nav>, <header>, <footer>, <aside> tags
 *   4. extract text from <article>, <main>, or <body> (fallback)
 *   5. collapse whitespace, trim to reasonable length
 *
 * Category: utility
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

const MAX_CONTENT_LENGTH = 8000;

function cleanHtml(html: string): { title: string; content: string } {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Remove script, style, nav, header, footer, aside, noscript
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Try to extract main content: <article>, <main>, or fallback to <body>
  let mainContent: string;
  const articleMatch = cleaned.match(/<article[\s\S]*?<\/article>/i);
  if (articleMatch) {
    mainContent = articleMatch[0];
  } else {
    const mainMatch = cleaned.match(/<main[\s\S]*?<\/main>/i);
    if (mainMatch) {
      mainContent = mainMatch[0];
    } else {
      const bodyMatch = cleaned.match(/<body[\s\S]*?<\/body>/i);
      mainContent = bodyMatch ? bodyMatch[0] : cleaned;
    }
  }

  // Convert common HTML elements to text markers
  let text = mainContent
    // Block elements → newline
    .replace(/<\/?(p|div|section|article|h[1-6]|li|ul|ol|blockquote|pre|hr|br|tr|table)[^>]*>/gi, "\n")
    // Remove all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Trim to max length
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + "\n\n...(内容已截断，完整内容请访问原始URL)";
  }

  return { title, content: text };
}

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "visit",
    aliases: ["访问", "fetch"],
    description: "访问网页并清洗内容注入上下文",
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
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; yuanbao-lite/11.2)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          await ctx.reply(`❌ 访问失败: HTTP ${response.status} ${response.statusText}`);
          return;
        }
        const html = await response.text();
        const { title, content } = cleanHtml(html);
        if (!content) {
          await ctx.reply(`❌ 无法提取网页内容（可能是纯JS渲染页面）`);
          return;
        }

        // Store in content-store for /query reference
        const { storeContent } = await import("../../../business/content-store.js");
        const fullContent = `标题: ${title || "(无标题)"}\nURL: ${url}\n\n${content}`;
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
          `✅ 网页内容已注入上下文 [${contentId}]\n` +
          `标题: ${title || "(无标题)"}\n` +
          `URL: ${url}\n` +
          `内容长度: ${content.length} 字符\n` +
          `预览: ${preview}${content.length > 200 ? "..." : ""}\n\n` +
          `LLM 现在可以基于此内容回复。使用 /query ${contentId} 查看完整内容。`,
        );
      } catch (err) {
        await ctx.reply(`❌ 访问失败: ${(err as Error).message}`);
      }
    },
  });
}
