import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";

/** Mirrors apps/station/src/lib/mirror.ts's applyMigrations against a raw node:sqlite handle. */
function applyStatements(db: DatabaseSync, statements: readonly string[]): void {
  for (const stmt of statements) {
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

function applyStationMigrations(db: DatabaseSync): void {
  applyStatements(db, STATION_MIGRATIONS);
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyStationMigrations(db);
  return db;
}

describe("STATION_MIGRATIONS", () => {
  it("creates the durable product image cache table", () => {
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
    expect(names).toContain("station_product_images");
  });

  it("retains deprecated item-label columns for rolling station compatibility", () => {
    const db = migratedDb();
    const columnNames = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        ({ name }) => name,
      );

    expect(columnNames("shift_mirror")).toEqual(
      expect.arrayContaining(["label_template_id", "label_template_name", "label_template_spec"]),
    );
    expect(columnNames("product_mirror")).toContain("default_label_template_id");
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

  it("adds the box print lifecycle columns with a legacy default and survives a second migration run", () => {
    const db = new DatabaseSync(":memory:");
    applyStationMigrations(db);
    expect(() => applyStationMigrations(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(boxes_mirror)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "print_state", dflt_value: "'legacy'" }),
        expect.objectContaining({ name: "print_error_code", dflt_value: null }),
      ]),
    );
  });

  it("migrates a historical closed box as legacy rather than pending", () => {
    const firstPrintMigration = STATION_MIGRATIONS.findIndex((stmt) =>
      stmt.includes("ADD COLUMN print_state"),
    );
    expect(firstPrintMigration).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, firstPrintMigration));
    db.prepare(
      `INSERT INTO boxes_mirror (box_id, shift_id, sscc, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "historical-box",
      "s1",
      "004601234560000017",
      "2026-07-29T10:00:00.000Z",
      "2026-07-29T10:05:00.000Z",
    );

    for (const stmt of STATION_MIGRATIONS.slice(firstPrintMigration)) {
      db.exec(stmt);
    }

    expect(
      db
        .prepare("SELECT print_state, print_error_code FROM boxes_mirror WHERE box_id = ?")
        .get("historical-box"),
    ).toEqual({ print_state: "legacy", print_error_code: null });
  });

  it("round-trips boxes_mirror.disassembled_at and box_exceptions_mirror", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO boxes_mirror (box_id, shift_id, opened_at, disassembled_at)
       VALUES (?, ?, ?, ?)`,
    ).run("b1", "s1", "2026-07-30T00:00:00.000Z", "2026-07-30T00:05:00.000Z");

    const box = db
      .prepare("SELECT disassembled_at FROM boxes_mirror WHERE box_id = ?")
      .get("b1") as
      | {
          disassembled_at: string;
        }
      | undefined;

    expect(box?.disassembled_at).toBe("2026-07-30T00:05:00.000Z");

    db.prepare(
      `INSERT INTO box_exceptions_mirror (kind, box_id, shift_id, at)
       VALUES (?, ?, ?, ?)`,
    ).run("clear", "b1", "s1", "2026-07-30T00:06:00.000Z");

    const rows = db.prepare("SELECT * FROM box_exceptions_mirror").all() as Array<{ id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
  });

  it("applies exception facts and local box mutations atomically through triggers", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO boxes_mirror (box_id, shift_id, opened_at, closed_at)
       VALUES (?, ?, ?, ?)`,
    ).run("b1", "s1", "2026-07-30T00:00:00.000Z", "2026-07-30T00:01:00.000Z");
    db.prepare(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
       VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
    ).run(
      "h1",
      "s1",
      "04600000000015",
      "a",
      "2026-07-30T00:00:00.000Z",
      "b1",
      "h2",
      "s1",
      "04600000000015",
      "b",
      "2026-07-30T00:00:01.000Z",
      "b1",
    );

    db.prepare(
      `INSERT INTO box_exceptions_mirror (kind, box_id, shift_id, reason, at)
       VALUES ('disassemble', ?, ?, ?, ?)`,
    ).run("b1", "s1", "wrong customer", "2026-07-30T00:02:00.000Z");

    expect(db.prepare("SELECT code_hash FROM codes_mirror WHERE box_id = 'b1'").all()).toEqual([]);
    expect(
      db.prepare("SELECT disassembled_at FROM boxes_mirror WHERE box_id = 'b1'").get(),
    ).toEqual({ disassembled_at: "2026-07-30T00:02:00.000Z" });
    expect(db.prepare("SELECT kind FROM box_exceptions_mirror").all()).toEqual([
      { kind: "disassemble" },
    ]);
  });

  it("rejects invalid exception payloads before local mutation triggers run", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO boxes_mirror (box_id, shift_id, opened_at)
       VALUES ('b1', 's1', '2026-07-30T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO codes_mirror (code_hash, shift_id, gtin14, serial, scanned_at, box_id)
       VALUES ('h1', 's1', '04600000000015', 'a', '2026-07-30T00:00:00.000Z', 'b1')`,
    ).run();

    const insert = db.prepare(
      `INSERT INTO box_exceptions_mirror (kind, box_id, code_hash, shift_id, reason, at)
       VALUES (?, 'b1', ?, 's1', ?, '2026-07-30T00:01:00.000Z')`,
    );
    for (const values of [
      ["undo", null, null],
      ["clear", null, "unexpected"],
      ["disassemble", null, null],
      ["reprint", "h1", "damaged"],
    ]) {
      expect(() => insert.run(...values)).toThrow(/constraint/i);
    }

    expect(db.prepare("SELECT kind FROM box_exceptions_mirror").all()).toEqual([]);
    expect(db.prepare("SELECT code_hash FROM codes_mirror").all()).toEqual([{ code_hash: "h1" }]);
    expect(
      db.prepare("SELECT disassembled_at FROM boxes_mirror WHERE box_id = 'b1'").get(),
    ).toEqual({
      disassembled_at: null,
    });
  });
});
