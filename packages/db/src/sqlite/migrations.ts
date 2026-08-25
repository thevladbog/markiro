/**
 * Ordered SQLite DDL applied by the station at startup (Task 9) via
 * tauri-plugin-sql. This array is the source of truth for the on-device
 * schema and MUST stay in sync with ./schema.ts; the sqlite-schema test
 * (test/sqlite-schema.test.ts) applies these and round-trips a row to catch
 * drift. `drizzle.sqlite.config.ts` exists for regeneration parity only.
 */
export const STATION_MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS station_meta (
     key TEXT PRIMARY KEY,
     value TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS operators_mirror (
     operator_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     login TEXT,
     role TEXT NOT NULL,
     pin_hash TEXT NOT NULL,
     badge_hash TEXT,
     active INTEGER NOT NULL DEFAULT 1
   );`,
  `CREATE TABLE IF NOT EXISTS operators_mirror_b (
     operator_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     login TEXT,
     role TEXT NOT NULL,
     pin_hash TEXT NOT NULL,
     badge_hash TEXT,
     active INTEGER NOT NULL DEFAULT 1
   );`,
  `CREATE TABLE IF NOT EXISTS shift_mirror (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     mode TEXT NOT NULL,
     product_id TEXT NOT NULL,
     product_name TEXT,
     line_id TEXT,
     line_name TEXT,
     counterparty_id TEXT,
     counterparty_name TEXT,
     counterparty_gln TEXT,
     label_template_id TEXT,
     label_template_name TEXT,
     label_template_spec TEXT,
     planned_qty INTEGER,
     planned_date TEXT,
     box_capacity INTEGER,
     pallet_capacity INTEGER,
     pallets_enabled INTEGER NOT NULL DEFAULT 0,
     opened_at TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS product_mirror (
     id TEXT PRIMARY KEY,
     gtin14 TEXT NOT NULL,
     name TEXT NOT NULL,
     product_group TEXT,
     box_capacity INTEGER,
     pallet_capacity INTEGER,
     status TEXT NOT NULL,
     default_counterparty_id TEXT,
     default_label_template_id TEXT,
     image_checksum TEXT,
     image_content_type TEXT,
     image_byte_size INTEGER,
     image_width INTEGER,
     image_height INTEGER,
     image_pointer_checksum TEXT
   );`,
  // Browser Cache Storage is not a reliable persistence boundary in every
  // Windows WebView2 runtime. Keep validated, content-addressed product
  // images in the station's own SQLite database so offline photos survive
  // restarts independently of browser storage support.
  `CREATE TABLE IF NOT EXISTS station_product_images (
     checksum TEXT PRIMARY KEY,
     content_type TEXT NOT NULL,
     byte_size INTEGER NOT NULL,
     bytes_base64 TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS codes_mirror (
     code_hash TEXT PRIMARY KEY,
     shift_id TEXT NOT NULL,
     gtin14 TEXT NOT NULL,
     serial TEXT NOT NULL,
     scanned_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS scan_events_mirror (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     raw TEXT NOT NULL,
     verdict TEXT NOT NULL,
     scanned_at TEXT NOT NULL
   );`,
  // AUTOINCREMENT is load-bearing, not decoration: an ordinary SQLite rowid is
  // reused after a delete, so once plan 09 purges rows a new scan could receive
  // an id below one already acknowledged. The outbox must preserve order and
  // never reuse ids, so every row must have a stable handle for the server.
  `CREATE TABLE IF NOT EXISTS outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     raw TEXT NOT NULL,
     verdict TEXT NOT NULL,
     scanned_at TEXT NOT NULL,
     code_hash TEXT,
     gtin14 TEXT,
     serial TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS conflicts_mirror (
     code_hash TEXT PRIMARY KEY,
     winning_terminal_id TEXT,
     winning_scanned_at TEXT NOT NULL,
     detected_at TEXT NOT NULL
   );`,
  // The device's local SSCC serial pool (Task 8, plan 06c): ranges the server
  // handed down for this device's own issuer prefix, burned one serial at a
  // time by apps/station/src/lib/sscc-pool.ts. The primary key on
  // (issuer_prefix, extension_digit, from_serial) is what makes a replayed
  // bundle harmless -- the same block cannot be inserted twice, so a retried
  // sync can never double the pool.
  `CREATE TABLE IF NOT EXISTS sscc_pool (
     issuer_prefix TEXT NOT NULL,
     extension_digit INTEGER NOT NULL,
     from_serial INTEGER NOT NULL,
     to_serial INTEGER NOT NULL,
     next_serial INTEGER NOT NULL,
     PRIMARY KEY (issuer_prefix, extension_digit, from_serial)
   );`,
  // The device's local mirror of transport boxes (Task 9, plan 06c): one row
  // per box this device has opened, keyed by boxId so a replayed sync bundle
  // stays idempotent. Membership of a scanned code in a box is a column on
  // `codes_mirror` (see the ALTER below), not a join table -- see
  // apps/station/src/lib/journal.ts's recordScan doc comment for why a
  // fourth write was rejected in favour of riding the insert already there.
  // `acked_at` is what stops a closed box being resent for the rest of the
  // shift once the sync engine sets it (Task 11); `print_verified_at` and
  // `print_skipped_at` are set once the label has been printed or the
  // operator explicitly skipped printing.
  `CREATE TABLE IF NOT EXISTS boxes_mirror (
     box_id TEXT PRIMARY KEY,
     shift_id TEXT NOT NULL,
     sscc TEXT,
     opened_at TEXT NOT NULL,
     closed_at TEXT,
     closed_by TEXT,
     acked_at TEXT,
     print_verified_at TEXT,
     print_skipped_at TEXT
   );`,
  // Upgrade path for devices enrolled before operators had a personnel number.
  // SQLite has no `ADD COLUMN IF NOT EXISTS`, and applyMigrations re-runs every
  // statement on each boot, so this throws "duplicate column name" once the
  // column exists — applyMigrations swallows exactly that error.
  `ALTER TABLE operators_mirror ADD COLUMN login TEXT;`,
  // Upgrade path for devices enrolled before boxes existed (Task 9, plan
  // 06c): box membership rides the code/outbox insert already there rather
  // than a fourth write, and operator attribution threads through the same
  // two rows. Same re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE codes_mirror ADD COLUMN box_id TEXT;`,
  `ALTER TABLE outbox ADD COLUMN box_id TEXT;`,
  `ALTER TABLE outbox ADD COLUMN operator_id TEXT;`,
  `ALTER TABLE scan_events_mirror ADD COLUMN operator_id TEXT;`,
  // Upgrade path for devices enrolled before boxes captured their own
  // terminal (Task 11, plan 06c): a closure must report the box's own
  // shift/terminal from THIS row, never from whatever the device considers
  // "current" at drain time, because deviceId/terminalId lives in
  // station.json and can change (re-enrollment) independently of this
  // SQLite mirror, and a box can still be open when that happens. Same
  // re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE boxes_mirror ADD COLUMN terminal_id TEXT;`,
  // Upgrade path for devices enrolled before the box UI existed (Task 13
  // review, plan 06c): `StationBundle.sscc.issuerPrefix` is fetched with
  // every bundle but, until this column, had no durable home -- the device
  // only ever held it in memory for the lifetime of the download. Written
  // by `upsertBundle` alongside `box_capacity` (null for a validation-mode
  // shift, or when the server could not resolve this device an issuer
  // prefix -- never a fallback), and read back by `readShiftMirror` the same
  // way. Same re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE shift_mirror ADD COLUMN issuer_prefix TEXT;`,
  // CodeRabbit PR33 review, Finding 3: the box label's OWN template spec,
  // entirely separate from `label_template_spec` above (the ITEM template).
  // Before this column, `getBundle` never even resolved
  // `shift.boxLabelTemplateId` server-side, so the station had nothing to
  // mirror here and its box-printing path (WorkScreen.tsx) fell back to the
  // item template -- printing the wrong label on every box, or nothing at
  // all when only a box template was configured. Written by `upsertBundle`
  // alongside the other shift_mirror columns; read back by `readShiftMirror`
  // the same way. Same re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE shift_mirror ADD COLUMN box_label_template_spec TEXT;`,
  `ALTER TABLE product_mirror ADD COLUMN image_checksum TEXT;`,
  `ALTER TABLE product_mirror ADD COLUMN image_content_type TEXT;`,
  `ALTER TABLE product_mirror ADD COLUMN image_byte_size INTEGER;`,
  `ALTER TABLE product_mirror ADD COLUMN image_width INTEGER;`,
  `ALTER TABLE product_mirror ADD COLUMN image_height INTEGER;`,
  `ALTER TABLE product_mirror ADD COLUMN image_pointer_checksum TEXT;`,
  `ALTER TABLE shift_mirror ADD COLUMN station_close_policy TEXT;`,
  `ALTER TABLE shift_mirror ADD COLUMN station_close_owner_device_id TEXT;`,
  // Human-readable shift number (`AUG26-003`, `/S` = station-created),
  // composed server-side and mirrored for offline display. Nullable: absent
  // from bundles served by pre-upgrade servers, and from any local row
  // written before this column existed until the next successful bundle
  // sync. Written by `upsertBundle` alongside the other shift_mirror
  // columns; read back by `readShiftContext`. Same re-runnable idempotency
  // as the `login` ALTER above.
  `ALTER TABLE shift_mirror ADD COLUMN number TEXT;`,
  `CREATE TABLE IF NOT EXISTS shift_close_outbox (
     event_id TEXT PRIMARY KEY,
     shift_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     operator_id TEXT,
     product_id TEXT NOT NULL,
     product_name TEXT NOT NULL,
     planned_qty_snapshot INTEGER,
     actual_qty INTEGER NOT NULL,
     closed_box_count INTEGER NOT NULL,
     reason_code TEXT,
     closed_at TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     conflict_code TEXT,
     last_checked_at TEXT
   );`,
  // Older devices could admit two close attempts before this constraint
  // existed. Keep the first durable fact for each shift, then make the
  // one-close-event invariant enforceable across processes and restarts.
  `DELETE FROM shift_close_outbox
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM shift_close_outbox GROUP BY shift_id
    );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shift_close_outbox_shift_id_uq
     ON shift_close_outbox (shift_id);`,
  // Station exceptions (undo/clear/reprint/disassemble): the box's own
  // retired flag. Upgrade path for devices enrolled before this slice --
  // same re-runnable idempotency as the `login` ALTER above (SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, and applyMigrations swallows the resulting
  // "duplicate column name" once the column already exists).
  `ALTER TABLE boxes_mirror ADD COLUMN disassembled_at TEXT;`,
  // The device-local queue for exception facts, drained the same
  // read-unacked -> send -> ack-by-hard-delete way the outbox already is
  // (outbox.ts's readBatch/ackThrough) -- these rows are pure facts, never
  // updated in place after insert, so they need no boxes_mirror-style
  // acked_at flag or content signature: a plain monotonic id ceiling is
  // enough (see sync.ts's box-exceptions read/ack functions).
  `CREATE TABLE IF NOT EXISTS box_exceptions_mirror (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     box_id TEXT NOT NULL,
     code_hash TEXT,
     target_scanned_at TEXT,
     shift_id TEXT NOT NULL,
     terminal_id TEXT,
     operator_id TEXT,
     reason TEXT,
     at TEXT NOT NULL,
     CHECK (
       (kind = 'undo' AND code_hash IS NOT NULL AND target_scanned_at IS NOT NULL AND reason IS NULL)
       OR (kind = 'clear' AND code_hash IS NULL AND target_scanned_at IS NULL AND reason IS NULL)
       OR (kind IN ('disassemble', 'reprint') AND code_hash IS NULL AND target_scanned_at IS NULL AND reason IS NOT NULL)
      )
    );`,
  `ALTER TABLE box_exceptions_mirror ADD COLUMN target_scanned_at TEXT;`,
  // One INSERT is the atomic unit available through tauri-plugin-sql's pool.
  // Keep the durable exception fact and its local state transition in that
  // same SQLite statement so a crash cannot leave only one side applied.
  `DROP TRIGGER IF EXISTS box_exception_undo_local;`,
  `CREATE TRIGGER box_exception_undo_local
     AFTER INSERT ON box_exceptions_mirror
     WHEN NEW.kind = 'undo'
     BEGIN
       DELETE FROM codes_mirror
        WHERE code_hash = NEW.code_hash
          AND box_id = NEW.box_id
          AND scanned_at = NEW.target_scanned_at;
      END;`,
  `CREATE TRIGGER IF NOT EXISTS box_exception_clear_local
     AFTER INSERT ON box_exceptions_mirror
     WHEN NEW.kind = 'clear'
     BEGIN
       DELETE FROM codes_mirror WHERE box_id = NEW.box_id;
     END;`,
  `CREATE TRIGGER IF NOT EXISTS box_exception_disassemble_local
     AFTER INSERT ON box_exceptions_mirror
     WHEN NEW.kind = 'disassemble'
     BEGIN
       DELETE FROM codes_mirror WHERE box_id = NEW.box_id;
       UPDATE boxes_mirror SET disassembled_at = NEW.at WHERE box_id = NEW.box_id;
     END;`,
  // Durable box-label recovery. These must remain trailing ALTERs rather
  // than changing CREATE TABLE: installed stations already have boxes_mirror,
  // and their historical rows must migrate to `legacy`, never `pending`.
  `ALTER TABLE boxes_mirror ADD COLUMN print_state TEXT NOT NULL DEFAULT 'legacy';`,
  `ALTER TABLE boxes_mirror ADD COLUMN print_error_code TEXT;`,
  // Box-label «Код ЕГАИС» / «Годен до» inputs mirrored off the shift bundle
  // (spec 2026-08-20). Same re-runnable idempotency as the `login` ALTER above.
  `ALTER TABLE product_mirror ADD COLUMN egais_code TEXT;`,
  `ALTER TABLE product_mirror ADD COLUMN shelf_life_days INTEGER;`,
  // Optional shift production date. This must remain a trailing ALTER:
  // deployed stations already have shift_mirror, and CREATE TABLE IF NOT
  // EXISTS cannot upgrade their existing database.
  `ALTER TABLE shift_mirror ADD COLUMN production_date TEXT;`,
  // Optional short product name for the shift card and, in a follow-up,
  // label rendering (spec 2026-08-21). Trailing ALTER for the same reason.
  `ALTER TABLE product_mirror ADD COLUMN print_name TEXT;`,
  // Inventory v1 is an additive, deployed-device upgrade. Keep all nine
  // architecture tables and their indexes trailing and rerunnable. Active and
  // staged manifest fields intentionally coexist: a partial new download must
  // not overwrite the currently published scanner contract.
  `CREATE TABLE IF NOT EXISTS inventory_task_mirror (
     inventory_id TEXT PRIMARY KEY,
     inventory_number TEXT NOT NULL,
     active_snapshot_id TEXT,
     active_snapshot_revision INTEGER,
     active_combined_digest TEXT,
     active_code_count INTEGER,
     active_manifest_json TEXT,
     staged_snapshot_id TEXT,
     staged_snapshot_revision INTEGER,
     staged_combined_digest TEXT,
     staged_code_count INTEGER,
     staged_manifest_json TEXT,
     staged_next_cursor TEXT,
     staged_verified_digest TEXT,
     staging_generation INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS inventory_snapshot_codes_mirror (
     snapshot_id TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     canonical_raw TEXT NOT NULL,
     gtin14 TEXT NOT NULL,
     serial TEXT NOT NULL,
     source_status TEXT NOT NULL,
     source_state TEXT,
     source_production_date TEXT,
     parent_sscc TEXT,
     expected INTEGER NOT NULL,
     protected INTEGER NOT NULL,
     PRIMARY KEY (snapshot_id, code_hash)
   );`,
  `CREATE INDEX IF NOT EXISTS inventory_snapshot_codes_mirror_parent_sscc_idx
     ON inventory_snapshot_codes_mirror (snapshot_id, parent_sscc);`,
  `CREATE INDEX IF NOT EXISTS inventory_snapshot_codes_mirror_expected_date_idx
     ON inventory_snapshot_codes_mirror (snapshot_id, expected, source_production_date);`,
  `CREATE TABLE IF NOT EXISTS inventory_terminal_state (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     operator_id TEXT,
     active_production_date TEXT,
     source_parent_sscc TEXT,
     open_repack_box_id TEXT,
     next_device_sequence INTEGER NOT NULL DEFAULT 1,
     progress_cursor TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, device_id)
   );`,
  `CREATE TABLE IF NOT EXISTS inventory_code_results_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     first_accepted_event_id TEXT NOT NULL,
     winning_device_id TEXT NOT NULL,
     winning_scanned_at TEXT NOT NULL,
     observed_production_date TEXT,
     classification TEXT NOT NULL,
     origin_classification TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, code_hash)
   );`,
  `CREATE TABLE IF NOT EXISTS inventory_scan_events_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     device_sequence INTEGER NOT NULL,
     operator_id TEXT NOT NULL,
     scanned_at TEXT NOT NULL,
     kind TEXT NOT NULL,
     normalized_identity TEXT NOT NULL,
     code_hash TEXT,
     raw_payload TEXT,
     active_production_date TEXT,
     local_verdict TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, event_id)
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_scan_events_mirror_device_sequence_uq
     ON inventory_scan_events_mirror
        (inventory_id, snapshot_id, device_id, device_sequence);`,
  `CREATE TABLE IF NOT EXISTS inventory_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     device_sequence INTEGER NOT NULL,
     payload_json TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_outbox_event_uq
     ON inventory_outbox (inventory_id, snapshot_id, event_id);`,
  `CREATE INDEX IF NOT EXISTS inventory_outbox_sequence_idx
     ON inventory_outbox (inventory_id, snapshot_id, device_sequence);`,
  `CREATE TABLE IF NOT EXISTS inventory_repack_boxes_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     box_id TEXT NOT NULL,
     old_sscc_context TEXT,
     new_sscc TEXT NOT NULL,
     owner_device_id TEXT NOT NULL,
     capacity INTEGER NOT NULL,
     production_date TEXT NOT NULL,
     state TEXT NOT NULL,
     print_state TEXT NOT NULL,
     print_attempt_count INTEGER NOT NULL DEFAULT 0,
     print_error_code TEXT,
     opened_at TEXT NOT NULL,
     closed_at TEXT,
     invalidated_at TEXT,
     printed_at TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, box_id)
   );`,
  `CREATE INDEX IF NOT EXISTS inventory_repack_boxes_mirror_owner_state_idx
     ON inventory_repack_boxes_mirror
        (inventory_id, snapshot_id, owner_device_id, state);`,
  `CREATE TABLE IF NOT EXISTS inventory_repack_items_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     box_id TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     production_date TEXT NOT NULL,
     added_at TEXT NOT NULL,
     removed_at TEXT,
     PRIMARY KEY (inventory_id, snapshot_id, item_id)
   );`,
  `CREATE INDEX IF NOT EXISTS inventory_repack_items_mirror_box_active_idx
     ON inventory_repack_items_mirror (inventory_id, snapshot_id, box_id, removed_at);`,
  `CREATE TABLE IF NOT EXISTS inventory_conflicts_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     conflict_id TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     losing_event_id TEXT,
     winning_event_id TEXT NOT NULL,
     winning_device_id TEXT NOT NULL,
     winning_scanned_at TEXT NOT NULL,
     detected_at TEXT NOT NULL,
     state TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, conflict_id)
   );`,
  `CREATE INDEX IF NOT EXISTS inventory_conflicts_mirror_state_idx
     ON inventory_conflicts_mirror (inventory_id, snapshot_id, state, detected_at);`,
];
