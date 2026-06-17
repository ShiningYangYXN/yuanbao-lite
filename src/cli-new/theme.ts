/**
 * Color palette + borderless render helpers.
 *
 * Design rules:
 *   - No box-drawing characters (─│┌┐└┘├┤ etc.) — borders are forbidden.
 *   - Use color + spacing for visual separation.
 *   - Column alignment via `string-width` (CJK-aware).
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

export function printSection(title: string): void {
  console.log("");
  console.log(COLORS.h2(title));
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

export function printInfo(message: string): void {
  console.log(`  ${COLORS.info("i")}  ${message}`);
}

export function printHint(message: string): void {
  console.log(`  ${MARK.arrow}  ${COLORS.hint(message)}`);
}

export function printPair(key: string, value: string, valueColor: (s: string) => string = COLORS.value): void {
  console.log(`    ${COLORS.key(padToWidth(key, 12))}  ${valueColor(value)}`);
}

export function printKV(pairs: Array<[string, string]>): void {
  const maxKey = Math.max(1, ...pairs.map(([k]) => stringWidth(k)));
  for (const [k, v] of pairs) {
    console.log(`    ${COLORS.key(padToWidth(k, maxKey))}  ${COLORS.value(v)}`);
  }
}

export function printBlank(): void {
  console.log("");
}

// ─── Borderless table ───

export type TableColumn = {
  header: string;
  /** Min width in characters (CJK-aware). */
  width?: number;
  /** Optional color function applied to cell values in this column. */
  color?: (s: string) => string;
};

/**
 * Render rows as a borderless table. Column widths auto-fit content but
 * respect `width` minimums. Header row uses COLORS.label, body rows use
 * COLORS.value (or per-column color override). Columns separated by 2 spaces.
 */
export function renderTable(columns: TableColumn[], rows: string[][]): string {
  // Compute display widths
  const widths = columns.map((c, i) => {
    const headerW = stringWidth(c.header);
    const maxCellW = Math.max(0, ...rows.map((r) => stringWidth(r[i] ?? "")));
    return Math.max(c.width ?? 0, headerW, maxCellW);
  });

  const formatRow = (cells: string[], isHeader: boolean): string => {
    return cells.map((cell, i) => {
      const txt = String(cell ?? "");
      const w = widths[i];
      const padded = padToWidth(txt, w);
      if (isHeader) return COLORS.label(padded);
      const colorFn = columns[i]?.color;
      return colorFn ? colorFn(padded) : COLORS.value(padded);
    }).join("  ");
  };

  const lines: string[] = [];
  lines.push(formatRow(columns.map((c) => c.header), true));
  for (const row of rows) {
    lines.push(formatRow(row, false));
  }
  return lines.join("\n");
}

export function printTable(columns: TableColumn[], rows: string[][]): void {
  console.log(renderTable(columns, rows));
}

// ─── String width helpers ───

/** Pad `s` with `pad` chars until its display width equals `width`. */
export function padToWidth(s: string, width: number, pad = " "): string {
  const w = stringWidth(s);
  if (w >= width) return s;
  return s + pad.repeat(width - w);
}

/** Truncate `s` to `maxWidth` display columns, appending ellipsis if cut. */
export function truncateToWidth(s: string, maxWidth: number): string {
  if (stringWidth(s) <= maxWidth) return s;
  // Greedy character-by-character (handles CJK)
  let out = "";
  for (const ch of Array.from(s)) {
    if (stringWidth(out + ch) + 1 > maxWidth) break;
    out += ch;
  }
  return out + "…";
}
