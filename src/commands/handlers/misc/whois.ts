/**
 * /whois command handler — extracted from registry.ts (lossless split).
 * Category: misc
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "whois",
        aliases: ["域名查询"],
        description: "查询域名 whois 信息",
        usage: "/whois <域名>   例: /whois example.com",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /whois <域名>");
            return;
          }
          const domain = ctx.args[0].toLowerCase();
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
            await ctx.reply("❌ 无效域名");
            return;
          }
          try {
            // Use RDAP (Registration Data Access Protocol) — modern whois
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            const resp = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
              signal: controller.signal,
              headers: { Accept: "application/rdap+json" },
            });
            clearTimeout(timer);

            if (!resp.ok) {
              if (resp.status === 404) {
                await ctx.reply(`❌ 域名 ${domain} 未找到 whois 记录`);
                return;
              }
              throw new Error(`HTTP ${resp.status}`);
            }

            const data = await resp.json() as Record<string, unknown>;
            const events = (data.events ?? []) as Array<{ eventAction: string; eventDate: string }>;
            const status = (data.status ?? []) as string[];
            const entities = (data.entities ?? []) as Array<{ roles?: string[]; vcardArray?: unknown[] }>;

            // Extract registrar
            let registrar = "(未知)";
            for (const e of entities) {
              if (e.roles?.includes("registrar")) {
                const vcard = e.vcardArray?.[1] as Array<unknown>[] | undefined;
                if (vcard) {
                  for (const item of vcard) {
                    if (Array.isArray(item) && item[0] === "fn" && typeof item[3] === "string") {
                      registrar = item[3];
                      break;
                    }
                  }
                }
              }
            }

            const registration = events.find(e => e.eventAction === "registration");
            const expiration = events.find(e => e.eventAction === "expiration");
            const lastChanged = events.find(e => e.eventAction === "last changed");

            const lines = [
              `📋 WHOIS: ${domain}`,
              `  注册商: ${registrar}`,
              ...(registration ? [`  注册时间: ${new Date(registration.eventDate).toLocaleString("zh-CN")}`] : []),
              ...(expiration ? [`  到期时间: ${new Date(expiration.eventDate).toLocaleString("zh-CN")}`] : []),
              ...(lastChanged ? [`  最后更新: ${new Date(lastChanged.eventDate).toLocaleString("zh-CN")}`] : []),
              ...(status.length > 0 ? [`  状态: ${status.slice(0, 3).join(", ")}${status.length > 3 ? ` (+${status.length - 3})` : ""}`] : []),
            ];
            await ctx.reply(lines.join("\n"));
          } catch (err) {
            await ctx.reply(`❌ WHOIS 查询失败: ${(err as Error).message}`);
          }
        },
      });
}
