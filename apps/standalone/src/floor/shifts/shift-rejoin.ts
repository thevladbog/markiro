import { shellActionFor } from "../../app/shell.js";
import { HostError } from "../../host/client.js";
import type { EnteredShift } from "../../host/protocol.js";
import { STATION_SHIFT_ENTER } from "../../host/requests.js";
import { readShiftCopy } from "./shift-copies.js";
import type { EntryContext, LineSlots } from "./shift-entry.js";
import { participationStatement, readParticipation } from "./shift-participation.js";

/**
 * What a return of a part the host has as `left` came to (plan 2b, final review I1): nothing to
 * do, the part holds a slot again, the line is full (with the refusal's numbers when it names
 * them), a failure that the next read tries again, or a refused key or another certificate for
 * the shell.
 */
export type RejoinResult =
  | { kind: "none" }
  | { kind: "rejoined" }
  | { kind: "line_full"; line: LineSlots | null }
  | { kind: "failed" }
  | { kind: "rejected"; error: unknown };

/** The numbers of a `shift_line_full` refusal, or `null` when it names none. */
function lineOf(details: Readonly<Record<string, unknown>>): LineSlots | null {
  const { active, maxStations } = details;
  return typeof active === "number" && typeof maxStations === "number"
    ? { active, maxStations }
    : null;
}

/**
 * Takes a slot again for the shift this station works when the host's last read says its part is
 * `left` (plan 2b, final review I1). The station works such a part in two ways: the operator left
 * the shift with the link up (the host freed the slot) and continued it offline from the stored
 * snapshot; or the pause was in flight when the operator came back, the entry reached the host
 * first (an active part's re-entry stamps no new `joinedRev`) and the pause, still carrying the
 * current token, freed the slot after it. Either way the host would leave the slot free for
 * another device. So, with the link up, a shift active and not closing here, its part `left` in
 * the cache and no pause of the operator's own waiting, the station enters it again
 * (`STATION_SHIFT_ENTER`) and keeps the answer's figures. A full line (`shift_line_full`) changes
 * nothing kept: the station goes on producing (its scans are facts the host takes from a left
 * part all the same) and the work screen says the line is full; the next read tries again. A part
 * the host has closed meanwhile is kept as closed. Nothing here stops the line.
 */
export async function rejoinLeftPart(
  context: EntryContext,
  shiftId: string,
): Promise<RejoinResult> {
  if (!context.online) return { kind: "none" };
  const copy = await readShiftCopy(context.local, context.pairing, shiftId);
  if (copy === null || copy.status !== "active" || copy.localState !== null) {
    return { kind: "none" };
  }
  const participation = await readParticipation(context.local, context.pairing, shiftId);
  if (participation?.myState !== "left" || participation.leaveRequestedAt !== null) {
    return { kind: "none" };
  }
  let answer: EnteredShift;
  try {
    answer = await context.enter(shiftId, STATION_SHIFT_ENTER);
  } catch (error) {
    if (shellActionFor(error, null) !== null) return { kind: "rejected", error };
    if (
      error instanceof HostError &&
      error.kind === "api" &&
      error.code === "conflict" &&
      error.details["constraint"] === "shift_line_full"
    ) {
      return { kind: "line_full", line: lineOf(error.details) };
    }
    return { kind: "failed" };
  }
  await context.local.transaction([
    participationStatement(context.pairing, [answer], context.now().getTime()),
  ]);
  return answer.myState === "active" ? { kind: "rejoined" } : { kind: "none" };
}
