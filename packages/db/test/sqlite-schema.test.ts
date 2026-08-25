import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATION_MIGRATION_ENTRIES,
  STATION_MIGRATIONS,
  SUPERSEDED_INVENTORY_LEGACY_AUDIT_MIGRATION_IDS,
} from "../src/sqlite/migrations.js";
import {
  inventoryCodeResultsMirror,
  inventoryConflictsMirror,
  inventoryEventClaimOutcomesMirror,
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
  const columns = db.prepare("PRAGMA table_info(inventory_scan_events_mirror)").all() as Array<{
    name: string;
  }>;
  const finalLegacyAuditExists = columns.some((column) => column.name === "legacy_audit_version");
  const commitStateAlreadyExisted = columns.some((column) => column.name === "commit_state");
  const skipLegacyAudits = finalLegacyAuditExists || commitStateAlreadyExisted;
  const supersededIds = new Set<string>(SUPERSEDED_INVENTORY_LEGACY_AUDIT_MIGRATION_IDS);
  applyStatements(
    db,
    STATION_MIGRATION_ENTRIES.filter(
      (migration) => !skipLegacyAudits || !supersededIds.has(migration.id),
    ).map((migration) => migration.sql),
  );
}

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyStationMigrations(db);
  return db;
}

describe("STATION_MIGRATIONS", () => {
  it("assigns unique append-only identities and names only the superseded audit steps", () => {
    expect(STATION_MIGRATION_ENTRIES.map((migration) => migration.id)).toEqual(
      STATION_MIGRATIONS.map(
        (_statement, index) => `station-sqlite-${String(index).padStart(3, "0")}`,
      ),
    );
    expect(new Set(STATION_MIGRATION_ENTRIES.map((migration) => migration.id)).size).toBe(
      STATION_MIGRATION_ENTRIES.length,
    );
    expect(SUPERSEDED_INVENTORY_LEGACY_AUDIT_MIGRATION_IDS).toEqual([
      "station-sqlite-078",
      "station-sqlite-079",
      "station-sqlite-081",
      "station-sqlite-082",
    ]);
  });

  it("creates and round-trips all ten inventory mirror tables with scanner indexes", () => {
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
      "inventory_event_claim_outcomes_mirror",
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
      `INSERT INTO inventory_event_claim_outcomes_mirror
         (inventory_id, snapshot_id, source_event_id, code_hash, status, winning_event_id,
          winning_device_id, winning_scanned_at, result_revision, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "inventory-1",
      "snapshot-1",
      "event-1",
      "b".repeat(64),
      "claimed",
      "event-1",
      "device-1",
      "2026-08-25T08:00:00.000Z",
      1,
      "2026-08-25T08:00:00.000Z",
    );
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
    expect(inventoryEventClaimOutcomesMirror).toBeDefined();
    expect(
      db
        .prepare("PRAGMA table_info(inventory_terminal_state)")
        .all()
        .some((column) => (column as { name?: string }).name === "progress_result_revision"),
    ).toBe(true);
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

  it("adds nullable duplicate chronology without inventing a legacy winner", () => {
    const chronologyMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN duplicate_winner_code_hash"),
    );
    expect(chronologyMigration).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, chronologyMigration));
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict, commit_state, legacy_audit_version)
       VALUES ('inventory-legacy', 'snapshot-legacy', 'duplicate-legacy', 'device-legacy', 1,
               'operator-legacy', '2026-08-25T08:00:00.000Z', 'item', 'item:legacy-hash',
               'legacy-hash', 'legacy-raw', '2026-08-20', 'duplicate', 'committed', 1)`,
    ).run();

    applyStatements(db, STATION_MIGRATIONS.slice(chronologyMigration));
    expect(
      db
        .prepare(
          `SELECT duplicate_winner_code_hash, duplicate_winner_event_id,
                  duplicate_winner_device_id, duplicate_winner_scanned_at
             FROM inventory_scan_events_mirror WHERE event_id = 'duplicate-legacy'`,
        )
        .get(),
    ).toEqual({
      duplicate_winner_code_hash: null,
      duplicate_winner_event_id: null,
      duplicate_winner_device_id: null,
      duplicate_winner_scanned_at: null,
    });
    expect(() => applyStationMigrations(db)).not.toThrow();
  });

  it("upgrades only exact legacy event/outbox pairs and compensates orphan projections", () => {
    const stateMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN commit_state"),
    );
    expect(stateMigration).toBeGreaterThan(0);

    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, stateMigration));
    const insertEvent = db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict)
       VALUES ('inventory-legacy', 'snapshot-legacy', ?, 'device-legacy', ?,
               'operator-legacy', ?, 'item', ?, ?, ?, '2026-08-20', ?)`,
    );
    insertEvent.run(
      "event-orphan",
      1,
      "2026-08-25T08:00:00.000Z",
      "item:orphan-hash",
      "orphan-hash",
      "orphan-raw",
      "expected",
    );
    insertEvent.run(
      "event-success",
      2,
      "2026-08-25T08:01:00.000Z",
      "item:success-hash",
      "success-hash",
      "success-raw",
      "expected",
    );
    insertEvent.run(
      "event-unknown",
      3,
      "2026-08-25T08:02:00.000Z",
      "item:unknown-hash",
      "unknown-hash",
      "unknown-raw",
      "unknown",
    );
    insertEvent.run(
      "event-mismatch",
      4,
      "2026-08-25T08:03:00.000Z",
      "item:mismatch-hash",
      "mismatch-hash",
      "mismatch-raw",
      "expected",
    );

    const insertProjection = db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification,
          origin_classification, updated_at)
       VALUES ('inventory-legacy', 'snapshot-legacy', ?, ?, 'device-legacy', ?,
               '2026-08-20', 'expected', 'expected', ?)`,
    );
    for (const [hash, eventId, scannedAt] of [
      ["orphan-hash", "event-orphan", "2026-08-25T08:00:00.000Z"],
      ["success-hash", "event-success", "2026-08-25T08:01:00.000Z"],
      ["mismatch-hash", "event-mismatch", "2026-08-25T08:03:00.000Z"],
    ] as const) {
      insertProjection.run(hash, eventId, scannedAt, scannedAt);
    }

    const insertOutbox = db.prepare(
      `INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES ('inventory-legacy', 'snapshot-legacy', ?, ?, ?, ?)`,
    );
    insertOutbox.run(
      "event-success",
      2,
      JSON.stringify({
        eventId: "event-success",
        deviceSequence: 2,
        operatorId: "operator-legacy",
        scannedAt: "2026-08-25T08:01:00.000Z",
        kind: "item",
        normalizedIdentity: "item:success-hash",
        codeHash: "success-hash",
        canonicalRaw: "success-raw",
        activeProductionDate: "2026-08-20",
        localVerdict: "expected",
      }),
      "2026-08-25T08:01:00.000Z",
    );
    insertOutbox.run(
      "event-unknown",
      3,
      JSON.stringify({
        eventId: "event-unknown",
        deviceSequence: 3,
        operatorId: "operator-legacy",
        scannedAt: "2026-08-25T08:02:00.000Z",
        kind: "item",
        normalizedIdentity: "item:unknown-hash",
        codeHash: "unknown-hash",
        canonicalRaw: "unknown-raw",
        activeProductionDate: "2026-08-20",
        localVerdict: "unknown",
      }),
      "2026-08-25T08:02:00.000Z",
    );
    insertOutbox.run(
      "event-mismatch",
      4,
      JSON.stringify({
        eventId: "event-mismatch",
        deviceSequence: 4,
        operatorId: "operator-legacy",
        scannedAt: "2026-08-25T08:03:00.000Z",
        kind: "item",
        normalizedIdentity: "item:different-hash",
        codeHash: "mismatch-hash",
        canonicalRaw: "mismatch-raw",
        activeProductionDate: "2026-08-20",
        localVerdict: "expected",
      }),
      "2026-08-25T08:03:00.000Z",
    );

    applyStatements(db, STATION_MIGRATIONS.slice(stateMigration));
    expect(() => applyStationMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT event_id, commit_state FROM inventory_scan_events_mirror ORDER BY device_sequence`,
        )
        .all(),
    ).toEqual([
      { event_id: "event-orphan", commit_state: "failed" },
      { event_id: "event-success", commit_state: "committed" },
      { event_id: "event-unknown", commit_state: "committed" },
      { event_id: "event-mismatch", commit_state: "failed" },
    ]);
    expect(
      db
        .prepare(
          `SELECT first_accepted_event_id FROM inventory_code_results_mirror
           ORDER BY first_accepted_event_id`,
        )
        .all(),
    ).toEqual([{ first_accepted_event_id: "event-success" }]);
  });

  it("re-audits orphan rows on devices that already applied the unsafe committed default", () => {
    const stateMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN commit_state"),
    );
    expect(stateMigration).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, stateMigration));
    db.exec(
      `ALTER TABLE inventory_scan_events_mirror
         ADD COLUMN commit_state TEXT NOT NULL DEFAULT 'committed'`,
    );
    db.prepare(
      `INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict)
       VALUES ('inventory-installed', 'snapshot-installed', 'event-installed-orphan',
               'device-installed', 1, 'operator-installed', '2026-08-25T08:00:00.000Z',
               'item', 'item:installed-hash', 'installed-hash', 'installed-raw',
               '2026-08-20', 'expected')`,
    ).run();
    db.prepare(
      `INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, observed_production_date, classification,
          origin_classification, updated_at)
       VALUES ('inventory-installed', 'snapshot-installed', 'installed-hash',
               'event-installed-orphan', 'device-installed', '2026-08-25T08:00:00.000Z',
               '2026-08-20', 'expected', 'expected', '2026-08-25T08:00:00.000Z')`,
    ).run();

    applyStatements(db, STATION_MIGRATIONS.slice(stateMigration));
    expect(db.prepare("SELECT commit_state FROM inventory_scan_events_mirror").get()).toEqual({
      commit_state: "failed",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_code_results_mirror").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  it("proves exact item and complete box projections before finalizing the legacy audit", () => {
    const stateMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN commit_state"),
    );
    expect(stateMigration).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, stateMigration));
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id)
       VALUES ('inventory-proof', 'INV-PROOF', 'snapshot-proof')`,
    ).run();

    const insertSnapshot = db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status, source_state,
          parent_sscc, expected, protected)
       VALUES ('snapshot-proof', ?, ?, '04600000000015', ?, ?, ?, ?, ?, ?)`,
    );
    const snapshot = (
      hash: string,
      parent: string | null,
      origin: "expected" | "protected" | "known-ineligible" = "expected",
    ) => {
      insertSnapshot.run(
        hash,
        `raw-${hash}`,
        hash,
        origin === "known-ineligible" ? "APPLIED" : "INTRODUCED",
        origin === "protected" ? "MOVING_BY_UD" : null,
        parent,
        origin === "expected" ? 1 : 0,
        origin === "protected" ? 1 : 0,
      );
    };
    const events: Array<{
      eventId: string;
      sequence: number;
      kind: "item" | "known_box";
      identity: string;
      codeHash: string | null;
      rawPayload: string;
      verdict: "expected" | "duplicate";
    }> = [];
    const addEvent = (event: (typeof events)[number]) => {
      events.push(event);
      const scannedAt = `2026-08-25T08:${String(event.sequence).padStart(2, "0")}:00.000Z`;
      db.prepare(
        `INSERT INTO inventory_scan_events_mirror
           (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
            scanned_at, kind, normalized_identity, code_hash, raw_payload,
            active_production_date, local_verdict)
         VALUES ('inventory-proof', 'snapshot-proof', ?, 'device-proof', ?, 'operator-proof',
                 ?, ?, ?, ?, ?, '2026-08-20', ?)`,
      ).run(
        event.eventId,
        event.sequence,
        scannedAt,
        event.kind,
        event.identity,
        event.codeHash,
        event.rawPayload,
        event.verdict,
      );
      db.prepare(
        `INSERT INTO inventory_outbox
           (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
         VALUES ('inventory-proof', 'snapshot-proof', ?, ?, ?, ?)`,
      ).run(
        event.eventId,
        event.sequence,
        JSON.stringify({
          eventId: event.eventId,
          deviceSequence: event.sequence,
          operatorId: "operator-proof",
          scannedAt,
          kind: event.kind,
          normalizedIdentity: event.identity,
          codeHash: event.codeHash,
          canonicalRaw: event.rawPayload,
          activeProductionDate: "2026-08-20",
          localVerdict: event.verdict,
        }),
        scannedAt,
      );
    };
    const addResult = (
      hash: string,
      eventId: string,
      sequence: number,
      origin: "expected" | "protected" | "known-ineligible" = "expected",
      classification = origin,
    ) => {
      const scannedAt = `2026-08-25T08:${String(sequence).padStart(2, "0")}:00.000Z`;
      db.prepare(
        `INSERT INTO inventory_code_results_mirror
           (inventory_id, snapshot_id, code_hash, first_accepted_event_id, winning_device_id,
            winning_scanned_at, observed_production_date, classification,
            origin_classification, updated_at)
         VALUES ('inventory-proof', 'snapshot-proof', ?, ?, 'device-proof', ?, '2026-08-20',
                 ?, ?, ?)`,
      ).run(hash, eventId, scannedAt, classification, origin, scannedAt);
    };

    addEvent({
      eventId: "item-wrong-hash",
      sequence: 1,
      kind: "item",
      identity: "item:item-right-hash",
      codeHash: "item-right-hash",
      rawPayload: "raw-item-right-hash",
      verdict: "expected",
    });
    addResult("item-foreign-hash", "item-wrong-hash", 1);

    addEvent({
      eventId: "item-wrong-classification",
      sequence: 2,
      kind: "item",
      identity: "item:item-class-hash",
      codeHash: "item-class-hash",
      rawPayload: "raw-item-class-hash",
      verdict: "expected",
    });
    addResult("item-class-hash", "item-wrong-classification", 2, "expected", "protected");

    const foreignBox = "111111111111111111";
    snapshot("foreign-owned-child", foreignBox);
    snapshot("foreign-extra-child", "999999999999999999");
    addEvent({
      eventId: "box-foreign-child",
      sequence: 3,
      kind: "known_box",
      identity: `known_box:${foreignBox}`,
      codeHash: null,
      rawPayload: foreignBox,
      verdict: "expected",
    });
    addResult("foreign-owned-child", "box-foreign-child", 3);
    addResult("foreign-extra-child", "box-foreign-child", 3);

    const partialBox = "222222222222222222";
    snapshot("partial-child-one", partialBox);
    snapshot("partial-child-two", partialBox);
    addEvent({
      eventId: "box-partial",
      sequence: 4,
      kind: "known_box",
      identity: `known_box:${partialBox}`,
      codeHash: null,
      rawPayload: partialBox,
      verdict: "expected",
    });
    addResult("partial-child-one", "box-partial", 4);

    const mixedBox = "333333333333333333";
    snapshot("mixed-expected", mixedBox, "expected");
    snapshot("mixed-protected", mixedBox, "protected");
    snapshot("mixed-ineligible", mixedBox, "known-ineligible");
    addEvent({
      eventId: "box-mixed-valid",
      sequence: 5,
      kind: "known_box",
      identity: `known_box:${mixedBox}`,
      codeHash: null,
      rawPayload: mixedBox,
      verdict: "expected",
    });
    addResult("mixed-expected", "box-mixed-valid", 5, "expected");
    addResult("mixed-protected", "box-mixed-valid", 5, "protected");
    addResult("mixed-ineligible", "box-mixed-valid", 5, "known-ineligible");
    addEvent({
      eventId: "box-mixed-duplicate",
      sequence: 6,
      kind: "known_box",
      identity: `known_box:${mixedBox}`,
      codeHash: null,
      rawPayload: mixedBox,
      verdict: "duplicate",
    });
    addEvent({
      eventId: "item-extra-projection",
      sequence: 7,
      kind: "item",
      identity: "item:item-extra-right",
      codeHash: "item-extra-right",
      rawPayload: "raw-item-extra-right",
      verdict: "expected",
    });
    addResult("item-extra-right", "item-extra-projection", 7);
    addResult("item-extra-foreign", "item-extra-projection", 7);

    applyStatements(db, STATION_MIGRATIONS.slice(stateMigration));
    expect(
      db
        .prepare(
          `SELECT event_id, commit_state, legacy_audit_version
             FROM inventory_scan_events_mirror
           ORDER BY device_sequence`,
        )
        .all(),
    ).toEqual([
      { event_id: "item-wrong-hash", commit_state: "failed", legacy_audit_version: 1 },
      {
        event_id: "item-wrong-classification",
        commit_state: "failed",
        legacy_audit_version: 1,
      },
      { event_id: "box-foreign-child", commit_state: "failed", legacy_audit_version: 1 },
      { event_id: "box-partial", commit_state: "failed", legacy_audit_version: 1 },
      { event_id: "box-mixed-valid", commit_state: "committed", legacy_audit_version: 1 },
      { event_id: "box-mixed-duplicate", commit_state: "committed", legacy_audit_version: 1 },
      { event_id: "item-extra-projection", commit_state: "failed", legacy_audit_version: 1 },
    ]);
    expect(
      db
        .prepare(
          `SELECT code_hash, first_accepted_event_id FROM inventory_code_results_mirror
           ORDER BY code_hash`,
        )
        .all(),
    ).toEqual([
      { code_hash: "mixed-expected", first_accepted_event_id: "box-mixed-valid" },
      { code_hash: "mixed-ineligible", first_accepted_event_id: "box-mixed-valid" },
      { code_hash: "mixed-protected", first_accepted_event_id: "box-mixed-valid" },
    ]);
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

  it("attributes a legacy staged mirror only when the strict active pointer matches its identity", () => {
    const ownershipMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN credential_ownership"),
    );
    expect(ownershipMigration).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, ownershipMigration));
    const owner = "a".repeat(64);
    const inventoryId = "11111111-1111-4111-8111-111111111111";
    const snapshotId = "22222222-2222-4222-8222-222222222222";
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, staged_snapshot_id)
       VALUES (?, ?, ?)`,
    ).run(inventoryId, "INV-STAGED", snapshotId);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          expected, protected)
       VALUES (?, ?, 'raw', '04600000000015', 'SERIAL', 'available', 1, 0)`,
    ).run(snapshotId, "c".repeat(64));
    db.prepare("INSERT INTO station_meta (key, value) VALUES (?, ?)").run(
      "active_inventory_floor_task_v1",
      JSON.stringify({ inventoryId, snapshotId, credentialOwnership: owner }),
    );

    applyStatements(db, STATION_MIGRATIONS.slice(ownershipMigration));

    expect(
      db
        .prepare(
          `SELECT staged_snapshot_id, credential_ownership
             FROM inventory_task_mirror WHERE inventory_id = ?`,
        )
        .get(inventoryId),
    ).toEqual({ staged_snapshot_id: snapshotId, credential_ownership: owner });
    expect(db.prepare("SELECT snapshot_id FROM inventory_snapshot_codes_mirror").all()).toEqual([
      { snapshot_id: snapshotId },
    ]);
  });

  it("does not attribute a shaped pointer whose task identities are not strict UUIDs", () => {
    const ownershipMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN credential_ownership"),
    );
    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, ownershipMigration));
    const inventoryId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    const snapshotId = "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy";
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, staged_snapshot_id)
       VALUES (?, 'INV-INVALID', ?)`,
    ).run(inventoryId, snapshotId);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          expected, protected)
       VALUES (?, ?, 'raw', '04600000000015', 'SERIAL', 'available', 1, 0)`,
    ).run(snapshotId, "f".repeat(64));
    db.prepare("INSERT INTO station_meta (key, value) VALUES (?, ?)").run(
      "active_inventory_floor_task_v1",
      JSON.stringify({
        inventoryId,
        snapshotId,
        credentialOwnership: "a".repeat(64),
      }),
    );

    applyStatements(db, STATION_MIGRATIONS.slice(ownershipMigration));

    expect(
      db
        .prepare(
          `SELECT staged_snapshot_id, credential_ownership
             FROM inventory_task_mirror WHERE inventory_id = ?`,
        )
        .get(inventoryId),
    ).toEqual({ staged_snapshot_id: null, credential_ownership: null });
    expect(db.prepare("SELECT * FROM inventory_snapshot_codes_mirror").all()).toEqual([]);
  });

  it("purges only unowned inactive staging while preserving active and newer-owner data", () => {
    const ownershipMigration = STATION_MIGRATIONS.findIndex((statement) =>
      statement.includes("ADD COLUMN credential_ownership"),
    );
    expect(ownershipMigration).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    applyStatements(db, STATION_MIGRATIONS.slice(0, ownershipMigration));
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id, staged_snapshot_id)
       VALUES ('inventory-legacy', 'INV-LEGACY', 'snapshot-active', 'snapshot-orphan')`,
    ).run();
    for (const [snapshotId, codeHash] of [
      ["snapshot-active", "a".repeat(64)],
      ["snapshot-orphan", "b".repeat(64)],
    ] as const) {
      db.prepare(
        `INSERT INTO inventory_snapshot_codes_mirror
           (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
            expected, protected)
         VALUES (?, ?, 'raw', '04600000000015', 'SERIAL', 'available', 1, 0)`,
      ).run(snapshotId, codeHash);
    }
    applyStatements(db, STATION_MIGRATIONS.slice(ownershipMigration, ownershipMigration + 1));
    const newerOwner = "d".repeat(64);
    const newerInventoryId = "33333333-3333-4333-8333-333333333333";
    const newerSnapshotId = "44444444-4444-4444-8444-444444444444";
    db.prepare(
      `INSERT INTO inventory_task_mirror
         (inventory_id, inventory_number, active_snapshot_id, credential_ownership)
       VALUES (?, 'INV-NEW', ?, ?)`,
    ).run(newerInventoryId, newerSnapshotId, newerOwner);
    db.prepare(
      `INSERT INTO inventory_snapshot_codes_mirror
         (snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
          expected, protected)
       VALUES (?, ?, 'raw', '04600000000015', 'SERIAL', 'available', 1, 0)`,
    ).run(newerSnapshotId, "e".repeat(64));
    const newerPointer = JSON.stringify({
      inventoryId: newerInventoryId,
      snapshotId: newerSnapshotId,
      credentialOwnership: newerOwner,
      activationId: "newer-activation",
    });
    db.prepare("INSERT INTO station_meta (key, value) VALUES (?, ?)").run(
      "active_inventory_floor_task_v1",
      newerPointer,
    );

    const recoveryMigrations = STATION_MIGRATIONS.slice(ownershipMigration + 1);
    applyStatements(db, recoveryMigrations);
    applyStatements(db, recoveryMigrations);

    expect(
      db
        .prepare(
          `SELECT inventory_id, active_snapshot_id, staged_snapshot_id, credential_ownership
             FROM inventory_task_mirror ORDER BY inventory_id`,
        )
        .all(),
    ).toEqual([
      {
        inventory_id: newerInventoryId,
        active_snapshot_id: newerSnapshotId,
        staged_snapshot_id: null,
        credential_ownership: newerOwner,
      },
      {
        inventory_id: "inventory-legacy",
        active_snapshot_id: "snapshot-active",
        staged_snapshot_id: null,
        credential_ownership: null,
      },
    ]);
    expect(
      db
        .prepare("SELECT snapshot_id FROM inventory_snapshot_codes_mirror ORDER BY snapshot_id")
        .all(),
    ).toEqual([{ snapshot_id: newerSnapshotId }, { snapshot_id: "snapshot-active" }]);
    expect(
      db
        .prepare("SELECT value FROM station_meta WHERE key = ?")
        .get("active_inventory_floor_task_v1"),
    ).toEqual({ value: newerPointer });
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
