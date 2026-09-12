import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  shifts,
  validationCodeAcceptances,
  validationCodeReprocessings,
  validationHistorySnapshots,
  validationHistorySnapshotEntries,
} from "../src/schema.js";

describe("validation reprocessing persistence", () => {
  it("defaults existing shifts off and keys one processing per tenant, shift and hash", () => {
    expect(shifts.allowPreviouslyAcceptedCodes.default).toBe(false);
    expect(shifts.allowPreviouslyAcceptedCodes.notNull).toBe(true);
    const config = getTableConfig(validationCodeReprocessings);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "shift_id",
      "code_hash",
    ]);
    for (const name of ["shift", "source", "device", "operator"]) {
      const reference = config.foreignKeys
        .find((key) => key.getName() === `validation_reprocessing_${name}_fk`)
        ?.reference();
      expect(reference?.columns[0]?.name).toBe("tenant_id");
      expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    }
  });
  it("retains tenant-scoped ordinary identities without an effective-owner foreign key", () => {
    const config = getTableConfig(validationCodeAcceptances);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "shift_id",
      "code_hash",
    ]);
    const reference = config.foreignKeys
      .find((key) => key.getName() === "validation_acceptance_shift_fk")
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual(["tenant_id", "shift_id"]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual([
      "validation_code_acceptances_tenant_id_organization_id_fk",
      "validation_acceptance_shift_fk",
    ]);
  });
  it("keys immutable history pages by a tenant lease with cascading expiry cleanup", () => {
    expect(
      getTableConfig(validationHistorySnapshots).primaryKeys[0]?.columns.map(
        (column) => column.name,
      ),
    ).toEqual(["tenant_id", "snapshot_id"]);
    const entries = getTableConfig(validationHistorySnapshotEntries);
    expect(entries.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "snapshot_id",
      "cursor",
    ]);
    expect(entries.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});
