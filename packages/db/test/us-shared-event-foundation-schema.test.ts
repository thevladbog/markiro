import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("typed shared event foundation", () => {
  it("anchors every event in its own tenant and type", () => {
    const config = getTableConfig(schema.traceabilityEvents);
    const ref = config.foreignKeys
      .find((key) => key.getName() === "traceability_events_typed_root_fk")
      ?.reference();
    expect(ref?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "root_event_id",
      "type",
    ]);
    expect(ref?.foreignTable).toBe(schema.traceabilityEvents);
    expect(ref?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id", "type"]);
  });
  it.each(["receiving", "transformation"])("requires a generated %s root relation", (type) => {
    const config = getTableConfig(schema.traceabilityEvents);
    expect(
      config.columns.find((column) => column.name === `${type}_root_key`)?.generated,
    ).toBeDefined();
    const ref = config.foreignKeys
      .find((key) => key.getName() === `traceability_events_${type}_root_fk`)
      ?.reference();
    expect(ref?.columns.map((column) => column.name)).toEqual(["tenant_id", `${type}_root_key`]);
    expect(ref?.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
    expect(ref && getTableConfig(ref.foreignTable).name).toBe(`${type}_event_roots`);
  });
});
