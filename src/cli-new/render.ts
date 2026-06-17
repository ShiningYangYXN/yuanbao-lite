/**
 * Console output helpers — no box drawing chars, colorful and clean.
 */

import chalk from "chalk";

const COLORS = {
  heading: chalk.rgb(140, 120, 255).bold,
  subheading: chalk.rgb(100, 180, 240).bold,
  key: chalk.rgb(100, 200, 200).bold,
  success: chalk.rgb(80, 220, 120),
  successDim: chalk.rgb(60, 160, 90),
  error: chalk.rgb(240, 80, 80),
  warn: chalk.rgb(240, 180, 60),
  info: chalk.rgb(140, 170, 255),
  dim: chalk.rgb(130, 130, 150),
  code: chalk.rgb(240, 160, 100),
  text: chalk.rgb(200, 210, 230),
  muted: chalk.dim.gray,
  separator: chalk.dim("• • • • • • • • • • • • • • • • • • • • • • • • • •"),
};

export function printWelcome(version: string): void {
  const title = `Yuanbao Lite CLI v${version}`;
  console.log("");
  console.log(COLORS.heading(title));
  console.log(COLORS.dim("Powered by Clack + Commander + Table"));
  console.log(COLORS.dim("  /help  查看命令  |  Tab 补全  |  ↑↓ 历史  |  Ctrl+C 退出"));
  console.log("");
}

export function printStatus(message: string): void {
  console.log(`  ${COLORS.info("▸")}  ${message}`);
}

export function printResult(message: string): void {
  console.log(`  ${COLORS.success("✓")}  ${message}`);
}

export function printError(message: string): void {
  console.log(`  ${COLORS.error("✗")}  ${message}`);
}

export function printWarn(message: string): void {
  console.log(`  ${COLORS.warn("!")}  ${message}`);
}

export function printSection(title: string): void {
  console.log("");
  console.log(COLORS.subheading(title));
  console.log(`  ${COLORS.muted("─".repeat(title.length + 2))}`);
}

export function printDivider(): void {
  console.log(`\n  ${COLORS.separator}\n`);
}

export function printBlock(text: string): void {
  console.log("");
  console.log(text);
}

export function printPair(key: string, value: string, color = COLORS.dim): void {
  console.log(`    ${COLORS.key(key)}  ${color(value)}`);
}
