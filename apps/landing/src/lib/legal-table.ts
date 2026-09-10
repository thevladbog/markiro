import type { LegalBlock } from "@markiro/legal-documents";

export type LegalTableBlock = Extract<LegalBlock, { kind: "table" }>;

/**
 * Column ratios as CSS percentages for `<col>`, mirroring the DOCX rule in
 * `legalTableColumnWidths`: omitted ratios mean equal columns, and the last
 * column absorbs the rounding so the row always spans the full text column.
 */
export function legalTableColumnPercents(
  columnCount: number,
  ratios: readonly number[] | undefined,
): readonly number[] {
  if (columnCount < 1) throw new Error("Legal table needs at least one column");
  const effective = ratios ?? Array.from({ length: columnCount }, () => 1);
  if (effective.length !== columnCount) {
    throw new Error("Legal table column ratios must match the column count");
  }
  let total = 0;
  for (const ratio of effective) {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      throw new Error("Legal table column ratios must be positive numbers");
    }
    total += ratio;
  }

  const round = (value: number): number => Math.round(value * 100) / 100;
  const head = effective.slice(0, -1).map((ratio) => round((ratio / total) * 100));
  const assigned = head.reduce((sum, percent) => sum + percent, 0);
  return [...head, round(100 - assigned)];
}

/**
 * Validates a table block against the same invariants the DOCX renderer
 * enforces and returns its column widths. A malformed table fails the build
 * rather than reaching the page as a broken grid.
 */
export function legalTableColumnLayout(block: LegalTableBlock): readonly number[] {
  for (const row of block.rows) {
    if (row.length !== block.columns.length) {
      throw new Error("Legal table row does not match its column count");
    }
  }
  return legalTableColumnPercents(block.columns.length, block.columnRatios);
}
