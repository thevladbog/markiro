import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { REFUSED_CLOSES_SQL } from "../src/floor/close/shift-close.js";
import {
  CONFLICT_COUNT_SQL,
  HEAD_RECORD_SQL,
  REJECTED_COUNT_SQL,
  UNSENT_COUNT_SQL,
} from "../src/floor/outbox-status.js";
import {
  DISMISS_SQL,
  QUEUE_SETTLED_SQL,
  QUEUE_TALLY_SQL,
  QUEUE_UNSENT_SQL,
} from "../src/floor/queue/outbox-recovery.js";
import { UNSENT_SQL } from "../src/local/facts-sender.js";
import { REOPEN_SQL } from "../src/local/restore-reconcile.js";
import { DUE_SHIFTS_SQL, purgeTableSql, RETAINED_TABLES } from "../src/local/retention.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);
const AT = "2026-10-09T08:00:00.000Z";

/** The migrations whose file name sorts within `[from, to]` (a prefix of four digits). */
function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= `${to}_zzz`)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

/** The plans of what the station reads and deletes today: the migration re-plans none. */
function plans(db: DatabaseSync): Record<string, string> {
  const statements = [
    UNSENT_SQL,
    UNSENT_COUNT_SQL,
    REJECTED_COUNT_SQL,
    CONFLICT_COUNT_SQL,
    HEAD_RECORD_SQL,
    REFUSED_CLOSES_SQL,
    REOPEN_SQL,
    DUE_SHIFTS_SQL,
    QUEUE_UNSENT_SQL,
    QUEUE_SETTLED_SQL,
    QUEUE_TALLY_SQL,
    DISMISS_SQL,
    ...RETAINED_TABLES.map(purgeTableSql),
  ];
  return Object.fromEntries(
    statements.map((sql) => [
      sql,
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: sql.split("?").length - 1 }, () => "x"))
        .map((step) => String(step["detail"]))
        .join("\n"),
    ]),
  );
}

describe("migration 0016 over a database of 0013 (plan КНФ)", () => {
  it("adds office_reviewed_at as NULL to every record and an empty table of displacements", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0013");
    const pairing = [HOST_ID, DEVICE_ID];
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
        "outcome, outcome_code, outcome_details, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', " +
        "?, ?, ?, ?, ?, ?)",
    );
    insert.run("waiting", ...pairing, '{"n":1}', AT, null, null, null, null);
    insert.run("accepted", ...pairing, '{"n":2}', AT, "accepted", null, null, AT);
    insert.run("conflict", ...pairing, '{"n":3}', AT, "conflict", null, '{"winner":{}}', AT);
    const before = db.prepare("SELECT * FROM outbox ORDER BY seq").all();
    const plansBefore = plans(db);

    // Migrations 0014 and 0015 belong to plan РЕЖ and may be absent.
    migrate(db, "0016", "0016");

    const after = db.prepare("SELECT * FROM outbox ORDER BY seq").all();
    expect(after).toHaveLength(3);
    for (const [index, row] of after.entries()) {
      const { office_reviewed_at, ...kept } = row;
      expect(kept).toEqual(before[index]);
      expect(office_reviewed_at).toBeNull();
    }
    expect(db.prepare("SELECT count(*) AS n FROM floor_displacements").get()).toEqual({ n: 0 });
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'floor_displacements' " +
          "AND sql IS NOT NULL ORDER BY name",
      )
      .all()
      .map((row) => row["name"]);
    expect(indexes).toEqual([
      "floor_displacements_cursor",
      "floor_displacements_open",
      "floor_displacements_record",
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    // The new column and table re-plan nothing the station reads or the retention deletes.
    expect(plans(db)).toEqual(plansBefore);
    // The office's review is kept only on a record the station resolved.
    expect(() =>
      db.prepare("UPDATE outbox SET office_reviewed_at = ? WHERE id = 'conflict'").run(AT),
    ).toThrow();
    db.prepare(
      "UPDATE outbox SET resolution = 'dismissed', resolved_at = ?, office_reviewed_at = ? " +
        "WHERE id = 'conflict'",
    ).run(AT, AT);
    db.close();
  });

  it("keeps a displacement's resolution whole and one row per record", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0016");
    const insert = db.prepare(
      "INSERT INTO floor_displacements (host_id, device_id, conflict_id, record_id, shift_id, " +
        "code_hash, box_id, detected_at, winner_shift_number, winner_same_device, " +
        "winner_scanned_at, learned_at, resolved_at, resolved_by, office_reviewed_at) " +
        "VALUES (?, ?, ?, ?, 'shift-1', ?, NULL, '2026-10-08T07:12:03Z', 'OCT26-005', ?, " +
        "'2026-10-08T06:00:50.000Z', ?, ?, ?, ?)",
    );
    const hash = "0".repeat(63) + "7";
    insert.run(HOST_ID, DEVICE_ID, "c-1", "r-1", hash, 0, AT, null, null, null);
    // A person or the office resolves it: both need the instant.
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "c-2", "r-2", hash, 0, AT, null, "op-1", null),
    ).toThrow();
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "c-3", "r-3", hash, 0, AT, null, null, AT),
    ).toThrow();
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "c-4", "r-4", hash, 2, AT, null, null, null),
    ).toThrow();
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "c-5", "r-5", "abc", 0, AT, null, null, null),
    ).toThrow();
    // The same record under another conflict id (a restored host) is not a second row.
    expect(() =>
      insert.run(HOST_ID, DEVICE_ID, "c-6", "r-1", hash, 0, AT, null, null, null),
    ).toThrow();
    // Another pairing keeps its own.
    insert.run("other-host", DEVICE_ID, "c-1", "r-1", hash, 1, AT, AT, "op-1", null);
    expect(db.prepare("SELECT count(*) AS n FROM floor_displacements").get()).toEqual({ n: 2 });
    db.close();
  });
});
