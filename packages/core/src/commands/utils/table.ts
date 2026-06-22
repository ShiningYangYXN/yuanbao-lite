/**
 * Markdown table output utility.
 *
 * Usage in command handlers:
 *   if (ctx.showAll || args.includes("--table")) {
 *     const table = formatTable(headers, rows);
 *     await ctx.reply(table);
 *   }
 *
 * Uses the `markdown-table` library for robust table generation.
 */

import { markdownTable } from "markdown-table";

/**
 * Format an array of rows as a Markdown table.
 *
 * @param headers - Column headers
 * @param rows - Array of row arrays (each row has same length as headers)
 * @returns Markdown table string
 */
export function formatTable(headers: string[], rows: string[][]): string {
  return markdownTable([headers, ...rows]);
}
