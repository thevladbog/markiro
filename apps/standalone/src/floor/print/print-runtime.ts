import type { HardwareApi, PrintResult, PrintTarget } from "../../hardware/hardware.js";
import { printerTargetKey } from "../setup/workstation-settings.js";

/**
 * How long the webview waits for one send's answer, from the moment it asks
 * (queue included). The shell bounds each connection and write by 5 s, but a
 * COM port's flush or a spooler call can block past its own limit, and the
 * call then never answers (plan 2a4's notes): the work screen must not wait
 * for it forever.
 *
 * The limit counts from the moment of asking, queue wait included: a label
 * queued behind a slow but healthy send gets only what is left of it and can
 * end as `timeout` or `busy`. Rare while an open job stops the next box; it
 * grows once pallet labels share the box printer (plan ПЛ-Ц).
 */
export const PRINT_SEND_LIMIT_MS = 20_000;

/**
 * How one send went, as far as this computer knows: `answered` — the shell's
 * answer; `timeout` — the bytes went to the shell and no answer came within
 * the limit, so a label may exist; `busy` — the limit ran out while an
 * earlier send to the same address still had the printer, and these bytes
 * were never given to the shell (they never will be).
 */
export type SendOutcome =
  { kind: "answered"; result: PrintResult } | { kind: "timeout" } | { kind: "busy" };

/** A timer the runtime can stop; tests give one they fire by hand. */
export type StartTimer = (ms: number, fire: () => void) => () => void;

const realTimer: StartTimer = (ms, fire) => {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
};

/**
 * The printers of this app: one send at a time per address (the cloud
 * station's `serializePrinterOutput`), each answered within
 * `PRINT_SEND_LIMIT_MS`, and the jobs whose bytes the shell holds right now.
 *
 * A shell call that never returns holds its address until the app restarts:
 * every later send to that printer ends `busy` (`failed` `printer_busy`, the
 * bytes never given over — safe) and the stuck call's job stays in flight, so
 * the recovery never frees it. The way out is another printer or a restart;
 * the screens' `printer_busy` text must say so.
 */
export interface PrintRuntime {
  /**
   * Sends `bytes` to `target` after the sends already queued for its address.
   * Never rejects: a failed IPC call is `outcome_unknown` (`printBytes`).
   * `jobId` (a print job's, `null` for a test label) is in flight from now
   * until the shell's call really settles — past the limit too.
   */
  send: (jobId: string | null, target: PrintTarget, bytes: Uint8Array) => Promise<SendOutcome>;
  /** The job's bytes are with the shell, or wait for their turn. */
  isInFlight: (jobId: string) => boolean;
  /** Every job in flight (the recovery of interrupted jobs skips them). */
  inFlight: () => string[];
}

export function createPrintRuntime(
  printBytes: HardwareApi["printBytes"],
  options: { limitMs?: number; startTimer?: StartTimer } = {},
): PrintRuntime {
  const { limitMs = PRINT_SEND_LIMIT_MS, startTimer = realTimer } = options;
  const tails = new Map<string, Promise<void>>();
  const flying = new Map<string, number>();

  function hold(jobId: string | null): () => void {
    if (jobId === null) return () => undefined;
    flying.set(jobId, (flying.get(jobId) ?? 0) + 1);
    return () => {
      const left = (flying.get(jobId) ?? 1) - 1;
      if (left <= 0) flying.delete(jobId);
      else flying.set(jobId, left);
    };
  }

  return {
    send: (jobId, target, bytes) => {
      const key = printerTargetKey(target);
      const release = hold(jobId);
      let started = false;
      let expired = false;
      const previous = tails.get(key) ?? Promise.resolve();
      // The call starts after every earlier send to this address has really
      // settled, never merely timed out: two writes to one printer at once
      // could interleave two labels.
      const call = previous.then(async (): Promise<PrintResult | null> => {
        if (expired) return null;
        started = true;
        return printBytes(target, bytes);
      });
      const settled = call.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, settled);
      void settled.then(() => {
        release();
        if (tails.get(key) === settled) tails.delete(key);
      });
      const answered = call.then(
        (result): SendOutcome =>
          result === null ? { kind: "busy" } : { kind: "answered", result },
        (): SendOutcome => ({ kind: "answered", result: { sent: false, code: "outcome_unknown" } }),
      );
      return new Promise<SendOutcome>((resolve) => {
        let done = false;
        const stop = startTimer(limitMs, () => {
          if (done) return;
          done = true;
          // Not yet given to the shell: it never will be.
          if (!started) expired = true;
          resolve(started ? { kind: "timeout" } : { kind: "busy" });
        });
        void answered.then((outcome) => {
          if (done) return;
          done = true;
          stop();
          resolve(outcome);
        });
      });
    },
    isInFlight: (jobId) => flying.has(jobId),
    inFlight: () => [...flying.keys()],
  };
}
