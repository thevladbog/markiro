/** Every Chestny ZNAK status that an inventory snapshot records. */
export const INVENTORY_CHZ_STATUSES = [
  "EMITTED",
  "INTRODUCED",
  "APPLIED",
  "RETIRED",
  "WRITTEN_OFF",
  "DISAGGREGATION",
] as const;

export type InventoryChzStatus = (typeof INVENTORY_CHZ_STATUSES)[number];

/**
 * Chestny ZNAK's source state column. Other source-state values remain
 * auditable; only `MOVING_BY_UD` changes inventory disposition.
 */
export type InventoryCodeState = string | null;

export interface InventoryChzCodeDispositionInput {
  status: InventoryChzStatus;
  state: InventoryCodeState;
}

/**
 * A code is eligible for a future sale or write-off action only when Chestny
 * ZNAK reports it as introduced and it is not in a universal document move.
 */
export function canDisposeChzCode({ status, state }: InventoryChzCodeDispositionInput): boolean {
  return status === "INTRODUCED" && state !== "MOVING_BY_UD";
}
