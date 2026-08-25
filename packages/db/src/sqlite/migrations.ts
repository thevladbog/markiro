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
  // Task 3 review hardening: these remain trailing ALTERs because Task 3's
  // nine tables may already exist on a deployed station. They add the
  // server-owned snapshot order, immutable content proof, and one-statement
  // page acceptance fence without replacing the authoritative tables.
  `ALTER TABLE inventory_task_mirror ADD COLUMN active_snapshot_fixed_at TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN active_content_digest TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_snapshot_fixed_at TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_content_digest TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_verified_content_digest TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_last_page_digest TEXT;`,
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_page_json TEXT;`,
  // The task-row UPDATE is the only page-acceptance statement sent through
  // the pooled SqlExecutor. SQLite executes this trigger in that statement's
  // own transaction, so a losing concurrent cursor/page-digest fence inserts
  // no code rows and cannot contaminate the candidate.
  `DROP TRIGGER IF EXISTS inventory_task_mirror_accept_page;`,
  `CREATE TRIGGER inventory_task_mirror_accept_page
     AFTER UPDATE OF staged_page_json ON inventory_task_mirror
     WHEN NEW.staged_page_json IS NOT NULL
       AND NEW.staged_last_page_digest IS NOT NULL
       AND NEW.staged_last_page_digest <> COALESCE(OLD.staged_last_page_digest, '')
     BEGIN
       INSERT INTO inventory_snapshot_codes_mirror (
         snapshot_id, code_hash, canonical_raw, gtin14, serial, source_status,
         source_state, source_production_date, parent_sscc, expected, protected
       )
       SELECT
         NEW.staged_snapshot_id,
         json_extract(page_item.value, '$.codeHash'),
         json_extract(page_item.value, '$.canonicalRaw'),
         json_extract(page_item.value, '$.gtin14'),
         json_extract(page_item.value, '$.serial'),
         json_extract(page_item.value, '$.sourceStatus'),
         json_extract(page_item.value, '$.sourceState'),
         json_extract(page_item.value, '$.sourceProductionDate'),
         json_extract(page_item.value, '$.parentSscc'),
         json_extract(page_item.value, '$.expected'),
         json_extract(page_item.value, '$.protected')
       FROM json_each(NEW.staged_page_json) AS page_item
       WHERE 1
       ON CONFLICT(snapshot_id, code_hash) DO NOTHING;
     END;`,
  // Safe recovery from a pre-proof staged/active revision needs the task-row
  // reset and removal of that revision's immutable rows to be one SQLite
  // statement. This transient target column drives that statement-local
  // trigger; it never deletes the row currently named by the active pointer.
  `ALTER TABLE inventory_task_mirror ADD COLUMN staged_reset_snapshot_id TEXT;`,
  `DROP TRIGGER IF EXISTS inventory_task_mirror_reset_snapshot;`,
  `CREATE TRIGGER inventory_task_mirror_reset_snapshot
     AFTER UPDATE OF staged_reset_snapshot_id ON inventory_task_mirror
     WHEN NEW.staged_reset_snapshot_id IS NOT NULL
     BEGIN
       DELETE FROM inventory_snapshot_codes_mirror
        WHERE snapshot_id = NEW.staged_reset_snapshot_id
          AND (NEW.active_snapshot_id IS NULL OR snapshot_id <> NEW.active_snapshot_id);
     END;`,
  // Task 4 recovery cleanup must distinguish reproducible inventory data
  // downloaded by a rejected credential from a newer credential's mirror.
  `ALTER TABLE inventory_task_mirror ADD COLUMN credential_ownership TEXT;`,
  // Forward-upgrade the Task 4 round-2 cache. The pointer was already bound
  // to a credential, but its matching mirror row predated the owner column.
  // Attribute only a strict pointer whose task and snapshot identity agree.
  `WITH pointer_json AS (
     SELECT CASE WHEN json_valid(value) = 1 THEN value ELSE '{}' END AS value
       FROM station_meta
      WHERE key = 'active_inventory_floor_task_v1'
   ), pointer_fields AS (
     SELECT
       value,
       json_extract(value, '$.inventoryId') AS inventory_id,
       json_extract(value, '$.snapshotId') AS snapshot_id,
       json_extract(value, '$.credentialOwnership') AS credential_ownership
       FROM pointer_json
   ), active_pointer AS (
     SELECT inventory_id, snapshot_id, credential_ownership
       FROM pointer_fields
      WHERE json_type(value, '$.inventoryId') = 'text'
        AND length(inventory_id) = 36
        AND substr(inventory_id, 9, 1) = '-'
        AND substr(inventory_id, 14, 1) = '-'
        AND substr(inventory_id, 19, 1) = '-'
        AND substr(inventory_id, 24, 1) = '-'
        AND length(replace(inventory_id, '-', '')) = 32
        AND replace(lower(inventory_id), '-', '') NOT GLOB '*[^0-9a-f]*'
        AND (
          lower(inventory_id) IN (
            '00000000-0000-0000-0000-000000000000',
            'ffffffff-ffff-ffff-ffff-ffffffffffff'
          )
          OR (
            substr(lower(inventory_id), 15, 1) GLOB '[1-8]'
            AND substr(lower(inventory_id), 20, 1) GLOB '[89ab]'
          )
        )
        AND json_type(value, '$.snapshotId') = 'text'
        AND length(snapshot_id) = 36
        AND substr(snapshot_id, 9, 1) = '-'
        AND substr(snapshot_id, 14, 1) = '-'
        AND substr(snapshot_id, 19, 1) = '-'
        AND substr(snapshot_id, 24, 1) = '-'
        AND length(replace(snapshot_id, '-', '')) = 32
        AND replace(lower(snapshot_id), '-', '') NOT GLOB '*[^0-9a-f]*'
        AND (
          lower(snapshot_id) IN (
            '00000000-0000-0000-0000-000000000000',
            'ffffffff-ffff-ffff-ffff-ffffffffffff'
          )
          OR (
            substr(lower(snapshot_id), 15, 1) GLOB '[1-8]'
            AND substr(lower(snapshot_id), 20, 1) GLOB '[89ab]'
          )
        )
        AND json_type(value, '$.credentialOwnership') = 'text'
        AND length(credential_ownership) = 64
        AND credential_ownership = lower(credential_ownership)
        AND credential_ownership NOT GLOB '*[^0-9a-f]*'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(pointer_fields.value) AS pointer_field
           WHERE pointer_field.key NOT IN (
             'inventoryId', 'snapshotId', 'credentialOwnership', 'activationId'
           )
        )
        AND (
          ((SELECT COUNT(*) FROM json_each(pointer_fields.value)) = 3
            AND json_type(value, '$.activationId') IS NULL)
          OR
          ((SELECT COUNT(*) FROM json_each(pointer_fields.value)) = 4
            AND json_type(value, '$.activationId') = 'text'
            AND length(json_extract(value, '$.activationId')) > 0)
        )
   )
   UPDATE inventory_task_mirror
      SET credential_ownership = (
        SELECT credential_ownership FROM active_pointer LIMIT 1
      )
    WHERE credential_ownership IS NULL
      AND EXISTS (
        SELECT 1 FROM active_pointer
         WHERE active_pointer.inventory_id = inventory_task_mirror.inventory_id
           AND (
             active_pointer.snapshot_id = inventory_task_mirror.active_snapshot_id
             OR active_pointer.snapshot_id = inventory_task_mirror.staged_snapshot_id
           )
      );`,
  // An unowned staged revision that is not the published active revision has
  // no durable proof of who downloaded it. It is reproducible, so fail closed
  // by resetting only that inactive stage; the existing trigger removes only
  // its immutable snapshot-code rows and explicitly protects active rows.
  `UPDATE inventory_task_mirror
      SET staged_reset_snapshot_id = staged_snapshot_id,
          staged_snapshot_id = NULL, staged_snapshot_revision = NULL,
          staged_snapshot_fixed_at = NULL, staged_combined_digest = NULL,
          staged_content_digest = NULL, staged_code_count = NULL,
          staged_manifest_json = NULL, staged_next_cursor = NULL,
          staged_verified_digest = NULL, staged_verified_content_digest = NULL,
          staged_last_page_digest = NULL, staged_page_json = NULL,
          staging_generation = staging_generation + 1
    WHERE credential_ownership IS NULL
      AND staged_snapshot_id IS NOT NULL
      AND (active_snapshot_id IS NULL OR staged_snapshot_id <> active_snapshot_id);`,
  // Task 5 review: event reservation precedes the projection and outbox. A
  // trailing state column makes that multi-statement protocol restart-safe.
  // Existing append-only facts predate reservations and already have their
  // transport rows, so the compatibility default is deliberately committed.
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN commit_state TEXT NOT NULL DEFAULT 'committed';`,
  // Forward audit for the original compatibility migration above. It is
  // deliberately separate and rerunnable so devices that already applied the
  // column still fail closed unless exact durable output can be proven.
  `UPDATE inventory_scan_events_mirror AS event
      SET commit_state = CASE WHEN EXISTS (
        SELECT 1 FROM inventory_outbox queued
         WHERE queued.inventory_id = event.inventory_id
           AND queued.snapshot_id = event.snapshot_id
           AND queued.event_id = event.event_id
           AND queued.device_sequence = event.device_sequence
           AND CASE WHEN json_valid(queued.payload_json) THEN
             json_type(queued.payload_json, '$.eventId') IS NOT NULL
             AND json_extract(queued.payload_json, '$.eventId') IS event.event_id
             AND json_type(queued.payload_json, '$.deviceSequence') IS NOT NULL
             AND json_extract(queued.payload_json, '$.deviceSequence') IS event.device_sequence
             AND json_type(queued.payload_json, '$.operatorId') IS NOT NULL
             AND json_extract(queued.payload_json, '$.operatorId') IS event.operator_id
             AND json_type(queued.payload_json, '$.scannedAt') IS NOT NULL
             AND json_extract(queued.payload_json, '$.scannedAt') IS event.scanned_at
             AND json_type(queued.payload_json, '$.kind') IS NOT NULL
             AND json_extract(queued.payload_json, '$.kind') IS event.kind
             AND json_type(queued.payload_json, '$.normalizedIdentity') IS NOT NULL
             AND json_extract(queued.payload_json, '$.normalizedIdentity')
                   IS event.normalized_identity
             AND json_type(queued.payload_json, '$.codeHash') IS NOT NULL
             AND json_extract(queued.payload_json, '$.codeHash') IS event.code_hash
             AND json_type(queued.payload_json, '$.canonicalRaw') IS NOT NULL
             AND json_extract(queued.payload_json, '$.canonicalRaw') IS event.raw_payload
             AND json_type(queued.payload_json, '$.activeProductionDate') IS NOT NULL
             AND json_extract(queued.payload_json, '$.activeProductionDate')
                   IS event.active_production_date
             AND json_type(queued.payload_json, '$.localVerdict') IS NOT NULL
             AND json_extract(queued.payload_json, '$.localVerdict') IS event.local_verdict
           ELSE 0 END
      )
      AND (
        (event.local_verdict = 'expected' AND EXISTS (
          SELECT 1 FROM inventory_code_results_mirror result
           WHERE result.inventory_id = event.inventory_id
             AND result.snapshot_id = event.snapshot_id
             AND result.first_accepted_event_id = event.event_id
             AND result.origin_classification = 'expected'
        ))
        OR (event.local_verdict = 'protected' AND EXISTS (
          SELECT 1 FROM inventory_code_results_mirror result
           WHERE result.inventory_id = event.inventory_id
             AND result.snapshot_id = event.snapshot_id
             AND result.first_accepted_event_id = event.event_id
             AND result.origin_classification = 'protected'
        ))
        OR (event.local_verdict = 'known-ineligible' AND EXISTS (
          SELECT 1 FROM inventory_code_results_mirror result
           WHERE result.inventory_id = event.inventory_id
             AND result.snapshot_id = event.snapshot_id
             AND result.first_accepted_event_id = event.event_id
             AND result.origin_classification = 'known-ineligible'
        ))
        OR (event.local_verdict IN ('unknown', 'duplicate') AND NOT EXISTS (
          SELECT 1 FROM inventory_code_results_mirror result
           WHERE result.inventory_id = event.inventory_id
             AND result.snapshot_id = event.snapshot_id
             AND result.first_accepted_event_id = event.event_id
        ))
      ) THEN 'committed' ELSE 'failed' END
    WHERE event.commit_state IN ('failed', 'committed');`,
  // Rerunnable compensation is event-owned and can never remove another
  // observation's winning projection.
  `DELETE FROM inventory_code_results_mirror AS result
    WHERE EXISTS (
      SELECT 1 FROM inventory_scan_events_mirror event
       WHERE event.inventory_id = result.inventory_id
         AND event.snapshot_id = result.snapshot_id
         AND event.event_id = result.first_accepted_event_id
         AND event.commit_state = 'failed'
    );`,
];
