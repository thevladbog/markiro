import { DomainError } from "../../errors.js";

export const TRACEABILITY_LOT_STATUSES = [
  "active",
  "consumed",
  "shipped",
  "quarantined",
  "recalled",
  "archived",
] as const;
export type TraceabilityLotStatus = (typeof TRACEABILITY_LOT_STATUSES)[number];

const MANUAL_TRANSITIONS: Readonly<
  Record<TraceabilityLotStatus, readonly TraceabilityLotStatus[]>
> = {
  active: ["consumed", "shipped", "quarantined", "recalled", "archived"],
  consumed: ["recalled", "archived"],
  shipped: ["recalled", "archived"],
  quarantined: ["active", "recalled", "archived"],
  recalled: ["archived"],
  archived: [],
};

function isLotStatus(value: unknown): value is TraceabilityLotStatus {
  return TRACEABILITY_LOT_STATUSES.some((status) => status === value);
}

/** Manual action only. No implicit reopening, balance recalculation or idempotency. */
export function assertLotTransition(from: unknown, to: unknown): void {
  if (!isLotStatus(from) || !isLotStatus(to)) {
    throw new DomainError("LOT_STATUS_INVALID", "Unknown lot status.");
  }
  if (!MANUAL_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      "LOT_TRANSITION_NOT_ALLOWED",
      "This manual lot status transition is not allowed.",
    );
  }
}
