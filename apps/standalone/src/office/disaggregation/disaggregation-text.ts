import { formatSsccHri } from "@markiro/domain";

import type { TagPhase } from "@markiro/ui";

import type {
  DisaggregationLine,
  DisaggregationLineStatus,
  DisaggregationReason,
  DisaggregationStatus,
} from "../../host/disaggregation.js";

/** A document's status in its phase, after the cloud's `DOCUMENT_STATUS_TO_PHASE`. */
export const DOCUMENT_STATUS_PHASE = {
  draft: "draft",
  applied: "done",
  cancelled: "retired",
} as const satisfies Record<DisaggregationStatus, TagPhase>;

/** A line's status in its phase, after the cloud's `LINE_STATUS_TO_PHASE`. */
export const LINE_STATUS_PHASE = {
  ok: "done",
  not_found: "failed",
  not_closed: "attention",
  shift_open: "attention",
  already_disassembled: "dismantled",
  duplicate: "duplicate",
} as const satisfies Record<DisaggregationLineStatus, TagPhase>;

/** A line's SSCC as people read it: `(00)…`, or what was typed when it is no SSCC. */
export function lineSsccLabel(line: Pick<DisaggregationLine, "sscc" | "ssccInput">): string {
  return line.sscc === null ? line.ssccInput : formatSsccHri(line.sscc);
}

const NAMES = new Intl.Collator("ru", { numeric: true });

/**
 * Reasons as the cloud's pickers show them: those in use before the archived,
 * each group by `sortOrder`, then by name, then by id so equal ones keep one
 * order.
 */
export function byReasonOrder(
  a: Pick<DisaggregationReason, "id" | "name" | "sortOrder" | "archived">,
  b: Pick<DisaggregationReason, "id" | "name" | "sortOrder" | "archived">,
): number {
  return (
    Number(a.archived) - Number(b.archived) ||
    a.sortOrder - b.sortOrder ||
    NAMES.compare(a.name, b.name) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
