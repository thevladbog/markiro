import { z } from "zod";

import {
  shiftModeSchema,
  shiftOriginSchema,
  shiftStatusSchema,
  type DeviceShift,
  type EnteredShift,
  type ShiftMode,
  type ShiftOrigin,
  type ShiftStatus,
} from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  checkShiftSnapshot,
  type CheckedSnapshot,
  type SnapshotRefusal,
} from "./shift-snapshot.js";

/**
 * A shift as this station keeps it (`floor_shifts`, migration `0006`): what
 * the host's last list said, this station's own close (`localState`, plan
 * 2a8), and whether it entered the shift and keeps its snapshot.
 */
export interface ShiftCopy {
  id: string;
  number: string;
  status: ShiftStatus;
  localState: "closing" | "closed" | null;
  mode: ShiftMode;
  palletsEnabled: boolean;
  createdFrom: ShiftOrigin;
  lineId: string;
  productId: string;
  productName: string;
  productGtin14: string;
  counterpartyName: string | null;
  productionDate: string;
  plannedQty: number | null;
  boxCapacity: number;
  boxTemplateId: string;
  ownerDeviceId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  entered: boolean;
}

/** A shift the station works: its copy and the snapshot this build read. */
export interface WorkShift {
  copy: ShiftCopy;
  snapshot: CheckedSnapshot;
}

/** The host's fields of a shift: its column and the `DeviceShift` key it comes from. */
const HOST_FIELDS = [
  ["id", "id"],
  ["number", "number"],
  ["status", "status"],
  ["mode", "mode"],
  ["pallets_enabled", "palletsEnabled"],
  ["created_from", "createdFrom"],
  ["line_id", "lineId"],
  ["product_id", "productId"],
  ["product_name", "productName"],
  ["product_gtin14", "productGtin14"],
  ["counterparty_name", "counterpartyName"],
  ["production_date", "productionDate"],
  ["planned_qty", "plannedQty"],
  ["box_capacity", "boxCapacity"],
  ["box_template_id", "boxTemplateId"],
  ["owner_device_id", "ownerDeviceId"],
  ["opened_at", "openedAt"],
  ["closed_at", "closedAt"],
] as const;

const COLUMNS = HOST_FIELDS.map(([column]) => column).join(", ");
// `->>` yields a JSON boolean as 1 or 0 and a JSON null as NULL.
const VALUES = HOST_FIELDS.map(([, key]) => `value ->> '${key}'`).join(", ");
const UPDATES = HOST_FIELDS.filter(([column]) => column !== "id")
  .map(([column]) => `${column} = excluded.${column}`)
  .join(", ");

/**
 * A status as a number. The host moves a shift one way only, planned, then
 * active, then closed (it never reopens one: `enter_shift` refuses a closed
 * shift), so a status lower than the stored one comes from a list or an
 * answer read before the stored one and applied after it: two refreshes that
 * overlap, or a list read before this station's entry.
 */
function rank(status: string): string {
  return `(CASE ${status} WHEN 'planned' THEN 0 WHEN 'active' THEN 1 ELSE 2 END)`;
}

/** True when the incoming row says a lower status than the stored one. */
const BEHIND = `${rank("excluded.status")} < ${rank("floor_shifts.status")}`;

/** The host's fields on an entry: each stays as stored when the answer is behind it. */
const KEPT_UPDATES = HOST_FIELDS.filter(([column]) => column !== "id")
  .map(
    ([column]) =>
      `${column} = CASE WHEN ${BEHIND} THEN floor_shifts.${column} ELSE excluded.${column} END`,
  )
  .join(", ");

/**
 * The host's fields of every shift in the JSON array parameter, as this
 * pairing's: new rows come in, known ones take the host's values, and the
 * station's own columns (`snapshot`, `entered_at`, `local_state`) are never
 * touched. A row whose status is behind the stored one is skipped whole, the
 * stored status, owner and times with it: a shift this station entered never
 * goes back to `planned`, and one the host closed does not reopen. A shift
 * listed twice keeps the higher status. Parameters: host id, device id, seen
 * at, the array.
 */
const UPSERT =
  `INSERT INTO floor_shifts (host_id, device_id, ${COLUMNS}, seen_at) ` +
  `SELECT ?, ?, ${VALUES}, ? FROM json_each(?) WHERE true ` +
  `ON CONFLICT (host_id, device_id, id) DO UPDATE SET ${UPDATES}, seen_at = excluded.seen_at ` +
  `WHERE NOT (${BEHIND})`;

/**
 * This pairing's shifts the host no longer lists and this station never
 * entered: planned shifts the office deleted or moved to another line, the
 * old line's shifts after the station was moved, and shifts the office closed
 * before this station entered them (the host lists the line's active shifts,
 * whoever owns them, so another station's open shift stays as a busy copy). A
 * shift this station entered stays, with its snapshot, whatever the list says,
 * a host-closed one too, which the host stops listing after a while: its facts
 * name it (plan 2a8 decides when it goes). Parameters: host id, device id, the
 * listed shifts.
 */
const DROP_UNLISTED =
  "DELETE FROM floor_shifts WHERE host_id = ? AND device_id = ? AND entered_at IS NULL " +
  "AND id NOT IN (SELECT value ->> 'id' FROM json_each(?))";

/**
 * What the station keeps when it enters: the host's fields, the snapshot and
 * the time of the first entry. A later entry (the owner's re-entry) takes the
 * answer's snapshot again and keeps the first entry time. The host freezes the
 * snapshot when the shift opens and returns that same one on every re-entry,
 * but the stored text is this build's reading of it, which drops what the
 * build does not know (`shiftSnapshotSchema`): a re-entry brings back a field
 * the stored copy lost, for instance after an upgrade in the middle of a
 * shift. The host's fields of an answer that is behind the stored status (a
 * late answer of an entry the office closed the shift meanwhile) are not
 * taken, but the snapshot and the entry time are. Parameters: host id, device
 * id, seen at, the snapshot, the time of the entry, the shift (a one-item
 * array).
 */
const KEEP_ENTERED =
  `INSERT INTO floor_shifts (host_id, device_id, ${COLUMNS}, seen_at, snapshot, entered_at) ` +
  `SELECT ?, ?, ${VALUES}, ?, ?, ? FROM json_each(?) WHERE true ` +
  `ON CONFLICT (host_id, device_id, id) DO UPDATE SET ${KEPT_UPDATES}, ` +
  "seen_at = excluded.seen_at, " +
  "snapshot = excluded.snapshot, " +
  "entered_at = coalesce(floor_shifts.entered_at, excluded.entered_at)";

/**
 * Replaces this pairing's copies with the host's list (`GET /v1/device/shifts`)
 * in one transaction (stage 2a spec §5.4). `shifts` must be the host's whole
 * parsed answer, never a fallback or a partial list: an empty array drops every
 * copy this station has not entered. Another pairing's rows, kept by a forget
 * with records not yet sent, are never touched.
 */
export async function replaceShiftCopies(
  local: LocalExecutor,
  pairing: Pairing,
  shifts: readonly DeviceShift[],
  seenAt: number,
): Promise<void> {
  const listed = JSON.stringify(shifts);
  await local.transaction([
    { sql: DROP_UNLISTED, values: [pairing.hostId, pairing.deviceId, listed] },
    { sql: UPSERT, values: [pairing.hostId, pairing.deviceId, seenAt, listed] },
  ]);
}

/** Keeps the shift this station has just created, before any list brings it. */
export async function keepCreatedShift(
  local: LocalExecutor,
  pairing: Pairing,
  shift: DeviceShift,
  seenAt: number,
): Promise<void> {
  await local.transaction([
    { sql: UPSERT, values: [pairing.hostId, pairing.deviceId, seenAt, JSON.stringify([shift])] },
  ]);
}

/**
 * Keeps the answer of an entry: the shift and its snapshot, which must pass
 * `checkShiftSnapshot` (a snapshot that does not is refused here, so that no
 * path stores one this build cannot work from; the entry screen checks first
 * and tells the operator why). The stored text is the answer's snapshot as
 * this build parsed it, the layout as the host sent it: a field a newer host
 * added to the product is dropped. A re-entry replaces the stored text with
 * the answer's (it may carry a field the stored one lost); the first entry
 * time stays.
 */
export async function keepEnteredShift(
  local: LocalExecutor,
  pairing: Pairing,
  shift: EnteredShift,
  enteredAt: string,
  seenAt: number,
): Promise<void> {
  const { snapshot, ...fields } = shift;
  const checked = checkShiftSnapshot(snapshot, shift.palletsEnabled);
  if (!checked.ok) {
    throw new Error(`keepEnteredShift: a snapshot to work from is required (${checked.reason})`);
  }
  const statement: LocalStatement = {
    sql: KEEP_ENTERED,
    values: [
      pairing.hostId,
      pairing.deviceId,
      seenAt,
      JSON.stringify(snapshot),
      enteredAt,
      JSON.stringify([fields]),
    ],
    expectedChanges: 1,
  };
  await local.transaction([statement]);
}

const copyRow = z.object({
  id: z.string(),
  number: z.string(),
  status: shiftStatusSchema,
  local_state: z.enum(["closing", "closed"]).nullable(),
  mode: shiftModeSchema,
  pallets_enabled: z.number(),
  created_from: shiftOriginSchema,
  line_id: z.string(),
  product_id: z.string(),
  product_name: z.string(),
  product_gtin14: z.string(),
  counterparty_name: z.string().nullable(),
  production_date: z.string(),
  planned_qty: z.number().nullable(),
  box_capacity: z.number(),
  box_template_id: z.string(),
  owner_device_id: z.string().nullable(),
  opened_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  entered: z.number(),
});

const COPY_COLUMNS =
  "id, number, status, local_state, mode, pallets_enabled, created_from, line_id, product_id, " +
  "product_name, product_gtin14, counterparty_name, production_date, planned_qty, " +
  "box_capacity, box_template_id, owner_device_id, opened_at, closed_at, " +
  "entered_at IS NOT NULL AS entered";

function toCopy(row: z.infer<typeof copyRow>): ShiftCopy {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    localState: row.local_state,
    mode: row.mode,
    palletsEnabled: row.pallets_enabled === 1,
    createdFrom: row.created_from,
    lineId: row.line_id,
    productId: row.product_id,
    productName: row.product_name,
    productGtin14: row.product_gtin14,
    counterpartyName: row.counterparty_name,
    productionDate: row.production_date,
    plannedQty: row.planned_qty,
    boxCapacity: row.box_capacity,
    boxTemplateId: row.box_template_id,
    ownerDeviceId: row.owner_device_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    entered: row.entered === 1,
  };
}

/**
 * The shifts of `lineId` the floor's list shows, from this pairing's copies:
 * planned and active ones, one this station is closing, and one the office
 * closed after this station entered it and before this station closed it
 * (plan 2a8: the station finishes it); neither another shift the host closed
 * nor one this station closed. By production date, then number.
 */
export async function readShiftCopies(
  local: LocalExecutor,
  pairing: Pairing,
  lineId: string,
): Promise<ShiftCopy[]> {
  const rows = await local.query(
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? ` +
      "AND line_id = ? AND (status <> 'closed' OR entered_at IS NOT NULL) " +
      "AND (local_state IS NULL OR local_state = 'closing') " +
      "ORDER BY production_date, number, id",
    [pairing.hostId, pairing.deviceId, lineId],
    copyRow,
  );
  return rows.map(toCopy);
}

/** One shift of this pairing's copies, or `null`. */
export async function readShiftCopy(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<ShiftCopy | null> {
  const [row] = await local.query(
    `SELECT ${COPY_COLUMNS} FROM floor_shifts WHERE host_id = ? AND device_id = ? AND id = ?`,
    [pairing.hostId, pairing.deviceId, shiftId],
    copyRow,
  );
  return row === undefined ? null : toCopy(row);
}

/**
 * A stored shift to work: there, not entered here, or entered with a snapshot
 * this build does not read. `ready` says only that the snapshot is readable:
 * the copy may be host-closed (`status`) or closed here (`localState`), and
 * the caller decides what a closed shift is offered (plan 2a5 Tasks 5 and 7).
 */
export type StoredWork =
  | { kind: "ready"; shift: WorkShift }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: SnapshotRefusal };

const storedRow = copyRow.extend({ snapshot: z.string().nullable() });

/**
 * A shift this station entered, with its stored snapshot checked again: what
 * the station works from without the host (stage 2a spec §5.4) and what the
 * work screen reads. One read, so that the copy and the snapshot are of the
 * same moment.
 */
export async function readStoredWork(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<StoredWork> {
  const [row] = await local.query(
    `SELECT ${COPY_COLUMNS}, snapshot FROM floor_shifts ` +
      "WHERE host_id = ? AND device_id = ? AND id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    storedRow,
  );
  if (row === undefined || row.snapshot === null) return { kind: "missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(row.snapshot);
  } catch {
    return { kind: "unreadable", reason: "shape" };
  }
  const checked = checkShiftSnapshot(raw, row.pallets_enabled === 1);
  return checked.ok
    ? { kind: "ready", shift: { copy: toCopy(row), snapshot: checked.snapshot } }
    : { kind: "unreadable", reason: checked.reason };
}
