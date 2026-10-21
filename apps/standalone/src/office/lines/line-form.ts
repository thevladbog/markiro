import { z } from "zod";

import { HostError } from "../../host/client.js";
import type { OfficeShift } from "../../host/protocol.js";
import { lineNameRule, maxStationsRule } from "../../lib/rules.js";
import { activeParticipants } from "../shifts/participation.js";

/** The text under the limit when it is lower than the devices at work (`{{count}}` says how many). */
export const STATIONS_IN_USE = "office.lines.errors.stationsInUse";

/**
 * The line form's fields: the name and the limit of devices in one shift, as typed. `inUse` is
 * how many devices the busiest active shift of the line has at work, once the shifts are read
 * (`activeStationsOnLine`); the limit cannot go below it, which the host refuses too
 * (`line_stations_in_use`).
 */
export function lineFieldsSchema(inUse: number | null) {
  return z.object({
    name: lineNameRule,
    maxStations: maxStationsRule.refine(
      (text) => inUse === null || Number(text) >= inUse,
      STATIONS_IN_USE,
    ),
  });
}
export type LineFields = z.input<ReturnType<typeof lineFieldsSchema>>;

/**
 * The most active participants of any active shift of the line (the host counts the same: «the
 * busiest active shift's live slots»); `0` for a line nobody works, `null` while the shifts are not
 * read, so the form claims nothing.
 */
export function activeStationsOnLine(
  shifts: readonly OfficeShift[] | undefined,
  lineId: string,
): number | null {
  if (shifts === undefined) return null;
  let busiest = 0;
  for (const shift of shifts) {
    if (shift.lineId !== lineId || shift.status !== "active") continue;
    busiest = Math.max(busiest, activeParticipants(shift).length);
  }
  return busiest;
}

/** How many devices work a shift of the line, when the host refused a lower limit; `null` for any other failure. */
export function stationsInUse(error: unknown): number | null {
  if (
    error instanceof HostError &&
    error.code === "conflict" &&
    error.details.constraint === "line_stations_in_use"
  ) {
    const active = error.details.active;
    return typeof active === "number" ? active : null;
  }
  return null;
}
