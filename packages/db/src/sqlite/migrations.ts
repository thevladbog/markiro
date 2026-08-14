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
];
