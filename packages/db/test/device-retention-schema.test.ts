import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("device retention storage schema", () => {
  it("exports dedicated preview, selection, membership and history tables", () => {
    for (const name of [
      "workingDeviceRetentionPreviews",
      "workingDeviceRetentionSelections",
      "workingDeviceRetentionMembers",
      "workingDeviceRetentionEvents",
    ])
      expect(schema).toHaveProperty(name);
  });
  it("pins all relationships to the tenant and preserves unique boundary and membership identities", () => {
    for (const [table, keys] of [
      [schema.workingDeviceRetentionSelections, ["tenant_id,preview_id"]],
      [schema.workingDeviceRetentionMembers, ["tenant_id,selection_id", "tenant_id,device_id"]],
      [schema.workingDeviceRetentionEvents, ["tenant_id,selection_id"]],
    ] as const) {
      const config = getTableConfig(table);
      expect(
        config.foreignKeys.map((key) =>
          key
            .reference()
            .columns.map((column) => column.name)
            .join(","),
        ),
      ).toEqual(expect.arrayContaining([...keys]));
    }
    expect(
      getTableConfig(schema.workingDeviceRetentionSelections).uniqueConstraints.map((key) =>
        key.columns.map((column) => column.name).join(","),
      ),
    ).toContain("tenant_id,effective_at");
    expect(
      getTableConfig(schema.workingDeviceRetentionMembers).uniqueConstraints.map((key) =>
        key.columns.map((column) => column.name).join(","),
      ),
    ).toContain("selection_id,device_id");
  });
});
