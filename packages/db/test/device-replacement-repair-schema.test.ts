import { SQL } from "drizzle-orm";
import { getTableConfig, IndexedColumn } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { workingDeviceReplacementExecutions } from "../src/schema/device-replacements.js";
it("persists restart-safe retry attempts and a due-row scheduling index", () => {
  const table = workingDeviceReplacementExecutions;
  expect(table).toHaveProperty("repairAttempts");
  expect(table).toHaveProperty("lastRepairAt");
  expect(table).toHaveProperty("nextRepairAt");
  const config = getTableConfig(table);
  const index = config.indexes.find(
    (index) => index.config.name === "replacement_executions_due_repair_idx",
  );
  expect(
    index?.config.columns.map((column) =>
      column instanceof IndexedColumn ? column.name : undefined,
    ),
  ).toEqual([undefined, "started_at", "id"]);
  expect(index?.config.columns[0]).toBeInstanceOf(SQL);
  expect(index?.config.where).toBeDefined();
  expect(config.checks.map((check) => check.name)).toContain("replacement_executions_repair_check");
});
