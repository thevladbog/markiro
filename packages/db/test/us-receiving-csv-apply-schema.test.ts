import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("receiving CSV apply binding schema", () => {
  it("exposes the binding for transactional consumers", () => {
    expect(schema).toHaveProperty("receivingCsvApplications");
  });

  it("pins one preview to a tenant-and-content-matched operation", () => {
    const config = getTableConfig(schema.receivingCsvApplications);
    expect(config.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([
      ["tenant_id", "preview_id"],
    ]);
    expect(
      config.foreignKeys.map((key) => {
        const ref = key.reference();
        return {
          columns: ref.columns.map((column) => column.name),
          target: getTableConfig(ref.foreignTable).name,
          foreign: ref.foreignColumns.map((column) => column.name),
        };
      }),
    ).toEqual([
      {
        columns: ["tenant_id", "preview_id", "input_digest"],
        target: "receiving_csv_previews",
        foreign: ["tenant_id", "id", "preview_digest"],
      },
      {
        columns: ["tenant_id", "command", "operation_key", "input_digest"],
        target: "receiving_operations",
        foreign: ["tenant_id", "command", "operation_key", "input_digest"],
      },
    ]);
    expect(config.columns.every((column) => column.notNull)).toBe(true);
  });
});
