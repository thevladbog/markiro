import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports tenant-bound seed history and prevents duplicate scenario/stage/operation bindings", () => {
  for (const name of ["traceabilityDemoSeeds", "traceabilityDemoSeedStages"]) {
    expect(schema).toHaveProperty(name);
  }
  const header = getTableConfig(Reflect.get(schema, "traceabilityDemoSeeds"));
  const stage = getTableConfig(Reflect.get(schema, "traceabilityDemoSeedStages"));
  expect(header.name).toBe("traceability_demo_seeds");
  expect(stage.name).toBe("traceability_demo_seed_stages");
  expect(header.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual(
    expect.arrayContaining([
      ["tenant_id", "id"],
      ["tenant_id", "scenario_version"],
    ]),
  );
  expect(stage.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual(
    expect.arrayContaining([
      ["tenant_id", "seed_id", "stage"],
      ["tenant_id", "seed_id", "operation_key"],
    ]),
  );
  expect(stage.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name))).toContainEqual([
    "tenant_id",
    "seed_id",
  ]);
  expect(
    header.foreignKeys.map((fk) => fk.reference().foreignColumns.map((c) => c.name)),
  ).toContainEqual(["id"]);
  for (const table of [header, stage]) {
    for (const fk of table.foreignKeys) {
      expect(fk.onDelete).toBe("no action");
      expect(fk.onUpdate).toBe("no action");
    }
    expect(table.columns.find((c) => c.name === "revision")?.default).toBe(1);
    expect(table.columns.find((c) => c.name === "created_at")?.getSQLType()).toBe(
      "timestamp with time zone",
    );
  }
});
