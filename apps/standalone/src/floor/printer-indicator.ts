import { useEffect, useState } from "react";

import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readOpenJob } from "./print/print-jobs.js";
import {
  onWorkstationSettingsChanged,
  readWorkstationSettings,
} from "./setup/workstation-settings.js";

/** What the header's printer chip is made of (`printerChip`). */
export interface PrinterState {
  /** The workstation has a printer profile at all. */
  configured: boolean;
  /** A label of the shift waits failed or with an unknown outcome. */
  failed: boolean;
}

/**
 * The printer as the station knows it: the profiles of the workstation setup and, in a shift,
 * its oldest label job still waiting (`readOpenJob`). A job this build cannot read still waits,
 * so it counts as failed; a read of the settings that fails leaves the chip out (`null`).
 */
export async function readPrinterState(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string | null,
): Promise<PrinterState> {
  const settings = await readWorkstationSettings(local);
  let failed = false;
  if (shiftId !== null) {
    try {
      const job = await readOpenJob(local, pairing, shiftId);
      failed = job !== null && (job.state === "failed" || job.state === "unknown");
    } catch {
      failed = true;
    }
  }
  return { configured: settings.printers.length > 0, failed };
}

/**
 * The state, read again with the outbox, the shift, the bar's own tick (it runs while a send
 * fails or the serials run low) and whenever the workstation setup saves. No timer of its own:
 * a quiet bar starts none. `null` before the first read and after a failed one.
 */
export function usePrinterState(
  local: LocalExecutor,
  pairing: Pairing,
  shiftId: string | null,
  outboxVersion: number,
  tick: number,
): PrinterState | null {
  const { hostId, deviceId } = pairing;
  const [state, setState] = useState<PrinterState | null>(null);
  const [saved, setSaved] = useState(0);
  useEffect(() => onWorkstationSettingsChanged(() => setSaved((count) => count + 1)), []);
  useEffect(() => {
    let cancelled = false;
    readPrinterState(local, { hostId, deviceId }, shiftId).then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {
        if (!cancelled) setState(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, outboxVersion, tick, saved]);
  return state;
}
