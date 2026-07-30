/** One exception fact from a device's sync batch. */
export interface ExceptionDto {
  kind: "undo" | "clear" | "disassemble" | "reprint";
  boxId: string;
  /** Only set for "undo" -- the single code it targets. */
  codeHash: string | null;
  shiftId: string;
  terminalId: string | null;
  operatorId: string | null;
  /** Required for everything except "undo" -- see the design spec, scope decision 5. */
  reason: string | null;
  occurredAt: string;
}

/**
 * Deterministic processing order: by boxId first (same 40P01-avoidance
 * reasoning the item upsert and box-closure loop already use -- concurrent
 * batches touching overlapping boxes must acquire them in the same order),
 * then kind, then codeHash so two "undo"s on the same box are stable too.
 */
export function sortExceptions(exceptions: ExceptionDto[]): ExceptionDto[] {
  return [...exceptions].sort((a, b) => {
    if (a.boxId !== b.boxId) return a.boxId.localeCompare(b.boxId);
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return (a.codeHash ?? "").localeCompare(b.codeHash ?? "");
  });
}
