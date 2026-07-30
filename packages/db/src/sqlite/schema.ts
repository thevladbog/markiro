import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  // This device's box-SSCC issuer prefix (Task 13 review, plan 06c) -- see
  // migrations.ts's ALTER for why this trails the rest of the table.
  issuerPrefix: text("issuer_prefix"),
  // The box label's OWN template spec (CodeRabbit PR33 review, Finding 3) --
  // entirely separate from labelTemplateSpec above, which is the ITEM
  // template. See migrations.ts's trailing ALTER for why this trails the
  // rest of the table too.
  boxLabelTemplateSpec: text("box_label_template_spec"),
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
 *
 * `boxId` (Task 9, plan 06c) is the box this code was scanned into, if any --
 * a plain column rather than a join table, so it rides the insert `recordScan`
 * already makes here instead of widening its compensate-on-failure surface.
 */
export const codesMirror = sqliteTable("codes_mirror", {
  codeHash: text("code_hash").primaryKey(),
  shiftId: text("shift_id").notNull(),
  gtin14: text("gtin14").notNull(),
  serial: text("serial").notNull(),
  scannedAt: text("scanned_at").notNull(),
  boxId: text("box_id"),
});

/**
 * Local journal mirror of server `scan_events` (05b writes here).
 *
 * `operatorId` (Task 9, plan 06c) attributes the scan to the operator signed
 * in when it happened -- captured here because, unlike a report, an
 * attribution never recorded cannot be recovered later.
 */
export const scanEventsMirror = sqliteTable("scan_events_mirror", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  raw: text("raw").notNull(),
  verdict: text("verdict").notNull(),
  scannedAt: text("scanned_at").notNull(),
  operatorId: text("operator_id"),
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
  // Task 9, plan 06c: carried alongside the other code fields so the server
  // can attribute a synced scan to its box and to the operator who made it.
  boxId: text("box_id"),
  operatorId: text("operator_id"),
});

/**
 * The device's local mirror of transport boxes (Task 9, plan 06c): one row
 * per box this device has opened, written by `apps/station/src/lib/boxes.ts`.
 * Box membership of a scanned code is a column on `codes_mirror`
 * (`codesMirror.boxId` above), not a join table — see `recordScan`'s doc
 * comment in `journal.ts` for why a fourth write was rejected there.
 * `terminalId` is the box's OWN terminal, captured at open time (Task 11) so
 * a closure can report it from this row rather than whatever the device
 * considers "current" when it happens to sync. `ackedAt` is what stops a
 * closed box being resent for the rest of the shift, set by the sync engine
 * (Task 11) beside the outbox ack.
 */
export const boxesMirror = sqliteTable("boxes_mirror", {
  boxId: text("box_id").primaryKey(),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  sscc: text("sscc"),
  openedAt: text("opened_at").notNull(),
  closedAt: text("closed_at"),
  closedBy: text("closed_by"),
  ackedAt: text("acked_at"),
  printVerifiedAt: text("print_verified_at"),
  printSkippedAt: text("print_skipped_at"),
  disassembledAt: text("disassembled_at"),
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
 * The device-local queue for exception facts (undo/clear/reprint/disassemble):
 * one row per exception event, drained to the server and deleted on
 * acknowledgement. Similar to outbox but for box exceptions rather than scans.
 * Rows are pure facts, never updated in place after insert — a plain
 * monotonic id ceiling is enough for ack tracking (see sync.ts's
 * box-exceptions read/ack functions).
 */
export const boxExceptionsMirror = sqliteTable("box_exceptions_mirror", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  boxId: text("box_id").notNull(),
  codeHash: text("code_hash"),
  shiftId: text("shift_id").notNull(),
  terminalId: text("terminal_id"),
  operatorId: text("operator_id"),
  reason: text("reason"),
  at: text("at").notNull(),
});

/**
 * The device's local SSCC serial pool: ranges the server handed down for
 * this device's own issuer prefix, burned one serial at a time by
 * `apps/station/src/lib/sscc-pool.ts`. Keyed by the 9-digit issuer PREFIX,
 * not a GLN -- see `ssccCounters` in `../schema/platform.ts` for why the
 * prefix, not the GLN, is the number space's identity. The primary key on
 * (issuerPrefix, extensionDigit, fromSerial) is what makes a replayed bundle
 * harmless: the same block cannot be inserted twice.
 */
export const ssccPool = sqliteTable(
  "sscc_pool",
  {
    issuerPrefix: text("issuer_prefix").notNull(),
    extensionDigit: integer("extension_digit").notNull(),
    fromSerial: integer("from_serial").notNull(),
    toSerial: integer("to_serial").notNull(),
    nextSerial: integer("next_serial").notNull(),
  },
  (t) => [primaryKey({ columns: [t.issuerPrefix, t.extensionDigit, t.fromSerial] })],
);

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
