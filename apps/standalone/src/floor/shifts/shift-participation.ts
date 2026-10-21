import { z } from "zod";

import {
  deviceShiftTotalsSchema,
  deviceTotalsSchema,
  maxStationsSchema,
  participantStateSchema,
  shiftParticipantSchema,
  type DeviceShift,
  type DeviceShiftTotals,
  type DeviceTotals,
  type ParticipantState,
  type ShiftParticipant,
} from "../../host/protocol.js";
import type { LocalExecutor, LocalStatement } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";

/**
 * A shift several devices may work, as the host's last read of it said (plan 2b, migration
 * `0022`): the line's limit, every device that entered it (first entry first), this station's own
 * state (`null`: it never entered), the whole shift's totals and each device's part at `asOf`, the
 * host's time (for a closed shift: the last answer that had them, host D14 as amended); the pause
 * this station asked for and the host has not answered yet; and this station's leave token
 * (`joinedRev` of its own participant row, `null` while no answer named one).
 */
export interface Participation {
  shiftId: string;
  maxStations: number;
  myState: ParticipantState | null;
  participants: ShiftParticipant[];
  totals: DeviceShiftTotals;
  byDevice: DeviceTotals[];
  asOf: string;
  leaveRequestedAt: string | null;
  joinedRev: number | null;
}

/**
 * The host's figures of every shift in the JSON array parameter that carries them, as this
 * pairing's. An active shift in the list, and any shift in a one-shift answer (entry, leave),
 * carries `totals`/`byDevice`; a closed shift in the list does not (host D14 as amended): it
 * updates `max_stations`, `my_state` and `participants` of a row already there while `totals`,
 * `by_device` and `as_of` keep the stored values (`COALESCE` against the stored row `f`), and it
 * makes no row where none is kept. `joined_rev` is this station's own `joinedRev` (the device id
 * parameter picks its participant row); an answer that does not name it keeps the stored one. A
 * read older than the stored one (`as_of`) changes nothing, so two overlapping refreshes never take
 * the figures back, unless this computer saw the stored one more than a minute before (`seen_at`:
 * a host clock set back must not freeze the figures); the station's own pause
 * (`leave_requested_at`) is never touched. Parameters: host id, device id, seen at, device id,
 * the array. Pinned with this exact text on the shell's SQLite in `src-tauri/tests/local_db.rs`.
 */
export const UPSERT_PARTICIPATION_SQL =
  "INSERT INTO floor_shift_participation (host_id, device_id, shift_id, max_stations, " +
  "my_state, participants, totals, by_device, as_of, seen_at, joined_rev) SELECT p.host_id, " +
  "p.device_id, p.shift_id, p.max_stations, p.my_state, p.participants, COALESCE(p.totals, " +
  "f.totals), COALESCE(p.by_device, f.by_device), COALESCE(p.as_of, f.as_of), p.seen_at, " +
  "COALESCE(p.joined_rev, f.joined_rev) FROM (SELECT ? AS host_id, ? AS device_id, s.value " +
  "->> 'id' AS shift_id, s.value ->> 'maxStations' AS max_stations, s.value ->> 'myState' " +
  "AS my_state, s.value -> 'participants' AS participants, s.value -> 'totals' AS totals, " +
  "s.value -> 'byDevice' AS by_device, s.value -> 'totals' ->> 'asOf' AS as_of, ? AS " +
  "seen_at, (SELECT me.value ->> 'joinedRev' FROM json_each(s.value -> 'participants') AS " +
  "me WHERE me.value ->> 'deviceId' = ?) AS joined_rev FROM json_each(?) AS s WHERE s.value " +
  "->> 'maxStations' IS NOT NULL AND s.value -> 'participants' IS NOT NULL) AS p LEFT JOIN " +
  "floor_shift_participation AS f ON f.host_id = p.host_id AND f.device_id = p.device_id " +
  "AND f.shift_id = p.shift_id WHERE (p.totals IS NOT NULL AND p.by_device IS NOT NULL) OR " +
  "f.shift_id IS NOT NULL ON CONFLICT (host_id, device_id, shift_id) DO UPDATE SET " +
  "max_stations = excluded.max_stations, my_state = excluded.my_state, participants = " +
  "excluded.participants, totals = excluded.totals, by_device = excluded.by_device, as_of = " +
  "excluded.as_of, seen_at = excluded.seen_at, joined_rev = excluded.joined_rev WHERE " +
  "excluded.as_of >= floor_shift_participation.as_of OR excluded.seen_at >= " +
  "floor_shift_participation.seen_at + 60000";

/**
 * The figures of shifts this pairing no longer keeps a copy of (a list dropped them, the
 * retention purged them). Parameters: host id, device id, host id, device id.
 */
export const DROP_ORPHAN_PARTICIPATION_SQL =
  "DELETE FROM floor_shift_participation WHERE host_id = ? AND device_id = ? AND shift_id NOT IN " +
  "(SELECT id FROM floor_shifts WHERE host_id = ? AND device_id = ?)";

/**
 * An entry drops the pause this station asked for (host D5): a late pause must never undo the
 * entry. Parameters: host id, device id, shift id.
 */
export const CLEAR_LEAVE_SQL =
  "UPDATE floor_shift_participation SET leave_requested_at = NULL " +
  "WHERE host_id = ? AND device_id = ? AND shift_id = ?";

export function participationStatement(
  pairing: Pairing,
  shifts: readonly DeviceShift[],
  seenAt: number,
): LocalStatement {
  return {
    sql: UPSERT_PARTICIPATION_SQL,
    values: [pairing.hostId, pairing.deviceId, seenAt, pairing.deviceId, JSON.stringify(shifts)],
  };
}

export function dropOrphanParticipationStatement(pairing: Pairing): LocalStatement {
  return {
    sql: DROP_ORPHAN_PARTICIPATION_SQL,
    values: [pairing.hostId, pairing.deviceId, pairing.hostId, pairing.deviceId],
  };
}

export function clearLeaveStatement(pairing: Pairing, shiftId: string): LocalStatement {
  return { sql: CLEAR_LEAVE_SQL, values: [pairing.hostId, pairing.deviceId, shiftId] };
}

const COLUMNS =
  "shift_id, max_stations, my_state, participants, totals, by_device, as_of, leave_requested_at, " +
  "joined_rev";

const rowSchema = z.object({
  shift_id: z.string(),
  max_stations: z.number().int(),
  my_state: z.string().nullable(),
  participants: z.string(),
  totals: z.string(),
  by_device: z.string(),
  as_of: z.string(),
  leave_requested_at: z.string().nullable(),
  joined_rev: z.number().int().nonnegative().nullable(),
});

const storedSchema = z.object({
  maxStations: maxStationsSchema,
  myState: participantStateSchema.nullable(),
  participants: z.array(shiftParticipantSchema),
  totals: deviceShiftTotalsSchema,
  byDevice: z.array(deviceTotalsSchema),
});

/** A stored row as the floor reads it; a row this build cannot read is none, never a guess. */
function toParticipation(row: z.infer<typeof rowSchema>): Participation | null {
  let participants: unknown;
  let totals: unknown;
  let byDevice: unknown;
  try {
    participants = JSON.parse(row.participants);
    totals = JSON.parse(row.totals);
    byDevice = JSON.parse(row.by_device);
  } catch {
    return null;
  }
  const parsed = storedSchema.safeParse({
    maxStations: row.max_stations,
    myState: row.my_state,
    participants,
    totals,
    byDevice,
  });
  if (!parsed.success) return null;
  return {
    shiftId: row.shift_id,
    ...parsed.data,
    asOf: row.as_of,
    leaveRequestedAt: row.leave_requested_at,
    joinedRev: row.joined_rev,
  };
}

/** Every shift's figures this pairing keeps, by shift id (the hub's cards). */
export async function readParticipations(
  local: LocalExecutor,
  pairing: Pairing,
): Promise<Map<string, Participation>> {
  const rows = await local.query(
    `SELECT ${COLUMNS} FROM floor_shift_participation WHERE host_id = ? AND device_id = ?`,
    [pairing.hostId, pairing.deviceId],
    rowSchema,
  );
  const read = new Map<string, Participation>();
  for (const row of rows) {
    const participation = toParticipation(row);
    if (participation !== null) read.set(participation.shiftId, participation);
  }
  return read;
}

/** One shift's figures, or `null` (none kept, or unreadable). */
export async function readParticipation(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string,
): Promise<Participation | null> {
  const [row] = await local.query(
    `SELECT ${COLUMNS} FROM floor_shift_participation ` +
      "WHERE host_id = ? AND device_id = ? AND shift_id = ?",
    [pairing.hostId, pairing.deviceId, shiftId],
    rowSchema,
  );
  return row === undefined ? null : toParticipation(row);
}

/**
 * A host answer's figures as the cache would read them, with `deviceId`'s own leave token; `null`
 * for a shift that carries none (planned, an older host, a closed shift in the list).
 */
export function participationFromShift(shift: DeviceShift, deviceId: string): Participation | null {
  const { maxStations, participants, totals, byDevice } = shift;
  if (
    maxStations === undefined ||
    participants === undefined ||
    totals === undefined ||
    byDevice === undefined
  ) {
    return null;
  }
  return {
    shiftId: shift.id,
    maxStations,
    myState: shift.myState ?? null,
    participants,
    totals,
    byDevice,
    asOf: totals.asOf,
    leaveRequestedAt: null,
    joinedRev: participants.find((row) => row.deviceId === deviceId)?.joinedRev ?? null,
  };
}

/**
 * The participation of a shift several devices may work (a line of more than one, or more than
 * one participant ever), else `null`: a station alone on a line of one sees stage 2a's floor.
 */
export function sharedParticipation(participation: Participation | null): Participation | null {
  if (participation === null) return null;
  return participation.maxStations > 1 || participation.participants.length > 1
    ? participation
    : null;
}

/** The other devices that hold a slot now (`active`), as the cache saw them. */
export function activeOthers(participation: Participation, deviceId: string): ShiftParticipant[] {
  return participation.participants.filter(
    (row) => row.state === "active" && row.deviceId !== deviceId,
  );
}

/** By the cache, no other participant stays active or left: this station's close closes the shift. */
export function closesShift(participation: Participation, deviceId: string): boolean {
  return participation.participants.every(
    (row) => row.deviceId === deviceId || row.state === "closed",
  );
}

/** Every participant the shift had by the cache, this station counted (at least 1). */
export function participantsEver(participation: Participation | null): number {
  return Math.max(1, participation?.participants.length ?? 1);
}

/** «Моя станция: N · Всего в смене: K» and the age of the host's part of K. */
export interface SharedCount {
  mine: number;
  total: number;
  asOf: string;
}

/**
 * The whole shift's count as this station knows it: the others' part by the host
 * (`totals.accepted` less this station's own part on the host) and this station's own `mine`
 * codes, which are never behind its own scans (spec §11 «Расхождение числа»: the host's count wins
 * at the next read).
 */
export function sharedCount(
  participation: Participation,
  deviceId: string,
  mine: number,
): SharedCount {
  const hostMine = participation.byDevice.find((part) => part.deviceId === deviceId)?.accepted ?? 0;
  return {
    mine,
    total: Math.max(0, participation.totals.accepted - hostMine) + mine,
    asOf: participation.asOf,
  };
}
