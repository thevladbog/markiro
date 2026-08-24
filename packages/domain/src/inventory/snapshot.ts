import { canDisposeChzCode, type InventoryChzStatus, type InventoryCodeState } from "./status.js";

export interface InventorySnapshotSourceRow {
  /** Normalized upstream to the inventory's GTIN-14 contract. */
  gtin14: string;
  status: InventoryChzStatus;
  state: InventoryCodeState;
  /** Immutable source evidence; `null` represents a missing value explicitly. */
  sourceProductionDate: string | null;
}

export interface InventoryProductionDateRange {
  productionDateFrom: string;
  productionDateTo: string;
}

export type InventorySnapshotClassification =
  | {
      kind: "expected";
      expected: true;
      protected: false;
    }
  | {
      kind: "protected";
      expected: false;
      protected: true;
    }
  | {
      kind: "known_ineligible";
      expected: false;
      protected: false;
    }
  | {
      kind: "invalid_missing_production_date";
      expected: false;
      protected: false;
    };

/**
 * Derives one immutable snapshot row's inventory disposition. The inputs use
 * canonical calendar dates (`YYYY-MM-DD`), whose lexical order is calendar
 * order, so both range endpoints are included without time-zone conversion.
 */
export function classifyInventorySnapshotRow(
  row: InventorySnapshotSourceRow,
  range: InventoryProductionDateRange,
): InventorySnapshotClassification {
  if (row.state === "MOVING_BY_UD") {
    return { kind: "protected", expected: false, protected: true };
  }

  if (!canDisposeChzCode(row)) {
    return { kind: "known_ineligible", expected: false, protected: false };
  }

  if (row.sourceProductionDate === null) {
    return { kind: "invalid_missing_production_date", expected: false, protected: false };
  }

  if (
    row.sourceProductionDate < range.productionDateFrom ||
    row.sourceProductionDate > range.productionDateTo
  ) {
    return { kind: "known_ineligible", expected: false, protected: false };
  }

  return { kind: "expected", expected: true, protected: false };
}
