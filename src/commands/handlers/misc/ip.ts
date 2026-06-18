/**
 * /ip command handler — extracted from registry.ts (lossless split).
 * Category: misc
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { generateColoredHelp } from "../../help-text.js";
import {
  searchStickers,
  getStickerPacks,
  loadStickerPacksFromDir,
  getBuiltinEmojis,
} from "../../../business/sticker.js";
import {
  uploadToLitterbox,
  uploadAndFormatLink as tempfileFormatLink,
} from "../../../access/http/tempfile.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
        name: "ip",
        aliases: ["ip查询"],
        description: "查询 IP 地址的地理位置信息（多服务商并发，支持 IPv4/IPv6）",
        usage: "/ip <IP地址>   例: /ip 8.8.8.8, /ip 2001:4860:4860::8888",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /ip <IP地址> (支持 IPv4 和 IPv6)");
            return;
          }
          const ip = ctx.args[0];
          // Validate IPv4 or IPv6
          const isIPv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
          const isIPv6 = /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");
          if (!isIPv4 && !isIPv6) {
            await ctx.reply("❌ 无效 IP 地址 (支持 IPv4 如 8.8.8.8 或 IPv6 如 2001:4860:4860::8888)");
            return;
          }

          type IpResult = {
            provider: string;
            country?: string;
            region?: string;
            city?: string;
            org?: string;
            as?: string;
            timezone?: string;
            latitude?: number | string;
            longitude?: number | string;
            error?: string;
          };

          const providers: Array<() => Promise<IpResult>> = [
            // ip-api.com (supports IPv6, no API key, 45 req/min)
            async () => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              try {
                const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=status,message,country,regionName,city,isp,as,timezone,lat,lon`, { signal: controller.signal });
                clearTimeout(timer);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const d = await resp.json() as Record<string, unknown>;
                if (d.status === "fail") throw new Error(String(d.message ?? "fail"));
                return {
                  provider: "ip-api.com",
                  country: String(d.country ?? ""),
                  region: String(d.regionName ?? ""),
                  city: String(d.city ?? ""),
                  org: String(d.isp ?? ""),
                  as: String(d.as ?? ""),
                  timezone: String(d.timezone ?? ""),
                  latitude: d.lat as number,
                  longitude: d.lon as number,
                };
              } catch (err) {
                clearTimeout(timer);
                return { provider: "ip-api.com", error: (err as Error).message };
              }
            },
            // ipapi.co (supports IPv6)
            async () => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              try {
                const resp = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, { signal: controller.signal });
                clearTimeout(timer);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const d = await resp.json() as Record<string, unknown>;
                if (d.error) throw new Error(String(d.reason ?? d.error));
                return {
                  provider: "ipapi.co",
                  country: String(d.country_name ?? ""),
                  region: String(d.region ?? ""),
                  city: String(d.city ?? ""),
                  org: String(d.org ?? ""),
                  as: String(d.asn ?? ""),
                  timezone: String(d.timezone ?? ""),
                  latitude: d.latitude as number,
                  longitude: d.longitude as number,
                };
              } catch (err) {
                clearTimeout(timer);
                return { provider: "ipapi.co", error: (err as Error).message };
              }
            },
            // ipinfo.io (supports IPv6)
            async () => {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              try {
                const resp = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { signal: controller.signal });
                clearTimeout(timer);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const d = await resp.json() as Record<string, unknown>;
                if (d.error) throw new Error(String(d.error));
                const [lat, lon] = typeof d.loc === "string" ? d.loc.split(",") : ["", ""];
                return {
                  provider: "ipinfo.io",
                  country: String(d.country ?? ""),
                  region: String(d.region ?? ""),
                  city: String(d.city ?? ""),
                  org: String(d.org ?? ""),
                  as: "",
                  timezone: String(d.timezone ?? ""),
                  latitude: lat,
                  longitude: lon,
                };
              } catch (err) {
                clearTimeout(timer);
                return { provider: "ipinfo.io", error: (err as Error).message };
              }
            },
          ];

          const results = await Promise.all(providers.map(p => p()));
          const success = results.find(r => !r.error);

          if (!success) {
            const errs = results.map(r => `${r.provider}: ${r.error}`).join("; ");
            await ctx.reply(`❌ 所有服务商查询失败:\n  ${errs}`);
            return;
          }

          const lines = [
            `🌐 IP: ${ip} (${isIPv6 ? "IPv6" : "IPv4"})  数据源: ${success.provider}`,
            `  位置: ${success.country ?? "?"} ${success.region ?? ""} ${success.city ?? ""}`.trim(),
            `  运营商: ${success.org || "(未知)"}`,
            ...(success.as ? [`  AS: ${success.as}`] : []),
            `  时区: ${success.timezone || "(未知)"}`,
            `  经纬度: ${success.latitude ?? "?"}, ${success.longitude ?? "?"}`,
          ];
          await ctx.reply(lines.join("\n"));
        },
      });
}
