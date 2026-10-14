import type { ReprintReason } from "@markiro/domain";
import type { TFunction } from "i18next";
import { useCallback, useRef, useState } from "react";

import type { SignalTone } from "@markiro/ui";

import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import { readWorkstationSettings, resolvePrinter } from "../setup/workstation-settings.js";
import { readShiftCopies, readShiftCopy, type WorkShift } from "../shifts/shift-copies.js";
import type { WorkQueue } from "../work/work-queue.js";
import {
  readShiftUnitLabels,
  readUnitLabelJob,
  readUnresolvedUnitLabel,
  readUnresolvedUnitLabelRef,
  type UnitLabelEntry,
  type UnitLabelJob,
} from "./unit-label-store.js";
import {
  canAcceptNext,
  recoverUnitLabels,
  reprintUnitLabel,
  sendUnitLabel,
  skipVerification,
  StaleUnitLabelError,
  UnitLabelRefusedError,
  UnitLabelShiftClosedError,
  UnitLabelStateError,
  verifyUnitLabel,
  type UnitLabelPrintContext,
} from "./unit-label-work.js";
import type { AnotherShiftReach, UnitLabelNote, UnitLabelWindow } from "./UnitLabelVerification.js";

/** Why a decision on a unit label was not saved, as the window and the history say it. */
export type UnitLabelFailure = "failed" | "shift_closed";

/** A decision's failure on a unit label in words: this station closed its shift, or anything else. */
function unitFailureOf(error: unknown): UnitLabelFailure {
  return error instanceof UnitLabelShiftClosedError ? "shift_closed" : "failed";
}

/** The window of a unit label, its job read whole (a check, a skip and a send need it). */
export type UnitView =
  { kind: "job"; job: UnitLabelJob } | Exclude<UnitLabelWindow, { kind: "job" }>;

/**
 * The work screen's stops of a shift that prints the duplicate (plan РЕЖ part B, task B6):
 * `unit_label` — the window over the work, as long as the station's label is unresolved, another
 * shift's label stands in the way, no duplicate printer is assigned, or the label could not be
 * read (a scan goes to the printed label's check, or is refused); `unit_history` — «История
 * этикеток» in place of the exceptions: `entries` once read; `failure` — not read or a reprint not
 * done (`failed`), or a reprint refused because this station closed the shift (`shift_closed`);
 * `blocked` — an unresolved label waits, and no other is printed again.
 */
export type UnitStop =
  | { kind: "unit_label"; view: UnitView }
  | {
      kind: "unit_history";
      entries: readonly UnitLabelEntry[] | null;
      failure: UnitLabelFailure | null;
      blocked: boolean;
    };

/** `stop` when it is one of the unit labels' own. */
function unitStopOf(stop: { readonly kind: string } | UnitStop | null): UnitStop | null {
  return stop !== null && isUnitStop(stop) ? stop : null;
}

function isUnitStop(stop: { readonly kind: string } | UnitStop): stop is UnitStop {
  return stop.kind === "unit_label" || stop.kind === "unit_history";
}

/** The policy of the Data Matrix duplicate a shift froze in its snapshot (plan РЕЖ part B). */
export type UnitLabelPolicy = NonNullable<WorkShift["snapshot"]["validationPrint"]>;

/**
 * The duplicate's policy of `shift`: a validation shift's, frozen in its snapshot when it opened;
 * `null` — the shift prints no duplicate (an aggregation shift, or a validation shift without it).
 */
export function unitLabelPolicy(shift: WorkShift): UnitLabelPolicy | null {
  return shift.copy.mode === "validation" ? shift.snapshot.validationPrint : null;
}

/** Whether `shift` is a validation shift that prints the Data Matrix duplicate (plan РЕЖ part B). */
export function printsUnitLabels(shift: WorkShift): boolean {
  return unitLabelPolicy(shift) !== null;
}

/** How many of a shift's labels «История этикеток» lists, newest first. */
const HISTORY_ROWS = 100;

/** What the unit labels' work reads when it runs: the work screen's latest props. */
export interface UnitLabelLive {
  shift: WorkShift;
  operatorId: string;
  hostId: string;
  deviceId: string;
  local: LocalExecutor;
  officeClosed: boolean;
  printing: PrintRuntime;
  onRecorded: () => void;
  track: <T>(work: Promise<T>) => Promise<T>;
  t: TFunction;
}

/** What the work screen lends the unit labels' work: all of it stable for the screen's life. */
export interface UnitLabelWorkDeps {
  live: { readonly current: UnitLabelLive };
  /** The screen's stop, read by a job in its turn before React renders it. */
  stopRef: { readonly current: { readonly kind: string } | null };
  setStop: (next: UnitStop | null) => void;
  /** The screen is mounted: no state is set after it is gone. */
  alive: { readonly current: boolean };
  queue: WorkQueue;
  /** A verdict's tone, flash or cue. */
  show: (tone: SignalTone, title: string, detail: string | null) => void;
  /** The screen's numbers again; a failed read is quiet. */
  refreshQuietly: () => Promise<unknown>;
  /** The floor has begun to leave. */
  leavingNow: () => boolean;
}

function pairingOf(now: UnitLabelLive): Pairing {
  return { hostId: now.hostId, deviceId: now.deviceId };
}

/** The context of a unit label's send, check, skip, reprint and recovery (plan РЕЖ part B). */
function unitContextOf(live: { readonly current: UnitLabelLive }): UnitLabelPrintContext {
  const now = live.current;
  return {
    local: now.local,
    pairing: pairingOf(now),
    runtime: now.printing,
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}

/**
 * Another shift's label in the way (plan РЕЖ part B): that shift's number from the station's copy
 * (`null` when none is left), and where the operator finds it — in the list of this line (the
 * work screen's shift is one of it: a move of the station to another line leaves the screen), on
 * another line, or nowhere. The last two are a dead end only the office can open.
 */
async function anotherShiftOf(
  live: { readonly current: UnitLabelLive },
  shiftId: string,
): Promise<{ number: string | null; reach: AnotherShiftReach }> {
  const now = live.current;
  const pairing = pairingOf(now);
  const lineId = now.shift.copy.lineId;
  const copy = await readShiftCopy(now.local, pairing, shiftId);
  const listed = (await readShiftCopies(now.local, pairing, lineId)).some(
    (listedCopy) => listedCopy.id === shiftId,
  );
  const reach: AnotherShiftReach = listed
    ? "listed"
    : copy !== null && copy.lineId !== lineId
      ? "other_line"
      : "unavailable";
  return { number: copy?.number ?? null, reach };
}

/**
 * The unit labels of a work screen whose shift prints the Data Matrix duplicate (plan РЕЖ part B,
 * task B6; the cloud station's `use-product-label-work.ts`): the label panel's job, the window's
 * note and refusals, whether a decision or a send runs, and every piece of work on them — each
 * one turn of the screen's queue, handed to the floor's gate. The screen keeps the scanner, its
 * stops and its last-scan line; it hands the window's scans here (`scanInWindow`) and the accepted
 * unit's label (`sendAccepted`).
 */
export function useUnitLabelWork(deps: UnitLabelWorkDeps) {
  const { live, stopRef, setStop, alive, queue, show, refreshQuietly, leavingNow } = deps;
  // The shift's current unit label (the unresolved one, else the newest) and what its window says.
  const [job, setJob] = useState<UnitLabelEntry | null>(null);
  const [note, setNote] = useState<UnitLabelNote | null>(null);
  // A decision is being saved; the label is on its way to the printer.
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const deciding = useRef(false);
  // The scans the window refused in the view it stands in (said in it, in words; a new view —
  // after any decision or read — says nothing of the old ones), and whether its reprint's
  // reasons are open, while no label is checked (the cloud pauses its verification).
  const [refusal, setRefusal] = useState<{ view: UnitView; count: number } | null>(null);
  const reasonOpen = useRef(false);
  const holdChecks = useCallback((open: boolean) => {
    reasonOpen.current = open;
  }, []);

  /**
   * What the station's unit labels need (plan РЕЖ part B, task B6) — on entry,
   * after a unit's label went, after its check and after every decision on it:
   * the label panel's job (this shift's unresolved one, else its newest) and
   * the window, which stands while the station's unresolved label waits (one
   * of another shift stands in the way, as the cloud's `PRODUCT_LABEL_BUSY`),
   * or while no duplicate printer is assigned where a new unit would need one
   * (not in a shift the office closed: it takes no unit). `recover`: the sends
   * a stop of the app cut become unknown first (`recoverUnitLabels`, which
   * leaves every send of this app run alone, so it may run at any load).
   * Nothing here sends a label. It replaces no stop but its own window.
   */
  const settle = useCallback(
    async (recover: boolean): Promise<void> => {
      const now = live.current;
      const pairing = pairingOf(now);
      const shiftId = now.shift.copy.id;
      if (recover) {
        const recovered = await recoverUnitLabels(unitContextOf(live), now.operatorId);
        if (recovered.length > 0) now.onRecorded();
      }
      const waiting = await readUnresolvedUnitLabel(now.local, pairing);
      const [newest] = await readShiftUnitLabels(now.local, pairing, shiftId, 1);
      const gate = canAcceptNext(waiting, shiftId);
      let view: UnitView | null = null;
      if (gate.kind === "another_shift") {
        const found = await anotherShiftOf(live, gate.job.shiftId);
        view = { kind: "another_shift", job: gate.job, ...found };
      } else if (gate.kind !== "accept") view = { kind: "job", job: gate.job };
      else if (
        !live.current.officeClosed &&
        resolvePrinter(await readWorkstationSettings(now.local), "duplicate") === null
      ) {
        view = { kind: "printer" };
      }
      if (alive.current) {
        setJob(waiting !== null && waiting.shiftId === shiftId ? waiting : (newest ?? null));
      }
      const stopped = stopRef.current;
      if (view !== null) {
        if (stopped === null || stopped.kind === "unit_label")
          setStop({ kind: "unit_label", view });
      } else if (stopped?.kind === "unit_label") {
        setStop(null);
      }
    },
    [live, stopRef, setStop, alive],
  );

  /** `settle`, whose failure stops the line with the window's own words. */
  const settleSafely = useCallback(
    async (recover: boolean): Promise<void> => {
      try {
        await settle(recover);
      } catch {
        setStop({ kind: "unit_label", view: { kind: "storage" } });
      }
    },
    [settle, setStop],
  );

  /**
   * The send of a unit's label that is `prepared` — the one an accepted unit
   * made, the operator's reprint, or one saved before a restart that the
   * operator sends: one send, `sending` written before the bytes go (B5's
   * `sendUnitLabel`). A job that moved on meanwhile is read again by the
   * settling that follows; any other failure is the caller's. Only from the
   * work queue.
   */
  const send = useCallback(
    async (prepared: UnitLabelJob): Promise<void> => {
      if (alive.current) {
        setSending(true);
        setJob(prepared);
      }
      try {
        const sent = await sendUnitLabel(unitContextOf(live), prepared, live.current.operatorId);
        live.current.onRecorded();
        if (alive.current) setJob(sent);
      } catch (error) {
        if (!(error instanceof StaleUnitLabelError || error instanceof UnitLabelStateError)) {
          throw error;
        }
      } finally {
        if (alive.current) setSending(false);
      }
    },
    [live, alive],
  );

  /**
   * A scan while the unit label's check waits (a required check after the
   * send, or an unknown outcome): the printed label's code against the job's
   * (B5's `verifyUnitLabel`). The label's own code resolves it, and the window
   * goes; another code or an unreadable one is said in the window and by tone,
   * the check still waiting. It never reaches the pipeline and journals no
   * scan. Only from the work queue.
   */
  const verify = useCallback(
    async (checked: UnitLabelJob, raw: string): Promise<void> => {
      const say = live.current.t;
      let result: Awaited<ReturnType<typeof verifyUnitLabel>>;
      try {
        result = await verifyUnitLabel(unitContextOf(live), checked, raw, live.current.operatorId);
      } catch (error) {
        if (!(error instanceof StaleUnitLabelError || error instanceof UnitLabelStateError)) {
          throw error;
        }
        // Not this check's label any more: the label as it is now.
        setNote(null);
        await settle(false);
        return;
      }
      live.current.onRecorded();
      if (result.kind === "verified") {
        setNote(null);
        show("ok", say("floor.unitLabels.verified"), null);
        await settle(false);
        return;
      }
      setNote(result.kind);
      show("error", say(`floor.unitLabels.${result.kind}`), null);
      if (stopRef.current?.kind === "unit_label") {
        setStop({ kind: "unit_label", view: { kind: "job", job: result.job } });
      }
    },
    [live, stopRef, settle, show, setStop],
  );

  /**
   * A scan while the window stands, in the queue's turn: the printed label's
   * check when the check is open, no decision runs and the reasons are not open
   * (`checked`; a failed check stops the line with the window's words), or
   * refused (`refused`: the window says so; the screen says it under it).
   * Nothing reaches the pipeline, nothing is journalled.
   */
  const scanInWindow = useCallback(
    async (view: UnitView, raw: string): Promise<"checked" | "refused"> => {
      if (
        view.kind === "job" &&
        !deciding.current &&
        !reasonOpen.current &&
        canAcceptNext(view.job, live.current.shift.copy.id).kind === "verify"
      ) {
        try {
          await verify(view.job, raw);
        } catch {
          setStop({ kind: "unit_label", view: { kind: "storage" } });
          show("error", live.current.t("floor.work.signal.systemError"), null);
        }
        return "checked";
      }
      // Said in the window too, where the operator looks, not only under it.
      if (alive.current) {
        setRefusal((was) => ({ view, count: was?.view === view ? was.count + 1 : 1 }));
      }
      return "refused";
    },
    [live, alive, verify, setStop, show],
  );

  /**
   * The accepted unit's label goes at once (its first send), read whole by the
   * reference the scan answered, and its window follows it. Only from the work
   * queue.
   */
  const sendAccepted = useCallback(
    async (labelId: string): Promise<void> => {
      try {
        const now = live.current;
        const accepted = await readUnitLabelJob(now.local, pairingOf(now), labelId);
        // Gone or moved meanwhile: the settling below reads the label as it is now.
        if (accepted !== null) await send(accepted);
      } catch (error) {
        // The label as it is now is read next; the window says the send was not saved.
        setNote(unitFailureOf(error));
      }
      await settleSafely(false);
    },
    [live, send, settleSafely],
  );

  /**
   * A decision on the unit label, as the line's next piece of work handed to
   * the gate before it starts (as `decide` for a box's label): the window
   * waits while it runs; then the label is read again and its window shows
   * where it ended. A job that moved on, or another label in the way, writes
   * nothing and is read again (in «История этикеток» it is said there); any
   * other failure is said in the window as the label is read again. A second
   * press while one runs, and any press once the leave began, does nothing.
   */
  const decide = (work: () => Promise<void>) => {
    if (deciding.current || leavingNow()) return;
    deciding.current = true;
    setBusy(true);
    setNote(null);
    void live.current
      .track(
        queue.run(async () => {
          let failed: UnitLabelFailure | null = null;
          try {
            await work();
          } catch (error) {
            const refused =
              error instanceof StaleUnitLabelError ||
              error instanceof UnitLabelStateError ||
              error instanceof UnitLabelRefusedError;
            const stopped = unitStopOf(stopRef.current);
            if (stopped?.kind === "unit_history") {
              setStop({ ...stopped, failure: unitFailureOf(error) });
            } else if (!refused) {
              failed = unitFailureOf(error);
            }
          } finally {
            deciding.current = false;
            if (alive.current) setBusy(false);
          }
          await settleSafely(false);
          if (failed !== null && stopRef.current?.kind === "unit_label") setNote(failed);
          await refreshQuietly();
        }),
      )
      // The focus is the window's while it stands (it moves it itself when a view drops the
      // button pressed) and goes somewhere safe when it goes (the screen's effect over its stop).
      .catch(() => setStop({ kind: "unit_label", view: { kind: "storage" } }));
  };

  /** The unit label's job, read whole and fresh in the queue's turn. */
  const jobNow = async (jobId: string): Promise<UnitLabelJob> => {
    const now = live.current;
    const fresh = await readUnitLabelJob(now.local, pairingOf(now), jobId);
    if (fresh === null) throw new StaleUnitLabelError(jobId);
    return fresh;
  };

  /** The window's job, or nothing to decide on. */
  const windowJob = (): UnitLabelJob | null => {
    const stopped = unitStopOf(stopRef.current);
    return stopped?.kind === "unit_label" && stopped.view.kind === "job" ? stopped.view.job : null;
  };

  /** «Пропустить проверку»: only after the label went to the printer (B5's `skipVerification`). */
  const skip = () => {
    const shown = windowJob();
    if (shown === null) return;
    decide(async () => {
      await skipVerification(unitContextOf(live), await jobNow(shown.id), live.current.operatorId);
      live.current.onRecorded();
    });
  };

  /** «Отправить сохранённую этикетку»: the first send of a label prepared before a restart. */
  const sendPrepared = () => {
    const shown = windowJob();
    if (shown === null) return;
    decide(async () => send(await jobNow(shown.id)));
  };

  /**
   * The label `jobId` printed again with the operator's reason: a new attempt
   * of the same bytes (B5's `reprintUnitLabel`), sent at once as the cloud's
   * reprint is; «История этикеток» closes once it is written.
   */
  const reprint = (jobId: string, reason: ReprintReason) =>
    decide(async () => {
      const prepared = await reprintUnitLabel(
        unitContextOf(live),
        await jobNow(jobId),
        reason,
        live.current.operatorId,
        live.current.shift.copy.id,
      );
      live.current.onRecorded();
      if (stopRef.current?.kind === "unit_history") setStop(null);
      await send(prepared);
    });

  /** The window's label printed again with the operator's reason. */
  const reprintShown = (reason: ReprintReason) => {
    const shown = windowJob();
    if (shown !== null) reprint(shown.id, reason);
  };

  /** «Повторить»: the label read again; a send this app lost becomes unknown first, nothing sent. */
  const retry = () =>
    decide(async () => {
      const recovered = await recoverUnitLabels(unitContextOf(live), live.current.operatorId);
      if (recovered.length > 0) live.current.onRecorded();
    });

  /**
   * «История этикеток», opened while nothing stops the work, as the line's
   * next piece of work: the shift's labels, newest first, and whether an
   * unresolved label holds every reprint back.
   */
  const openHistory = () => {
    if (leavingNow() || stopRef.current !== null) return;
    setStop({ kind: "unit_history", entries: null, failure: null, blocked: false });
    void live.current
      .track(
        queue.run(async () => {
          const now = live.current;
          const entries = await readShiftUnitLabels(
            now.local,
            pairingOf(now),
            now.shift.copy.id,
            HISTORY_ROWS,
          );
          const blocked = (await readUnresolvedUnitLabelRef(now.local, pairingOf(now))) !== null;
          if (stopRef.current?.kind === "unit_history") {
            setStop({ kind: "unit_history", entries, failure: null, blocked });
          }
        }),
      )
      .catch(() => {
        if (stopRef.current?.kind === "unit_history") {
          setStop({ kind: "unit_history", entries: [], failure: "failed", blocked: true });
        }
      });
  };

  /** How many scans the window refused in `view` (0 — none), as the window says it. */
  const refusedIn = (view: UnitView): number => (refusal?.view === view ? refusal.count : 0);

  return {
    /** The label panel's job: the shift's unresolved label, else its newest; `null` — none yet. */
    job,
    /** What the window says under the label. */
    note,
    /** A decision is being saved. */
    busy,
    /** The label is on its way to the printer. */
    sending,
    refusedIn,
    holdChecks,
    settle,
    settleSafely,
    scanInWindow,
    sendAccepted,
    skip,
    sendPrepared,
    reprint,
    reprintShown,
    retry,
    openHistory,
  };
}
