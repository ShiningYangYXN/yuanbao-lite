/**
 * Console output helpers — colored status messages, results, errors.
 *
 * Replaces all manual console.log + chalk formatting.
 */

import chalk from "chalk";

/** Welcome banner */
export function printWelcome(version: string): void {
  const width = 66;
  const sep = "─".repeat(width);
  const pad = (s: string) => {
    const padLen = width - 2 - s.length;
    return s + " ".repeat(Math.max(0, padLen));
  };

  console.log("");
  console.log(chalk.cyan("╔") + chalk.cyan(sep) + chalk.cyan("╗"));
  console.log(chalk.cyan("║") + chalk.bold(`🤖 Yuanbao Lite v${version}`) + " ".repeat(Math.max(0, width - 2 - chalk.stripColor(`🤖 Yuanbao Lite v${version}`).length)) + chalk.cyan("║"));
  console.log(chalk.cyan("╠") + chalk.cyan(sep) + chalk.cyan("╣"));
  console.log(
    chalk.cyan("║") +
    chalk.dim(pad("输入 /help 查看命令 | Tab 补全 | ↑↓ 历史 | Ctrl+C 退出")) +
    chalk.cyan("║"),
  );
  console.log(
    chalk.cyan("║") +
    chalk.dim(pad("\\ 续行 | @提及 | /chat 切换聊天目标")) +
    chalk.cyan("║"),
  );
  console.log(chalk.cyan("╚") + chalk.cyan(sep) + chalk.cyan("╝"));
  console.log("");
}

/** Status / system messages */
export function printStatus(message: string): void {
  console.log(chalk.dim("  ℹ ") + chalk.cyan(message));
}

/** Success result */
export function printResult(message: string): void {
  console.log(chalk.green("  ✅ " + message));
}

/** Error message */
export function printError(message: string): void {
  console.log(chalk.red("  ❌ " + message));
}

/** Section header */
export function printSection(title: string): void {
  console.log("");
  console.log(chalk.cyan.bold(title));
  console.log(chalk.dim("  " + "─".repeat(title.length)));
}

/** Generic output block (pre-formatted) */
export function printBlock(text: string): void {
  console.log("");
  console.log(text);
}
