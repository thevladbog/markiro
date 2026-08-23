import type { ClosedBoxSummary } from "./boxes.js";

/**
 * Tail search over the shift's closed boxes: the operator types the LAST
 * digits of the SSCC — the part a human reads off the label — and the list
 * narrows to boxes whose SSCC ends with them. An empty query hides nothing.
 */
export interface TailFilterResult {
  matched: ClosedBoxSummary[];
  /** How many boxes the query hid — printed so a filter never looks like an empty shift. */
  hiddenCount: number;
}

export function filterBoxesByTail(
  boxes: readonly ClosedBoxSummary[],
  tail: string,
): TailFilterResult {
  if (!tail) return { matched: [...boxes], hiddenCount: 0 };
  const matched = boxes.filter((box) => box.sscc.endsWith(tail));
  return { matched, hiddenCount: boxes.length - matched.length };
}

/**
 * Splits an SSCC for highlight rendering: `head` printed muted, `tail` — the
 * digits the operator typed — printed emphasized. When the SSCC does not end
 * with the query (or there is no query), everything is the head.
 */
export function splitSsccForHighlight(sscc: string, tail: string): { head: string; tail: string } {
  if (!tail || !sscc.endsWith(tail)) return { head: sscc, tail: "" };
  return { head: sscc.slice(0, sscc.length - tail.length), tail };
}
