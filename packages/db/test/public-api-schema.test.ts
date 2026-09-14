import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";

describe("durable public API actor storage", () => {
  it("retains key identities independently of deletable secrets", () => {
    expect(schema).toHaveProperty("publicApiKeyIdentities");
    expect(schema).toHaveProperty("publicApiRequestReceipts");
  });
  it("supports tenant-scoped public actors at each selected inventory owner", () => {
    for (const [table, column] of [
      [schema.inventories, "created_by_public_key_id"],
      [schema.inventories, "started_by_public_key_id"],
      [schema.inventoryImports, "created_by_public_key_id"],
      [schema.inventorySnapshots, "fixed_by_public_key_id"],
    ] as const) {
      const config = getTableConfig(table);
      expect(config.columns.map((item) => item.name)).toContain(column);
      expect(
        config.foreignKeys.map((key) =>
          key
            .reference()
            .columns.map((item) => item.name)
            .join(","),
        ),
      ).toContain(`tenant_id,${column}`);
    }
  });
});
