import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports separate tenant-bound dataset history with stable unit and operation identity", () => {
  expect(schema).toHaveProperty("traceabilityDemoDatasets");
  expect(schema).toHaveProperty("traceabilityDemoDatasetStages");
  const header = getTableConfig(Reflect.get(schema, "traceabilityDemoDatasets"));
  const stages = getTableConfig(Reflect.get(schema, "traceabilityDemoDatasetStages"));
  expect(header.name).toBe("traceability_demo_datasets");
  expect(stages.name).toBe("traceability_demo_dataset_stages");
  expect(header.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual(
    expect.arrayContaining([["tenant_id", "id"], ["tenant_id"]]),
  );
  expect(stages.uniqueConstraints.map((u) => u.columns.map((c) => c.name))).toEqual(
    expect.arrayContaining([
      ["tenant_id", "dataset_id", "unit_key", "stage"],
      ["tenant_id", "dataset_id", "operation_key"],
    ]),
  );
  expect(stages.foreignKeys.map((fk) => fk.reference().columns.map((c) => c.name))).toContainEqual([
    "tenant_id",
    "dataset_id",
  ]);
  for (const table of [header, stages]) {
    for (const fk of table.foreignKeys) {
      expect(fk.onDelete).toBe("no action");
      expect(fk.onUpdate).toBe("no action");
    }
    expect(table.columns.find((c) => c.name === "created_at")?.getSQLType()).toBe(
      "timestamp with time zone",
    );
  }
  expect(stages.columns.find((c) => c.name === "revision")?.default).toBe(1);
});
