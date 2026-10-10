import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("warehouse print tenancy", () => {
  it("ties jobs and events to the authenticated device and same tenant", () => {
    const job = getTableConfig(schema.warehouseReprintJobs);
    expect(job.primaryKeys[0]?.columns.map((c) => c.name)).toEqual([
      "tenant_id",
      "device_id",
      "job_id",
    ]);
    const device = job.foreignKeys
      .find((k) => getTableName(k.reference().foreignTable) === "station_devices")
      ?.reference();
    expect(device?.columns.map((c) => c.name)).toEqual(["tenant_id", "device_id"]);
    const events = getTableConfig(schema.warehouseReprintEvents);
    expect(events.uniqueConstraints.map((c) => c.columns.map((k) => k.name))).toContainEqual([
      "tenant_id",
      "device_id",
      "job_id",
      "sequence",
    ]);
    expect(Object.keys(getTableColumns(schema.warehouseReprintJobs))).not.toContain("raw");
    expect(Object.keys(getTableColumns(schema.warehouseReprintJobs))).not.toContain("bytesBase64");
    expect(
      events.foreignKeys
        .find((k) => getTableName(k.reference().foreignTable) === "employees")
        ?.reference()
        .columns.map((c) => c.name),
    ).toEqual(["tenant_id", "operator_id"]);
  });
});
