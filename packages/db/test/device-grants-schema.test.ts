import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
describe("offline grant provenance schema", () => {
  it("persists independent credential epochs on durable native identities", () => {
    for (const table of [schema.stationDevices, schema.kiosks]) {
      const epoch = getTableConfig(table).columns.find(
        (column) => column.name === "credential_epoch",
      );
      expect(epoch?.notNull).toBe(true);
      expect(epoch?.default).toBe(1);
    }
  });
  it("exposes issuance, frozen authority and retained evidence", () => {
    expect(schema).toHaveProperty("deviceGrantIssuances");
    expect(schema).toHaveProperty("deviceGrantTaskSources");
    expect(schema).toHaveProperty("deviceGrantEvidence");
    expect(schema).toHaveProperty("deviceGrantConfigurations");
  });
});
