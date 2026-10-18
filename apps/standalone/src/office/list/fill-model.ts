import type { CSSProperties } from "react";

/**
 * The list card's fill / shrink rule, as numbers. The card is as tall as its content (it shrinks to
 * a short list: no empty room under the last row) and is bounded by the room the window leaves it;
 * only past that room does the table pin its heading and scroll its rows inside. CSS does the
 * deciding (`flex: 0 1 auto` on the table); these functions are the floor it may not be crushed
 * below and the same decision stated plainly, so tests hold both.
 */

/** The table's heading row (the office's 44 px heading). */
export const HEADING_PX = 44;
/** One row of an office table (`--table-row-h`). */
export const ROW_PX = 56;
/** The least a scrolling table keeps: the heading and four rows. A lower window scrolls the page. */
export const TABLE_FLOOR_PX = HEADING_PX + 4 * ROW_PX;

/**
 * The least height of the table region for `rowCount` rows on the page: the rows' own height up
 * to the floor. Never more than the content needs, so a short list is never stretched.
 */
export function tableFloorPx(rowCount: number): number {
  const rows = Math.max(0, Math.floor(rowCount));
  return Math.min(HEADING_PX + rows * ROW_PX, TABLE_FLOOR_PX);
}

/** Whether the rows scroll inside the card: only when the content is taller than the room left. */
export function fillEngaged(contentPx: number, availablePx: number): boolean {
  return contentPx > availablePx;
}

/** The table's inline style for `rowCount` rows: its floor as the custom property `list.css` reads. */
export function tableFloorStyle(rowCount: number): CSSProperties {
  const floor = tableFloorPx(rowCount);
  return { "--office-table-floor": `${floor}px`, minHeight: floor } as CSSProperties;
}
