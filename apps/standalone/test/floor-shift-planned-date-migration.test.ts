import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);

function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

const SHIFT =
  "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, pallets_enabled, created_from, " +
  "line_id, product_id, product_name, product_gtin14, production_date, box_capacity, " +
  "box_template_id, seen_at, planned_date) VALUES (?, ?, ?, 'OCT26-004', 'active', " +
  "'aggregation', 0, 'office', 'line-1', 'product-1', 'Молоко', '04600682000013', '2026-10-08', " +
  "12, 'template-1', 1, ?)";

describe("migration 0018 over a database of 0017 (the shift date on the station)", () => {
  it("adds a nullable shift date and keeps the copies as they were", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0017_zzz");
    db.exec(
      "INSERT INTO floor_shifts (host_id, device_id, id, number, status, mode, pallets_enabled, created_from, " +
        "line_id, product_id, product_name, product_gtin14, production_date, box_capacity, " +
        `box_template_id, seen_at) VALUES ('${HOST_ID}', '${DEVICE_ID}', 'old', 'OCT26-001', ` +
        "'planned', 'aggregation', 0, 'office', 'line-1', 'product-1', 'Молоко', '04600682000013', " +
        "'2026-10-08', 12, 'template-1', 1)",
    );
    migrate(db, "0018", "0018_zzz");
    expect(db.prepare("SELECT id, planned_date FROM floor_shifts").all()).toEqual([
      expect.objectContaining({ id: "old", planned_date: null }),
    ]);
    const column = db
      .prepare(
        "SELECT \"notnull\" AS required, dflt_value AS dflt FROM pragma_table_info('floor_shifts') WHERE name = 'planned_date'",
      )
      .get();
    expect({ ...column }).toEqual({ required: 0, dflt: null });
    db.prepare(SHIFT).run(HOST_ID, DEVICE_ID, "new", "2026-10-12");
    expect(db.prepare("SELECT planned_date FROM floor_shifts WHERE id = 'new'").get()).toEqual(
      expect.objectContaining({ planned_date: "2026-10-12" }),
    );
    expect(() => db.prepare(SHIFT).run(HOST_ID, DEVICE_ID, "bad", "12.10.2026")).toThrow(/CHECK/);
  });
});
