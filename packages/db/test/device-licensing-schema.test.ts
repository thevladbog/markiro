import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("working device schema", () => {
  it("exports tenant-scoped current assignments and transition history", () => {
    expect(schema).toHaveProperty("workingDeviceAssignments");
    expect(schema).toHaveProperty("workingDeviceEvents");
  });
  it("uses composite tenant/device references and a positive integer revision", () => {
    for (const table of [schema.workingDeviceAssignments, schema.workingDeviceEvents]) {
      const config = getTableConfig(table);
      expect(
        config.foreignKeys.some(
          (key) =>
            key
              .reference()
              .columns.map((c) => c.name)
              .join(",") === "tenant_id,device_id",
        ),
      ).toBe(true);
    }
    expect(schema.workingDeviceAssignments.revision.getSQLType()).toBe("integer");
  });
});
