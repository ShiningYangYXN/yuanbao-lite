/**
 * /calc command handler — extracted from registry.ts (lossless split).
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
        name: "calc",
        aliases: ["计算", "calc"],
        description: "快速计算数学表达式",
        usage: "/calc <表达式>   例: /calc 2+3*4, /calc sqrt(16), /calc 100/7",
        category: "misc" as CommandCategory,
        handler: async (ctx) => {
          if (ctx.args.length === 0) {
            await ctx.reply("用法: /calc <表达式>\n支持: + - * / % ** sqrt() sin() cos() log() 等");
            return;
          }
          const expr = ctx.args.join(" ");
          // Whitelist safe characters only
          if (!/^[\d\s+\-*/%.()a-z,]+$/i.test(expr)) {
            await ctx.reply("❌ 表达式包含非法字符");
            return;
          }
          try {
            // Provide common math functions
            const sandbox = {
              sqrt: Math.sqrt,
              sin: Math.sin, cos: Math.cos, tan: Math.tan,
              asin: Math.asin, acos: Math.acos, atan: Math.atan,
              log: Math.log, log2: Math.log2, log10: Math.log10,
              exp: Math.exp, pow: Math.pow, abs: Math.abs,
              floor: Math.floor, ceil: Math.ceil, round: Math.round,
              max: Math.max, min: Math.min,
              PI: Math.PI, E: Math.E,
            };
            const fn = new Function(...Object.keys(sandbox), `"use strict"; return (${expr});`);
            const result = fn(...Object.values(sandbox));
            if (typeof result === "number") {
              const formatted = Number.isFinite(result)
                ? (Number.isInteger(result) ? String(result) : result.toFixed(10).replace(/\.?0+$/, ""))
                : String(result);
              await ctx.reply(`🧮 ${expr} = ${formatted}`);
            } else {
              await ctx.reply(`🧮 ${expr} = ${String(result)}`);
            }
          } catch (err) {
            await ctx.reply(`❌ 计算错误: ${(err as Error).message}`);
          }
        },
      });
}
