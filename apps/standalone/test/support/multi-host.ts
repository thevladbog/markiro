import { z } from "zod";

import { HostError } from "../../src/host/client.js";
import {
  deviceShiftSchema,
  enteredShiftSchema,
  type CodeCheck,
  type DeviceShift,
  type EnteredShift,
  type FactReceipt,
  type ShiftEnter,
  type ShiftLeave,
  type ShiftParticipant,
} from "../../src/host/protocol.js";

interface Part {
  row: ShiftParticipant;
  accepted: number;
}

const recordSchema = z.object({
  id: z.string(),
  kind: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type MultiHost = ReturnType<typeof multiHost>;

/**
 * The host's `reason_need` (`host/src/shift_participants.rs`, fixture
 * `shift-close-reason-shared.json`), written here on its own and not imported from the station, so
 * the station's mirror (`src/floor/close/shared-reason.ts`) is checked against something it did not
 * write: a close that does not close the shift needs nothing; a shift that only ever had this
 * device keeps stage 2a's rule (`close_reason_required`: a plan the device saw, not met by its own
 * count) and is refused without the reason; a shared shift's closing close needs one when the
 * host's plan is not the whole shift's accepted units, and goes on without it, marked missing.
 */
export function hostReasonNeed(
  closesShift: boolean,
  participantsEver: number,
  factPlanned: number | null,
  ownActual: number,
  hostPlanned: number | null,
  shiftAccepted: number,
): "none" | "required" | "shared" {
  if (!closesShift) return "none";
  if (participantsEver <= 1) {
    return factPlanned !== null && factPlanned !== ownActual ? "required" : "none";
  }
  return hostPlanned !== null && hostPlanned !== shiftAccepted ? "shared" : "none";
}

/** A device instant in the host's column format: whole seconds, UTC (`format_timestamp`). */
function hostSeconds(instant: string): string {
  return new Date(Date.parse(instant)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A host of one shared shift for the webview tests of plan 2b, in memory: the host contract's
 * entry (a slot by `maxStations`, `shift_line_full` with its numbers, `shift_busy` without the
 * capability, a closed part read back to a capable device and `shift_status` to one that is not; a
 * first entry or a return from `left` stamps a new `joinedRev`), leave (`left`,
 * `shift_not_entered`; a `joinedRev` that is not the row's current one changes nothing), list
 * (participants, `myState`; totals by device for an active shift only — a closed shift in the list
 * carries none, while the answer of an entry or a leave always does) and facts (an accepted scan
 * claims its code in the registry, the earliest device instant winning; a `shift_closed` closes
 * the sender's part at the device's `closedAt` in whole seconds and the shift with the last one at
 * the latest of the device-closed parts, the reason by the host's own rule `hostReasonNeed`; a
 * close the shift no longer takes is refused without a reason a one-device shift needs, else
 * `alreadyClosed`/`partClosed`). The host's clock is whole seconds and moves only on `tick`, so
 * answers share an `asOf` as the real host's do within a second; `list` may be kept and applied
 * later, out of order. Not the host: what the stations must see of it.
 */
export function multiHost(
  base: EnteredShift,
  maxStations: number,
  names: Readonly<Record<string, string>>,
) {
  const { snapshot, ...fields } = base;
  const parts = new Map<string, Part>();
  let status: "active" | "closed" = "active";
  let closedAt: string | null = null;
  let reasonMissing = false;
  let rev = 0;
  /** The host revision a slot-taking write stamps on its participant row (`joinedRev`). */
  const nextRev = () => {
    rev += 1;
    return rev;
  };
  let seconds = 0;
  /** The host's clock now, in whole seconds; it moves only on `tick`. */
  const instant = () =>
    new Date(Date.parse("2026-10-08T07:00:00Z") + seconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  const refused = (
    code: string,
    constraint: string | null,
    details: Record<string, unknown> = {},
  ) =>
    new HostError({
      kind: "api",
      code,
      status: code === "not_found" ? 404 : 409,
      message: constraint ?? code,
      details: constraint === null ? details : { constraint, ...details },
    });
  const row = (deviceId: string, at: string): ShiftParticipant => ({
    deviceId,
    deviceKind: "station",
    deviceName: names[deviceId] ?? deviceId,
    state: "active",
    firstEnteredAt: at,
    joinedAt: at,
    joinedRev: nextRev(),
    leftAt: null,
    closedAt: null,
    closedBy: null,
    closedActualQty: null,
    closedReasonCode: null,
    lateDataAt: null,
    lastSeenAt: at,
  });
  const accepted = () => [...parts.values()].reduce((sum, part) => sum + part.accepted, 0);
  /** The registry (`code_owners`): each code's owning part and its scan's device instant. */
  const owners = new Map<string, { part: Part; scannedAt: string }>();
  /**
   * An accepted scan claims its code: the earliest device instant owns it whatever the order of
   * arrival; an earlier scan displaces the owner (its part counts one less; the fake serves no
   * `/displacements`), a later one or one at the same instant is `conflict` (host
   * `facts/registry.rs`).
   */
  const claim = (part: Part, id: string, data: Record<string, unknown>): FactReceipt => {
    const code = data["code"];
    const hash =
      typeof code === "object" && code !== null && "codeHash" in code ? String(code.codeHash) : id;
    const scannedAt = String(data["scannedAt"]);
    const owner = owners.get(hash);
    if (owner !== undefined && owner.scannedAt <= scannedAt) {
      return { id, outcome: "conflict", details: { winner: { scannedAt: owner.scannedAt } } };
    }
    if (owner !== undefined) owner.part.accepted -= 1;
    owners.set(hash, { part, scannedAt });
    part.accepted += 1;
    return { id, outcome: "accepted" };
  };
  /** The shift as `deviceId` reads it; the list leaves a closed shift's figures out (host D14). */
  const shiftFor = (deviceId: string, withTotals = true): DeviceShift => {
    const list = [...parts.values()];
    const mine = parts.get(deviceId);
    return deviceShiftSchema.parse({
      ...fields,
      status,
      closedAt,
      maxStations,
      participants: list.map((part) => part.row),
      ...(mine === undefined ? {} : { myState: mine.row.state }),
      ...(withTotals
        ? {
            totals: { accepted: accepted(), boxesClosed: 0, pallets: 0, asOf: instant() },
            byDevice: list.map((part) => ({
              deviceId: part.row.deviceId,
              accepted: part.accepted,
              boxesClosed: 0,
              pallets: 0,
            })),
          }
        : {}),
    });
  };
  const closePart = (deviceId: string, id: string, data: Record<string, unknown>): FactReceipt => {
    const mine = parts.get(deviceId);
    if (mine === undefined) return { id, outcome: "rejected", code: "invalid_record" };
    const planned =
      typeof data["plannedQtySnapshot"] === "number" ? data["plannedQtySnapshot"] : null;
    const actual = typeof data["actualQty"] === "number" ? data["actualQty"] : 0;
    const reasonCode = typeof data["reasonCode"] === "string" ? data["reasonCode"] : null;
    const missingReason: FactReceipt = {
      id,
      outcome: "rejected",
      code: "invalid_record",
      details: { field: "data.reasonCode" },
    };
    // A close the shift no longer takes: a one-device shift keeps stage 2a's rule.
    if (status === "closed" || mine.row.state === "closed") {
      if (
        hostReasonNeed(true, parts.size, planned, actual, null, 0) === "required" &&
        reasonCode === null
      ) {
        return missingReason;
      }
      return status === "closed"
        ? { id, outcome: "accepted", details: { alreadyClosed: true } }
        : { id, outcome: "accepted", details: { partClosed: true } };
    }
    const closesShift = [...parts.values()].every(
      (part) => part.row.deviceId === deviceId || part.row.state === "closed",
    );
    const need = hostReasonNeed(
      closesShift,
      parts.size,
      planned,
      actual,
      fields.plannedQty,
      closesShift && parts.size > 1 ? accepted() : 0,
    );
    if (need === "required" && reasonCode === null) return missingReason;
    mine.row = {
      ...mine.row,
      state: "closed",
      closedAt: hostSeconds(String(data["closedAt"])),
      closedBy: "device",
      closedActualQty: actual,
      closedReasonCode: reasonCode,
    };
    if (!closesShift) return { id, outcome: "accepted", details: { partClosed: true } };
    status = "closed";
    // The latest close among the device-closed parts: an offline station's earlier close may
    // arrive last.
    closedAt = [...parts.values()]
      .filter((part) => part.row.closedBy === "device" && part.row.closedAt !== null)
      .map((part) => part.row.closedAt ?? "")
      .reduce((latest, at) => (at > latest ? at : latest), "");
    if (need === "shared" && reasonCode === null) {
      reasonMissing = true;
      return { id, outcome: "accepted", details: { reasonMissing: true } };
    }
    return { id, outcome: "accepted" };
  };
  return {
    /** The office's planned shift opened by this device's first entry. */
    open(deviceId: string): void {
      parts.set(deviceId, { row: row(deviceId, instant()), accepted: 0 });
    },
    list: async (deviceId: string): Promise<DeviceShift[]> => [
      shiftFor(deviceId, status === "active"),
    ],
    enter:
      (deviceId: string) =>
      async (shiftId: string, enter: ShiftEnter): Promise<EnteredShift> => {
        if (shiftId !== base.id) throw refused("not_found", null);
        if (status === "closed") throw refused("conflict", "shift_status");
        const mine = parts.get(deviceId);
        const capable = (enter.supports ?? []).includes("multi-station-v1");
        // A closed part reads the shift back to a capable build; an older one gets stage 2a's
        // `shift_status` (the read-back's `active` would send it on producing).
        if (mine?.row.state === "closed" && !capable) throw refused("conflict", "shift_status");
        if (mine === undefined || mine.row.state === "left") {
          if (mine === undefined && !capable) {
            throw refused("conflict", "shift_busy");
          }
          const active = [...parts.values()].filter(
            (part) => part.row.deviceId !== deviceId && part.row.state === "active",
          ).length;
          if (active >= maxStations) {
            throw refused("conflict", "shift_line_full", { maxStations, active });
          }
          const at = instant();
          if (mine === undefined) parts.set(deviceId, { row: row(deviceId, at), accepted: 0 });
          else {
            mine.row = {
              ...mine.row,
              state: "active",
              joinedAt: at,
              joinedRev: nextRev(),
              leftAt: null,
            };
          }
        }
        return enteredShiftSchema.parse({ ...shiftFor(deviceId), snapshot });
      },
    leave:
      (deviceId: string) =>
      async (shiftId: string, leave: ShiftLeave | null): Promise<DeviceShift> => {
        if (shiftId !== base.id) throw refused("not_found", null);
        const mine = parts.get(deviceId);
        if (mine === undefined) throw refused("conflict", "shift_not_entered");
        // A token of an earlier stay: the shift as it is, nothing written (host D5 as amended).
        if (leave !== null && leave.joinedRev !== mine.row.joinedRev) return shiftFor(deviceId);
        if (mine.row.state === "active") {
          mine.row = { ...mine.row, state: "left", leftAt: instant() };
        }
        return shiftFor(deviceId);
      },
    checkCode: async (): Promise<CodeCheck> => ({ status: "free" }),
    facts:
      (deviceId: string) =>
      async (records: readonly unknown[]): Promise<FactReceipt[]> =>
        records.map((raw): FactReceipt => {
          const record = recordSchema.parse(raw);
          if (record.kind === "shift_closed") return closePart(deviceId, record.id, record.data);
          const mine = parts.get(deviceId);
          if (record.kind === "scan" && mine !== undefined && record.data["verdict"] === "ok") {
            return claim(mine, record.id, record.data);
          }
          return { id: record.id, outcome: "accepted" };
        }),
    /** The host's clock moves on by `by` seconds. */
    tick(by = 1): void {
      seconds += by;
    },
    state: () => ({
      status,
      closedAt,
      reasonMissing,
      accepted: accepted(),
      parts: new Map(parts),
    }),
  };
}
