import { HostError } from "../../host/client.js";
import type { EnteredShift, ShiftEnter } from "../../host/protocol.js";
import { STATION_SHIFT_ENTER } from "../../host/requests.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { shellActionFor } from "../../app/shell.js";
import { licenseRefusalOf, type LicenseRefusal } from "../license.js";
import {
  keepEnteredShift,
  readStoredWork,
  type ShiftCopy,
  type WorkShift,
} from "./shift-copies.js";
import { checkShiftSnapshot } from "./shift-snapshot.js";

/**
 * Why the station did not enter a shift: the host is away and the shift is
 * not one this station entered before (`no_link`); the host refused it
 * (`busy`: another station opened it, `closed`, `other_line`, `not_found`:
 * deleted, `product_inactive`, `template_not_fit`, `pallet_template_not_fit`:
 * the pallet template, plan ПЛ-Х; `duplicate_template_not_fit`: the template
 * of a validation shift's duplicate, plan РЕЖ part B; `station_update`: the shift's mode needs
 * what this build does not name in its entry, plan РЕЖ); its layout is one this
 * build does not read (`unreadable`); this computer could not keep it
 * (`local`); or anything else (`failed`).
 */
export type EntryRefusal =
  | "no_link"
  | "busy"
  | "closed"
  | "other_line"
  | "not_found"
  | "product_inactive"
  | "template_not_fit"
  | "pallet_template_not_fit"
  | "duplicate_template_not_fit"
  | "station_update"
  | "unreadable"
  | "local"
  | "failed"
  /** The site's license opens no new shift (plan ЛЦ-3), by the state the host names. */
  | LicenseRefusal;

export type EntryResult =
  | { kind: "entered"; shift: WorkShift; offline: boolean }
  | { kind: "refused"; reason: EntryRefusal }
  /** The host refused this device's key or showed another certificate: the shell's to handle. */
  | { kind: "rejected"; error: unknown };

export interface EntryContext {
  local: LocalExecutor;
  pairing: Pairing;
  /** The link to the host is online now. */
  online: boolean;
  /** `HostApi.enterShift`. */
  enter: (shiftId: string, enter: ShiftEnter) => Promise<EnteredShift>;
  now: () => Date;
}

/** The refusals of `POST /v1/device/shifts/{id}/enter` by `details.constraint` (stage 2a spec §4.8). */
const CONFLICTS: Readonly<Record<string, EntryRefusal>> = {
  shift_busy: "busy",
  shift_status: "closed",
  shift_line: "other_line",
  product_inactive: "product_inactive",
  template_not_fit: "template_not_fit",
  pallet_template_not_fit: "pallet_template_not_fit",
  duplicate_template_not_fit: "duplicate_template_not_fit",
  station_update: "station_update",
};

/**
 * The stored shift to work without the host, or why there is none. An active
 * shift, or one the office closed after this station entered it (to finish
 * it, plan 2a8): `readStoredWork` also answers `ready` for one this station
 * closed, which the list never enters.
 */
async function storedWork(context: EntryContext, shiftId: string): Promise<EntryResult> {
  const stored = await readStoredWork(context.local, context.pairing, shiftId);
  switch (stored.kind) {
    case "ready":
      if (
        (stored.shift.copy.status !== "active" && stored.shift.copy.status !== "closed") ||
        stored.shift.copy.localState !== null
      ) {
        return { kind: "refused", reason: "closed" };
      }
      return { kind: "entered", shift: stored.shift, offline: true };
    case "missing":
      return { kind: "refused", reason: "no_link" };
    case "unreadable":
      return { kind: "refused", reason: "unreadable" };
  }
}

/**
 * Enters `copy` (stage 2a spec §5.4). With the link online the host opens a
 * planned shift or answers the snapshot of one this station opened (the entry
 * names what this station works, `STATION_SHIFT_ENTER`), which is
 * checked (`checkShiftSnapshot`) and kept before the station works from it;
 * a snapshot this build does not read is neither kept nor worked from. With
 * the link down, or a request that never reached the host, only an active
 * shift this station entered before is entered, from its stored snapshot;
 * so is a shift the office closed after this station entered it, to finish
 * it (plan 2a8).
 * Opening a planned shift and freezing its snapshot are the host's, so a
 * station on a PC away from the host enters its planned shifts while the
 * link is up and works them later without it.
 */
export async function enterShift(context: EntryContext, copy: ShiftCopy): Promise<EntryResult> {
  if (copy.localState !== null) return { kind: "refused", reason: "closed" };
  // The office closed it after this station entered: finished from the
  // stored snapshot, without the host, which refuses to enter a closed shift.
  if (copy.status === "closed" || !context.online) return storedWork(context, copy.id);
  let answer: EnteredShift;
  try {
    answer = await context.enter(copy.id, STATION_SHIFT_ENTER);
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "rejected", error };
    if (!(error instanceof HostError)) return { kind: "refused", reason: "failed" };
    // No answer at all: the link said online, but the request found no host.
    if (error.kind === "transport") return storedWork(context, copy.id);
    if (error.code === "not_found") return { kind: "refused", reason: "not_found" };
    if (error.code === "conflict" && error.details["constraint"] === "license_restricted") {
      return { kind: "refused", reason: licenseRefusalOf(error.details) };
    }
    const constraint = error.details["constraint"];
    const refusal =
      error.code === "conflict" && typeof constraint === "string"
        ? CONFLICTS[constraint]
        : undefined;
    return { kind: "refused", reason: refusal ?? "failed" };
  }
  if (!checkShiftSnapshot(answer.snapshot, answer.palletsEnabled).ok) {
    return { kind: "refused", reason: "unreadable" };
  }
  try {
    const at = context.now();
    await keepEnteredShift(context.local, context.pairing, answer, at.toISOString(), at.getTime());
    const stored = await readStoredWork(context.local, context.pairing, copy.id);
    if (stored.kind !== "ready") return { kind: "refused", reason: "local" };
    return { kind: "entered", shift: stored.shift, offline: false };
  } catch {
    return { kind: "refused", reason: "local" };
  }
}
