/**
 * /shell command handler — extracted from registry.ts (lossless split).
 * Category: system
 *
 * Handler logic is copied verbatim from the original registerBuiltinCommands()
 * method, with only `this.X` → `cmdSys.X` substitutions and relative import
 * path fixes.
 *
 * Node-only: uses `node:child_process.exec` to run a system command.
 * Under browser, the dynamic import resolves to an error which we surface
 * to the user with a clear message.
 */

import type { CommandSystem } from "../../registry.js";
import type { CommandCategory } from "../../types.js";

export function register(cmdSys: CommandSystem): void {
  cmdSys.register({
    name: "shell",
    aliases: ["sh"],
    description: "运行系统命令（仅私聊，默认截断2000字符输出）",
    usage:
      "/shell [--all] <命令>   (--all/-a 放在命令前取消截断，命令中的 --all/-a 会原样传入)",
    category: "system" as CommandCategory,
    elevated: true,
    handler: async (ctx) => {
      if (ctx.args.length === 0) {
        await ctx.reply(
          "用法: /shell [--all] <命令>\n" +
            "例如: /shell ls -la /tmp          (输出截断至2000字符)\n" +
            "      /shell --all ls -la /tmp    (输出不截断)\n" +
            "      /shell ls --all              (--all 作为 ls 的参数原样传入)\n" +
            "提示: --all/-a 放在命令前 = 取消截断；放在命令后 = 原样传入",
        );
        return;
      }
      // ctx.args already has the leading --all/-a stripped by makeContext (when it was first arg)
      // and ctx.showAll is set accordingly. Any --all/-a in later positions is preserved in ctx.args.
      const cmd = ctx.args.join(" ");
      // Node-only dynamic import — bundlers split this into a separate chunk
      // that's only loaded under Node. Under browser, the import resolves to
      // an error which we catch and surface to the user.
      type ExecFn = (
        cmd: string,
        opts: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => unknown;
      let exec: ExecFn | null = null;
      try {
        const childProcess = await import("node:child_process");
        exec = childProcess.exec as unknown as ExecFn;
      } catch (err) {
        await ctx.reply(
          `❌ /shell 需要 Node.js 运行时（node:child_process 不可用）: ${(err as Error).message}`,
        );
        return;
      }
      try {
        const result = await new Promise<{ output: string; code: number }>(
          (resolve) => {
            exec!(
              cmd,
              { timeout: 30000, maxBuffer: 1024 * 1024 },
              (err, stdout, stderr) => {
                const parts: string[] = [];
                if (stdout) parts.push(stdout.trim());
                if (stderr) parts.push(`[stderr] ${stderr.trim()}`);
                // exec sets err for non-zero exit codes — extract the code
                const exitCode = err
                  ? ((err as NodeJS.ErrnoException).errno ??
                    (err as { code?: number }).code ??
                    1)
                  : 0;
                // If the error is just a non-zero exit code, don't treat as failure
                if (err && !stdout && !stderr && err.message) {
                  parts.push(err.message);
                }
                resolve({
                  output: parts.join("\n") || "(无输出)",
                  code: exitCode,
                });
              },
            );
          },
        );
        // Truncate output if too long for IM (unless --all/-a was the first arg)
        const maxLen = ctx.showAll ? Infinity : 2000;
        const truncated =
          result.output.length > maxLen
            ? result.output.substring(0, maxLen) +
              `\n... (输出被截断，共 ${result.output.length} 字符，用 /shell --all ${cmd} 查看全部)`
            : result.output;
        await ctx.reply(`$ ${cmd}\n${truncated}\n[退出码: ${result.code}]`);
      } catch (err) {
        await ctx.reply(`❌ 命令执行失败: ${(err as Error).message}`);
      }
    },
  });
}
