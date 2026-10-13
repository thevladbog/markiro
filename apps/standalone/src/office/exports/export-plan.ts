import { useEffect, useState } from "react";

import type { ShiftExportRows, ShiftMode } from "../../host/protocol.js";
import {
  exportCounts,
  formatCheck,
  offeredFormats,
  palletOffers,
  palletWarnings,
  type ExportCounts,
  type ExportWarning,
  type FormatCheck,
  type PalletOffer,
} from "./export-checks.js";
import { failureReason } from "./run-export.js";

/**
 * What the export dialog works out before it offers anything (plan ЧЗ): the
 * counts, the check of every format and every pallet with its own warnings.
 * A shift of 200 000 codes takes a second or two to check a format against,
 * ten formats a few seconds, so the work is cut into turns — one a step — with
 * the event loop given back before each. The dialog stays open to a key, a
 * click or its close, says how far the work has come, and a close or a newer
 * answer ends it at the next turn.
 */

export interface PalletCheck extends PalletOffer {
  /** The late boxes of this pallet's own document; none when it cannot be formed. */
  warnings: ExportWarning[];
}

export interface ExportPlan {
  counts: ExportCounts;
  /** Each format the shift is offered, with its refusal and warnings now. */
  checks: FormatCheck[];
  /** Every pallet of a shift with pallets; none for a shift without. */
  pallets: PalletCheck[];
}

export interface PlanProgress {
  done: number;
  total: number;
}

export interface PlanTurns {
  /** Gives the event loop back; resolves in a later turn. */
  pause: () => Promise<void>;
  /** Whether the answer is still wanted; asked after each pause. */
  live: () => boolean;
  progress: (step: PlanProgress) => void;
}

/** A turn of the event loop: whatever is waiting to be drawn or handled runs first. */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The steps of a plan: the counts, each format the shift is offered, the pallets. */
export function planSteps(rows: ShiftExportRows, mode: ShiftMode = "aggregation"): number {
  return offeredFormats(rows, mode).length + 2;
}

/**
 * The plan of `rows`, made one step at a time — the counts, each format the
 * shift of `mode` is offered (`offeredFormats`), the pallets — with a pause
 * before each. `null`: it was no longer wanted at a pause, and nothing after
 * that pause was done.
 */
export async function planExport(
  rows: ShiftExportRows,
  formedAt: string,
  turns: PlanTurns,
  mode: ShiftMode = "aggregation",
): Promise<ExportPlan | null> {
  const formats = offeredFormats(rows, mode);
  const total = planSteps(rows, mode);
  let done = 0;
  async function step<T>(work: () => T): Promise<{ value: T } | null> {
    await turns.pause();
    if (!turns.live()) return null;
    const value = work();
    done += 1;
    turns.progress({ done, total });
    return { value };
  }
  const counts = await step(() => exportCounts(rows));
  if (counts === null) return null;
  const checks: FormatCheck[] = [];
  for (const format of formats) {
    const checked = await step(() => formatCheck(rows, format, formedAt));
    if (checked === null) return null;
    checks.push(checked.value);
  }
  const pallets = await step(() =>
    rows.shift.palletsEnabled
      ? palletOffers(rows).map((pallet) => ({
          ...pallet,
          warnings: palletWarnings(rows, pallet.palletId),
        }))
      : [],
  );
  if (pallets === null) return null;
  return { counts: counts.value, checks, pallets: pallets.value };
}

export type PlanState =
  | { status: "working"; done: number; total: number }
  | { status: "ready"; plan: ExportPlan }
  | { status: "failed"; reason: string };

/**
 * The plan of the rows on screen, for a shift of `mode` (the export source
 * does not carry it: the dialog's shift does), made in turns after they
 * arrive. A new `rows` starts over; leaving ends the work at its next turn. A
 * failure is kept as its kind (`failureReason`), for the dialog to say.
 */
export function useExportPlan(rows: ShiftExportRows | undefined, mode: ShiftMode): PlanState {
  const [job, setJob] = useState<{ rows: ShiftExportRows; state: PlanState } | null>(null);
  useEffect(() => {
    if (rows === undefined) return undefined;
    let wanted = true;
    planExport(
      rows,
      new Date().toISOString(),
      {
        pause: yieldToUi,
        live: () => wanted,
        progress: ({ done, total }) => setJob({ rows, state: { status: "working", done, total } }),
      },
      mode,
    ).then(
      (plan) => {
        if (plan !== null && wanted) setJob({ rows, state: { status: "ready", plan } });
      },
      (error: unknown) => {
        if (wanted) setJob({ rows, state: { status: "failed", reason: failureReason(error) } });
      },
    );
    return () => {
      wanted = false;
    };
  }, [rows, mode]);
  if (job !== null && job.rows === rows) return job.state;
  return { status: "working", done: 0, total: rows === undefined ? 0 : planSteps(rows, mode) };
}
