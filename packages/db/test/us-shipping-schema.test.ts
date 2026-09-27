import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("exports tenant-scoped Shipping storage with typed event guards", () => {
  for (const name of [
    "shippingEventDetails",
    "shippingEventItems",
    "shippingEventDocuments",
    "shippingLotStatusEffects",
  ] as const) {
    expect(schema).toHaveProperty(name);
    const config = getTableConfig(schema[name]);
    expect(config.columns.find((column) => column.name === "event_type")?.generated).toBeDefined();
    expect(
      config.foreignKeys.some((key) => {
        const ref = key.reference();
        return (
          ref.foreignTable === schema.traceabilityEvents &&
          ref.columns.map((column) => column.name).join() === "tenant_id,event_id,event_type"
        );
      }),
    ).toBe(true);
  }
  expect(schema).toHaveProperty("shippingEventRoots");
  const events = getTableConfig(schema.traceabilityEvents);
  expect(
    events.columns.find((column) => column.name === "shipping_root_key")?.generated,
  ).toBeDefined();
  expect(
    events.foreignKeys.some((key) => key.getName() === "traceability_events_shipping_root_fk"),
  ).toBe(true);
});

it("keeps exact decimal quantities and a unique lot per Shipping event", () => {
  const items = getTableConfig(schema.shippingEventItems);
  expect(items.columns.find((column) => column.name === "quantity")?.getSQLType()).toBe("text");
  expect(items.checks.map((check) => check.name)).toContain("shipping_items_quantity_valid");
  expect(items.checks.map((check) => check.name)).toContain("shipping_items_uom_valid");
  expect(
    items.uniqueConstraints
      .find((unique) => unique.name === "shipping_items_lot_uq")
      ?.columns.map((column) => column.name),
  ).toEqual(["tenant_id", "event_id", "lot_id"]);
});

it("exports per-tenant/year Shipping counters and typed durable operation receipts", () => {
  expect(schema).toHaveProperty("shippingCounters");
  expect(schema).toHaveProperty("shippingOperations");

  const counters = getTableConfig(schema.shippingCounters);
  expect(counters.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([
    ["tenant_id", "year"],
  ]);
  expect(counters.checks.map((constraint) => constraint.name)).toContain("shipping_counters_valid");

  const operations = getTableConfig(schema.shippingOperations);
  expect(operations.primaryKeys.map((key) => key.columns.map((column) => column.name))).toEqual([
    ["tenant_id", "command", "operation_key"],
  ]);
  expect(
    operations.columns.find((column) => column.name === "event_type")?.generated,
  ).toBeDefined();
  expect(
    operations.foreignKeys.some((key) => {
      const ref = key.reference();
      return (
        ref.foreignTable === schema.traceabilityEvents &&
        ref.columns.map((column) => column.name).join() === "tenant_id,event_id,event_type"
      );
    }),
  ).toBe(true);
  for (const name of [
    "shipping_operations_command_valid",
    "shipping_operations_digest_valid",
    "shipping_operations_result_valid",
  ]) {
    expect(operations.checks.map((constraint) => constraint.name)).toContain(name);
  }
});
