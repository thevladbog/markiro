import { assertLotTransition, TRACEABILITY_LOT_STATUSES } from "@markiro/domain";
import type { TraceabilityLot } from "@markiro/platform-contracts";

export function allowedLotStatuses(lot: TraceabilityLot) {
  return TRACEABILITY_LOT_STATUSES.filter((status) => {
    try {
      assertLotTransition(lot.status, status);
      return true;
    } catch {
      return false;
    }
  });
}

export function lotSourceLabel(lot: TraceabilityLot): string | null {
  if (!lot.source) return null;
  return lot.source.kind === "location" ? lot.source.locationId : lot.source.referenceValue;
}
