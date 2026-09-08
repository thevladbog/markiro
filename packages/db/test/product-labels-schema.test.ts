import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("product label persistence", () => {
  it("keeps legacy templates and shifts opt-out by default", () => {
    expect(schema.labelTemplates.purpose.notNull).toBe(true);
    expect(schema.labelTemplates.purpose.default).toBe("box");
    expect(schema.shifts.validationPrintMode.default).toBe("none");
    expect(schema.shifts.validationPrintVerification.default).toBe("none");
    expect(schema.shifts.validationPrintSnapshot.notNull).toBe(false);
    const config = getTableConfig(schema.shifts);
    expect(config.checks.map((check) => check.name)).toContain(
      "shifts_validation_print_policy_check",
    );
    const reference = config.foreignKeys
      .find((key) => key.getName() === "shifts_tenant_validation_print_template_fk")
      ?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "validation_print_template_id",
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
  });

  it("keeps job projection with same-tenant shift and device ownership", () => {
    const columns = getTableColumns(schema.productLabelJobs);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "tenantId",
        "deviceId",
        "jobId",
        "shiftId",
        "codeHash",
        "acceptedAt",
        "policyRevision",
        "templateDigest",
        "payloadDigest",
        "latestSequence",
        "projection",
      ]),
    );
    expect(columns).not.toHaveProperty("raw");
    expect(columns).not.toHaveProperty("bytesBase64");
    const config = getTableConfig(schema.productLabelJobs);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "device_id",
      "job_id",
    ]);
    for (const target of ["shifts", "station_devices"]) {
      const ref = config.foreignKeys
        .find((key) => getTableName(key.reference().foreignTable) === target)
        ?.reference();
      expect(ref?.columns[0]?.name).toBe("tenant_id");
      expect(ref?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    }
  });

  it("keys immutable events by device and enforces one event per job sequence", () => {
    const config = getTableConfig(schema.productLabelEvents);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "device_id",
      "event_id",
    ]);
    expect(
      config.uniqueConstraints.map((key) => key.columns.map((column) => column.name)),
    ).toContainEqual(["tenant_id", "device_id", "job_id", "sequence"]);
    const refs = config.foreignKeys.map((key) => key.reference());
    expect(
      refs
        .find((ref) => getTableName(ref.foreignTable) === "product_label_jobs")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "device_id", "job_id"]);
    expect(
      refs
        .find((ref) => getTableName(ref.foreignTable) === "employees")
        ?.columns.map((column) => column.name),
    ).toEqual(["tenant_id", "operator_id"]);
  });

  it("persists rejected receipts without trusting a missing parent or operator", () => {
    const config = getTableConfig(schema.productLabelEventReceipts);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "device_id",
      "event_id",
    ]);
    expect(
      config.foreignKeys.map((key) => getTableName(key.reference().foreignTable)).sort(),
    ).toEqual(["organization", "station_devices"]);
  });
});
