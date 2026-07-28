import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Station-local key/value metadata (e.g. current terminal id, last sync). */
export const stationMeta = sqliteTable("station_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

/**
 * Local mirror of operators for OFFLINE PIN/badge login. Seeded from the
 * shift bundle (Task 9); the credential columns hold PBKDF2 PHC verifiers
 * (see the credential-hash contract). The server operators table is a
 * PARALLEL workstream (05b) — 05a only ever reads/writes this local mirror.
 */
export const operatorsMirror = sqliteTable("operators_mirror", {
  operatorId: text("operator_id").primaryKey(),
  name: text("name").notNull(),
  // Nullable in SQLite only because devices enrolled before this column
  // existed already have rows; the server always sends a login and the first
  // roster sync replaces the whole set (see readOperatorsMirror's `?? ""`).
  login: text("login"),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  badgeHash: text("badge_hash"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

/**
 * The second roster slot. `operators_mirror` and this table hold alternating
 * generations of the same roster; `station_meta.operators_slot` names the
 * active one. See `replaceOperatorsMirror` for why publication needs two
 * tables rather than a generation column.
 */
export const operatorsMirrorB = sqliteTable("operators_mirror_b", {
  operatorId: text("operator_id").primaryKey(),
  name: text("name").notNull(),
  // Nullable to match operators_mirror: the two slots must be interchangeable
  // for alternation to be sound (see replaceOperatorsMirror), and a NOT NULL
  // asymmetry here buys nothing but a landmine — a null `login` from the
  // server (roster-sync.ts takes the network payload on an unchecked type
  // assertion) would succeed whenever this slot happens to be inactive and
  // throw whenever it's the publish target, freezing the roster on whichever
  // slot tolerates it. See readOperatorsMirror's `?? ""`.
  login: text("login"),
  role: text("role").notNull(),
  pinHash: text("pin_hash").notNull(),
  badgeHash: text("badge_hash"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

/** Local mirror of the downloaded shift, incl. the label template spec json. */
export const shiftMirror = sqliteTable("shift_mirror", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  mode: text("mode").notNull(),
  productId: text("product_id").notNull(),
  productName: text("product_name"),
  lineId: text("line_id"),
  lineName: text("line_name"),
  counterpartyId: text("counterparty_id"),
  counterpartyName: text("counterparty_name"),
  counterpartyGln: text("counterparty_gln"),
  labelTemplateId: text("label_template_id"),
  labelTemplateName: text("label_template_name"),
  labelTemplateSpec: text("label_template_spec"),
  plannedQty: integer("planned_qty"),
  plannedDate: text("planned_date"),
  boxCapacity: integer("box_capacity"),
  palletCapacity: integer("pallet_capacity"),
  palletsEnabled: integer("pallets_enabled", { mode: "boolean" }).notNull().default(false),
  openedAt: text("opened_at"),
});

/** Local mirror of the shift's product (for ad-hoc GTIN resolution offline). */
export const productMirror = sqliteTable("product_mirror", {
  id: text("id").primaryKey(),
  gtin14: text("gtin14").notNull(),
  name: text("name").notNull(),
  productGroup: text("product_group"),
  boxCapacity: integer("box_capacity"),
  palletCapacity: integer("pallet_capacity"),
  status: text("status").notNull(),
  defaultCounterpartyId: text("default_counterparty_id"),
  defaultLabelTemplateId: text("default_label_template_id"),
});

/**
 * Local journal mirror of server `codes` (05b writes here; 05a only defines
 * the schema). Columns mirror packages/db/src/schema/codes.ts.
 */
export const codesMirror = sqliteTable("codes_mirror", {
  codeHash: text("code_hash").primaryKey(),
  shiftId: text("shift_id").notNull(),
  gtin14: text("gtin14").notNull(),
  serial: text("serial").notNull(),
  scannedAt: text("scanned_at").notNull(),
});

/** Local journal mirror of server `scan_events` (05b writes here). */
export const scanEventsMirror = sqliteTable("scan_events_mirror", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: text("scanned_at").notNull(),
});

/**
 * Device-local transport queue: one row per scan, drained to the server and
 * deleted on acknowledgement. Deliberately separate from `codes_mirror` —
 * that table serves duplicate detection and will be purged on a retention
 * schedule, and transport state must not be governed by retention.
 */
export const outbox = sqliteTable("outbox", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: text("scanned_at").notNull(),
  codeHash: text("code_hash"),
  gtin14: text("gtin14"),
  serial: text("serial"),
});

/**
 * Device-local mirror of conflicts the server reported for this terminal's
 * own losing scans (the earlier `scannedAt` elsewhere wins). Keyed by
 * `codeHash` so re-reporting the same conflict is idempotent — one
 * statement, no device transaction. `winningTerminalId`/`winningScannedAt`
 * come straight off the server's `BatchConflictDto`; `detectedAt` is when
 * this device recorded it, for sorting the operator's list newest-first.
 */
export const conflictsMirror = sqliteTable("conflicts_mirror", {
  codeHash: text("code_hash").primaryKey(),
  winningTerminalId: text("winning_terminal_id"),
  winningScannedAt: text("winning_scanned_at").notNull(),
  detectedAt: text("detected_at").notNull(),
});

/**
 * A local operator record after offline hydration. `pinHash`/`badgeHash` are
 * PBKDF2 PHC verifiers (see the credential-hash contract). This is the exact
 * shape the server station-bundle `operators` field will carry in 05b — in
 * 05a that field is MOCKED as `[]`.
 */
export interface OperatorMirrorRecord {
  operatorId: string;
  name: string;
  login: string;
  role: string;
  pinHash: string;
  badgeHash: string | null;
  active: boolean;
}
