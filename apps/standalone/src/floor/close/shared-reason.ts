import { shiftCloseReasonRequired } from "@markiro/domain";

/**
 * What a part's close needs (host `shift_participants::ReasonNeed`, plan 2b D7): nothing; stage
 * 2a's reason, which the host refuses to do without (a shift that only ever had this device); or
 * the shared reason, which the host does without and marks missing for the office.
 */
export type ReasonNeed = "none" | "required" | "shared";

/** One case of `proto/fixtures/shift-close-reason-shared.json`, as the host reads it. */
export interface ReasonCase {
  /** No other participant stays active or left: this close closes the shift. */
  closesShift: boolean;
  /** Every participant the shift had, this one included. */
  participantsEver: number;
  /** The plan this device saw (its record's `plannedQtySnapshot`). */
  factPlanned: number | null;
  /** This device's own count (its record's `actualQty`). */
  actualQty: number;
  /** The shift's plan on the host now. */
  hostPlanned: number | null;
  /** The whole shift's accepted units. */
  shiftAccepted: number;
}

/** The host's rule, mirrored and pinned case for case by the shared fixture. */
export function reasonNeed(rule: ReasonCase): ReasonNeed {
  if (!rule.closesShift) return "none";
  if (rule.participantsEver <= 1) {
    return shiftCloseReasonRequired(rule.factPlanned, rule.actualQty) ? "required" : "none";
  }
  return rule.hostPlanned !== null && rule.hostPlanned !== rule.shiftAccepted ? "shared" : "none";
}

/** What the station knows when it closes its part. */
export interface StationReasonInput {
  /** The shift's plan as this station's copy has it now (the host's, by its last list). */
  plannedQty: number | null;
  /** This station's own codes in the shift. */
  actualQty: number;
  /** The participants of the station's last read, itself included (at least 1). */
  participantsEver: number;
  /** By the station's last read, no other participant stays active or left. */
  closesShift: boolean;
  /** The link is up now. */
  online: boolean;
  /** The whole shift's count as the station knows it (`sharedCount`). */
  total: number;
}

/**
 * Whether the close panel asks for one of the six reasons (spec §5 «Закрытие», §12.9): a shift
 * that only ever had this station by its last read keeps stage 2a's rule with or without the link
 * (the host would refuse the close without it, and a second device joining since only makes the
 * reason optional); a shared shift asks it only online, of the last closer, by the whole shift's
 * count against the plan; offline it never asks — the host marks the reason missing.
 */
export function stationReasonRequired(input: StationReasonInput): boolean {
  if (input.participantsEver <= 1) {
    return shiftCloseReasonRequired(input.plannedQty, input.actualQty);
  }
  if (!input.online) return false;
  return (
    reasonNeed({
      closesShift: input.closesShift,
      participantsEver: input.participantsEver,
      factPlanned: input.plannedQty,
      actualQty: input.actualQty,
      hostPlanned: input.plannedQty,
      shiftAccepted: input.total,
    }) !== "none"
  );
}
