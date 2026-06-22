/**
 * /log command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 *
 * Browser-compatible: uses PersistenceAdapter (NodeFsAdapter under Node)
 * instead of static node:fs / node:path / node:os imports.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";
import { setLogLevel } from "../../../logger.js";
import {
  getDefaultPersistenceAdapter,
  getDefaultPersistenceDir,
  joinPath,
} from "../../../access/persistence/adapter.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "log",
    aliases: ["日志"],
    description: "切换日志级别（持久化保存）",
    usage: "/log <debug|info|warn|error>",
    category: "system" as CommandCategory,
    elevated: true,
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
      setLogLevel(level);
      // Persist log level to runtime-prefs.json via PersistenceAdapter.
      // Under Node this writes to ~/.yuanbao-lite/runtime-prefs.json.
      // Under browser with a custom adapter, it writes to the configured
      // key (e.g. localStorage["yuanbao-lite/runtime-prefs"]).
      // Persistence failures are non-critical — log level is still applied
      // in-memory for this session.
      try {
        const adapter = getDefaultPersistenceAdapter();
        const configDir = getDefaultPersistenceDir();
        const configPath = joinPath(configDir, "runtime-prefs.json");
        let prefs: Record<string, unknown> = {};
        if (adapter.exists(configPath)) {
          try {
            prefs = JSON.parse(adapter.read(configPath));
          } catch {
            // Corrupt prefs file — start fresh
          }
        }
        prefs.logLevel = level;
        adapter.write(configPath, JSON.stringify(prefs, null, 2));
      } catch {
        // Persist failure is non-critical
      }
      await ctx.reply(`日志级别已切换为: ${level}`);
    },
  });
}

