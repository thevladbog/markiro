import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);
const AT = "2026-10-09T08:00:00.000Z";
const SHIFT_INDEXES = ["floor_exceptions_shift", "floor_pallet_exceptions_shift", "outbox_shift"];

function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= to)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

describe("migration 0010 over a database of 0009 (plan ХП)", () => {
  it("adds the indexes by shift, the shift first, and keeps every row", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0009_zzz");
    const pairing = [HOST_ID, DEVICE_ID];
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, outcome, " +
        "acked_at) VALUES ('record-1', ?, ?, 'shift_closed', 'shift-1', '{}', ?, 'accepted', ?)",
    ).run(...pairing, AT, AT);
    db.prepare(
      "INSERT INTO floor_exceptions (id, host_id, device_id, shift_id, kind, box_id, occurred_at) " +
        "VALUES ('exception-1', ?, ?, 'shift-1', 'clear', 'box-1', ?)",
    ).run(...pairing, AT);
    db.prepare(
      "INSERT INTO floor_pallet_exceptions (id, host_id, device_id, shift_id, kind, pallet_id, " +
        "reason_code, occurred_at) VALUES ('pallet-exception-1', ?, ?, 'shift-1', 'reprint', " +
        "'pallet-1', 'damaged_label', ?)",
    ).run(...pairing, AT);
    const indexes = () =>
      db
        .prepare(
          "SELECT name, tbl_name AS tableName FROM sqlite_master WHERE type = 'index' " +
            `AND name IN (${SHIFT_INDEXES.map(() => "?").join(", ")}) ORDER BY name`,
        )
        .all(...SHIFT_INDEXES);
    expect(indexes()).toEqual([]);

    migrate(db, "0010", "0010_zzz");

    expect(indexes()).toEqual([
      { name: "floor_exceptions_shift", tableName: "floor_exceptions" },
      { name: "floor_pallet_exceptions_shift", tableName: "floor_pallet_exceptions" },
      { name: "outbox_shift", tableName: "outbox" },
    ]);
    const columns = (index: string) =>
      db
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(index)
        .map((row) => row["name"]);
    // The shift leads (plan ХП, Д1): led by the pairing, the index would become the hourly due
    // select's first step and the status bar's count of unsent records.
    expect(columns("outbox_shift")).toEqual(["shift_id", "host_id", "device_id", "acked_at"]);
    expect(columns("floor_exceptions_shift")).toEqual(["shift_id", "host_id", "device_id"]);
    expect(columns("floor_pallet_exceptions_shift")).toEqual(["shift_id", "host_id", "device_id"]);
    expect(db.prepare("SELECT id, outcome, acked_at FROM outbox").all()).toEqual([
      { id: "record-1", outcome: "accepted", acked_at: AT },
    ]);
    expect(db.prepare("SELECT id FROM floor_exceptions").all()).toEqual([{ id: "exception-1" }]);
    expect(db.prepare("SELECT id FROM floor_pallet_exceptions").all()).toEqual([
      { id: "pallet-exception-1" },
    ]);
    db.close();
  });
});
