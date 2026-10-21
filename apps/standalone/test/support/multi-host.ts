import { z } from "zod";

import { reasonNeed } from "../../src/floor/close/shared-reason.js";
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
 * A host of one shared shift for the webview tests of plan 2b, in memory: the host contract's
 * entry (a slot by `maxStations`, `shift_line_full` with its numbers, `shift_busy` without the
 * capability, a closed part read back; a first entry or a return from `left` stamps a new
 * `joinedRev`), leave (`left`, `shift_not_entered`; a `joinedRev` that is not the row's current
 * one changes nothing), list (participants, `myState`; totals by device at an `asOf` that moves on
 * with every answer, for an active shift only — a closed shift in the list carries none, while the
 * answer of an entry or a leave always does) and facts (an accepted
 * scan counts; a `shift_closed` closes the sender's part and the shift with the last one, the
 * reason by `reasonNeed`, the receipts `partClosed`, `reasonMissing`, `alreadyClosed`). Not the
 * host: what the stations must see of it.
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
  const instant = () => {
    seconds += 1;
    return new Date(Date.parse("2026-10-08T07:00:00Z") + seconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  };
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
    if (status === "closed") return { id, outcome: "accepted", details: { alreadyClosed: true } };
    const mine = parts.get(deviceId);
    if (mine === undefined) return { id, outcome: "rejected", code: "invalid_record" };
    if (mine.row.state === "closed")
      return { id, outcome: "accepted", details: { partClosed: true } };
    const planned = data["plannedQtySnapshot"];
    const actual = typeof data["actualQty"] === "number" ? data["actualQty"] : 0;
    const reasonCode = typeof data["reasonCode"] === "string" ? data["reasonCode"] : null;
    const closesShift = [...parts.values()].every(
      (part) => part.row.deviceId === deviceId || part.row.state === "closed",
    );
    const need = reasonNeed({
      closesShift,
      participantsEver: parts.size,
      factPlanned: typeof planned === "number" ? planned : null,
      actualQty: actual,
      hostPlanned: fields.plannedQty,
      shiftAccepted: accepted(),
    });
    if (need === "required" && reasonCode === null) {
      return { id, outcome: "rejected", code: "invalid_record" };
    }
    const at = instant();
    mine.row = {
      ...mine.row,
      state: "closed",
      closedAt: at,
      closedBy: "device",
      closedActualQty: actual,
      closedReasonCode: reasonCode,
    };
    if (!closesShift) return { id, outcome: "accepted", details: { partClosed: true } };
    status = "closed";
    closedAt = at;
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
        if (mine === undefined || mine.row.state === "left") {
          if (mine === undefined && !(enter.supports ?? []).includes("multi-station-v1")) {
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
    state: () => ({ status, reasonMissing, accepted: accepted(), parts: new Map(parts) }),
  };
}
