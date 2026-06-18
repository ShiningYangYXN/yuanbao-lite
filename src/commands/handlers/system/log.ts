/**
 * /log command handler — extracted from registry.ts (lossless split).
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
        name: "log",
        aliases: ["日志"],
        description: "切换日志级别（持久化保存）",
        usage: "/log <debug|info|warn|error>",
        category: "system" as CommandCategory,
        dmOnly: true,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /log <debug|info|warn|error>");
            return;
          }
          const level = ctx.args[0] as "debug" | "info" | "warn" | "error";
          const validLevels = ["debug", "info", "warn", "error"];
          if (!validLevels.includes(level)) {
            await ctx.reply(`无效日志级别: ${level} (可选: ${validLevels.join("|")})`);
            return;
          }
          const { setLogLevel } = await import("../../../logger.js");
          setLogLevel(level);
          // Persist log level to config
          try {
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import("node:fs");
            const configDir = join(homedir(), ".yuanbao-lite");
            const configPath = join(configDir, "runtime-prefs.json");
            let prefs: Record<string, unknown> = {};
            if (existsSync(configPath)) {
              try { prefs = JSON.parse(readFileSync(configPath, "utf-8")); } catch { /* ignore */ }
            }
            prefs.logLevel = level;
            if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
            writeFileSync(configPath, JSON.stringify(prefs, null, 2), "utf-8");
          } catch { /* persist failure is non-critical */ }
          await ctx.reply(`日志级别已切换为: ${level}`);
        },
      });
}
