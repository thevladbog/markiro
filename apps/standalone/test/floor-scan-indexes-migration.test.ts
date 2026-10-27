import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SCAN_HISTORY_SQL } from "../src/floor/work/scan-history.js";
import { VALIDATION_COUNTS_SQL } from "../src/floor/work/work-reads.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);
const SCAN_INDEXES = ["floor_scans_box", "floor_scans_shift_time"];

function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
    .sort();
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

const master = (db: DatabaseSync): unknown[] =>
  db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .map((row) => ({ ...row }));

const plan = (db: DatabaseSync, sql: string, values: (string | number)[]): string[] =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...values)
    .map((step) => String(step["detail"]));

describe("migration 0023 over a database of 0022 (the scan lag fix)", () => {
  it("adds the two indexes of the scans' history and box positions, and changes nothing else", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0022_zzz");
    const insert = db.prepare(
      "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at, operator_id) " +
        "VALUES (?, ?, ?, 'shift-1', ?, ?, ?, 'km', 40, ?, '04600682000013', ?, 'c', ?, NULL)",
    );
    insert.run(
      "scan-1",
      HOST_ID,
      DEVICE_ID,
      "box-1",
      "ok",
      null,
      "h1",
      "S1",
      "2026-10-27T08:00:00.000Z",
    );
    insert.run(
      "scan-2",
      HOST_ID,
      DEVICE_ID,
      null,
      "duplicate",
      "local",
      "h1",
      "S1",
      "2026-10-27T08:00:01.000Z",
    );
    insert.run(
      "scan-3",
      HOST_ID,
      DEVICE_ID,
      null,
      "ok",
      null,
      "h3",
      "S3",
      "2026-10-27T08:00:01.000Z",
    );
    const rows = db.prepare("SELECT rowid, * FROM floor_scans ORDER BY rowid").all();
    const before = master(db);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name IN (${SCAN_INDEXES.map(() => "?").join(", ")})`,
        )
        .all(...SCAN_INDEXES),
    ).toEqual([]);

    migrate(db, "0023", "0023_zzz");

    // Every row stays with its rowid (the box position breaks ties by it).
    expect(db.prepare("SELECT rowid, * FROM floor_scans ORDER BY rowid").all()).toEqual(rows);
    // The schema changes by exactly the two indexes; `floor_scans_shift` stays.
    const after = master(db);
    const added = after.filter(
      (entry) => !before.some((old) => JSON.stringify(old) === JSON.stringify(entry)),
    );
    expect(
      after.filter((entry) => before.some((old) => JSON.stringify(old) === JSON.stringify(entry))),
    ).toEqual(before);
    expect(added).toEqual([
      {
        type: "index",
        name: "floor_scans_box",
        tbl_name: "floor_scans",
        sql: "CREATE INDEX floor_scans_box ON floor_scans (host_id, device_id, box_id) WHERE box_id IS NOT NULL",
      },
      {
        type: "index",
        name: "floor_scans_shift_time",
        tbl_name: "floor_scans",
        sql: "CREATE INDEX floor_scans_shift_time ON floor_scans (host_id, device_id, shift_id, scanned_at)",
      },
    ]);
    const columns = (index: string) =>
      db
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(index)
        .map((row) => row["name"]);
    expect(columns("floor_scans_shift_time")).toEqual([
      "host_id",
      "device_id",
      "shift_id",
      "scanned_at",
    ]);
    expect(columns("floor_scans_box")).toEqual(["host_id", "device_id", "box_id"]);
    expect(columns("floor_scans_shift")).toEqual(["host_id", "device_id", "shift_id"]);

    // The history read: its page comes from the shift's scans in time order (the index's own
    // order, no sort of the shift), and each box position counts the box's scans only.
    const history = plan(db, SCAN_HISTORY_SQL, [HOST_ID, DEVICE_ID, "shift-1", 8, 0]);
    expect(history).toContain(
      "SEARCH floor_scans USING COVERING INDEX floor_scans_shift_time (host_id=? AND device_id=? AND shift_id=?)",
    );
    expect(history).toContain(
      "SEARCH p USING INDEX floor_scans_box (host_id=? AND device_id=? AND box_id=?)",
    );
    expect(history.filter((step) => step.includes("TEMP B-TREE"))).toEqual([
      // The outer sort of the page's own rows (eight at most), not of the shift.
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    // The other reads of a shift's scans keep their index.
    expect(plan(db, VALIDATION_COUNTS_SQL, ["x", "x", "x"])).toContain(
      "SEARCH floor_scans USING INDEX floor_scans_shift (host_id=? AND device_id=? AND shift_id=?)",
    );
    db.close();
  });
});
