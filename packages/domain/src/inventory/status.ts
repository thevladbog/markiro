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

const FILTERED_CIS_REPORT_UNAVAILABLE_PRODUCT_GROUPS = new Set([25, 42, 44]);
const TOBACCO_PRODUCT_GROUPS = new Set([3, 12, 16]);

export type ChzFilteredCisReportPolicy =
  | { supported: true; statuses: typeof INVENTORY_CHZ_STATUSES }
  | { supported: false; reason: "report_unavailable" | "status_profile_unsupported" };

/**
 * The filtered-code export is not a universal product-group contract. Three
 * groups do not expose this report at all, while tobacco groups use a distinct
 * status vocabulary that the current inventory snapshot cannot yet represent.
 * Refusing those groups before creating a paid/quota-limited task is safer than
 * issuing six known-invalid exports.
 */
export function chzFilteredCisReportPolicy(productGroupCode: number): ChzFilteredCisReportPolicy {
  if (FILTERED_CIS_REPORT_UNAVAILABLE_PRODUCT_GROUPS.has(productGroupCode)) {
    return { supported: false, reason: "report_unavailable" };
  }
  if (TOBACCO_PRODUCT_GROUPS.has(productGroupCode)) {
    return { supported: false, reason: "status_profile_unsupported" };
  }
  return { supported: true, statuses: INVENTORY_CHZ_STATUSES };
}

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
