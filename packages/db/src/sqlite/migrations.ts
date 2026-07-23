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
     default_label_template_id TEXT
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
];
