import type {
  HardwareApi,
  PrintResult,
  PrintTarget,
  WindowsJobObservation,
  WindowsPrinting,
  WindowsPrintReceipt,
} from "../../hardware/hardware.js";
import { printerTargetKey, type PrinterMode } from "../setup/workstation-settings.js";

/**
 * How long the webview waits for one send's answer, from the moment it asks
 * (queue included). The shell bounds each connection and write by 5 s, but a
 * COM port's flush or a spooler call can block past its own limit, and the
 * call then never answers (plan 2a4's notes): the work screen must not wait
 * for it forever. A driver print (plan ДРВ) has the shell's own 30 s limit;
 * this one is shorter, so the work screen reads `timeout` first.
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
 * What «Проверить очередь Windows» learns of a job (plan ДРВ): the spooler's
 * word on its newest driver send, or `no_receipt` — no driver send of this
 * app run named a spooler job for it. Never a printed label.
 */
export type WindowsQueueCheck = WindowsJobObservation | { state: "no_receipt" };

/**
 * The printers of this app: one send at a time per address (the cloud
 * station's `serializePrinterOutput`), each answered within
 * `PRINT_SEND_LIMIT_MS`, and the jobs whose bytes the shell holds right now.
 * A send in driver mode (plan ДРВ) goes to the queue's Windows driver as the
 * document `Markiro:<uuid>`, through the same queue of its address.
 *
 * A shell call that never returns holds its address until the app restarts:
 * every later send to that printer ends `busy` (`failed` `printer_busy`, the
 * bytes never given over — safe) and the stuck call's job stays in flight, so
 * the recovery never frees it. The way out is another printer or a restart;
 * the screens' `printer_busy` text must say so.
 */
export interface PrintRuntime {
  /**
   * Sends `bytes` to `target` after the sends already queued for its address:
   * in the printer's language (`raw`, the default) or as a page for the
   * Windows driver (`windows_driver`, a Windows queue only). `paper: "a4"`
   * (plan А4) is an A4 sheet for the driver and nothing else: with RAW it is
   * refused as `invalid_target`, nothing sent. Never rejects: a
   * failed IPC call is `outcome_unknown` (`printBytes`) or `driver_unknown`.
   * `jobId` (a print job's, `null` for a test label) is in flight from now
   * until the shell's call really settles — past the limit too.
   */
  send: (
    jobId: string | null,
    target: PrintTarget,
    bytes: Uint8Array,
    mode?: PrinterMode,
    paper?: "a4",
  ) => Promise<SendOutcome>;
  /** The job's bytes are with the shell, or wait for their turn. */
  isInFlight: (jobId: string) => boolean;
  /** Every job in flight (the recovery of interrupted jobs skips them). */
  inFlight: () => string[];
  /**
   * The spooler's word on the job's newest driver send. The receipt is kept
   * in memory only — one that came after the limit too — and a new send of
   * the job forgets it; after a restart it is `no_receipt`. Never rejects.
   */
  checkWindowsJob: (jobId: string) => Promise<WindowsQueueCheck>;
  /** The shell prints through Windows drivers (Windows only); `false` when it cannot say. */
  supportsWindowsDriver: () => Promise<boolean>;
}

export interface PrintRuntimeOptions {
  limitMs?: number;
  startTimer?: StartTimer;
  /** The shell's driver printing; without it a driver send is `unsupported`, nothing sent. */
  windows?: WindowsPrinting;
  /** The UUID of a driver send's document name; a fresh one for every send. */
  newDocumentId?: () => string;
}

export function createPrintRuntime(
  printBytes: HardwareApi["printBytes"],
  options: PrintRuntimeOptions = {},
): PrintRuntime {
  const {
    limitMs = PRINT_SEND_LIMIT_MS,
    startTimer = realTimer,
    windows,
    newDocumentId = () => crypto.randomUUID(),
  } = options;
  const tails = new Map<string, Promise<void>>();
  const flying = new Map<string, number>();
  // The spooler receipt of each job's newest driver send, and which send that is.
  const receipts = new Map<string, WindowsPrintReceipt>();
  const newest = new Map<string, number>();
  let sequence = 0;

  function hold(jobId: string | null): () => void {
    if (jobId === null) return () => undefined;
    flying.set(jobId, (flying.get(jobId) ?? 0) + 1);
    return () => {
      const left = (flying.get(jobId) ?? 1) - 1;
      if (left <= 0) flying.delete(jobId);
      else flying.set(jobId, left);
    };
  }

  async function deliver(
    jobId: string | null,
    send: number,
    target: PrintTarget,
    bytes: Uint8Array,
    mode: PrinterMode,
    paper: "a4" | undefined,
  ): Promise<PrintResult> {
    // A sheet of A4 is a driver page: RAW has no such paper, and its bytes are no printer language.
    if (mode !== "windows_driver" && paper === "a4") return { sent: false, code: "invalid_target" };
    if (mode !== "windows_driver") return printBytes(target, bytes);
    // A driver profile is a Windows queue (`parsePrinterProfile`): anything else never goes.
    if (target.kind !== "usb") return { sent: false, code: "invalid_target" };
    if (windows === undefined) return { sent: false, code: "unsupported" };
    const documentName = `Markiro:${newDocumentId()}`;
    // The paper reaches the shell only when it is asked for: a label's call is as it was before plan А4.
    const result =
      paper === "a4"
        ? await windows.printWindowsRaster(target.printer, bytes, documentName, "a4")
        : await windows.printWindowsRaster(target.printer, bytes, documentName);
    if (jobId !== null && result.receipt !== undefined && newest.get(jobId) === send) {
      receipts.set(jobId, result.receipt);
    }
    return result;
  }

  return {
    send: (jobId, target, bytes, mode = "raw", paper) => {
      const key = printerTargetKey(target);
      const release = hold(jobId);
      sequence += 1;
      const send = sequence;
      if (jobId !== null) {
        newest.set(jobId, send);
        receipts.delete(jobId);
      }
      let started = false;
      let expired = false;
      const previous = tails.get(key) ?? Promise.resolve();
      // The call starts after every earlier send to this address has really
      // settled, never merely timed out: two writes to one printer at once
      // could interleave two labels.
      const call = previous.then(async (): Promise<PrintResult | null> => {
        if (expired) return null;
        started = true;
        return deliver(jobId, send, target, bytes, mode, paper);
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
        (): SendOutcome => ({
          kind: "answered",
          result: {
            sent: false,
            code: mode === "windows_driver" ? "driver_unknown" : "outcome_unknown",
          },
        }),
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
    checkWindowsJob: async (jobId) => {
      const receipt = receipts.get(jobId);
      if (receipt === undefined || windows === undefined) return { state: "no_receipt" };
      try {
        return await windows.getWindowsPrintJob(receipt);
      } catch {
        return { state: "unavailable" };
      }
    },
    supportsWindowsDriver: async () => {
      if (windows === undefined) return false;
      try {
        return await windows.supportsWindowsPrinting();
      } catch {
        return false;
      }
    },
  };
}
