/**
 * Color palette + output helpers.
 *
 * Design rules:
 *   - ANSI colors via chalk
 *   - CJK-aware alignment via string-width
 *   - Tables rendered by cli-table3 (see utils/cli-format.ts)
 */

import chalk from "chalk";
import stringWidth from "string-width";

// ─── Palette ───

export const COLORS = {
  // Brand
  brand: chalk.rgb(120, 180, 255).bold,
  brandSoft: chalk.rgb(120, 180, 255),
  // Headings
  h1: chalk.rgb(140, 120, 255).bold,
  h2: chalk.rgb(100, 180, 240).bold,
  h3: chalk.rgb(160, 200, 240).bold,
  // Keys & labels
  key: chalk.rgb(100, 200, 200).bold,
  label: chalk.rgb(160, 180, 220),
  // Values
  value: chalk.rgb(220, 230, 250),
  // Status
  success: chalk.rgb(80, 220, 120),
  warn: chalk.rgb(240, 180, 60),
  error: chalk.rgb(240, 80, 80),
  info: chalk.rgb(140, 170, 255),
  hint: chalk.rgb(200, 180, 240),
  // Dimmed
  dim: chalk.rgb(130, 130, 150),
  muted: chalk.gray,
  // Special
  cmd: chalk.rgb(100, 220, 220).bold,
  path: chalk.rgb(140, 220, 140),
  url: chalk.rgb(120, 180, 255).underline,
  num: chalk.rgb(240, 200, 120),
  mention: chalk.rgb(255, 140, 200),
  // Aliases for semantic access
  accent: chalk.rgb(255, 180, 90).bold,
  primary: chalk.rgb(120, 180, 255),
} as const;

// ─── Status prefix marks ───

export const MARK = {
  success: COLORS.success("✓"),
  error: COLORS.error("✗"),
  warn: COLORS.warn("!"),
  info: COLORS.info("▸"),
  bullet: COLORS.dim("•"),
  arrow: COLORS.dim("→"),
  star: COLORS.success("⭐"),
  dot: COLORS.dim("·"),
} as const;

// ─── Output helpers ───

export function printH1(text: string): void {
  console.log("");
  console.log(COLORS.h1(text));
}

export function printH2(text: string): void {
  console.log("");
  console.log(COLORS.h2(text));
}

export function printStatus(message: string): void {
  console.log(`  ${MARK.info}  ${message}`);
}

export function printResult(message: string): void {
  console.log(`  ${MARK.success}  ${message}`);
}

export function printError(message: string): void {
  console.log(`  ${MARK.error}  ${message}`);
}

export function printWarn(message: string): void {
  console.log(`  ${MARK.warn}  ${message}`);
}

export function printKV(pairs: Array<[string, string]>): void {
  const maxKey = Math.max(1, ...pairs.map(([k]) => stringWidth(k)));
  for (const [k, v] of pairs) {
    console.log(`    ${COLORS.key(padToWidth(k, maxKey))}  ${COLORS.value(v)}`);
  }
}

// ─── String width helpers ───

/** Pad `s` with `pad` chars until its display width equals `width`. */
export function padToWidth(s: string, width: number, pad = " "): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return s + pad.repeat(width - w);
}
