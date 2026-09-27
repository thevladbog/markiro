import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { schema } from "../src/index.js";

it("models case history with tenant-composite box and lot references", () => {
  const links = getTableConfig(schema.traceLotBoxes);
  const references = links.foreignKeys.map((key) => {
    const ref = key.reference();
    return [
      ref.foreignTable,
      ref.columns.map((column) => column.name),
      ref.foreignColumns.map((column) => column.name),
    ];
  });
  expect(references).toContainEqual([schema.boxes, ["tenant_id", "box_id"], ["tenant_id", "id"]]);
  expect(references).toContainEqual([
    schema.traceabilityLots,
    ["tenant_id", "lot_id"],
    ["tenant_id", "id"],
  ]);
  expect(
    links.indexes.some(
      (index) =>
        index.config.name === "trace_lot_boxes_one_active_box_uq" &&
        index.config.unique &&
        index.config.where,
    ),
  ).toBe(true);
  expect(
    links.indexes.some(
      (index) => index.config.name === "trace_lot_boxes_lot_active_idx" && index.config.where,
    ),
  ).toBe(true);
});

it("models synthetic provenance and immutable operation receipts separately", () => {
  const marker = getTableConfig(schema.traceabilitySyntheticCaseOrigins);
  const operations = getTableConfig(schema.traceLotBoxOperations);
  expect(marker.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
    "tenant_id",
    "box_id",
  ]);
  expect(operations.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
    "tenant_id",
    "command",
    "operation_key",
  ]);
  expect(operations.columns.find((column) => column.name === "result")?.dataType).toBe("json");
});
