/**
 * /myip command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "myip",
        aliases: ["服务器ip", "serverip"],
        description: "查看服务器 IP 信息（双栈，含 AS 和地区）",
        usage: "/myip",
        category: "system" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          try {
            // Fetch both IPv4 and IPv6 concurrently
            const [ipv4Result, ipv6Result] = await Promise.allSettled([
              fetch("https://api.ipify.org?format=json").then(r => r.json() as Promise<{ ip: string }>),
              fetch("https://api64.ipify.org?format=json").then(r => r.json() as Promise<{ ip: string }>),
            ]);

            const lines = ["🖥️ 服务器 IP 信息:"];

            if (ipv4Result.status === "fulfilled") {
              const ip4 = ipv4Result.value.ip;
              lines.push(`  IPv4: ${ip4}`);
              // Try to get geo info
              try {
                const geoResp = await fetch(`http://ip-api.com/json/${ip4}?lang=zh-CN&fields=country,regionName,city,isp,as,timezone`, { signal: AbortSignal.timeout(5000) });
                if (geoResp.ok) {
                  const geo = await geoResp.json() as Record<string, string>;
                  lines.push(`    地区: ${geo.country ?? "?"} ${geo.regionName ?? ""} ${geo.city ?? ""}`.trim());
                  lines.push(`    ISP: ${geo.isp || "(未知)"}`);
                  lines.push(`    AS: ${geo.as || "(未知)"}`);
                  lines.push(`    时区: ${geo.timezone || "(未知)"}`);
                }
              } catch { /* geo lookup optional */ }
            } else {
              lines.push("  IPv4: (获取失败)");
            }

            if (ipv6Result.status === "fulfilled") {
              const ip6 = ipv6Result.value.ip;
              const isV6 = ip6.includes(":");
              if (isV6) {
                lines.push(`  IPv6: ${ip6}`);
              } else {
                lines.push(`  IPv6: (无 IPv6 连接，回退到 IPv4)`);
              }
            } else {
              lines.push("  IPv6: (获取失败)");
            }

            // Also check local interfaces
            try {
              const { networkInterfaces } = await import("node:os");
              const nets = networkInterfaces();
              const localV4: string[] = [];
              const localV6: string[] = [];
              for (const [, addrs] of Object.entries(nets)) {
                if (!addrs) continue;
                for (const addr of addrs) {
                  if (addr.family === "IPv4" && !addr.internal) localV4.push(addr.address);
                  else if (addr.family === "IPv6" && !addr.internal) localV6.push(addr.address);
                }
              }
              if (localV4.length > 0 || localV6.length > 0) {
                lines.push("", "本地接口:");
                if (localV4.length > 0) lines.push(`  本地 IPv4: ${localV4.join(", ")}`);
                if (localV6.length > 0) lines.push(`  本地 IPv6: ${localV6.join(", ")}`);
              }
            } catch { /* ignore */ }

            await ctx.reply(lines.join("\n"));
          } catch (err) {
            await ctx.reply(`❌ 获取服务器 IP 失败: ${(err as Error).message}`);
          }
        },
      });
}
