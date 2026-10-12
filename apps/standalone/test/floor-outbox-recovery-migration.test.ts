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
import { UNSENT_SQL } from "../src/local/facts-sender.js";
import { REOPEN_SQL } from "../src/local/restore-reconcile.js";
import {
  DUE_SHIFTS_SQL,
  PURGE_COPY_SQL,
  purgeTableSql,
  RETAINED_TABLES,
} from "../src/local/retention.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";

// See test/protocol.test.ts: bind import.meta.url before building a URL from it.
const testModuleUrl = import.meta.url;
const MIGRATIONS = new URL("../src-tauri/migrations/", testModuleUrl);
const AT = "2026-10-09T08:00:00.000Z";
const NEW_COLUMNS = ["resolution", "resent_as", "resolved_at", "resolved_by"];

/** The migrations whose file name sorts within `[from, to]` (a prefix of four digits). */
function migrate(db: DatabaseSync, from: string, to: string): void {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && name >= from && name <= `${to}_zzz`)
    .sort();
  for (const name of files) db.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
}

/**
 * The plans of the statements the station ran before the migration. The reads that count,
 * name or reopen unresolved records (plan ОЧ task 2) name `resolved_at`: they cannot be planned
 * on a database without the column, and their plans are pinned in `floor-schema.test.ts`.
 */
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
    PURGE_COPY_SQL,
    ...RETAINED_TABLES.map(purgeTableSql),
  ].filter((sql) => !sql.includes("resolved_at"));
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

describe("migration 0013 over a database of 0010 (plan ОЧ)", () => {
  it("adds the four columns as NULL to every record and an empty table of dropped blocks", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, "0001", "0010");
    const pairing = [HOST_ID, DEVICE_ID];
    const insert = db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at, " +
        "outcome, outcome_code, outcome_details, acked_at) VALUES (?, ?, ?, 'scan', 'shift-1', " +
        "?, ?, ?, ?, ?, ?)",
    );
    insert.run("waiting", ...pairing, '{"n":1}', AT, null, null, null, null);
    insert.run("accepted", ...pairing, '{"n":2}', AT, "accepted", null, null, AT);
    insert.run("rejected", ...pairing, '{"n":3}', AT, "rejected", "not_entered", null, AT);
    insert.run("conflict", ...pairing, '{"n":4}', AT, "conflict", "duplicate", '{"by":"x"}', AT);
    const before = db.prepare("SELECT * FROM outbox ORDER BY seq").all();
    const plansBefore = plans(db);
    expect(before.map((row) => row["id"])).toEqual(["waiting", "accepted", "rejected", "conflict"]);

    // Migrations 0011 and 0012 belong to other plans and may be absent: a database that skips
    // them takes 0013 all the same.
    migrate(db, "0013", "0013");

    const after = db.prepare("SELECT * FROM outbox ORDER BY seq").all();
    expect(after).toHaveLength(4);
    for (const [index, row] of after.entries()) {
      const { resolution, resent_as, resolved_at, resolved_by, ...kept } = row;
      expect(kept).toEqual(before[index]);
      expect({ resolution, resent_as, resolved_at, resolved_by }).toEqual({
        resolution: null,
        resent_as: null,
        resolved_at: null,
        resolved_by: null,
      });
    }
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('outbox') ORDER BY cid")
      .all()
      .map((column) => column["name"]);
    expect(columns.slice(-NEW_COLUMNS.length)).toEqual(NEW_COLUMNS);
    expect(db.prepare("SELECT count(*) AS n FROM floor_block_drops").get()).toEqual({ n: 0 });
    // The new columns and the table re-plan nothing the station reads or the retention deletes.
    expect(plans(db)).toEqual(plansBefore);
    // The record keeps being written without the new columns, as the station writes it today.
    db.prepare(
      "INSERT INTO outbox (id, host_id, device_id, kind, shift_id, payload, created_at) " +
        "VALUES ('later', ?, ?, 'scan', 'shift-1', '{}', ?)",
    ).run(...pairing, AT);
    expect(db.prepare("SELECT resolution FROM outbox WHERE id = 'later'").get()).toEqual({
      resolution: null,
    });
    db.close();
  });
});
