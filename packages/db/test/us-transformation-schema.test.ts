import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports tenant-scoped Transformation storage with typed event foreign keys", () => {
  for (const name of [
    "transformationEventDetails",
    "transformationEventInputs",
    "transformationEventOutputs",
    "transformationEventDocuments",
    "transformationOperations",
    "lotGenealogyEdges",
  ] as const) {
    expect(schema).toHaveProperty(name);
    const config = getTableConfig(schema[name]);
    expect(
      config.foreignKeys.some((key) => {
        const ref = key.reference();
        return (
          ref.foreignTable === schema.traceabilityEvents &&
          ref.columns.map((c) => c.name).join() === "tenant_id,event_id,event_type"
        );
      }),
    ).toBe(true);
    expect(config.columns.find((c) => c.name === "event_type")?.generated).toBeDefined();
    for (const key of config.foreignKeys) {
      const ref = key.reference();
      expect(ref.columns[0]?.name).toBe("tenant_id");
      if (ref.columns.length > 1) expect(ref.foreignColumns[0]?.name).toBe("tenant_id");
    }
  }
  expect(schema).toHaveProperty("transformationCounters");
});

it("indexes tenant-scoped reverse lot lookups and prevents duplicate event lot bindings", () => {
  for (const [table, prefix] of [
    [schema.transformationEventInputs, "transformation_inputs"],
    [schema.transformationEventOutputs, "transformation_outputs"],
  ] as const) {
    const config = getTableConfig(table);
    const index = config.indexes.find((value) => value.config.name === `${prefix}_lot_idx`);
    expect(index?.config.columns.map((column) => ("name" in column ? column.name : null))).toEqual([
      "tenant_id",
      "lot_id",
      "event_id",
    ]);
    const unique = config.uniqueConstraints.find((value) => value.name === `${prefix}_lot_uq`);
    expect(unique?.columns.map((column) => column.name)).toEqual([
      "tenant_id",
      "event_id",
      "lot_id",
    ]);
  }
  const edges = getTableConfig(schema.lotGenealogyEdges);
  for (const direction of ["input", "output"] as const) {
    const index = edges.indexes.find(
      (value) => value.config.name === `lot_genealogy_${direction}_idx`,
    );
    expect(index?.config.columns.map((column) => ("name" in column ? column.name : null))).toEqual([
      "tenant_id",
      `${direction}_lot_id`,
      "event_id",
    ]);
  }
  expect(edges.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([
    ["tenant_id", "event_id", "input_lot_id", "output_lot_id"],
  ]);
});

it("exposes a positive lot dependency epoch and revision-capable Transformation roots", () => {
  const lots = getTableConfig(schema.traceabilityLots);
  const epoch = lots.columns.find((column) => column.name === "current_dependency_version");
  expect(epoch?.notNull).toBe(true);
  expect(epoch?.default).toBe(1);
  expect(
    lots.checks.some(
      (value) => value.name === "traceability_lots_current_dependency_version_positive",
    ),
  ).toBe(true);

  const roots = getTableConfig(schema.transformationEventRoots);
  expect(roots.checks.some((value) => value.name === "transformation_roots_revision_valid")).toBe(
    true,
  );
  expect(roots.checks.some((value) => value.name === "transformation_roots_original_valid")).toBe(
    false,
  );
});
