import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
import {
  inventoryCodeResultsMirror,
  inventoryConflictsMirror,
  inventoryOutbox,
  inventoryRepackBoxesMirror,
  inventoryRepackItemsMirror,
  inventoryScanEventsMirror,
  inventorySnapshotCodesMirror,
  inventoryTaskMirror,
  inventoryTerminalState,
  shiftMirror,
} from "../src/sqlite/schema.js";

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
  it("creates and round-trips all nine inventory mirror tables with scanner indexes", () => {
    const db = migratedDb();
    const expectedTables = [
      "inventory_task_mirror",
      "inventory_snapshot_codes_mirror",
      "inventory_terminal_state",
      "inventory_code_results_mirror",
      "inventory_scan_events_mirror",
      "inventory_outbox",
      "inventory_repack_boxes_mirror",
      "inventory_repack_items_mirror",
      "inventory_conflicts_mirror",
    ];
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'inventory_%'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([...expectedTables].sort());

    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision,
          active_combined_digest, active_code_count, active_manifest_json, staging_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("inventory-1", "INV-1", "snapshot-1", 1, "a".repeat(64), 1, "{}", 1);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
          source_production_date, parent_sscc, expected, protected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "snapshot-1",
      "b".repeat(64),
      "010460000000001521SERIAL",
      "04600000000015",
      "SERIAL",
      "INTRODUCED",
      null,
      "2026-08-01",
      "004600000000000015",
      1,
      0,
    );
    db.prepare(
      `INSERT INTO inventory_terminal_state
         (inventory_id, snapshot_id, device_id, operator_id, active_production_date,
          source_parent_sscc, next_device_sequence, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "device-1",
      "operator-1",
      "2026-08-01",
      null,
      2,
      "2026-08-25T08:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification, origin_classification,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "b".repeat(64),
      "event-1",
      "device-1",
      "2026-08-25T08:00:00.000Z",
      "2026-08-01",
      "expected",
      "expected",
      "2026-08-25T08:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "event-1",
      "device-1",
      1,
      "operator-1",
      "2026-08-25T08:00:00.000Z",
      "item",
      "01...21...",
      "b".repeat(64),
      "010460000000001521SERIAL",
      "2026-08-01",
      "accepted",
    );
    db.prepare(
      `INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("inventory-1", "snapshot-1", "event-1", 1, '{"kind":"item"}', "2026-08-25T08:00:00.000Z");
    db.prepare(
      `INSERT INTO inventory_repack_boxes_mirror
         (inventory_id, snapshot_id, box_id, old_sscc_context, new_sscc, owner_device_id,
          capacity, production_date, state, print_state, print_attempt_count, opened_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "box-1",
      null,
      "004600000000000015",
      "device-1",
      12,
      "2026-08-01",
      "open",
      "not_ready",
      0,
      "2026-08-25T08:00:00.000Z",
      "2026-08-25T08:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO inventory_repack_items_mirror
         (inventory_id, snapshot_id, item_id, box_id, code_hash, production_date, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "item-1",
      "box-1",
      "b".repeat(64),
      "2026-08-01",
      "2026-08-25T08:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO inventory_conflicts_mirror
         (inventory_id, snapshot_id, conflict_id, code_hash, winning_event_id,
          winning_device_id, winning_scanned_at, detected_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "conflict-1",
      "b".repeat(64),
      "event-0",
      "device-2",
      "2026-08-25T07:59:00.000Z",
      "2026-08-25T08:00:00.000Z",
      "open",
    );

    expect(
      db.prepare("SELECT inventory_id, active_snapshot_id FROM inventory_task_mirror").get(),
    ).toEqual({ inventory_id: "inventory-1", active_snapshot_id: "snapshot-1" });
    for (const table of expectedTables.slice(1)) {
      expect(
        db.prepare(`SELECT snapshot_id FROM ${table} LIMIT 1`).get(),
        `${table} must retain its snapshot revision`,
      ).toEqual({ snapshot_id: "snapshot-1" });
    }

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'inventory_snapshot_codes_mirror'`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "inventory_snapshot_codes_mirror_parent_sscc_idx",
        "inventory_snapshot_codes_mirror_expected_date_idx",
      ]),
    );

    expect(inventoryTaskMirror).toBeDefined();
    expect(inventorySnapshotCodesMirror).toBeDefined();
    expect(inventoryTerminalState).toBeDefined();
    expect(inventoryCodeResultsMirror).toBeDefined();
    expect(inventoryScanEventsMirror).toBeDefined();
    expect(inventoryOutbox).toBeDefined();
    expect(inventoryRepackBoxesMirror).toBeDefined();
    expect(inventoryRepackItemsMirror).toBeDefined();
    expect(inventoryConflictsMirror).toBeDefined();
  });

  it("keeps the trailing inventory DDL rerunnable on an upgraded database", () => {
    const firstInventoryMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS inventory_task_mirror"),
    );
    expect(firstInventoryMigration).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, firstInventoryMigration));
    applyStatements(db, STATION_MIGRATIONS.slice(firstInventoryMigration));
    expect(() => applyStationMigrations(db)).not.toThrow();
  });

  it("adds durable content/order/page fences to an existing inventory mirror", () => {
    const firstInventoryMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS inventory_task_mirror"),
    );
    const contentFenceMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN active_snapshot_fixed_at"),
    );
    expect(contentFenceMigration).toBeGreaterThan(firstInventoryMigration);

    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, contentFenceMigration));
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id, active_snapshot_revision,
          active_combined_digest, active_code_count, active_manifest_json)
       VALUES ('inventory-1', 'INV-1', 'snapshot-1', 1, ?, 0, '{}')`,
    ).run("a".repeat(64));

    applyStatements(db, STATION_MIGRATIONS.slice(contentFenceMigration));
    expect(() => applyStationMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT active_snapshot_fixed_at, active_content_digest,
                  staged_snapshot_fixed_at, staged_content_digest,
                  staged_verified_content_digest, staged_last_page_digest, staged_page_json,
                  staged_reset_snapshot_id
             FROM inventory_task_mirror`,
        )
        .get(),
    ).toEqual({
      active_snapshot_fixed_at: null,
      active_content_digest: null,
      staged_snapshot_fixed_at: null,
      staged_content_digest: null,
      staged_verified_content_digest: null,
      staged_last_page_digest: null,
      staged_page_json: null,
      staged_reset_snapshot_id: null,
    });
  });

  it("adds credential ownership to an existing inventory mirror for scoped recovery cleanup", () => {
    const db = migratedDb();
    const columns = db.prepare("PRAGMA table_info(inventory_task_mirror)").all() as Array<{
      name: string;
    }>;

    expect(columns.map(({ name }) => name)).toContain("credential_ownership");
  });

  it("atomically removes only an explicitly reset inactive snapshot", () => {
    const db = migratedDb();
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id, staged_snapshot_id)
       VALUES ('inventory-1', 'INV-1', 'active-1', 'legacy-stage')`,
    ).run();
    for (const snapshotId of ["active-1", "legacy-stage"]) {
      db.prepare(
        `INSERT INTO inventory_snapshot_codes_mirror
           (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
            expected, protected)
         VALUES (?, ?, 'raw', '04600000000015', 'S', 'EMITTED', 0, 0)`,
      ).run(snapshotId, snapshotId === "active-1" ? "a".repeat(64) : "b".repeat(64));
    }

    db.prepare(
      `UPDATE inventory_task_mirror
          SET staged_snapshot_id = NULL, staged_reset_snapshot_id = 'legacy-stage'
        WHERE inventory_id = 'inventory-1'`,
    ).run();

    expect(
      db
        .prepare(
          "SELECT DISTINCT snapshot_id FROM inventory_snapshot_codes_mirror ORDER BY snapshot_id",
        )
        .all(),
    ).toEqual([{ snapshot_id: "active-1" }]);
  });

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

  it("mirrors the shift number", () => {
    expect(shiftMirror.number).toBeDefined();
    expect(shiftMirror.number.notNull).toBe(false);
  });

  it("mirrors a nullable shift production date", () => {
    expect(shiftMirror.productionDate).toBeDefined();
    expect(shiftMirror.productionDate.notNull).toBe(false);
  });

  it("migrates a legacy product row to a nullable print_name and survives a second migration run", () => {
    const db = new DatabaseSync(":memory:");
    const printNameMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ALTER TABLE product_mirror ADD COLUMN print_name"),
    );
    expect(printNameMigration).toBeGreaterThan(0);
    applyStatements(db, STATION_MIGRATIONS.slice(0, printNameMigration));
    db.prepare(
      `INSERT INTO product_mirror (id, gtin14, name, status)
       VALUES (?, ?, ?, ?)`,
    ).run("legacy-product", "04600000000015", "Сидр сухой газированный", "active");

    applyStatements(db, STATION_MIGRATIONS.slice(printNameMigration));

    const columns = db.prepare("PRAGMA table_info(product_mirror)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "print_name", notnull: 0 })]),
    );
    expect(
      db.prepare("SELECT print_name FROM product_mirror WHERE id = ?").get("legacy-product"),
    ).toEqual({ print_name: null });

    expect(() => db.exec(STATION_MIGRATIONS[printNameMigration] ?? "missing migration")).toThrow(
      /duplicate column name/i,
    );
    expect(() => applyStationMigrations(db)).not.toThrow();
  });

  it("migrates a legacy shift row to nullable production_date and survives a second migration run", () => {
    const db = new DatabaseSync(":memory:");
    const productionDateMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ALTER TABLE shift_mirror ADD COLUMN production_date"),
    );
    expect(productionDateMigration).toBeGreaterThan(0);
    applyStatements(db, STATION_MIGRATIONS.slice(0, productionDateMigration));
    db.prepare(
      `INSERT INTO shift_mirror (id, status, mode, product_id)
       VALUES (?, ?, ?, ?)`,
    ).run("legacy-shift", "active", "validation", "p1");

    applyStatements(db, STATION_MIGRATIONS.slice(productionDateMigration));

    const columns = db.prepare("PRAGMA table_info(shift_mirror)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "production_date", notnull: 0 })]),
    );
    expect(
      db.prepare("SELECT production_date FROM shift_mirror WHERE id = ?").get("legacy-shift"),
    ).toEqual({ production_date: null });

    expect(() =>
      db.exec(STATION_MIGRATIONS[productionDateMigration] ?? "missing migration"),
    ).toThrow(/duplicate column name/i);
    expect(() => applyStationMigrations(db)).not.toThrow();
    expect(
      db.prepare("SELECT production_date FROM shift_mirror WHERE id = ?").get("legacy-shift"),
    ).toEqual({ production_date: null });
  });

  it("adds shift_mirror.number via the trailing ALTER and survives a second migration run", () => {
    const db = new DatabaseSync(":memory:");
    applyStationMigrations(db);
    expect(() => applyStationMigrations(db)).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(shift_mirror)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const number = columns.find((c) => c.name === "number");
    expect(number).toBeDefined();
    expect(number?.notnull).toBe(0);
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
