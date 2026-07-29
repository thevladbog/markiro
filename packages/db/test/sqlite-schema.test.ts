import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

/** Mirrors apps/station/src/lib/mirror.ts's applyMigrations against a raw node:sqlite handle. */
function applyStationMigrations(db: DatabaseSync): void {
  for (const stmt of STATION_MIGRATIONS) {
    try {
      db.exec(stmt);
    } catch (err) {
      // The operators_mirror CREATE TABLE already declares `login`, so the
      // upgrade-path ALTER TABLE ADD COLUMN that follows it always collides
      // on a fresh database. That's expected — swallow only that error.
      if (!/duplicate column name/i.test(err instanceof Error ? err.message : String(err))) {
        throw err;
      }
    }
  }
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyStationMigrations(db);
  return db;
}

describe("STATION_MIGRATIONS", () => {
  it("creates all eleven mirror tables", () => {
    const db = migratedDb();
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("station_meta");
    expect(names).toContain("operators_mirror");
    expect(names).toContain("operators_mirror_b");
    expect(names).toContain("shift_mirror");
    expect(names).toContain("product_mirror");
    expect(names).toContain("codes_mirror");
    expect(names).toContain("scan_events_mirror");
    expect(names).toContain("outbox");
    expect(names).toContain("conflicts_mirror");
    expect(names).toContain("sscc_pool");
    expect(names).toContain("boxes_mirror");
  });

  it("keeps operators_mirror and operators_mirror_b column-for-column identical", () => {
    // apps/station/src/lib/mirror.ts alternates the active offline-roster
    // slot between operators_mirror ("a") and operators_mirror_b ("b") and
    // publishes into whichever is currently inactive. That only works if the
    // two tables accept exactly the same writes. If one slot is stricter than
    // the other (e.g. only one declares `login NOT NULL`), a payload that a
    // server sends with a null login succeeds into the lenient slot and
    // throws into the strict one. The active slot only flips on a successful
    // publish, so the next refresh targets that same failing slot again —
    // the roster freezes on one generation forever and server-side operator
    // removals silently stop propagating to offline sign-in. If this test
    // trips, fix the schema asymmetry; do not relax the assertion.
    const db = migratedDb();
    const columnsOf = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }>
      ).map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));

    expect(columnsOf("operators_mirror_b")).toEqual(columnsOf("operators_mirror"));
  });

  it("round-trips an operators_mirror row with a nullable badge_hash", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("op_1", "Ivan", "operator", "pbkdf2$sha256$100000$c2FsdA==$aGFzaA==", null, 1);

    const row = db
      .prepare(
        "SELECT operator_id, name, badge_hash, active FROM operators_mirror WHERE operator_id = ?",
      )
      .get("op_1") as {
      operator_id: string;
      name: string;
      badge_hash: string | null;
      active: number;
    };

    expect(row).toEqual({ operator_id: "op_1", name: "Ivan", badge_hash: null, active: 1 });
  });

  it("adds boxes_mirror.terminal_id via the trailing ALTER and survives a second migration run", () => {
    // Task 11 review fix: boxes_mirror's CREATE TABLE was briefly edited
    // in-place to add terminal_id, which is a no-op against any database that
    // already ran migrations at Task 9's shape (CREATE TABLE IF NOT EXISTS
    // does nothing once the table exists). terminal_id must instead arrive
    // via the trailing ALTER, like every other post-launch column. Migrating
    // the SAME database twice reproduces a device rebooting after that
    // upgrade shipped: the second pass must swallow the ALTER's own
    // duplicate-column error rather than throw, and the column must still be
    // there afterwards, nullable, for devices that never re-open a box.
    const db = new DatabaseSync(":memory:");
    applyStationMigrations(db);
    expect(() => applyStationMigrations(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(boxes_mirror)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const terminalId = columns.find((c) => c.name === "terminal_id");
    expect(terminalId).toBeDefined();
    expect(terminalId?.notnull).toBe(0);
  });
});
