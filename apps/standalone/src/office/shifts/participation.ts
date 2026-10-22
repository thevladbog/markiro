import type { TagPhase } from "@markiro/ui";

import type { OfficeShift, ParticipantState, ShiftParticipant } from "../../host/protocol.js";

/**
 * Participation in a shift (plan 2b, spec §7): who is in it, in what state, who is silent, and
 * which shift a device works. One module, so the list, the card, «Устройства» and «Обзор» agree.
 * A shift of a host before protocol 7 names no participants (`participants` absent), and every
 * rule here then says «none»: the office looks as it did.
 */

/** An active participant the host has not heard for longer than this is silent (the owner's ten minutes). */
export const PARTICIPANT_SILENT_MS = 10 * 60 * 1000;

type WithParticipants = Pick<OfficeShift, "participants">;

/** The devices that entered the shift, first entry first; none for a host before protocol 7 or a planned shift. */
export function participantsOf(shift: WithParticipants): readonly ShiftParticipant[] {
  return shift.participants ?? [];
}

/** A shift several devices entered: only then does the office say «целиком». */
export function isSharedShift(shift: WithParticipants): boolean {
  return participantsOf(shift).length > 1;
}

/**
 * The ids of the revoked devices of a devices list: the host frees a revoked device's slot
 * (`active_others`, `line_slots_in_use`), so the office leaves it out of «who is at work» too.
 * Empty while the list is unread (a technologist never reads it, or it has not come yet): the office
 * then claims nothing about revocation and counts as the host's participants say.
 */
export function revokedDeviceIds(
  devices: readonly { id: string; revokedAt: string | null }[] | undefined,
): ReadonlySet<string> {
  return new Set((devices ?? []).filter((each) => each.revokedAt !== null).map((each) => each.id));
}

const NONE_REVOKED: ReadonlySet<string> = new Set();

/**
 * Participants that hold a slot of the line now: active ones whose device is not in `revoked`. A
 * revoked device's open part is still real (it blocks the automatic close, `notClosedParticipants`),
 * but it holds no slot.
 */
export function activeParticipants(
  shift: WithParticipants,
  revoked: ReadonlySet<string> = NONE_REVOKED,
): ShiftParticipant[] {
  return participantsOf(shift).filter(
    (each) => each.state === "active" && !revoked.has(each.deviceId),
  );
}

/** Participants that have not closed their part (`active` and `left`): what a forced close would close. */
export function notClosedParticipants(shift: WithParticipants): ShiftParticipant[] {
  return participantsOf(shift).filter((each) => each.state !== "closed");
}

export function closedParticipants(shift: WithParticipants): ShiftParticipant[] {
  return participantsOf(shift).filter((each) => each.state === "closed");
}

/** The latest sign of life the host has: its last hearing, else the entry. */
export function lastSign(participant: ShiftParticipant): string {
  return participant.lastSeenAt ?? participant.joinedAt;
}

/**
 * An active participant not heard for more than `PARTICIPANT_SILENT_MS` before `nowMs`, the host's
 * time; `null` (the host's time is not known) claims no silence.
 */
export function isSilent(participant: ShiftParticipant, nowMs: number | null): boolean {
  if (nowMs === null || participant.state !== "active") return false;
  return nowMs - Date.parse(lastSign(participant)) > PARTICIPANT_SILENT_MS;
}

/** What a participant looks like: the word and the glyph of a phase, never a colour alone. */
export type ParticipantLook = "active" | "silent" | "left" | "closedDevice" | "closedOffice";

export function participantLook(
  participant: ShiftParticipant,
  nowMs: number | null,
): ParticipantLook {
  if (participant.state === "closed") {
    return participant.closedBy === "office_user" ? "closedOffice" : "closedDevice";
  }
  if (participant.state === "left") return "left";
  return isSilent(participant, nowMs) ? "silent" : "active";
}

/** The kit's phase of each look (glyph and tone derive from the phase only; grey is one of its four). */
export const LOOK_PHASE = {
  active: "active",
  silent: "attention",
  left: "none",
  closedDevice: "done",
  closedOffice: "done",
} as const satisfies Record<ParticipantLook, TagPhase>;

/**
 * Whether a device works the shift now. With participants: an active one (the owner is only
 * «who opened it», and may have left). A host before protocol 7 names none, and the owner of an
 * active shift is the one device that works it, as in stage 2a.
 */
export function deviceWorksShift(
  shift: Pick<OfficeShift, "status" | "ownerDeviceId" | "participants">,
  deviceId: string,
): boolean {
  if (shift.status !== "active") return false;
  if (shift.participants === undefined) return shift.ownerDeviceId === deviceId;
  return shift.participants.some((each) => each.deviceId === deviceId && each.state === "active");
}

/** A device's place in an active shift. */
export interface Presence {
  shiftId: string;
  number: string;
  state: ParticipantState;
}

const STATE_RANK: Record<ParticipantState, number> = { active: 0, left: 1, closed: 2 };

/**
 * The device's part in the active shifts of `shifts`: an active part wins over a paused one over a
 * closed one, the latest entry within a state. `null` when it is in none, and while the list is
 * not read (`undefined`); a shift without participants (an older host) claims nothing. A revoked
 * device (`revoked` names it) is in no shift: the host frees its slot, and the card's «Станции»
 * tab is where its open part stays visible.
 */
export function presenceOf(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
  revoked: ReadonlySet<string> = NONE_REVOKED,
): Presence | null {
  if (revoked.has(deviceId)) return null;
  let best: { presence: Presence; joinedMs: number } | null = null;
  for (const shift of shifts ?? []) {
    if (shift.status !== "active") continue;
    for (const each of participantsOf(shift)) {
      if (each.deviceId !== deviceId) continue;
      const candidate = {
        presence: { shiftId: shift.id, number: shift.number, state: each.state },
        joinedMs: Date.parse(each.joinedAt),
      };
      if (
        best === null ||
        STATE_RANK[candidate.presence.state] < STATE_RANK[best.presence.state] ||
        (candidate.presence.state === best.presence.state && candidate.joinedMs > best.joinedMs)
      ) {
        best = candidate;
      }
    }
  }
  return best?.presence ?? null;
}

/**
 * The numbers of the active shifts in which the device has a part not closed (`active` or `left`:
 * either blocks the automatic close). Empty while the list is not read (`undefined`): nothing is claimed.
 */
export function openShiftNumbers(
  shifts: readonly OfficeShift[] | undefined,
  deviceId: string,
): string[] {
  return (shifts ?? [])
    .filter(
      (shift) =>
        shift.status === "active" &&
        notClosedParticipants(shift).some((each) => each.deviceId === deviceId),
    )
    .map((shift) => shift.number);
}
