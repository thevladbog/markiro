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
  // Version 1 is the final one-time legacy proof. New events are inserted at
  // this version; existing rows start at zero and are audited exactly once.
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN legacy_audit_version INTEGER NOT NULL DEFAULT 0;`,
  // Box proof uses the current unique winner set, but accepts another owner
  // only when its reservation tuple (sequence, device, event) precedes this
  // box and its item/parent identity exactly covers that child. Recursive
  // invalidation prevents a later box from depending on a prior owner that
  // fails its own final proof.
  `WITH RECURSIVE
     candidates AS (
       SELECT event.*
         FROM inventory_scan_events_mirror event
        WHERE event.legacy_audit_version = 0
          AND event.commit_state IN ('committed', 'failed')
     ),
     structurally_valid AS (
       SELECT event.*
         FROM candidates event
        WHERE event.commit_state = 'committed'
          AND (
            (
              event.kind = 'item'
              AND event.local_verdict IN ('expected', 'protected', 'known-ineligible')
              AND event.code_hash IS NOT NULL
              AND (
                SELECT COUNT(*) FROM inventory_code_results_mirror owned
                 WHERE owned.inventory_id = event.inventory_id
                   AND owned.snapshot_id = event.snapshot_id
                   AND owned.first_accepted_event_id = event.event_id
              ) = 1
              AND EXISTS (
                SELECT 1 FROM inventory_code_results_mirror owned
                 WHERE owned.inventory_id = event.inventory_id
                   AND owned.snapshot_id = event.snapshot_id
                   AND owned.first_accepted_event_id = event.event_id
                   AND owned.code_hash = event.code_hash
                   AND owned.winning_device_id = event.device_id
                   AND owned.winning_scanned_at = event.scanned_at
                   AND owned.observed_production_date IS event.active_production_date
                   AND owned.origin_classification = event.local_verdict
                   AND owned.classification = event.local_verdict
              )
            )
            OR (
              event.kind = 'known_box'
              AND event.local_verdict IN ('expected', 'protected', 'known-ineligible')
              AND substr(event.normalized_identity, 1, 10) = 'known_box:'
              AND EXISTS (
                SELECT 1 FROM inventory_task_mirror task
                 WHERE task.inventory_id = event.inventory_id
                   AND task.active_snapshot_id = event.snapshot_id
              )
              AND EXISTS (
                SELECT 1 FROM inventory_code_results_mirror owned
                 WHERE owned.inventory_id = event.inventory_id
                   AND owned.snapshot_id = event.snapshot_id
                   AND owned.first_accepted_event_id = event.event_id
                   AND owned.origin_classification = event.local_verdict
                   AND owned.classification = event.local_verdict
              )
              AND NOT EXISTS (
                SELECT 1 FROM inventory_code_results_mirror owned
                LEFT JOIN inventory_snapshot_codes_mirror snapshot
                  ON snapshot.snapshot_id = owned.snapshot_id
                 AND snapshot.code_hash = owned.code_hash
               WHERE owned.inventory_id = event.inventory_id
                 AND owned.snapshot_id = event.snapshot_id
                 AND owned.first_accepted_event_id = event.event_id
                 AND (
                   snapshot.code_hash IS NULL
                   OR snapshot.parent_sscc IS NOT substr(event.normalized_identity, 11)
                   OR owned.winning_device_id IS NOT event.device_id
                   OR owned.winning_scanned_at IS NOT event.scanned_at
                   OR owned.observed_production_date IS NOT event.active_production_date
                   OR owned.origin_classification IS NOT CASE
                     WHEN snapshot.source_state = 'MOVING_BY_UD' OR snapshot.protected = 1
                       THEN 'protected'
                     WHEN snapshot.expected = 1 THEN 'expected'
                     ELSE 'known-ineligible'
                   END
                   OR owned.classification IS NOT CASE
                     WHEN snapshot.source_state = 'MOVING_BY_UD' OR snapshot.protected = 1
                       THEN 'protected'
                     WHEN snapshot.expected = 1 THEN 'expected'
                     ELSE 'known-ineligible'
                   END
                 )
              )
              AND EXISTS (
                SELECT 1 FROM inventory_snapshot_codes_mirror child
                 WHERE child.snapshot_id = event.snapshot_id
                   AND child.parent_sscc = substr(event.normalized_identity, 11)
              )
              AND NOT EXISTS (
                SELECT 1 FROM inventory_snapshot_codes_mirror child
                 WHERE child.snapshot_id = event.snapshot_id
                   AND child.parent_sscc = substr(event.normalized_identity, 11)
                   AND NOT EXISTS (
                     SELECT 1 FROM inventory_code_results_mirror winner
                     LEFT JOIN inventory_scan_events_mirror owner
                       ON owner.inventory_id = winner.inventory_id
                      AND owner.snapshot_id = winner.snapshot_id
                      AND owner.event_id = winner.first_accepted_event_id
                      WHERE winner.inventory_id = event.inventory_id
                        AND winner.snapshot_id = event.snapshot_id
                        AND winner.code_hash = child.code_hash
                        AND winner.winning_device_id IS COALESCE(owner.device_id, event.device_id)
                        AND winner.winning_scanned_at IS COALESCE(owner.scanned_at, event.scanned_at)
                        AND winner.observed_production_date IS
                              COALESCE(owner.active_production_date, event.active_production_date)
                        AND winner.origin_classification IS CASE
                          WHEN child.source_state = 'MOVING_BY_UD' OR child.protected = 1
                            THEN 'protected'
                          WHEN child.expected = 1 THEN 'expected'
                          ELSE 'known-ineligible'
                        END
                        AND winner.classification IS winner.origin_classification
                        AND (
                          winner.first_accepted_event_id = event.event_id
                          OR (
                            owner.commit_state = 'committed'
                            AND (
                              owner.device_sequence < event.device_sequence
                              OR (
                                owner.device_sequence = event.device_sequence
                                AND owner.device_id < event.device_id
                              )
                              OR (
                                owner.device_sequence = event.device_sequence
                                AND owner.device_id = event.device_id
                                AND owner.event_id < event.event_id
                              )
                            )
                            AND (
                              (owner.kind = 'item' AND owner.code_hash = child.code_hash)
                              OR (
                                owner.kind = 'known_box'
                                AND owner.normalized_identity =
                                      'known_box:' || child.parent_sscc
                                AND NOT EXISTS (
                                  SELECT 1 FROM inventory_code_results_mirror owner_extra
                                  LEFT JOIN inventory_snapshot_codes_mirror owner_snapshot
                                    ON owner_snapshot.snapshot_id = owner_extra.snapshot_id
                                   AND owner_snapshot.code_hash = owner_extra.code_hash
                                 WHERE owner_extra.inventory_id = owner.inventory_id
                                   AND owner_extra.snapshot_id = owner.snapshot_id
                                   AND owner_extra.first_accepted_event_id = owner.event_id
                                   AND (
                                     owner_snapshot.code_hash IS NULL
                                     OR owner_snapshot.parent_sscc IS NOT child.parent_sscc
                                     OR owner_extra.classification IS NOT
                                          owner_extra.origin_classification
                                   )
                                )
                              )
                            )
                          )
                        )
                   )
              )
            )
            OR (
              event.local_verdict IN ('unknown', 'duplicate')
              AND NOT EXISTS (
                SELECT 1 FROM inventory_code_results_mirror owned
                 WHERE owned.inventory_id = event.inventory_id
                   AND owned.snapshot_id = event.snapshot_id
                   AND owned.first_accepted_event_id = event.event_id
              )
              AND (
                event.local_verdict = 'unknown'
                OR event.kind <> 'known_box'
                OR (
                  substr(event.normalized_identity, 1, 10) = 'known_box:'
                  AND EXISTS (
                    SELECT 1 FROM inventory_task_mirror task
                     WHERE task.inventory_id = event.inventory_id
                       AND task.active_snapshot_id = event.snapshot_id
                  )
                  AND EXISTS (
                    SELECT 1 FROM inventory_snapshot_codes_mirror child
                     WHERE child.snapshot_id = event.snapshot_id
                       AND child.parent_sscc = substr(event.normalized_identity, 11)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM inventory_snapshot_codes_mirror child
                     WHERE child.snapshot_id = event.snapshot_id
                       AND child.parent_sscc = substr(event.normalized_identity, 11)
                       AND NOT EXISTS (
                         SELECT 1 FROM inventory_code_results_mirror winner
                         JOIN inventory_scan_events_mirror owner
                           ON owner.inventory_id = winner.inventory_id
                          AND owner.snapshot_id = winner.snapshot_id
                          AND owner.event_id = winner.first_accepted_event_id
                          WHERE winner.inventory_id = event.inventory_id
                            AND winner.snapshot_id = event.snapshot_id
                            AND winner.code_hash = child.code_hash
                            AND winner.winning_device_id = owner.device_id
                            AND winner.winning_scanned_at = owner.scanned_at
                            AND winner.observed_production_date IS owner.active_production_date
                            AND winner.origin_classification IS CASE
                              WHEN child.source_state = 'MOVING_BY_UD' OR child.protected = 1
                                THEN 'protected'
                              WHEN child.expected = 1 THEN 'expected'
                              ELSE 'known-ineligible'
                            END
                            AND winner.classification IS winner.origin_classification
                            AND owner.commit_state = 'committed'
                            AND (
                              owner.device_sequence < event.device_sequence
                              OR (
                                owner.device_sequence = event.device_sequence
                                AND owner.device_id < event.device_id
                              )
                              OR (
                                owner.device_sequence = event.device_sequence
                                AND owner.device_id = event.device_id
                                AND owner.event_id < event.event_id
                              )
                            )
                            AND (
                              (owner.kind = 'item' AND owner.code_hash = child.code_hash)
                              OR (
                                owner.kind = 'known_box'
                                AND owner.normalized_identity =
                                      'known_box:' || child.parent_sscc
                                AND NOT EXISTS (
                                  SELECT 1 FROM inventory_code_results_mirror owner_extra
                                  LEFT JOIN inventory_snapshot_codes_mirror owner_snapshot
                                    ON owner_snapshot.snapshot_id = owner_extra.snapshot_id
                                   AND owner_snapshot.code_hash = owner_extra.code_hash
                                 WHERE owner_extra.inventory_id = owner.inventory_id
                                   AND owner_extra.snapshot_id = owner.snapshot_id
                                   AND owner_extra.first_accepted_event_id = owner.event_id
                                   AND (
                                     owner_snapshot.code_hash IS NULL
                                     OR owner_snapshot.parent_sscc IS NOT child.parent_sscc
                                     OR owner_extra.classification IS NOT
                                          owner_extra.origin_classification
                                   )
                                )
                              )
                            )
                       )
                  )
                )
              )
            )
          )
     ),
     invalid(inventory_id, snapshot_id, event_id) AS (
       SELECT candidate.inventory_id, candidate.snapshot_id, candidate.event_id
         FROM candidates candidate
        WHERE NOT EXISTS (
          SELECT 1 FROM structurally_valid valid
           WHERE valid.inventory_id = candidate.inventory_id
             AND valid.snapshot_id = candidate.snapshot_id
             AND valid.event_id = candidate.event_id
        )
       UNION
       SELECT dependent.inventory_id, dependent.snapshot_id, dependent.event_id
         FROM structurally_valid dependent
         JOIN inventory_snapshot_codes_mirror child
           ON child.snapshot_id = dependent.snapshot_id
          AND child.parent_sscc = substr(dependent.normalized_identity, 11)
         JOIN inventory_code_results_mirror winner
           ON winner.inventory_id = dependent.inventory_id
          AND winner.snapshot_id = dependent.snapshot_id
          AND winner.code_hash = child.code_hash
         JOIN invalid bad_owner
           ON bad_owner.inventory_id = winner.inventory_id
          AND bad_owner.snapshot_id = winner.snapshot_id
          AND bad_owner.event_id = winner.first_accepted_event_id
        WHERE dependent.kind = 'known_box'
          AND winner.first_accepted_event_id <> dependent.event_id
     )
   UPDATE inventory_scan_events_mirror AS event
      SET commit_state = CASE WHEN EXISTS (
            SELECT 1 FROM invalid bad
             WHERE bad.inventory_id = event.inventory_id
               AND bad.snapshot_id = event.snapshot_id
               AND bad.event_id = event.event_id
          ) THEN 'failed' ELSE 'committed' END,
          legacy_audit_version = 1
    WHERE event.legacy_audit_version = 0
      AND event.commit_state IN ('committed', 'failed');`,
  `DELETE FROM inventory_code_results_mirror AS result
    WHERE EXISTS (
      SELECT 1 FROM inventory_scan_events_mirror event
       WHERE event.inventory_id = result.inventory_id
         AND event.snapshot_id = result.snapshot_id
         AND event.event_id = result.first_accepted_event_id
         AND event.commit_state = 'failed'
         AND event.legacy_audit_version = 1
    );`,
  // Round 4 repair-first handoff. On a pre-existing round-1/round-2 database
  // the runtime executor skips the superseded destructive audits above. The
  // marker therefore starts at zero and this statement hides ambiguous legacy
  // acceptance until the journal can rebuild and requeue it from immutable
  // event/snapshot facts. Fresh databases have no version-zero rows here.
  `UPDATE inventory_scan_events_mirror
      SET commit_state = 'pending'
    WHERE legacy_audit_version = 0 AND commit_state = 'committed';`,
  // Duplicate chronology is evidence captured at reservation time. Existing
  // rows intentionally remain null: a later projection must never be used to
  // invent or backfill a legacy winner.
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN duplicate_winner_code_hash TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN duplicate_winner_event_id TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN duplicate_winner_device_id TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror
     ADD COLUMN duplicate_winner_scanned_at TEXT;`,
  // Task 6 keeps the complete server acknowledgement durable before the
  // corresponding transport row can be removed.
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN authoritative_verdict TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_reason_code TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_result_revision INTEGER;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_winner_code_hash TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_winner_event_id TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_winner_device_id TEXT;`,
  `ALTER TABLE inventory_scan_events_mirror ADD COLUMN server_winner_scanned_at TEXT;`,
  `ALTER TABLE inventory_terminal_state
     ADD COLUMN progress_result_revision INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE IF NOT EXISTS inventory_event_claim_outcomes_mirror (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     status TEXT NOT NULL,
     winning_event_id TEXT NOT NULL,
     winning_device_id TEXT NOT NULL,
     winning_scanned_at TEXT NOT NULL,
     result_revision INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (inventory_id, snapshot_id, source_event_id, code_hash)
   );`,
  // Acknowledgement and progress are each reduced by one SQLite statement.
  // The receipt insert, its trigger writes, and the exact delete/cursor CAS are
  // one implicit SQLite transaction even when SqlExecutor rotates pooled connections.
  `CREATE TABLE IF NOT EXISTS inventory_sync_ack_receipts (
     receipt_id TEXT PRIMARY KEY,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     response_json TEXT NOT NULL,
     outbox_rows_json TEXT NOT NULL,
     pin_key TEXT NOT NULL,
     pin_value TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     CHECK (json_valid(response_json) AND length(response_json) <= 8388608),
     CHECK (json_valid(outbox_rows_json) AND length(outbox_rows_json) <= 524288)
   );`,
  `DROP TRIGGER IF EXISTS inventory_sync_validate_ack;`,
  `CREATE TRIGGER inventory_sync_validate_ack
     BEFORE INSERT ON inventory_sync_ack_receipts
     WHEN NOT EXISTS (
       SELECT 1 FROM inventory_sync_ack_receipts receipt
        WHERE receipt.receipt_id = NEW.receipt_id
     ) AND (
       json_extract(NEW.response_json, '$.inventoryId') <> NEW.inventory_id
       OR json_extract(NEW.response_json, '$.snapshotId') <> NEW.snapshot_id
       OR json_extract(NEW.response_json, '$.batchId') <> NEW.batch_id
       OR json_extract(NEW.response_json, '$.payloadDigest') <> NEW.payload_digest
       OR json_array_length(NEW.outbox_rows_json) NOT BETWEEN 1 AND 100
       OR json_array_length(NEW.response_json, '$.outcomes') <>
            json_array_length(NEW.outbox_rows_json)
       OR NOT EXISTS (
       SELECT 1 FROM station_meta pin
        WHERE pin.key = NEW.pin_key AND pin.value = NEW.pin_value
     ) OR EXISTS (
       SELECT 1 FROM json_each(NEW.outbox_rows_json) pinned
        WHERE NOT EXISTS (
          SELECT 1 FROM inventory_outbox queued
           WHERE queued.id = json_extract(pinned.value, '$.id')
             AND queued.inventory_id = NEW.inventory_id
             AND queued.snapshot_id = NEW.snapshot_id
             AND queued.event_id = json_extract(pinned.value, '$.eventId')
             AND queued.payload_json = json_extract(pinned.value, '$.payloadJson')
        )
     ))
     BEGIN
       SELECT RAISE(ABORT, 'inventory outbox payload changed');
     END;`,
  `DROP TRIGGER IF EXISTS inventory_sync_apply_ack;`,
  `CREATE TRIGGER inventory_sync_apply_ack
     AFTER INSERT ON inventory_sync_ack_receipts
     BEGIN
       UPDATE inventory_scan_events_mirror AS event
          SET authoritative_verdict = (
                SELECT json_extract(outcome.value, '$.status')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
              ),
              server_reason_code = (
                SELECT json_extract(outcome.value, '$.reasonCode')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
              ),
              server_result_revision = json_extract(NEW.response_json, '$.resultRevision'),
              server_winner_code_hash = (
                SELECT json_extract(claim.value, '$.codeHash')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome,
                       json_each(outcome.value, '$.claims') claim
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
                   AND json_extract(claim.value, '$.status') = 'duplicate'
                 ORDER BY json_extract(claim.value, '$.codeHash') LIMIT 1
              ),
              server_winner_event_id = (
                SELECT json_extract(claim.value, '$.winner.eventId')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome,
                       json_each(outcome.value, '$.claims') claim
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
                   AND json_extract(claim.value, '$.status') = 'duplicate'
                 ORDER BY json_extract(claim.value, '$.codeHash') LIMIT 1
              ),
              server_winner_device_id = (
                SELECT json_extract(claim.value, '$.winner.deviceId')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome,
                       json_each(outcome.value, '$.claims') claim
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
                   AND json_extract(claim.value, '$.status') = 'duplicate'
                 ORDER BY json_extract(claim.value, '$.codeHash') LIMIT 1
              ),
              server_winner_scanned_at = (
                SELECT json_extract(claim.value, '$.winner.scannedAt')
                  FROM json_each(NEW.response_json, '$.outcomes') outcome,
                       json_each(outcome.value, '$.claims') claim
                 WHERE json_extract(outcome.value, '$.eventId') = event.event_id
                   AND json_extract(claim.value, '$.status') = 'duplicate'
                 ORDER BY json_extract(claim.value, '$.codeHash') LIMIT 1
              )
        WHERE event.inventory_id = NEW.inventory_id
          AND event.snapshot_id = NEW.snapshot_id
          AND EXISTS (
            SELECT 1 FROM json_each(NEW.response_json, '$.outcomes') outcome
             WHERE json_extract(outcome.value, '$.eventId') = event.event_id
          );

       INSERT INTO inventory_event_claim_outcomes_mirror (
         inventory_id, snapshot_id, source_event_id, code_hash, status,
         winning_event_id, winning_device_id, winning_scanned_at,
         result_revision, updated_at
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              json_extract(outcome.value, '$.eventId'),
              json_extract(claim.value, '$.codeHash'),
              json_extract(claim.value, '$.status'),
              json_extract(claim.value, '$.winner.eventId'),
              json_extract(claim.value, '$.winner.deviceId'),
              json_extract(claim.value, '$.winner.scannedAt'),
              json_extract(NEW.response_json, '$.resultRevision'), NEW.applied_at
         FROM json_each(NEW.response_json, '$.outcomes') outcome,
              json_each(outcome.value, '$.claims') claim
        WHERE true
       ON CONFLICT(inventory_id, snapshot_id, source_event_id, code_hash) DO UPDATE SET
         status = excluded.status,
         winning_event_id = excluded.winning_event_id,
         winning_device_id = excluded.winning_device_id,
         winning_scanned_at = excluded.winning_scanned_at,
         result_revision = excluded.result_revision,
         updated_at = excluded.updated_at;

       INSERT INTO inventory_conflicts_mirror (
         inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
         winning_event_id, winning_device_id, winning_scanned_at, detected_at, state
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              json_extract(outcome.value, '$.eventId') || ':' ||
                json_extract(claim.value, '$.codeHash') || ':' ||
                json_extract(claim.value, '$.winner.eventId'),
              json_extract(claim.value, '$.codeHash'),
              json_extract(outcome.value, '$.eventId'),
              json_extract(claim.value, '$.winner.eventId'),
              json_extract(claim.value, '$.winner.deviceId'),
              json_extract(claim.value, '$.winner.scannedAt'), NEW.applied_at, 'open'
         FROM json_each(NEW.response_json, '$.outcomes') outcome,
              json_each(outcome.value, '$.claims') claim
        WHERE json_extract(claim.value, '$.status') = 'duplicate'
       ON CONFLICT(inventory_id, snapshot_id, conflict_id) DO UPDATE SET
         code_hash = excluded.code_hash,
         losing_event_id = excluded.losing_event_id,
         winning_event_id = excluded.winning_event_id,
         winning_device_id = excluded.winning_device_id,
         winning_scanned_at = excluded.winning_scanned_at;

       DELETE FROM inventory_outbox
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND EXISTS (
            SELECT 1 FROM json_each(NEW.outbox_rows_json) pinned
             WHERE inventory_outbox.id = json_extract(pinned.value, '$.id')
               AND inventory_outbox.event_id = json_extract(pinned.value, '$.eventId')
               AND inventory_outbox.payload_json = json_extract(pinned.value, '$.payloadJson')
          );
       DELETE FROM station_meta WHERE key = NEW.pin_key AND value = NEW.pin_value;
     END;`,
  `CREATE TABLE IF NOT EXISTS inventory_progress_receipts (
     receipt_id TEXT PRIMARY KEY,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     requested_cursor TEXT,
     prior_result_revision INTEGER NOT NULL,
     page_json TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     CHECK (json_valid(page_json) AND length(page_json) <= 8388608)
   );`,
  `DROP TRIGGER IF EXISTS inventory_progress_validate_page;`,
  `CREATE TRIGGER inventory_progress_validate_page
     BEFORE INSERT ON inventory_progress_receipts
     WHEN json_extract(NEW.page_json, '$.inventoryId') <> NEW.inventory_id
       OR json_extract(NEW.page_json, '$.snapshotId') <> NEW.snapshot_id
       OR json_extract(NEW.page_json, '$.cursor') IS NOT NEW.requested_cursor
       OR json_array_length(NEW.page_json, '$.items') > 200
       OR NOT EXISTS (
       SELECT 1 FROM inventory_terminal_state terminal
        WHERE terminal.inventory_id = NEW.inventory_id
          AND terminal.snapshot_id = NEW.snapshot_id
          AND terminal.device_id = NEW.device_id
          AND terminal.progress_cursor IS NEW.requested_cursor
          AND terminal.progress_result_revision = NEW.prior_result_revision
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory progress cursor changed');
     END;`,
  `DROP TRIGGER IF EXISTS inventory_progress_apply_page;`,
  `CREATE TRIGGER inventory_progress_apply_page
     AFTER INSERT ON inventory_progress_receipts
     BEGIN
       INSERT INTO inventory_code_results_mirror (
         inventory_id, snapshot_id, code_hash, first_accepted_event_id,
         winning_device_id, winning_scanned_at, observed_production_date,
         classification, origin_classification, updated_at
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              json_extract(item.value, '$.codeHash'),
              json_extract(item.value, '$.winner.eventId'),
              json_extract(item.value, '$.winner.deviceId'),
              json_extract(item.value, '$.winner.scannedAt'),
              json_extract(item.value, '$.observedProductionDate'),
              CASE json_extract(item.value, '$.classification')
                WHEN 'ineligible' THEN 'known-ineligible'
                ELSE json_extract(item.value, '$.classification') END,
              CASE json_extract(item.value, '$.classification')
                WHEN 'ineligible' THEN 'known-ineligible'
                ELSE json_extract(item.value, '$.classification') END,
              json_extract(item.value, '$.correctedAt')
         FROM json_each(NEW.page_json, '$.items') item
        WHERE json_type(item.value, '$.winner') = 'object'
       ON CONFLICT(inventory_id, snapshot_id, code_hash) DO UPDATE SET
         first_accepted_event_id = excluded.first_accepted_event_id,
         winning_device_id = excluded.winning_device_id,
         winning_scanned_at = excluded.winning_scanned_at,
         observed_production_date = excluded.observed_production_date,
         classification = excluded.classification,
         origin_classification = CASE
           WHEN inventory_code_results_mirror.origin_classification = 'voided'
             THEN excluded.origin_classification
           ELSE inventory_code_results_mirror.origin_classification END,
         updated_at = excluded.updated_at;

       UPDATE inventory_code_results_mirror AS result
          SET classification = CASE json_extract(item.value, '$.classification')
                WHEN 'ineligible' THEN 'known-ineligible'
                ELSE json_extract(item.value, '$.classification') END,
              observed_production_date = json_extract(item.value, '$.observedProductionDate'),
              updated_at = json_extract(item.value, '$.correctedAt')
         FROM json_each(NEW.page_json, '$.items') item
        WHERE json_type(item.value, '$.winner') = 'null'
          AND result.inventory_id = NEW.inventory_id
          AND result.snapshot_id = NEW.snapshot_id
          AND result.code_hash = json_extract(item.value, '$.codeHash');

       INSERT INTO inventory_conflicts_mirror (
         inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
         winning_event_id, winning_device_id, winning_scanned_at, detected_at, state
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              local.event_id || ':' || json_extract(item.value, '$.winner.eventId'),
              json_extract(item.value, '$.codeHash'), local.event_id,
              json_extract(item.value, '$.winner.eventId'),
              json_extract(item.value, '$.winner.deviceId'),
              json_extract(item.value, '$.winner.scannedAt'),
              json_extract(item.value, '$.correctedAt'), 'open'
         FROM json_each(NEW.page_json, '$.items') item
         JOIN inventory_scan_events_mirror local
           ON local.inventory_id = NEW.inventory_id
          AND local.snapshot_id = NEW.snapshot_id
          AND local.code_hash = json_extract(item.value, '$.codeHash')
          AND local.device_id = NEW.device_id
        WHERE json_type(item.value, '$.winner') = 'object'
          AND json_extract(item.value, '$.winner.deviceId') <> NEW.device_id
          AND NOT EXISTS (
            SELECT 1 FROM inventory_scan_events_mirror earlier
             WHERE earlier.inventory_id = local.inventory_id
               AND earlier.snapshot_id = local.snapshot_id
               AND earlier.code_hash = local.code_hash
               AND earlier.device_id = local.device_id
               AND (earlier.scanned_at < local.scanned_at
                 OR (earlier.scanned_at = local.scanned_at AND earlier.event_id < local.event_id))
          )
       ON CONFLICT(inventory_id, snapshot_id, conflict_id) DO NOTHING;

       UPDATE inventory_terminal_state
          SET progress_cursor = COALESCE(json_extract(NEW.page_json, '$.nextCursor'), progress_cursor),
              progress_result_revision = json_extract(NEW.page_json, '$.resultRevision'),
              updated_at = NEW.applied_at
       WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND device_id = NEW.device_id
          AND progress_cursor IS NEW.requested_cursor
          AND progress_result_revision = NEW.prior_result_revision;
     END;`,
  // Forward hardening uses new receipt tables instead of replacing live
  // triggers. SQLite pools may prepare consecutive migration statements on
  // different connections, so DROP/CREATE is not a safe replacement protocol.
  // Legacy receipts remain immutable evidence and are bridged idempotently.
  `CREATE TABLE IF NOT EXISTS inventory_sync_ack_receipts_v2 (
     receipt_id TEXT PRIMARY KEY,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     response_json TEXT NOT NULL,
     outbox_rows_json TEXT NOT NULL,
     pin_key TEXT NOT NULL,
     pin_value TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     CHECK (json_valid(response_json) AND length(response_json) <= 8388608),
     CHECK (json_valid(outbox_rows_json) AND length(outbox_rows_json) <= 524288)
   );`,
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_validate_ack_v2
     BEFORE INSERT ON inventory_sync_ack_receipts_v2
     WHEN NOT (
       EXISTS (
         SELECT 1 FROM inventory_sync_ack_receipts_v2 receipt
          WHERE receipt.receipt_id = NEW.receipt_id
            AND receipt.inventory_id IS NEW.inventory_id
            AND receipt.snapshot_id IS NEW.snapshot_id
            AND receipt.batch_id IS NEW.batch_id
            AND receipt.payload_digest IS NEW.payload_digest
            AND receipt.response_json IS NEW.response_json
            AND receipt.outbox_rows_json IS NEW.outbox_rows_json
            AND receipt.pin_key IS NEW.pin_key
            AND receipt.pin_value IS NEW.pin_value
            AND receipt.applied_at IS NEW.applied_at
       )
       OR (
         NOT EXISTS (
           SELECT 1 FROM inventory_sync_ack_receipts_v2 receipt
            WHERE receipt.receipt_id = NEW.receipt_id
         )
         AND NEW.receipt_id IS NOT NULL
         AND NEW.inventory_id IS NOT NULL
         AND NEW.snapshot_id IS NOT NULL
         AND NEW.batch_id IS NOT NULL
         AND NEW.payload_digest IS NOT NULL
         AND NEW.pin_key IS NOT NULL
         AND NEW.pin_value IS NOT NULL
         AND NEW.applied_at IS NOT NULL
         AND json_valid(NEW.response_json)
         AND json_type(NEW.response_json, '$') = 'object'
         AND json_valid(NEW.outbox_rows_json)
         AND json_type(NEW.outbox_rows_json, '$') = 'array'
         AND json_valid(NEW.pin_value)
         AND json_type(NEW.pin_value, '$') = 'object'
         AND NEW.receipt_id = NEW.inventory_id || ':' || NEW.snapshot_id || ':' ||
              NEW.batch_id || ':' || NEW.payload_digest
         AND NEW.pin_key = 'inventory_sync_batch_v1:' || NEW.inventory_id || ':' || NEW.snapshot_id
         AND json_extract(NEW.response_json, '$.inventoryId') IS NEW.inventory_id
         AND json_extract(NEW.response_json, '$.snapshotId') IS NEW.snapshot_id
         AND json_extract(NEW.response_json, '$.snapshotRevision') IS 1
         AND json_extract(NEW.response_json, '$.batchId') IS NEW.batch_id
         AND json_extract(NEW.response_json, '$.payloadDigest') IS NEW.payload_digest
         AND json_type(NEW.response_json, '$.sequenceCeiling') = 'integer'
         AND json_type(NEW.response_json, '$.resultRevision') = 'integer'
         AND json_extract(NEW.response_json, '$.resultRevision') >= 0
         AND json_type(NEW.response_json, '$.outcomes') = 'array'
         AND (SELECT COUNT(*) FROM json_each(NEW.response_json)) = 8
         AND json_array_length(NEW.response_json, '$.outcomes') BETWEEN 1 AND 100
         AND json_array_length(NEW.response_json, '$.outcomes') =
              json_array_length(NEW.outbox_rows_json)
         AND json_extract(NEW.pin_value, '$.inventoryId') IS NEW.inventory_id
         AND json_extract(NEW.pin_value, '$.snapshotId') IS NEW.snapshot_id
         AND json_type(NEW.pin_value, '$.deviceId') = 'text'
         AND json_type(NEW.pin_value, '$.request') = 'object'
         AND json_type(NEW.pin_value, '$.outboxRows') = 'array'
         AND (SELECT COUNT(*) FROM json_each(NEW.pin_value)) = 5
         AND json_extract(NEW.pin_value, '$.request.snapshotId') IS NEW.snapshot_id
         AND json_extract(NEW.pin_value, '$.request.snapshotRevision') IS 1
         AND json_extract(NEW.pin_value, '$.request.batchId') IS NEW.batch_id
         AND json_extract(NEW.pin_value, '$.request.payloadDigest') IS NEW.payload_digest
         AND json_extract(NEW.pin_value, '$.request.sequenceCeiling') IS
              json_extract(NEW.response_json, '$.sequenceCeiling')
         AND json_type(NEW.pin_value, '$.request.events') = 'array'
         AND json_type(NEW.pin_value, '$.request.events[#-1].scannedAt') = 'text'
         AND NEW.applied_at = json_extract(
              NEW.pin_value, '$.request.events[#-1].scannedAt'
            )
         AND json_array_length(NEW.pin_value, '$.request.events') =
              json_array_length(NEW.outbox_rows_json)
         AND json(NEW.outbox_rows_json) = json(json_extract(NEW.pin_value, '$.outboxRows'))
         AND EXISTS (
           SELECT 1 FROM station_meta pin
            WHERE pin.key = NEW.pin_key AND pin.value = NEW.pin_value
         )
         AND EXISTS (
           SELECT 1 FROM inventory_terminal_state terminal
            WHERE terminal.inventory_id = NEW.inventory_id
              AND terminal.snapshot_id = NEW.snapshot_id
              AND terminal.device_id = json_extract(NEW.pin_value, '$.deviceId')
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(NEW.outbox_rows_json) pinned
            WHERE json_type(pinned.value, '$') <> 'object'
               OR json_type(pinned.value, '$.id') <> 'integer'
               OR json_type(pinned.value, '$.eventId') <> 'text'
               OR json_type(pinned.value, '$.payloadJson') <> 'text'
               OR (SELECT COUNT(*) FROM json_each(pinned.value)) <> 3
               OR NOT EXISTS (
                 SELECT 1 FROM inventory_outbox queued
                  WHERE queued.id = json_extract(pinned.value, '$.id')
                    AND queued.inventory_id = NEW.inventory_id
                    AND queued.snapshot_id = NEW.snapshot_id
                    AND queued.event_id = json_extract(pinned.value, '$.eventId')
                    AND queued.payload_json = json_extract(pinned.value, '$.payloadJson')
               )
               OR (SELECT COUNT(*)
                     FROM json_each(NEW.pin_value, '$.request.events') event
                    WHERE json_extract(event.value, '$.eventId') =
                          json_extract(pinned.value, '$.eventId')) <> 1
         )
         AND (SELECT COUNT(DISTINCT json_extract(pinned.value, '$.id'))
                FROM json_each(NEW.outbox_rows_json) pinned) =
              json_array_length(NEW.outbox_rows_json)
         AND (SELECT COUNT(DISTINCT json_extract(pinned.value, '$.eventId'))
                FROM json_each(NEW.outbox_rows_json) pinned) =
              json_array_length(NEW.outbox_rows_json)
         AND NOT EXISTS (
           SELECT 1 FROM json_each(NEW.response_json, '$.outcomes') outcome
            WHERE json_type(outcome.value, '$') <> 'object'
               OR json_type(outcome.value, '$.eventId') <> 'text'
               OR json_type(outcome.value, '$.status') <> 'text'
               OR json_type(outcome.value, '$.reasonCode') <> 'text'
               OR json_type(outcome.value, '$.claimedCount') <> 'integer'
               OR json_type(outcome.value, '$.conflictCount') <> 'integer'
               OR json_type(outcome.value, '$.claims') <> 'array'
               OR (SELECT COUNT(*) FROM json_each(outcome.value)) <> 6
               OR json_extract(outcome.value, '$.claimedCount') < 0
               OR json_extract(outcome.value, '$.conflictCount') < 0
               OR json_extract(outcome.value, '$.claimedCount') <>
                    (SELECT COUNT(*) FROM json_each(outcome.value, '$.claims') claim
                      WHERE json_extract(claim.value, '$.status') = 'claimed')
               OR json_extract(outcome.value, '$.conflictCount') <>
                    (SELECT COUNT(*) FROM json_each(outcome.value, '$.claims') claim
                      WHERE json_extract(claim.value, '$.status') = 'duplicate')
               OR json_array_length(outcome.value, '$.claims') > 10000
               OR NOT (
                 (json_extract(outcome.value, '$.status') = 'applied'
                   AND json_extract(outcome.value, '$.reasonCode') = 'CLAIM_APPLIED'
                   AND (json_extract(outcome.value, '$.claimedCount') > 0
                     OR json_array_length(outcome.value, '$.claims') = 0))
                 OR (json_extract(outcome.value, '$.status') = 'duplicate'
                   AND json_extract(outcome.value, '$.reasonCode') = 'CLAIM_LOST'
                   AND json_extract(outcome.value, '$.claimedCount') = 0
                   AND json_extract(outcome.value, '$.conflictCount') > 0)
                 OR (json_extract(outcome.value, '$.status') = 'replay'
                   AND json_extract(outcome.value, '$.reasonCode') = 'BATCH_REPLAY')
                 OR (json_extract(outcome.value, '$.status') = 'quarantined'
                   AND json_extract(outcome.value, '$.reasonCode') IN
                     ('INVENTORY_CLOSED', 'INVENTORY_COMPLETED')
                   AND json_extract(outcome.value, '$.claimedCount') = 0
                   AND json_extract(outcome.value, '$.conflictCount') = 0
                   AND json_array_length(outcome.value, '$.claims') = 0)
               )
               OR (SELECT COUNT(*) FROM json_each(NEW.outbox_rows_json) pinned
                    WHERE json_extract(pinned.value, '$.eventId') =
                          json_extract(outcome.value, '$.eventId')) <> 1
               OR EXISTS (
                 SELECT 1 FROM json_each(outcome.value, '$.claims') claim
                  WHERE json_type(claim.value, '$') <> 'object'
                     OR json_type(claim.value, '$.codeHash') <> 'text'
                     OR length(json_extract(claim.value, '$.codeHash')) <> 64
                     OR json_extract(claim.value, '$.codeHash') GLOB '*[^0-9a-f]*'
                     OR json_extract(claim.value, '$.status') NOT IN ('claimed', 'duplicate')
                     OR json_type(claim.value, '$.winner') <> 'object'
                     OR (SELECT COUNT(*) FROM json_each(claim.value)) <> 3
                     OR (SELECT COUNT(*) FROM json_each(claim.value, '$.winner')) <> 4
                     OR json_extract(claim.value, '$.winner.codeHash') IS NOT
                          json_extract(claim.value, '$.codeHash')
                     OR json_type(claim.value, '$.winner.eventId') <> 'text'
                     OR json_type(claim.value, '$.winner.deviceId') <> 'text'
                     OR json_type(claim.value, '$.winner.scannedAt') <> 'text'
                     OR (json_extract(claim.value, '$.status') = 'claimed'
                       AND json_extract(claim.value, '$.winner.eventId') IS NOT
                            json_extract(outcome.value, '$.eventId'))
                     OR (json_extract(claim.value, '$.status') = 'duplicate'
                       AND json_extract(claim.value, '$.winner.eventId') IS
                            json_extract(outcome.value, '$.eventId'))
               )
         )
         AND (SELECT COUNT(DISTINCT json_extract(outcome.value, '$.eventId'))
                FROM json_each(NEW.response_json, '$.outcomes') outcome) =
              json_array_length(NEW.response_json, '$.outcomes')
         AND (SELECT COUNT(*)
                FROM json_each(NEW.response_json, '$.outcomes') outcome,
                     json_each(outcome.value, '$.claims') claim) <= 10000
       )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory acknowledgement receipt invalid');
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_apply_ack_v2
     AFTER INSERT ON inventory_sync_ack_receipts_v2
     BEGIN
       INSERT INTO inventory_sync_ack_receipts (
         receipt_id, inventory_id, snapshot_id, batch_id, payload_digest,
         response_json, outbox_rows_json, pin_key, pin_value, applied_at
       ) VALUES (
         NEW.receipt_id, NEW.inventory_id, NEW.snapshot_id, NEW.batch_id,
         NEW.payload_digest, NEW.response_json, NEW.outbox_rows_json,
         NEW.pin_key, NEW.pin_value, NEW.applied_at
       ) ON CONFLICT(receipt_id) DO NOTHING;
     END;`,
  `CREATE TABLE IF NOT EXISTS inventory_progress_receipts_v2 (
     receipt_id TEXT PRIMARY KEY,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     requested_cursor TEXT,
     prior_result_revision INTEGER NOT NULL,
     page_json TEXT NOT NULL,
     pointer_key TEXT NOT NULL,
     pointer_value TEXT NOT NULL,
     credential_ownership TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     CHECK (json_valid(page_json) AND length(page_json) <= 8388608)
   );`,
  `CREATE TRIGGER IF NOT EXISTS inventory_progress_validate_page_v2
     BEFORE INSERT ON inventory_progress_receipts_v2
     WHEN NOT (
       EXISTS (
         SELECT 1 FROM inventory_progress_receipts_v2 receipt
          WHERE receipt.receipt_id = NEW.receipt_id
            AND receipt.inventory_id IS NEW.inventory_id
            AND receipt.snapshot_id IS NEW.snapshot_id
            AND receipt.device_id IS NEW.device_id
            AND receipt.requested_cursor IS NEW.requested_cursor
            AND receipt.prior_result_revision IS NEW.prior_result_revision
            AND receipt.page_json IS NEW.page_json
            AND receipt.pointer_key IS NEW.pointer_key
            AND receipt.pointer_value IS NEW.pointer_value
            AND receipt.credential_ownership IS NEW.credential_ownership
            AND receipt.applied_at IS NEW.applied_at
       )
       OR (
         NOT EXISTS (
           SELECT 1 FROM inventory_progress_receipts_v2 receipt
            WHERE receipt.receipt_id = NEW.receipt_id
         )
         AND NEW.receipt_id IS NOT NULL
         AND NEW.inventory_id IS NOT NULL
         AND NEW.snapshot_id IS NOT NULL
         AND NEW.device_id IS NOT NULL
         AND NEW.prior_result_revision IS NOT NULL
         AND NEW.pointer_key IS NOT NULL
         AND NEW.pointer_value IS NOT NULL
         AND NEW.credential_ownership IS NOT NULL
         AND NEW.applied_at IS NOT NULL
         AND json_valid(NEW.page_json)
         AND json_type(NEW.page_json, '$') = 'object'
         AND (SELECT COUNT(*) FROM json_each(NEW.page_json)) = 7
         AND json_extract(NEW.page_json, '$.inventoryId') IS NEW.inventory_id
         AND json_extract(NEW.page_json, '$.snapshotId') IS NEW.snapshot_id
         AND json_extract(NEW.page_json, '$.snapshotRevision') IS 1
         AND json_extract(NEW.page_json, '$.cursor') IS NEW.requested_cursor
         AND json_type(NEW.page_json, '$.resultRevision') = 'integer'
         AND json_extract(NEW.page_json, '$.resultRevision') >= NEW.prior_result_revision
         AND json_type(NEW.page_json, '$.items') = 'array'
         AND json_array_length(NEW.page_json, '$.items') <= 200
         AND json_type(NEW.page_json, '$.nextCursor') IN ('text', 'null')
         AND NEW.receipt_id = NEW.inventory_id || ':' || NEW.snapshot_id || ':' ||
              NEW.device_id || ':' || COALESCE(NEW.requested_cursor, 'root') || ':' ||
              CAST(NEW.prior_result_revision AS TEXT) || ':' ||
              CAST(json_extract(NEW.page_json, '$.resultRevision') AS TEXT) || ':' ||
              COALESCE(json_extract(NEW.page_json, '$.nextCursor'), 'end')
         AND NEW.pointer_key = 'active_inventory_floor_task_v1'
         AND json_valid(NEW.pointer_value)
         AND json_type(NEW.pointer_value, '$') = 'object'
         AND json_extract(NEW.pointer_value, '$.inventoryId') IS NEW.inventory_id
         AND json_extract(NEW.pointer_value, '$.snapshotId') IS NEW.snapshot_id
         AND json_extract(NEW.pointer_value, '$.credentialOwnership') IS NEW.credential_ownership
         AND json_type(NEW.pointer_value, '$.activationId') = 'text'
         AND length(json_extract(NEW.pointer_value, '$.activationId')) > 0
         AND (SELECT COUNT(*) FROM json_each(NEW.pointer_value)) = 4
         AND length(NEW.credential_ownership) = 64
         AND NEW.credential_ownership = lower(NEW.credential_ownership)
         AND NEW.credential_ownership NOT GLOB '*[^0-9a-f]*'
         AND EXISTS (
           SELECT 1 FROM station_meta pointer
            WHERE pointer.key = NEW.pointer_key AND pointer.value = NEW.pointer_value
         )
         AND EXISTS (
           SELECT 1 FROM inventory_terminal_state terminal
            WHERE terminal.inventory_id = NEW.inventory_id
              AND terminal.snapshot_id = NEW.snapshot_id
              AND terminal.device_id = NEW.device_id
              AND terminal.progress_cursor IS NEW.requested_cursor
              AND terminal.progress_result_revision = NEW.prior_result_revision
              AND NEW.applied_at = CASE
                WHEN json_array_length(NEW.page_json, '$.items') > 0 THEN
                  json_extract(NEW.page_json, '$.items[#-1].correctedAt')
                ELSE terminal.updated_at
              END
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(NEW.page_json, '$.items') item
            WHERE json_type(item.value, '$') <> 'object'
               OR (SELECT COUNT(*) FROM json_each(item.value)) <> 8
               OR json_type(item.value, '$.id') <> 'text'
               OR json_type(item.value, '$.revision') <> 'integer'
               OR json_extract(item.value, '$.revision') <= 0
               OR json_extract(item.value, '$.revision') >
                    json_extract(NEW.page_json, '$.resultRevision')
               OR json_extract(item.value, '$.kind') NOT IN ('claim', 'correction')
               OR json_type(item.value, '$.codeHash') <> 'text'
               OR length(json_extract(item.value, '$.codeHash')) <> 64
               OR json_extract(item.value, '$.codeHash') GLOB '*[^0-9a-f]*'
               OR json_extract(item.value, '$.classification') NOT IN
                    ('expected', 'protected', 'ineligible', 'unknown', 'voided')
               OR json_type(item.value, '$.correctedAt') <> 'text'
               OR json_type(item.value, '$.winner') NOT IN ('object', 'null')
               OR (json_type(item.value, '$.winner') = 'object' AND (
                 (SELECT COUNT(*) FROM json_each(item.value, '$.winner')) <> 4
                 OR json_extract(item.value, '$.winner.codeHash') IS NOT
                      json_extract(item.value, '$.codeHash')
                 OR json_type(item.value, '$.winner.eventId') <> 'text'
                 OR json_type(item.value, '$.winner.deviceId') <> 'text'
                 OR json_type(item.value, '$.winner.scannedAt') <> 'text'
               ))
               OR EXISTS (
                 SELECT 1 FROM json_each(NEW.page_json, '$.items') prior
                  WHERE CAST(prior.key AS INTEGER) < CAST(item.key AS INTEGER)
                    AND (json_extract(prior.value, '$.revision') >
                           json_extract(item.value, '$.revision')
                      OR (json_extract(prior.value, '$.revision') =
                            json_extract(item.value, '$.revision')
                        AND json_extract(prior.value, '$.id') >=
                            json_extract(item.value, '$.id')))
               )
         )
         AND (
           (json_array_length(NEW.page_json, '$.items') = 0
             AND json_extract(NEW.page_json, '$.nextCursor') IS NULL)
           OR (json_array_length(NEW.page_json, '$.items') > 0
             AND json_extract(NEW.page_json, '$.nextCursor') = (
               SELECT CAST(json_extract(item.value, '$.revision') AS TEXT) || ':' ||
                      json_extract(item.value, '$.id')
                 FROM json_each(NEW.page_json, '$.items') item
                ORDER BY CAST(item.key AS INTEGER) DESC LIMIT 1
             ))
         )
       )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory progress receipt invalid');
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_progress_apply_page_v2
     AFTER INSERT ON inventory_progress_receipts_v2
     BEGIN
       INSERT INTO inventory_code_results_mirror (
         inventory_id, snapshot_id, code_hash, first_accepted_event_id,
         winning_device_id, winning_scanned_at, observed_production_date,
         classification, origin_classification, updated_at
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              json_extract(winner.value, '$.codeHash'),
              json_extract(winner.value, '$.winner.eventId'),
              json_extract(winner.value, '$.winner.deviceId'),
              json_extract(winner.value, '$.winner.scannedAt'),
              (SELECT json_extract(final.value, '$.observedProductionDate')
                 FROM json_each(NEW.page_json, '$.items') final
                WHERE json_extract(final.value, '$.codeHash') =
                      json_extract(winner.value, '$.codeHash')
                ORDER BY json_extract(final.value, '$.revision') DESC,
                         json_extract(final.value, '$.id') DESC LIMIT 1),
              (SELECT CASE json_extract(final.value, '$.classification')
                        WHEN 'ineligible' THEN 'known-ineligible'
                        ELSE json_extract(final.value, '$.classification') END
                 FROM json_each(NEW.page_json, '$.items') final
                WHERE json_extract(final.value, '$.codeHash') =
                      json_extract(winner.value, '$.codeHash')
                ORDER BY json_extract(final.value, '$.revision') DESC,
                         json_extract(final.value, '$.id') DESC LIMIT 1),
              (SELECT CASE json_extract(final.value, '$.classification')
                        WHEN 'ineligible' THEN 'known-ineligible'
                        ELSE json_extract(final.value, '$.classification') END
                 FROM json_each(NEW.page_json, '$.items') final
                WHERE json_extract(final.value, '$.codeHash') =
                      json_extract(winner.value, '$.codeHash')
                ORDER BY json_extract(final.value, '$.revision') DESC,
                         json_extract(final.value, '$.id') DESC LIMIT 1),
              (SELECT json_extract(final.value, '$.correctedAt')
                 FROM json_each(NEW.page_json, '$.items') final
                WHERE json_extract(final.value, '$.codeHash') =
                      json_extract(winner.value, '$.codeHash')
                ORDER BY json_extract(final.value, '$.revision') DESC,
                         json_extract(final.value, '$.id') DESC LIMIT 1)
         FROM json_each(NEW.page_json, '$.items') winner
        WHERE json_type(winner.value, '$.winner') = 'object'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.page_json, '$.items') later
             WHERE json_extract(later.value, '$.codeHash') =
                   json_extract(winner.value, '$.codeHash')
               AND json_type(later.value, '$.winner') = 'object'
               AND (json_extract(later.value, '$.revision') >
                      json_extract(winner.value, '$.revision')
                 OR (json_extract(later.value, '$.revision') =
                       json_extract(winner.value, '$.revision')
                   AND json_extract(later.value, '$.id') >
                       json_extract(winner.value, '$.id')))
          )
       ON CONFLICT(inventory_id, snapshot_id, code_hash) DO UPDATE SET
         first_accepted_event_id = excluded.first_accepted_event_id,
         winning_device_id = excluded.winning_device_id,
         winning_scanned_at = excluded.winning_scanned_at,
         observed_production_date = excluded.observed_production_date,
         classification = excluded.classification,
         origin_classification = CASE
           WHEN inventory_code_results_mirror.origin_classification = 'voided'
             THEN excluded.origin_classification
           ELSE inventory_code_results_mirror.origin_classification END,
         updated_at = excluded.updated_at;

       UPDATE inventory_code_results_mirror AS result
          SET classification = (
                SELECT CASE json_extract(final.value, '$.classification')
                  WHEN 'ineligible' THEN 'known-ineligible'
                  ELSE json_extract(final.value, '$.classification') END
                  FROM json_each(NEW.page_json, '$.items') final
                 WHERE json_extract(final.value, '$.codeHash') = result.code_hash
                 ORDER BY json_extract(final.value, '$.revision') DESC,
                          json_extract(final.value, '$.id') DESC LIMIT 1
              ),
              observed_production_date = (
                SELECT json_extract(final.value, '$.observedProductionDate')
                  FROM json_each(NEW.page_json, '$.items') final
                 WHERE json_extract(final.value, '$.codeHash') = result.code_hash
                 ORDER BY json_extract(final.value, '$.revision') DESC,
                          json_extract(final.value, '$.id') DESC LIMIT 1
              ),
              updated_at = (
                SELECT json_extract(final.value, '$.correctedAt')
                  FROM json_each(NEW.page_json, '$.items') final
                 WHERE json_extract(final.value, '$.codeHash') = result.code_hash
                 ORDER BY json_extract(final.value, '$.revision') DESC,
                          json_extract(final.value, '$.id') DESC LIMIT 1
              )
        WHERE result.inventory_id = NEW.inventory_id
          AND result.snapshot_id = NEW.snapshot_id
          AND EXISTS (
            SELECT 1 FROM json_each(NEW.page_json, '$.items') item
             WHERE json_extract(item.value, '$.codeHash') = result.code_hash
          );

       INSERT INTO inventory_conflicts_mirror (
         inventory_id, snapshot_id, conflict_id, code_hash, losing_event_id,
         winning_event_id, winning_device_id, winning_scanned_at, detected_at, state
       )
       SELECT NEW.inventory_id, NEW.snapshot_id,
              local.event_id || ':' || json_extract(item.value, '$.winner.eventId'),
              json_extract(item.value, '$.codeHash'), local.event_id,
              json_extract(item.value, '$.winner.eventId'),
              json_extract(item.value, '$.winner.deviceId'),
              json_extract(item.value, '$.winner.scannedAt'),
              json_extract(item.value, '$.correctedAt'), 'open'
         FROM json_each(NEW.page_json, '$.items') item
         JOIN inventory_scan_events_mirror local
           ON local.inventory_id = NEW.inventory_id
          AND local.snapshot_id = NEW.snapshot_id
          AND local.code_hash = json_extract(item.value, '$.codeHash')
          AND local.device_id = NEW.device_id
        WHERE json_type(item.value, '$.winner') = 'object'
          AND json_extract(item.value, '$.winner.deviceId') <> NEW.device_id
          AND NOT EXISTS (
            SELECT 1 FROM inventory_scan_events_mirror earlier
             WHERE earlier.inventory_id = local.inventory_id
               AND earlier.snapshot_id = local.snapshot_id
               AND earlier.code_hash = local.code_hash
               AND earlier.device_id = local.device_id
               AND (earlier.scanned_at < local.scanned_at
                 OR (earlier.scanned_at = local.scanned_at AND earlier.event_id < local.event_id))
          )
       ON CONFLICT(inventory_id, snapshot_id, conflict_id) DO NOTHING;

       UPDATE inventory_terminal_state
          SET progress_cursor = COALESCE(json_extract(NEW.page_json, '$.nextCursor'), progress_cursor),
              progress_result_revision = json_extract(NEW.page_json, '$.resultRevision'),
              updated_at = NEW.applied_at
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND device_id = NEW.device_id
          AND progress_cursor IS NEW.requested_cursor
          AND progress_result_revision = NEW.prior_result_revision;
     END;`,
  // Forward fail-closed admission: bind each acknowledgement outcome to the
  // exact immutable request event instead of trusting aggregate shape alone.
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_validate_ack_event_facts_v3
     BEFORE INSERT ON inventory_sync_ack_receipts_v2
     WHEN NOT EXISTS (
       SELECT 1 FROM inventory_sync_ack_receipts_v2 receipt
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.inventory_id IS NEW.inventory_id
          AND receipt.snapshot_id IS NEW.snapshot_id
          AND receipt.batch_id IS NEW.batch_id
          AND receipt.payload_digest IS NEW.payload_digest
          AND receipt.response_json IS NEW.response_json
          AND receipt.outbox_rows_json IS NEW.outbox_rows_json
          AND receipt.pin_key IS NEW.pin_key
          AND receipt.pin_value IS NEW.pin_value
          AND receipt.applied_at IS NEW.applied_at
     ) AND EXISTS (
       SELECT 1 FROM json_each(NEW.response_json, '$.outcomes') outcome
        WHERE (SELECT COUNT(*)
                 FROM json_each(NEW.pin_value, '$.request.events') event
                WHERE json_extract(event.value, '$.eventId') =
                      json_extract(outcome.value, '$.eventId')) <> 1
           OR (
             json_extract(outcome.value, '$.status') = 'applied'
             AND json_extract(outcome.value, '$.reasonCode') = 'CLAIM_APPLIED'
             AND json_array_length(outcome.value, '$.claims') = 0
             AND NOT EXISTS (
               SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
                WHERE json_extract(event.value, '$.eventId') =
                      json_extract(outcome.value, '$.eventId')
                  AND json_extract(event.value, '$.kind') = 'old_box'
             )
           )
           OR EXISTS (
             SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
              WHERE json_extract(event.value, '$.eventId') =
                    json_extract(outcome.value, '$.eventId')
                AND json_extract(event.value, '$.kind') = 'old_box'
                AND json_array_length(outcome.value, '$.claims') <> 0
           )
           OR EXISTS (
             SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
              WHERE json_extract(event.value, '$.eventId') =
                    json_extract(outcome.value, '$.eventId')
                AND json_extract(event.value, '$.kind') = 'item'
                AND json_array_length(outcome.value, '$.claims') > 0
                AND (
                  json_type(event.value, '$.codeHash') <> 'text'
                  OR json_array_length(outcome.value, '$.claims') <> 1
                  OR json_extract(outcome.value, '$.claims[0].codeHash') IS NOT
                       json_extract(event.value, '$.codeHash')
                )
           )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory acknowledgement event facts invalid');
     END;`,
  // z.iso.date() semantics at the direct-SQL boundary: JSON null or an exact
  // Gregorian YYYY-MM-DD that SQLite round-trips without normalization.
  `CREATE TRIGGER IF NOT EXISTS inventory_progress_validate_civil_date_v3
     BEFORE INSERT ON inventory_progress_receipts_v2
     WHEN NOT EXISTS (
       SELECT 1 FROM inventory_progress_receipts_v2 receipt
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.inventory_id IS NEW.inventory_id
          AND receipt.snapshot_id IS NEW.snapshot_id
          AND receipt.device_id IS NEW.device_id
          AND receipt.requested_cursor IS NEW.requested_cursor
          AND receipt.prior_result_revision IS NEW.prior_result_revision
          AND receipt.page_json IS NEW.page_json
          AND receipt.pointer_key IS NEW.pointer_key
          AND receipt.pointer_value IS NEW.pointer_value
          AND receipt.credential_ownership IS NEW.credential_ownership
          AND receipt.applied_at IS NEW.applied_at
     ) AND EXISTS (
       SELECT 1 FROM json_each(NEW.page_json, '$.items') item
        WHERE json_type(item.value, '$.observedProductionDate') IS NULL
           OR json_type(item.value, '$.observedProductionDate') NOT IN ('text', 'null')
           OR (
             json_type(item.value, '$.observedProductionDate') = 'text'
             AND (
               length(json_extract(item.value, '$.observedProductionDate')) <> 10
               OR json_extract(item.value, '$.observedProductionDate') NOT GLOB
                    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
               OR date(json_extract(item.value, '$.observedProductionDate')) IS NOT
                    json_extract(item.value, '$.observedProductionDate')
             )
           )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory progress civil date invalid');
     END;`,
  // Forward item acknowledgement binding: claim-bearing item outcomes must
  // reproduce the exact pinned event and device facts accepted by Domain.
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_validate_ack_item_facts_v4
     BEFORE INSERT ON inventory_sync_ack_receipts_v2
     WHEN NOT EXISTS (
       SELECT 1 FROM inventory_sync_ack_receipts_v2 receipt
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.inventory_id IS NEW.inventory_id
          AND receipt.snapshot_id IS NEW.snapshot_id
          AND receipt.batch_id IS NEW.batch_id
          AND receipt.payload_digest IS NEW.payload_digest
          AND receipt.response_json IS NEW.response_json
          AND receipt.outbox_rows_json IS NEW.outbox_rows_json
          AND receipt.pin_key IS NEW.pin_key
          AND receipt.pin_value IS NEW.pin_value
          AND receipt.applied_at IS NEW.applied_at
     ) AND EXISTS (
       SELECT 1
         FROM json_each(NEW.response_json, '$.outcomes') outcome
         JOIN json_each(NEW.pin_value, '$.request.events') event
           ON json_extract(event.value, '$.eventId') =
              json_extract(outcome.value, '$.eventId')
        WHERE json_extract(event.value, '$.kind') = 'item'
          AND json_extract(outcome.value, '$.status') IN ('applied', 'replay', 'duplicate')
          AND (
            json_type(event.value, '$.codeHash') <> 'text'
            OR json_array_length(outcome.value, '$.claims') <> 1
            OR json_extract(outcome.value, '$.claims[0].codeHash') IS NOT
                 json_extract(event.value, '$.codeHash')
            OR EXISTS (
              SELECT 1 FROM json_each(outcome.value, '$.claims') claim
               WHERE json_extract(claim.value, '$.status') = 'claimed'
                 AND (
                   json_extract(claim.value, '$.winner.eventId') IS NOT
                     json_extract(event.value, '$.eventId')
                   OR json_extract(claim.value, '$.winner.deviceId') IS NOT
                     json_extract(NEW.pin_value, '$.deviceId')
                   OR json_extract(claim.value, '$.winner.scannedAt') IS NOT
                     json_extract(event.value, '$.scannedAt')
                 )
            )
          )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory acknowledgement item facts invalid');
     END;`,
  // Task 7 repack journal is append-only. Existing deployed tables receive
  // source-event anchors through trailing ALTERs; no historical DDL is rewritten.
  `ALTER TABLE inventory_repack_boxes_mirror ADD COLUMN opened_event_id TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE inventory_repack_boxes_mirror ADD COLUMN closed_event_id TEXT;`,
  `ALTER TABLE inventory_repack_items_mirror ADD COLUMN source_event_id TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE inventory_repack_items_mirror ADD COLUMN position INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE inventory_repack_items_mirror ADD COLUMN source_parent_mismatch INTEGER NOT NULL DEFAULT 0;`,
  `CREATE TABLE IF NOT EXISTS inventory_repack_journal (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     device_sequence INTEGER NOT NULL,
     operator_id TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     event_kind TEXT NOT NULL,
     normalized_identity TEXT NOT NULL,
     code_hash TEXT,
     canonical_raw TEXT,
     active_production_date TEXT,
     local_verdict TEXT NOT NULL,
     action TEXT NOT NULL,
     box_id TEXT NOT NULL,
     item_id TEXT,
     old_sscc TEXT,
     new_sscc TEXT,
     capacity INTEGER,
     production_date TEXT,
     position INTEGER,
     close_box INTEGER NOT NULL DEFAULT 0,
     source_parent_mismatch INTEGER NOT NULL DEFAULT 0,
     payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
     PRIMARY KEY (inventory_id, snapshot_id, event_id)
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS inventory_repack_journal_device_sequence_uq
     ON inventory_repack_journal (inventory_id, snapshot_id, device_id, device_sequence);`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_apply_journal_v1
     AFTER INSERT ON inventory_repack_journal
     BEGIN
       INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict, commit_state, legacy_audit_version)
       VALUES
         (NEW.inventory_id, NEW.snapshot_id, NEW.event_id, NEW.device_id,
          NEW.device_sequence, NEW.operator_id, NEW.occurred_at, NEW.event_kind,
          NEW.normalized_identity, NEW.code_hash, NEW.canonical_raw,
          NEW.active_production_date, NEW.local_verdict, 'committed', 1);

       INSERT INTO inventory_code_results_mirror
         (inventory_id, snapshot_id, code_hash, first_accepted_event_id,
          winning_device_id, winning_scanned_at, observed_production_date,
          classification, origin_classification, updated_at)
       SELECT NEW.inventory_id, NEW.snapshot_id, NEW.code_hash, NEW.event_id,
              NEW.device_id, NEW.occurred_at, NEW.active_production_date,
              CASE NEW.local_verdict
                WHEN 'known-ineligible' THEN 'ineligible' ELSE NEW.local_verdict END,
              CASE NEW.local_verdict
                WHEN 'known-ineligible' THEN 'ineligible' ELSE NEW.local_verdict END,
              NEW.occurred_at
        WHERE NEW.event_kind = 'item'
          AND NEW.local_verdict IN ('expected', 'protected', 'known-ineligible', 'unknown')
       ON CONFLICT(inventory_id, snapshot_id, code_hash) DO NOTHING;

       INSERT INTO inventory_repack_boxes_mirror
         (inventory_id, snapshot_id, box_id, opened_event_id, closed_event_id,
          old_sscc_context, new_sscc, owner_device_id, capacity, production_date,
          state, print_state, print_attempt_count, opened_at, updated_at)
       SELECT NEW.inventory_id, NEW.snapshot_id, NEW.box_id, NEW.event_id, NULL,
              NEW.old_sscc, NEW.new_sscc, NEW.device_id, NEW.capacity,
              NEW.production_date, 'open', 'not_ready', 0, NEW.occurred_at, NEW.occurred_at
        WHERE NEW.action = 'open-box';

       UPDATE inventory_terminal_state
          SET source_parent_sscc = NEW.old_sscc, open_repack_box_id = NEW.box_id,
              updated_at = NEW.occurred_at
        WHERE NEW.action = 'open-box' AND inventory_id = NEW.inventory_id
          AND snapshot_id = NEW.snapshot_id AND device_id = NEW.device_id;

       INSERT INTO inventory_repack_items_mirror
         (inventory_id, snapshot_id, item_id, source_event_id, box_id, code_hash,
          position, source_parent_mismatch, production_date, added_at, removed_at)
       SELECT NEW.inventory_id, NEW.snapshot_id, NEW.item_id, NEW.event_id,
              NEW.box_id, NEW.code_hash, NEW.position, NEW.source_parent_mismatch,
              NEW.production_date, NEW.occurred_at, NULL
        WHERE NEW.action = 'add-item'
          AND EXISTS (
            SELECT 1 FROM inventory_code_results_mirror result
             WHERE result.inventory_id = NEW.inventory_id
               AND result.snapshot_id = NEW.snapshot_id
               AND result.code_hash = NEW.code_hash
               AND result.classification = 'expected'
               AND result.winning_device_id = NEW.device_id
          );

       UPDATE inventory_repack_items_mirror
          SET removed_at = NEW.occurred_at
        WHERE NEW.action = 'remove-last' AND inventory_id = NEW.inventory_id
          AND snapshot_id = NEW.snapshot_id AND box_id = NEW.box_id
          AND item_id = NEW.item_id AND removed_at IS NULL;

       UPDATE inventory_repack_items_mirror
          SET removed_at = NEW.occurred_at
        WHERE NEW.action = 'clear-box' AND inventory_id = NEW.inventory_id
          AND snapshot_id = NEW.snapshot_id AND box_id = NEW.box_id
          AND removed_at IS NULL;

       UPDATE inventory_repack_boxes_mirror
          SET state = 'closed', print_state = 'pending', closed_at = NEW.occurred_at,
              closed_event_id = NEW.event_id, updated_at = NEW.occurred_at
        WHERE (NEW.action = 'close-incomplete'
              OR (NEW.action = 'add-item' AND NEW.close_box = 1))
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND owner_device_id = NEW.device_id AND state = 'open';

       UPDATE inventory_repack_boxes_mirror
          SET production_date = NEW.production_date, updated_at = NEW.occurred_at
        WHERE NEW.action = 'change-date' AND inventory_id = NEW.inventory_id
          AND snapshot_id = NEW.snapshot_id AND box_id = NEW.box_id
          AND owner_device_id = NEW.device_id AND state = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM inventory_repack_items_mirror item
             WHERE item.inventory_id = NEW.inventory_id
               AND item.snapshot_id = NEW.snapshot_id
               AND item.box_id = NEW.box_id AND item.removed_at IS NULL
          );

       UPDATE inventory_terminal_state
          SET active_production_date = NEW.production_date, updated_at = NEW.occurred_at
        WHERE NEW.action = 'change-date' AND inventory_id = NEW.inventory_id
          AND snapshot_id = NEW.snapshot_id AND device_id = NEW.device_id;

       INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (NEW.inventory_id, NEW.snapshot_id, NEW.event_id,
               NEW.device_sequence, NEW.payload_json, NEW.occurred_at);
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_invalidate_ack_v1
     AFTER INSERT ON inventory_sync_ack_receipts
     BEGIN
       UPDATE inventory_repack_boxes_mirror AS box
          SET state = 'invalidated', invalidated_at = NEW.applied_at,
              updated_at = NEW.applied_at
        WHERE box.inventory_id = NEW.inventory_id
          AND box.snapshot_id = NEW.snapshot_id
          AND box.state = 'open'
          AND EXISTS (
            SELECT 1
              FROM inventory_repack_items_mirror item,
                   json_each(NEW.response_json, '$.outcomes') outcome
             WHERE item.inventory_id = box.inventory_id
               AND item.snapshot_id = box.snapshot_id
               AND item.box_id = box.box_id
               AND item.removed_at IS NULL
               AND item.source_event_id = json_extract(outcome.value, '$.eventId')
               AND json_extract(outcome.value, '$.status') = 'duplicate'
          );
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_invalidate_progress_v1
     AFTER INSERT ON inventory_progress_receipts_v2
     BEGIN
       UPDATE inventory_repack_boxes_mirror AS box
          SET state = 'invalidated', invalidated_at = NEW.applied_at,
              updated_at = NEW.applied_at
        WHERE box.inventory_id = NEW.inventory_id
          AND box.snapshot_id = NEW.snapshot_id
          AND box.state = 'open'
          AND EXISTS (
            SELECT 1
              FROM inventory_repack_items_mirror item,
                   json_each(NEW.page_json, '$.items') progress
             WHERE item.inventory_id = box.inventory_id
               AND item.snapshot_id = box.snapshot_id
               AND item.box_id = box.box_id
               AND item.removed_at IS NULL
               AND item.code_hash = json_extract(progress.value, '$.codeHash')
               AND json_type(progress.value, '$.winner') = 'object'
               AND json_extract(progress.value, '$.winner.eventId') <> item.source_event_id
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(NEW.page_json, '$.items') later
                  WHERE json_extract(later.value, '$.codeHash') = item.code_hash
                    AND (json_extract(later.value, '$.revision') >
                           json_extract(progress.value, '$.revision')
                      OR (json_extract(later.value, '$.revision') =
                            json_extract(progress.value, '$.revision')
                        AND json_extract(later.value, '$.id') >
                            json_extract(progress.value, '$.id')))
               )
          );
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_invalidate_ack_v2
     AFTER INSERT ON inventory_sync_ack_receipts
     BEGIN
       UPDATE inventory_repack_boxes_mirror AS box
          SET state = 'invalidated',
              print_state = CASE WHEN box.print_state = 'pending' THEN 'failed'
                                 ELSE box.print_state END,
              invalidated_at = NEW.applied_at, updated_at = NEW.applied_at
        WHERE box.inventory_id = NEW.inventory_id
          AND box.snapshot_id = NEW.snapshot_id
          AND (box.state = 'open' OR (box.state = 'closed' AND box.print_state = 'pending'))
          AND EXISTS (
            SELECT 1
              FROM inventory_repack_items_mirror item,
                   json_each(NEW.response_json, '$.outcomes') outcome
             WHERE item.inventory_id = box.inventory_id
               AND item.snapshot_id = box.snapshot_id
               AND item.box_id = box.box_id
               AND item.removed_at IS NULL
               AND item.source_event_id = json_extract(outcome.value, '$.eventId')
               AND json_extract(outcome.value, '$.status') = 'duplicate'
          );
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_invalidate_progress_v2
     AFTER INSERT ON inventory_progress_receipts_v2
     BEGIN
       UPDATE inventory_repack_boxes_mirror AS box
          SET state = 'invalidated',
              print_state = CASE WHEN box.print_state = 'pending' THEN 'failed'
                                 ELSE box.print_state END,
              invalidated_at = NEW.applied_at, updated_at = NEW.applied_at
        WHERE box.inventory_id = NEW.inventory_id
          AND box.snapshot_id = NEW.snapshot_id
          AND (box.state = 'open' OR (box.state = 'closed' AND box.print_state = 'pending'))
          AND EXISTS (
            SELECT 1
              FROM inventory_repack_items_mirror item,
                   json_each(NEW.page_json, '$.items') progress
             WHERE item.inventory_id = box.inventory_id
               AND item.snapshot_id = box.snapshot_id
               AND item.box_id = box.box_id
               AND item.removed_at IS NULL
               AND item.code_hash = json_extract(progress.value, '$.codeHash')
               AND json_type(progress.value, '$.winner') = 'object'
               AND json_extract(progress.value, '$.winner.eventId') <> item.source_event_id
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(NEW.page_json, '$.items') later
                  WHERE json_extract(later.value, '$.codeHash') = item.code_hash
                    AND (json_extract(later.value, '$.revision') >
                           json_extract(progress.value, '$.revision')
                      OR (json_extract(later.value, '$.revision') =
                            json_extract(progress.value, '$.revision')
                        AND json_extract(later.value, '$.id') >
                            json_extract(progress.value, '$.id')))
               )
          );
     END;`,
  `CREATE TABLE IF NOT EXISTS inventory_repack_print_attempts (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     box_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('initial', 'reprint')),
     attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
     state TEXT NOT NULL CHECK (state IN ('printing', 'printed', 'failed')),
     error_code TEXT,
     attempted_at TEXT NOT NULL,
     completed_at TEXT,
     event_id TEXT,
     PRIMARY KEY (inventory_id, snapshot_id, attempt_id),
     UNIQUE (inventory_id, snapshot_id, box_id, attempt_number),
     CHECK ((state = 'failed' AND error_code IS NOT NULL)
       OR (state <> 'failed' AND error_code IS NULL)),
     CHECK ((state = 'printing' AND completed_at IS NULL)
       OR (state <> 'printing' AND completed_at IS NOT NULL))
   );
   CREATE INDEX IF NOT EXISTS inventory_repack_print_attempt_box_idx
     ON inventory_repack_print_attempts
        (inventory_id, snapshot_id, box_id, attempt_number);
   CREATE UNIQUE INDEX IF NOT EXISTS inventory_repack_print_one_active_uq
     ON inventory_repack_print_attempts (inventory_id, snapshot_id, box_id)
     WHERE state = 'printing';`,
  `CREATE TABLE IF NOT EXISTS inventory_repack_print_journal (
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     attempt_id TEXT NOT NULL,
     box_id TEXT NOT NULL,
     device_id TEXT NOT NULL,
     event_id TEXT NOT NULL,
     device_sequence INTEGER NOT NULL,
     operator_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('initial', 'reprint')),
     attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
     result TEXT NOT NULL CHECK (result IN ('printed', 'failed')),
     error_code TEXT,
     attempted_at TEXT NOT NULL,
     completed_at TEXT NOT NULL,
     payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
     PRIMARY KEY (inventory_id, snapshot_id, attempt_id),
     UNIQUE (inventory_id, snapshot_id, event_id),
     CHECK ((result = 'failed' AND error_code IS NOT NULL)
       OR (result = 'printed' AND error_code IS NULL))
   );`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_claim_print_v1
     AFTER INSERT ON inventory_repack_print_attempts
     BEGIN
       UPDATE inventory_repack_boxes_mirror
          SET print_state = 'printing', print_attempt_count = NEW.attempt_number,
              print_error_code = NULL, updated_at = NEW.attempted_at
        WHERE NEW.kind = 'initial'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed'
          AND print_state IN ('pending', 'failed');
       SELECT CASE WHEN NEW.kind = 'initial' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory print claim rejected') END;
       SELECT CASE WHEN NEW.kind = 'reprint' AND NOT EXISTS (
         SELECT 1 FROM inventory_repack_boxes_mirror
          WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
            AND box_id = NEW.box_id AND state = 'closed' AND print_state = 'printed'
       ) THEN RAISE(ABORT, 'inventory reprint claim rejected') END;
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_apply_print_v1
     AFTER INSERT ON inventory_repack_print_journal
     BEGIN
       UPDATE inventory_repack_print_attempts
          SET state = NEW.result, error_code = NEW.error_code,
              completed_at = NEW.completed_at, event_id = NEW.event_id
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND attempt_id = NEW.attempt_id AND box_id = NEW.box_id
          AND kind = NEW.kind AND attempt_number = NEW.attempt_number
          AND state = 'printing';
       SELECT CASE WHEN changes() <> 1
         THEN RAISE(ABORT, 'inventory print finalization rejected') END;
       UPDATE inventory_repack_boxes_mirror
          SET print_state = CASE WHEN NEW.result = 'printed' THEN 'printed' ELSE 'failed' END,
              print_error_code = NEW.error_code,
              printed_at = CASE WHEN NEW.result = 'printed' THEN NEW.completed_at ELSE NULL END,
              updated_at = NEW.completed_at
        WHERE NEW.kind = 'initial'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed' AND print_state = 'printing';
       SELECT CASE WHEN NEW.kind = 'initial' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory print box finalization rejected') END;
       UPDATE inventory_terminal_state
          SET open_repack_box_id = NULL, updated_at = NEW.completed_at
        WHERE NEW.kind = 'initial' AND NEW.result = 'printed'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND device_id = NEW.device_id AND open_repack_box_id = NEW.box_id;
       INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict)
       SELECT NEW.inventory_id, NEW.snapshot_id, NEW.event_id, NEW.device_id,
              NEW.device_sequence, NEW.operator_id, NEW.completed_at, 'repack_action',
              json_extract(NEW.payload_json, '$.normalizedIdentity'), NULL, NULL,
              json_extract(NEW.payload_json, '$.activeProductionDate'), 'repack-action';
       INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (NEW.inventory_id, NEW.snapshot_id, NEW.event_id, NEW.device_sequence,
               NEW.payload_json, NEW.completed_at);
     END;`,
  `DROP TRIGGER IF EXISTS inventory_repack_claim_print_v1;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_claim_print_v2
     AFTER INSERT ON inventory_repack_print_attempts
     BEGIN
       UPDATE inventory_repack_boxes_mirror
          SET print_state = 'printing', print_attempt_count = NEW.attempt_number,
              print_error_code = NULL, updated_at = NEW.attempted_at
        WHERE NEW.kind = 'initial'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed'
          AND print_state IN ('pending', 'failed');
       SELECT CASE WHEN NEW.kind = 'initial' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory print claim rejected') END;
       UPDATE inventory_repack_boxes_mirror
          SET print_attempt_count = NEW.attempt_number,
              print_error_code = NULL, updated_at = NEW.attempted_at
        WHERE NEW.kind = 'reprint'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed' AND print_state = 'printed';
       SELECT CASE WHEN NEW.kind = 'reprint' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory reprint claim rejected') END;
     END;`,
  `DROP TRIGGER IF EXISTS inventory_repack_apply_print_v1;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_apply_print_v2
     AFTER INSERT ON inventory_repack_print_journal
     BEGIN
       UPDATE inventory_repack_print_attempts
          SET state = NEW.result, error_code = NEW.error_code,
              completed_at = NEW.completed_at, event_id = NEW.event_id
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND attempt_id = NEW.attempt_id AND box_id = NEW.box_id
          AND kind = NEW.kind AND attempt_number = NEW.attempt_number
          AND state = 'printing';
       SELECT CASE WHEN changes() <> 1
         THEN RAISE(ABORT, 'inventory print finalization rejected') END;
       UPDATE inventory_repack_boxes_mirror
          SET print_state = CASE WHEN NEW.result = 'printed' THEN 'printed' ELSE 'failed' END,
              print_error_code = NEW.error_code,
              printed_at = CASE WHEN NEW.result = 'printed' THEN NEW.completed_at ELSE NULL END,
              updated_at = NEW.completed_at
        WHERE NEW.kind = 'initial'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed' AND print_state = 'printing';
       SELECT CASE WHEN NEW.kind = 'initial' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory print box finalization rejected') END;
       UPDATE inventory_repack_boxes_mirror
          SET print_attempt_count = NEW.attempt_number,
              print_error_code = NEW.error_code, updated_at = NEW.completed_at
        WHERE NEW.kind = 'reprint'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND state = 'closed' AND print_state = 'printed';
       SELECT CASE WHEN NEW.kind = 'reprint' AND changes() <> 1
         THEN RAISE(ABORT, 'inventory reprint box finalization rejected') END;
       UPDATE inventory_terminal_state
          SET open_repack_box_id = NULL, updated_at = NEW.completed_at
        WHERE NEW.kind = 'initial' AND NEW.result = 'printed'
          AND inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND device_id = NEW.device_id AND open_repack_box_id = NEW.box_id;
       INSERT INTO inventory_scan_events_mirror
         (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, code_hash, raw_payload,
          active_production_date, local_verdict)
       SELECT NEW.inventory_id, NEW.snapshot_id, NEW.event_id, NEW.device_id,
              NEW.device_sequence, NEW.operator_id, NEW.completed_at, 'repack_action',
              json_extract(NEW.payload_json, '$.normalizedIdentity'), NULL, NULL,
              json_extract(NEW.payload_json, '$.activeProductionDate'), 'repack-action';
       INSERT INTO inventory_outbox
         (inventory_id, snapshot_id, event_id, device_sequence, payload_json, created_at)
       VALUES (NEW.inventory_id, NEW.snapshot_id, NEW.event_id, NEW.device_sequence,
               NEW.payload_json, NEW.completed_at);
     END;`,
  // A losing claim invalidates an unprinted box. Recovery is an explicit,
  // journaled transition: remove its active composition, preserve item/event
  // evidence, resolve the matching conflict rows, and reopen the reserved SSCC.
  `CREATE TRIGGER IF NOT EXISTS inventory_repack_resolve_conflict_v1
     AFTER INSERT ON inventory_repack_journal
     WHEN NEW.action = 'resolve-conflict'
     BEGIN
       UPDATE inventory_conflicts_mirror
          SET state = 'resolved'
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND state = 'open'
          AND losing_event_id IN (
            SELECT source_event_id FROM inventory_repack_items_mirror
             WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
               AND box_id = NEW.box_id AND removed_at IS NULL
          );

       UPDATE inventory_repack_items_mirror
          SET removed_at = NEW.occurred_at
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND removed_at IS NULL;

       UPDATE inventory_repack_boxes_mirror
          SET state = 'open', print_state = 'not_ready', print_attempt_count = 0,
              print_error_code = NULL, closed_event_id = NULL, closed_at = NULL,
              invalidated_at = NULL, printed_at = NULL, updated_at = NEW.occurred_at
        WHERE inventory_id = NEW.inventory_id AND snapshot_id = NEW.snapshot_id
          AND box_id = NEW.box_id AND owner_device_id = NEW.device_id
          AND state = 'invalidated' AND print_attempt_count = 0 AND printed_at IS NULL;
       SELECT CASE WHEN changes() <> 1
         THEN RAISE(ABORT, 'inventory repack conflict resolution rejected') END;
     END;`,
  // Rejected outcomes were added after v2 shipped. A new receipt generation
  // preserves deployed validator SQL while admitting only an exact, bounded,
  // request-bound response and then delegates to the immutable v1 reducer.
  `CREATE TABLE IF NOT EXISTS inventory_sync_ack_receipts_v3 (
     receipt_id TEXT PRIMARY KEY,
     inventory_id TEXT NOT NULL,
     snapshot_id TEXT NOT NULL,
     batch_id TEXT NOT NULL,
     payload_digest TEXT NOT NULL,
     response_json TEXT NOT NULL,
     outbox_rows_json TEXT NOT NULL,
     pin_key TEXT NOT NULL,
     pin_value TEXT NOT NULL,
     applied_at TEXT NOT NULL,
     CHECK (json_valid(response_json) AND length(response_json) <= 8388608),
     CHECK (json_valid(outbox_rows_json) AND length(outbox_rows_json) <= 524288)
   );`,
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_reject_changed_ack_v3
     BEFORE INSERT ON inventory_sync_ack_receipts_v3
     WHEN EXISTS (
       SELECT 1 FROM inventory_sync_ack_receipts_v3 receipt
        WHERE receipt.receipt_id = NEW.receipt_id
          AND NOT (
            receipt.inventory_id IS NEW.inventory_id
            AND receipt.snapshot_id IS NEW.snapshot_id
            AND receipt.batch_id IS NEW.batch_id
            AND receipt.payload_digest IS NEW.payload_digest
            AND receipt.response_json IS NEW.response_json
            AND receipt.outbox_rows_json IS NEW.outbox_rows_json
            AND receipt.pin_key IS NEW.pin_key
            AND receipt.pin_value IS NEW.pin_value
            AND receipt.applied_at IS NEW.applied_at
          )
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory acknowledgement receipt changed');
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_validate_ack_v3
     BEFORE INSERT ON inventory_sync_ack_receipts_v3
     WHEN NOT EXISTS (
       SELECT 1 FROM inventory_sync_ack_receipts_v3 receipt
        WHERE receipt.receipt_id = NEW.receipt_id
          AND receipt.inventory_id IS NEW.inventory_id
          AND receipt.snapshot_id IS NEW.snapshot_id
          AND receipt.batch_id IS NEW.batch_id
          AND receipt.payload_digest IS NEW.payload_digest
          AND receipt.response_json IS NEW.response_json
          AND receipt.outbox_rows_json IS NEW.outbox_rows_json
          AND receipt.pin_key IS NEW.pin_key
          AND receipt.pin_value IS NEW.pin_value
          AND receipt.applied_at IS NEW.applied_at
     ) AND NOT (
       json_valid(NEW.response_json)
       AND json_valid(NEW.outbox_rows_json)
       AND json_valid(NEW.pin_value)
       AND json_type(NEW.response_json, '$') = 'object'
       AND json_type(NEW.outbox_rows_json, '$') = 'array'
       AND json_type(NEW.pin_value, '$') = 'object'
       AND (SELECT COUNT(*) FROM json_each(NEW.response_json)) = 8
       AND (SELECT COUNT(*) FROM json_each(NEW.pin_value)) = 5
       AND json_extract(NEW.response_json, '$.inventoryId') IS NEW.inventory_id
       AND json_extract(NEW.response_json, '$.snapshotId') IS NEW.snapshot_id
       AND json_extract(NEW.response_json, '$.snapshotRevision') IS 1
       AND json_extract(NEW.response_json, '$.batchId') IS NEW.batch_id
       AND json_extract(NEW.response_json, '$.payloadDigest') IS NEW.payload_digest
       AND json_type(NEW.response_json, '$.sequenceCeiling') = 'integer'
       AND json_type(NEW.response_json, '$.resultRevision') = 'integer'
       AND json_extract(NEW.response_json, '$.resultRevision') >= 0
       AND json_type(NEW.response_json, '$.outcomes') = 'array'
       AND json_array_length(NEW.response_json, '$.outcomes') BETWEEN 1 AND 100
       AND json_extract(NEW.pin_value, '$.inventoryId') IS NEW.inventory_id
       AND json_extract(NEW.pin_value, '$.snapshotId') IS NEW.snapshot_id
       AND json_type(NEW.pin_value, '$.deviceId') = 'text'
       AND json_type(NEW.pin_value, '$.request') = 'object'
       AND json_type(NEW.pin_value, '$.outboxRows') = 'array'
       AND NEW.receipt_id = NEW.inventory_id || ':' || NEW.snapshot_id || ':' ||
            NEW.batch_id || ':' || NEW.payload_digest
       AND NEW.pin_key = 'inventory_sync_batch_v1:' || NEW.inventory_id || ':' || NEW.snapshot_id
       AND json_extract(NEW.pin_value, '$.request.snapshotId') IS NEW.snapshot_id
       AND json_extract(NEW.pin_value, '$.request.snapshotRevision') IS 1
       AND json_extract(NEW.pin_value, '$.request.batchId') IS NEW.batch_id
       AND json_extract(NEW.pin_value, '$.request.payloadDigest') IS NEW.payload_digest
       AND json_extract(NEW.pin_value, '$.request.sequenceCeiling') IS
            json_extract(NEW.response_json, '$.sequenceCeiling')
       AND json_type(NEW.pin_value, '$.request.events') = 'array'
       AND json_type(NEW.pin_value, '$.request.events[#-1].scannedAt') = 'text'
       AND NEW.applied_at = json_extract(NEW.pin_value, '$.request.events[#-1].scannedAt')
       AND json_array_length(NEW.outbox_rows_json) BETWEEN 1 AND 100
       AND json_array_length(NEW.response_json, '$.outcomes') =
            json_array_length(NEW.outbox_rows_json)
       AND json_array_length(NEW.pin_value, '$.request.events') =
            json_array_length(NEW.outbox_rows_json)
       AND json(NEW.outbox_rows_json) = json(json_extract(NEW.pin_value, '$.outboxRows'))
       AND EXISTS (
         SELECT 1 FROM station_meta pin
          WHERE pin.key = NEW.pin_key AND pin.value = NEW.pin_value
       )
       AND EXISTS (
         SELECT 1 FROM inventory_terminal_state terminal
          WHERE terminal.inventory_id = NEW.inventory_id
            AND terminal.snapshot_id = NEW.snapshot_id
            AND terminal.device_id = json_extract(NEW.pin_value, '$.deviceId')
       )
       AND NOT EXISTS (
         SELECT 1 FROM json_each(NEW.outbox_rows_json) pinned
          WHERE json_type(pinned.value, '$') <> 'object'
             OR (SELECT COUNT(*) FROM json_each(pinned.value)) <> 3
             OR json_type(pinned.value, '$.id') <> 'integer'
             OR json_type(pinned.value, '$.eventId') <> 'text'
             OR json_type(pinned.value, '$.payloadJson') <> 'text'
             OR NOT EXISTS (
               SELECT 1 FROM inventory_outbox queued
                WHERE queued.id = json_extract(pinned.value, '$.id')
                  AND queued.inventory_id = NEW.inventory_id
                  AND queued.snapshot_id = NEW.snapshot_id
                  AND queued.event_id = json_extract(pinned.value, '$.eventId')
                  AND queued.payload_json = json_extract(pinned.value, '$.payloadJson')
             )
             OR (SELECT COUNT(*) FROM json_each(NEW.pin_value, '$.request.events') event
                  WHERE json_extract(event.value, '$.eventId') =
                        json_extract(pinned.value, '$.eventId')) <> 1
       )
       AND (SELECT COUNT(DISTINCT json_extract(pinned.value, '$.id'))
              FROM json_each(NEW.outbox_rows_json) pinned) = json_array_length(NEW.outbox_rows_json)
       AND (SELECT COUNT(DISTINCT json_extract(pinned.value, '$.eventId'))
              FROM json_each(NEW.outbox_rows_json) pinned) = json_array_length(NEW.outbox_rows_json)
       AND NOT EXISTS (
         SELECT 1 FROM json_each(NEW.response_json, '$.outcomes') outcome
          WHERE json_type(outcome.value, '$') <> 'object'
             OR (SELECT COUNT(*) FROM json_each(outcome.value)) <> 6
             OR json_type(outcome.value, '$.eventId') <> 'text'
             OR json_type(outcome.value, '$.status') <> 'text'
             OR json_type(outcome.value, '$.reasonCode') <> 'text'
             OR json_type(outcome.value, '$.claimedCount') <> 'integer'
             OR json_type(outcome.value, '$.conflictCount') <> 'integer'
             OR json_type(outcome.value, '$.claims') <> 'array'
             OR json_extract(outcome.value, '$.claimedCount') < 0
             OR json_extract(outcome.value, '$.conflictCount') < 0
             OR json_extract(outcome.value, '$.claimedCount') <>
                  (SELECT COUNT(*) FROM json_each(outcome.value, '$.claims') claim
                    WHERE json_extract(claim.value, '$.status') = 'claimed')
             OR json_extract(outcome.value, '$.conflictCount') <>
                  (SELECT COUNT(*) FROM json_each(outcome.value, '$.claims') claim
                    WHERE json_extract(claim.value, '$.status') = 'duplicate')
             OR json_array_length(outcome.value, '$.claims') > 10000
             OR NOT (
               (json_extract(outcome.value, '$.status') = 'applied'
                 AND json_extract(outcome.value, '$.reasonCode') = 'CLAIM_APPLIED'
                 AND (json_extract(outcome.value, '$.claimedCount') > 0 OR (
                   json_array_length(outcome.value, '$.claims') = 0 AND EXISTS (
                     SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
                      WHERE json_extract(event.value, '$.eventId') =
                            json_extract(outcome.value, '$.eventId')
                        AND json_extract(event.value, '$.kind') IN ('old_box', 'repack_action')
                   )
                 )))
               OR (json_extract(outcome.value, '$.status') = 'duplicate'
                 AND json_extract(outcome.value, '$.reasonCode') = 'CLAIM_LOST'
                 AND json_extract(outcome.value, '$.claimedCount') = 0
                 AND json_extract(outcome.value, '$.conflictCount') > 0)
               OR (json_extract(outcome.value, '$.status') = 'replay'
                 AND json_extract(outcome.value, '$.reasonCode') = 'BATCH_REPLAY')
               OR (json_extract(outcome.value, '$.status') = 'rejected'
                 AND json_extract(outcome.value, '$.reasonCode') = 'INVENTORY_EVENT_REJECTED'
                 AND json_extract(outcome.value, '$.claimedCount') = 0
                 AND json_extract(outcome.value, '$.conflictCount') = 0
                 AND json_array_length(outcome.value, '$.claims') = 0)
               OR (json_extract(outcome.value, '$.status') = 'quarantined'
                 AND json_extract(outcome.value, '$.reasonCode') IN
                   ('INVENTORY_CLOSED', 'INVENTORY_COMPLETED')
                 AND json_extract(outcome.value, '$.claimedCount') = 0
                 AND json_extract(outcome.value, '$.conflictCount') = 0
                 AND json_array_length(outcome.value, '$.claims') = 0)
             )
             OR (SELECT COUNT(*) FROM json_each(NEW.outbox_rows_json) pinned
                  WHERE json_extract(pinned.value, '$.eventId') =
                        json_extract(outcome.value, '$.eventId')) <> 1
             OR (SELECT COUNT(*) FROM json_each(NEW.pin_value, '$.request.events') event
                  WHERE json_extract(event.value, '$.eventId') =
                        json_extract(outcome.value, '$.eventId')) <> 1
             OR EXISTS (
               SELECT 1 FROM json_each(outcome.value, '$.claims') claim
                WHERE json_type(claim.value, '$') <> 'object'
                   OR (SELECT COUNT(*) FROM json_each(claim.value)) <> 3
                   OR (SELECT COUNT(*) FROM json_each(claim.value, '$.winner')) <> 4
                   OR json_type(claim.value, '$.codeHash') <> 'text'
                   OR length(json_extract(claim.value, '$.codeHash')) <> 64
                   OR json_extract(claim.value, '$.codeHash') GLOB '*[^0-9a-f]*'
                   OR json_extract(claim.value, '$.status') NOT IN ('claimed', 'duplicate')
                   OR json_type(claim.value, '$.winner') <> 'object'
                   OR json_extract(claim.value, '$.winner.codeHash') IS NOT
                        json_extract(claim.value, '$.codeHash')
                   OR json_type(claim.value, '$.winner.eventId') <> 'text'
                   OR json_type(claim.value, '$.winner.deviceId') <> 'text'
                   OR json_type(claim.value, '$.winner.scannedAt') <> 'text'
                   OR (json_extract(claim.value, '$.status') = 'claimed' AND (
                     json_extract(claim.value, '$.winner.eventId') IS NOT
                       json_extract(outcome.value, '$.eventId')
                     OR json_extract(claim.value, '$.winner.deviceId') IS NOT
                       json_extract(NEW.pin_value, '$.deviceId')
                     OR json_extract(claim.value, '$.winner.scannedAt') IS NOT (
                       SELECT json_extract(event.value, '$.scannedAt')
                         FROM json_each(NEW.pin_value, '$.request.events') event
                        WHERE json_extract(event.value, '$.eventId') =
                              json_extract(outcome.value, '$.eventId')
                     )
                   ))
                   OR (json_extract(claim.value, '$.status') = 'duplicate'
                     AND json_extract(claim.value, '$.winner.eventId') IS
                          json_extract(outcome.value, '$.eventId'))
             )
             OR EXISTS (
               SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
                WHERE json_extract(event.value, '$.eventId') =
                      json_extract(outcome.value, '$.eventId')
                  AND json_extract(event.value, '$.kind') IN ('old_box', 'repack_action')
                  AND json_array_length(outcome.value, '$.claims') <> 0
             )
             OR EXISTS (
               SELECT 1 FROM json_each(NEW.pin_value, '$.request.events') event
                WHERE json_extract(event.value, '$.eventId') =
                      json_extract(outcome.value, '$.eventId')
                  AND json_extract(event.value, '$.kind') = 'item'
                  AND json_array_length(outcome.value, '$.claims') > 0
                  AND (json_type(event.value, '$.codeHash') <> 'text'
                    OR json_array_length(outcome.value, '$.claims') <> 1
                    OR json_extract(outcome.value, '$.claims[0].codeHash') IS NOT
                         json_extract(event.value, '$.codeHash'))
             )
       )
       AND (SELECT COUNT(DISTINCT json_extract(outcome.value, '$.eventId'))
              FROM json_each(NEW.response_json, '$.outcomes') outcome) =
            json_array_length(NEW.response_json, '$.outcomes')
       AND (SELECT COUNT(*) FROM json_each(NEW.response_json, '$.outcomes') outcome,
                  json_each(outcome.value, '$.claims') claim) <= 10000
     )
     BEGIN
       SELECT RAISE(ABORT, 'inventory acknowledgement receipt invalid');
     END;`,
  `CREATE TRIGGER IF NOT EXISTS inventory_sync_apply_ack_v3
     AFTER INSERT ON inventory_sync_ack_receipts_v3
     BEGIN
       INSERT INTO inventory_sync_ack_receipts (
         receipt_id, inventory_id, snapshot_id, batch_id, payload_digest,
         response_json, outbox_rows_json, pin_key, pin_value, applied_at
       ) VALUES (
         NEW.receipt_id, NEW.inventory_id, NEW.snapshot_id, NEW.batch_id,
         NEW.payload_digest, NEW.response_json, NEW.outbox_rows_json,
         NEW.pin_key, NEW.pin_value, NEW.applied_at
       ) ON CONFLICT(receipt_id) DO NOTHING;
     END;`,
];

export interface StationMigrationEntry {
  readonly id: string;
  readonly sql: string;
}

/**
 * Stable append-only identities for runtime dispatch. The numeric identity is
 * the statement's historical append position; existing entries must never be
 * reordered. STATION_MIGRATIONS remains the compatibility SQL export.
 */
export const STATION_MIGRATION_ENTRIES: readonly StationMigrationEntry[] = STATION_MIGRATIONS.map(
  (sql, index) => ({
    id: `station-sqlite-${String(index).padStart(3, "0")}`,
    sql,
  }),
);

/** Exact legacy audit identities; never infer these from SQL text. */
export const SUPERSEDED_INVENTORY_LEGACY_AUDIT_MIGRATION_IDS = [
  "station-sqlite-078",
  "station-sqlite-079",
  "station-sqlite-081",
  "station-sqlite-082",
] as const;
