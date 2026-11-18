import { useEffect, useState } from "react";

import type { LocalExecutor } from "../../local/executor.js";
import { readPartState, type PartState } from "../close/shift-close.js";
import type { Pairing } from "../../local/reference-sync.js";
import {
  readParticipation,
  sharedParticipation,
  type Participation,
} from "../shifts/shift-participation.js";

/** How often the work screen of a shared shift asks the link for the list (plan 2b, host D11). */
export const SHIFT_TOTALS_POLL_MS = 15_000;

export interface ShiftParticipationInput {
  local: LocalExecutor;
  pairing: Pairing;
  shiftId: string;
  /** `ShellState.shiftReads.done`: the cache is read again after every read of the host's list. */
  shiftReads: number;
  /** The link is up: only then is the list asked for. */
  online: boolean;
  /** Asks the link to read the list now (`HostLinkControls.requestShifts`); none — never asked. */
  onRefresh?: () => void;
}

/**
 * What the host's last read said of the work screen's shift (plan 2b): read from the cache when
 * the screen opens and after every read of the host's list; while the shift is shared and the link
 * is up, the link is asked to read the list every `SHIFT_TOTALS_POLL_MS` — another device's scan
 * takes no revision on the host, so nothing else would bring its count. It only reads and asks:
 * nothing here writes or sends, so nothing is handed to the work gate. A failed read keeps what was
 * read before.
 */
export function useShiftParticipation(input: ShiftParticipationInput): Participation | null {
  const { local, shiftId, shiftReads, online, onRefresh } = input;
  const { hostId, deviceId } = input.pairing;
  const [participation, setParticipation] = useState<Participation | null>(null);
  useEffect(() => {
    let cancelled = false;
    readParticipation(local, { hostId, deviceId }, shiftId).then(
      (read) => {
        if (!cancelled) setParticipation(read);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // `shiftReads` is the trigger: every read of the host's list brings figures to read again.
  }, [local, hostId, deviceId, shiftId, shiftReads]);
  const shared = sharedParticipation(participation) !== null;
  useEffect(() => {
    if (!online || !shared || onRefresh === undefined) return undefined;
    const timer = setInterval(onRefresh, SHIFT_TOTALS_POLL_MS);
    return () => clearInterval(timer);
  }, [online, shared, onRefresh]);
  return participation;
}

/** Follow a closed part's receipts until the operator leaves the results screen. */
export function useClosedPartState(
  {
    local,
    pairing: { hostId, deviceId },
    shiftReads,
    outboxVersion,
  }: {
    local: LocalExecutor;
    pairing: Pairing;
    shiftReads?: number;
    outboxVersion?: number;
  },
  shiftId: string,
  closedPart: boolean,
) {
  const state = useState<PartState | null>(null);
  const [, setPartState] = state;
  useEffect(() => {
    if (!closedPart) return;
    let current = true;
    void readPartState(local, { hostId, deviceId }, shiftId).then(
      (part) => {
        if (current && part !== null) setPartState(part);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [local, hostId, deviceId, shiftId, closedPart, shiftReads, outboxVersion, setPartState]);
  return state;
}
