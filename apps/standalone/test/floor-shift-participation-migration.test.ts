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

const INSERT =
  "INSERT INTO floor_shift_participation (host_id, device_id, shift_id, max_stations, my_state, " +
  "participants, totals, by_device, as_of, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)";
const TOTALS = '{"accepted":5,"boxesClosed":0,"pallets":0,"asOf":"2026-10-08T09:41:07Z"}';

describe("migration 0022 over a database of 0021 (plan 2b, the station's participation cache)", () => {
  it("adds an empty cache that keeps the host's figures whole and refuses what the host never sends", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0021_zzz");
    migrate(db, "0022", "0022_zzz");
    expect(db.prepare("SELECT count(*) AS n FROM floor_shift_participation").get()).toEqual({
      n: 0,
    });
    const columns = db
      .prepare(
        "SELECT name, \"notnull\" AS required, pk FROM pragma_table_info('floor_shift_participation') ORDER BY cid",
      )
      .all()
      .map((row) => ({ ...row }));
    expect(columns).toEqual([
      { name: "host_id", required: 1, pk: 1 },
      { name: "device_id", required: 1, pk: 2 },
      { name: "shift_id", required: 1, pk: 3 },
      { name: "max_stations", required: 1, pk: 0 },
      { name: "my_state", required: 0, pk: 0 },
      { name: "participants", required: 1, pk: 0 },
      { name: "totals", required: 1, pk: 0 },
      { name: "by_device", required: 1, pk: 0 },
      { name: "as_of", required: 1, pk: 0 },
      { name: "seen_at", required: 1, pk: 0 },
      { name: "leave_requested_at", required: 0, pk: 0 },
      { name: "joined_rev", required: 0, pk: 0 },
    ]);
    const insert = db.prepare(INSERT);
    insert.run(HOST_ID, DEVICE_ID, "s1", 2, "active", "[]", TOTALS, "[]", "2026-10-08T09:41:07Z");
    insert.run(HOST_ID, DEVICE_ID, "s2", 1, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z");
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s3", 17, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s4", 2, "paused", "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s5", 2, null, "{}", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s6", 2, null, "[]", "[]", "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "s1", 2, null, "[]", TOTALS, "[]", "2026-10-08T09:41:07Z"),
    ).toThrow(/UNIQUE|PRIMARY/);
    // The leave token is the host's revision: never negative (host `shift_participants.joined_rev`).
    const token = db.prepare(
      "UPDATE floor_shift_participation SET joined_rev = ? WHERE shift_id = ?",
    );
    token.run(12, "s1");
    expect(() => token.run(-1, "s1")).toThrow(/CHECK/);
    // No foreign key, as every table of the station (`0006`).
    expect(
      db
        .prepare("SELECT count(*) AS n FROM pragma_foreign_key_list('floor_shift_participation')")
        .get(),
    ).toEqual({ n: 0 });
  });
});
