import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  classifyScan,
  kmKey,
  validateShiftScan,
  type LabelTemplateSpec,
  type ScanVerdict,
} from "@markiro/domain";
import { Alert, Button, SignalOverlay, type SignalTone } from "@markiro/ui";
import { boxLabelFields } from "../lib/box-label.js";
import {
  clearBox,
  currentBox,
  disassembleBox,
  listClosedBoxes,
  markPrintSkipped,
  markPrintVerified,
  openBox,
  reprintBox,
  type ClosedBoxSummary,
  type DeviceBox,
} from "../lib/boxes.js";
import { closeCurrentBox as closeCurrentBoxLib, type CloseBoxResult } from "../lib/close-box.js";
import type { PrintTarget } from "../lib/hardware.js";
import type { PrinterLanguage } from "../lib/hardware-config.js";
import { findFirstSeen, loadCodeKeys, recordScan, undoLastScan } from "../lib/journal.js";
import { readShiftMirror, type SqlExecutor } from "../lib/mirror.js";
import { renderLabelBytes } from "../lib/print-label.js";
import { rasterizeText } from "../lib/rasterizer.js";
import { createScanQueue, type ScanOutcome } from "../lib/scan-queue.js";
import type { ScanSource } from "../lib/scan-source.js";
import { playSignalTone, type SoundSettings } from "../lib/signal-sound.js";
import { PrintVerification } from "../ui/PrintVerification.js";
import { ShiftBoxesPanel } from "../ui/ShiftBoxesPanel.js";

export interface WorkScreenProps {
  exec: SqlExecutor;
  shiftId: string;
  terminalId: string | null;
  operatorId: string;
  expectedGtin14: string;
  productName: string;
  counterpartyName?: string | null;
  source: ScanSource;
  sound: SoundSettings;
  /** Signals a scan was just written, so a queued outbox row does not have
   * to wait for the sync engine's 15s heartbeat before draining. */
  onScanRecorded?: () => void;
  /** Return to shift selection. Does NOT close the shift — that is a cabinet action. */
  onExit: () => void;
  /** Scans still queued on this device, shown before the operator walks away. */
  pendingSync: number;
  /**
   * This device's 9-digit GS1 issuer prefix for box SSCCs
   * (`StationBundle.sscc.issuerPrefix`), or null for a validation-mode
   * shift, or when the server could not resolve one for this device. Null
   * means the box UI does not render at all — there is nothing to close.
   */
  issuerPrefix: string | null;
  /** Items per box before it closes automatically (the shift's `boxCapacity`). */
  boxCapacity: number | null;
  /**
   * Injectable for tests; defaults to the real `closeCurrentBox` (Task 12)
   * bound to this device's `issuerPrefix`.
   */
  closeCurrentBox?: (shiftId: string, operatorId: string | null) => Promise<CloseBoxResult>;
  /** Fires for every raw payload the scan queue processes, whatever the verdict — test-only observability. */
  onScan?: (raw: string) => void;
  /** Opt-in per workstation: scan a closed box's printed label back before moving on. */
  verifyPrintedLabel: boolean;
  /** Where and how to render + send a box label. Omit to skip printing (e.g. no printer configured). */
  printing?: {
    target: PrintTarget;
    language: PrinterLanguage;
    print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
  } | null;
}

/** How long each verdict's full-screen flash stays up (design brief 04). */
const FLASH_MS: Record<SignalTone, number> = { ok: 350, error: 1200, duplicate: 900 };

function toneOf(verdict: ScanVerdict): SignalTone {
  if (verdict.status === "ok") return "ok";
  if (verdict.status === "duplicate") return "duplicate";
  return "error";
}

export function WorkScreen({
  exec,
  shiftId,
  terminalId,
  operatorId,
  expectedGtin14,
  productName,
  counterpartyName,
  source,
  sound,
  onScanRecorded,
  onExit,
  pendingSync,
  issuerPrefix,
  boxCapacity,
  closeCurrentBox: closeCurrentBoxProp,
  onScan,
  verifyPrintedLabel,
  printing,
}: WorkScreenProps) {
  const { t, i18n } = useTranslation();
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [signal, setSignal] = useState<{ tone: SignalTone; title: string; detail?: string } | null>(
    null,
  );
  const [confirmExit, setConfirmExit] = useState(false);

  // Box aggregation state -- null (never loaded / no `issuerPrefix`) means no
  // box UI at all, per Task 13's correction: a validation-mode shift, or a
  // device the server could not resolve an issuer prefix for, has no box
  // section to show.
  const [box, setBox] = useState<{ boxId: string; itemCount: number } | null>(null);
  const [lastScanned, setLastScanned] = useState<{ boxId: string; codeHash: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [closedBoxes, setClosedBoxes] = useState<ClosedBoxSummary[]>([]);
  // `boxRef` is the box's SOURCE OF TRUTH for `process()` below, updated by
  // `updateBox` synchronously and directly -- never derived from `box` via a
  // separate effect. A scan can arrive (and be judged) the instant this
  // screen mounts, before React has committed the box-loading effect's
  // state update and re-run any effect that merely mirrors it; `updateBox`
  // closes that gap by writing the ref at the exact moment the box changes,
  // with `setBox` alongside it purely to drive the on-screen display.
  const boxRef = useRef<{ boxId: string; itemCount: number } | null>(null);
  function updateBox(next: { boxId: string; itemCount: number } | null): void {
    const previousBoxId = boxRef.current?.boxId ?? null;
    boxRef.current = next;
    setBox(next);
    if ((next?.boxId ?? null) !== previousBoxId) setLastScanned(null);
  }
  // Resolves once the current box has been loaded (or opened, or -- with no
  // `issuerPrefix` -- decided there is none) so `process()` can await it the
  // same way it already awaits `keysReady`, instead of racing a scan that
  // arrives before this screen's mount effects have settled.
  const boxReady = useRef<Promise<void> | null>(null);

  const reloadClosedBoxes = useCallback(async (): Promise<void> => {
    try {
      setClosedBoxes(await listClosedBoxes(exec, shiftId, terminalId));
    } catch (err) {
      console.error("station: failed to list closed boxes", err);
    }
  }, [exec, shiftId, terminalId]);

  useEffect(() => {
    if (issuerPrefix === null) {
      setClosedBoxes([]);
      return;
    }
    void reloadClosedBoxes();
  }, [issuerPrefix, reloadClosedBoxes]);

  const [noSerials, setNoSerials] = useState(false);
  // CodeRabbit PR33 review, Finding 4: `closeCurrentBox` burned a serial
  // that `buildSscc` could not turn into a valid SSCC (an over-capacity
  // local pool range -- see `close-box.ts`'s `invalid-serial` status for
  // the full story). Surfaced plainly rather than a silent console.error:
  // the box stays open (no sscc/closedAt written), so the operator can
  // simply try closing it again.
  const [invalidSerial, setInvalidSerial] = useState(false);
  // The box label's geometry -- a plain ref, not React state, the same shape
  // `keys` (above) already takes: nothing renders off this, and
  // `printAndMaybeVerify` reads it from inside `closeTheBox`, which can
  // itself run from `process()` -- a scan handler awaited well before React
  // has necessarily re-rendered this component, so a value that only
  // updated via `setState` could still read stale here regardless of
  // `labelSpecReady` below (Task 13 review, Finding 4). Written
  // synchronously inside the SAME `.then()` that resolves `labelSpecReady`,
  // so awaiting that promise guarantees this ref already holds whatever the
  // load produced, regardless of render timing.
  const labelSpecRef = useRef<LabelTemplateSpec | null>(null);
  // Resolves once this device's box-label geometry has been loaded (or
  // decided there is none, with no `issuerPrefix`) -- the same `keysReady`/
  // `boxReady` pattern this file already uses twice (Task 13 review, Finding
  // 4). `printAndMaybeVerify` awaits this before deciding whether a print
  // happened: without it, a box that closes before this mount-time
  // `readShiftMirror` resolves (a very fast first box, e.g. `boxCapacity: 1`)
  // would race a still-null `labelSpecRef`, silently skip printing, and --
  // now that Finding 3 makes a non-print visible -- show "print unavailable"
  // for a label that would have printed fine a moment later.
  const labelSpecReady = useRef<Promise<void> | null>(null);
  // CodeRabbit PR33 review, Finding 9: a QUEUE, not a single slot. Printing
  // is fired per box without being awaited by `closeTheBox` (a slow printer
  // must never delay the next scan), so with box capacity 1 (or a slow
  // printer) two boxes can finish printing in close succession. A single
  // `verification` slot would have the second box's prompt silently
  // overwrite -- and permanently lose -- the first's, leaving that box's
  // `print_verified_at`/`print_skipped_at` null forever (the operator never
  // even sees a prompt to resolve it against). Queuing means every box that
  // printed gets its own prompt, shown one at a time in arrival order; none
  // is silently dropped.
  const [verificationQueue, setVerificationQueue] = useState<
    Array<{ sscc: string; bytes: Uint8Array | null; boxId: string | null }>
  >([]);
  /** The one prompt currently shown, or null when the queue is empty. */
  const verification = verificationQueue[0] ?? null;
  function enqueueVerification(entry: {
    sscc: string;
    bytes: Uint8Array | null;
    boxId: string | null;
  }): void {
    setVerificationQueue((q) => [...q, entry]);
  }
  /** Drops the currently-shown prompt, revealing the next queued one (if any). */
  function dequeueVerification(): void {
    setVerificationQueue((q) => q.slice(1));
  }
  // Verification was requested (the workstation setting is on) but the box
  // closed without a genuine print -- no label spec, no printer configured,
  // or rendering/printing itself threw (Task 13 review, Finding 3). Told to
  // the operator plainly rather than opening a prompt to verify a label that
  // was never produced.
  const [printUnavailable, setPrintUnavailable] = useState(false);
  // Mirrors `verification` on every render (a plain assignment, not an
  // effect, so it is already current by the time anything reads it after
  // this commit) -- the same "read the latest value through a ref instead
  // of closing over state" trick `live` below uses, needed here so
  // `handleVerified` can have a STABLE identity across renders while still
  // seeing the current box id.
  const verificationRef = useRef(verification);
  verificationRef.current = verification;
  // CodeRabbit PR33 review, Finding 9: serializes every `printing.print(...)`
  // call -- a native/hardware call with no serialization of its own -- so
  // two boxes closing in quick succession (box capacity 1, or a slow
  // printer) can never send two labels to the printer concurrently, which
  // could arrive out of order or fail on a busy serial port. Deliberately
  // scoped to ONLY the printer call, not the whole print-and-verify flow:
  // scanning itself (and rendering each box's own label bytes) must stay
  // non-blocking, and only the shared printer resource needs exclusive
  // access. A promise chain, not a lock flag: each job attaches to the
  // TAIL of whatever is already queued, and the tail is always renormalized
  // to a non-rejecting promise so one job's failure (already handled by its
  // own caller) never poisons the chain for jobs queued after it.
  const printQueueRef = useRef<Promise<void>>(Promise.resolve());
  function serializePrint<T>(job: () => Promise<T>): Promise<T> {
    const started = printQueueRef.current.then(job);
    printQueueRef.current = started.then(
      () => undefined,
      () => undefined,
    );
    return started;
  }

  // Ref-based in-flight guard around `closeTheBox`, mirroring `boxRef` above:
  // checked and set synchronously, before any `await`, so a double-tap of
  // the manual close button -- or a tap racing an auto-close the very same
  // accepted scan triggers via `refreshBoxAndMaybeClose` -- cannot run the
  // close path twice concurrently. Without this, both calls burn a serial
  // and print a label each, and the box's stored SSCC ends up as whichever
  // write lands second (Task 13 review, Finding 2). `closing` (state, not
  // the ref) exists only to disable the button visually -- a re-render
  // lands too late to prevent the second call by itself, which is why the
  // ref is what actually closes the race.
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [boxActionPending, setBoxActionPending] = useState(false);

  function requestExit() {
    if (pendingSync > 0) setConfirmExit(true);
    else onExit();
  }

  // The domain's isDuplicate(key) is synchronous, so the device's accepted keys
  // are held in memory and updated on every insert rather than queried per scan.
  const keys = useRef<Set<string>>(new Set());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The duplicate index must be in memory before the first scan is judged.
  // The scan source starts listening immediately (so nothing is missed) and
  // the queue serialises, so awaiting the load here simply makes the first
  // scan wait rather than validating against an empty set — which would
  // wrongly accept an already-known code. Even then, codes_mirror's PRIMARY
  // KEY is the backstop: recordScan reports that as `alreadyPresent` and the
  // verdict is corrected below, rather than the write failing outright.
  const keysReady = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resilient by construction: `keysReady` is awaited before every scan is
    // judged, so if this promise ever REJECTED, every later scan would await
    // a rejected promise and vanish silently forever. A failed load instead
    // falls back to an empty index — codes_mirror's PRIMARY KEY is still the
    // real backstop against duplicates (see journal.ts's recordScan), and now
    // correctly yields a `duplicate` verdict instead of a lost scan.
    keysReady.current = loadCodeKeys(exec)
      .then((loaded) => {
        if (!cancelled) keys.current = loaded;
      })
      .catch((err) => {
        console.error("station: failed to load accepted code keys", err);
        if (!cancelled) keys.current = new Set();
      });
    return () => {
      cancelled = true;
    };
  }, [exec]);

  // Loads this shift's current open box, or opens a fresh one when this
  // device can aggregate (`issuerPrefix` present) but none is open yet --
  // e.g. the very first scan of an aggregation shift. Nothing is loaded or
  // opened when `issuerPrefix` is null: that is the "no box UI at all" state
  // (Task 13's correction), not a race to paper over.
  useEffect(() => {
    if (issuerPrefix === null) {
      updateBox(null);
      boxReady.current = Promise.resolve();
      return;
    }
    let cancelled = false;
    boxReady.current = currentBox(exec, shiftId)
      .then(async (existing: DeviceBox | null) => {
        if (cancelled) return;
        if (existing) {
          updateBox({ boxId: existing.boxId, itemCount: existing.itemCount });
          return;
        }
        const boxId = crypto.randomUUID();
        await openBox(exec, shiftId, boxId, new Date().toISOString(), terminalId);
        if (!cancelled) updateBox({ boxId, itemCount: 0 });
      })
      .catch((err: unknown) => {
        console.error("station: failed to load or open the current box", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec, shiftId, terminalId, issuerPrefix]);

  // The box label's geometry -- only needed when this device can print a box
  // label at all. A missing or unparsable spec degrades to "skip printing"
  // rather than a crash (see `printAndMaybeVerify` below). No `issuerPrefix`
  // needs no gate at all: there is no box UI, so nothing will ever await
  // `labelSpecReady` in the first place, but it is still resolved (to a
  // no-op) for the same reason `boxReady` is -- a stray future await must
  // never hang forever.
  useEffect(() => {
    if (issuerPrefix === null) {
      labelSpecReady.current = Promise.resolve();
      return;
    }
    let cancelled = false;
    labelSpecReady.current = readShiftMirror(exec, shiftId)
      .then((row) => {
        // CodeRabbit PR33 review, Finding 3: this is the BOX label's own
        // template spec (`box_label_template_spec`), never
        // `row.labelTemplateSpec` -- that is the ITEM template, mirrored from
        // a completely separate `shift.labelTemplateId`. Reading the item
        // spec here used to print the wrong label on every box (or nothing
        // at all, when only a box template was configured and the item one
        // was left unset).
        if (cancelled || !row?.boxLabelTemplateSpec) return;
        try {
          // Written synchronously, in the same tick this `.then()` runs, so
          // `printAndMaybeVerify` sees it the instant `labelSpecReady`
          // resolves rather than waiting on a React re-render (see
          // `labelSpecRef`'s own doc comment).
          labelSpecRef.current = JSON.parse(row.boxLabelTemplateSpec) as LabelTemplateSpec;
        } catch (err) {
          console.error("station: failed to parse the box label template spec", err);
        }
      })
      .catch((err: unknown) => {
        console.error("station: failed to read the shift mirror for the box label spec", err);
      });
    return () => {
      cancelled = true;
    };
  }, [exec, shiftId, issuerPrefix]);

  /**
   * Renders and (if a printer is configured) sends the just-closed box's
   * label, then either opens the print-verification prompt or, when the
   * setting is off, does nothing further -- `print_verified_at` is left
   * null in that case because no verification actually happened. Fired
   * WITHOUT being awaited by `closeTheBox` below: a slow printer must never
   * delay the next scan.
   *
   * Awaits `labelSpecReady` first (Task 13 review, Finding 4), the same
   * `keysReady`/`boxReady` pattern this file already uses twice: without it,
   * a box that closes before the mount-time `readShiftMirror` read resolves
   * (a very fast first box, e.g. `boxCapacity: 1`) would race a still-null
   * `labelSpecRef` and silently decide no print happened, even with a valid
   * template and printer.
   *
   * Whether printing happened at all -- NOT whether it is being verified --
   * decides `printUnavailable` (Task 13 review, Finding 3): `labelSpecRef`
   * may be null (no template, or an unparsable one), `printing` may be null
   * (no printer configured on this workstation), or `renderLabelBytes`/
   * `printing.print` may throw. Previously this notice was reachable only
   * when `verifyPrintedLabel` was ALSO on, so in the default (verification
   * off) configuration a box could close, burn a serial, and print nothing,
   * with only a `console.error` -- silent to the operator. Verification is
   * the separate, opt-in question of whether a print that DID happen gets
   * checked; it is not what makes a failed print visible.
   *
   * `printing.print(...)` itself runs through `serializePrint` (CodeRabbit
   * PR33 review, Finding 9): rendering (`renderLabelBytes`, pure
   * computation) stays unserialized -- each call renders its OWN box's bytes
   * independently -- but the actual printer call is queued, so two boxes
   * closing in quick succession never send two labels to the printer at
   * once. A resolved verification prompt is QUEUED (`enqueueVerification`),
   * never simply set, for the same reason: this function itself can be
   * in flight for more than one box at a time (it is never awaited by
   * `closeTheBox`), so two boxes finishing printing in close succession
   * must not have the second's prompt silently overwrite the first's.
   */
  async function printAndMaybeVerify(
    result: { sscc: string; itemCount: number },
    closedBoxId: string | null,
  ): Promise<void> {
    await labelSpecReady.current;
    const fields = boxLabelFields({
      sscc: result.sscc,
      itemCount: result.itemCount,
      productName,
      gtin14: expectedGtin14,
      operatorName: null,
      counterpartyName: counterpartyName ?? null,
      closedAt: new Date().toISOString(),
    });
    let bytes: Uint8Array | null = null;
    let printed = false;
    if (labelSpecRef.current && printing) {
      try {
        bytes = await renderLabelBytes(
          labelSpecRef.current,
          fields,
          printing.language,
          rasterizeText,
        );
        const printBytes = bytes;
        await serializePrint(() => printing.print(printing.target, printBytes));
        printed = true;
      } catch (err) {
        console.error("station: rendering or printing the box label failed", err);
        bytes = null;
      }
    }
    if (!printed) {
      setPrintUnavailable(true);
      return;
    }
    setPrintUnavailable(false);
    if (!verifyPrintedLabel) return;
    enqueueVerification({ sscc: result.sscc, bytes, boxId: closedBoxId });
  }

  /**
   * Closes the current box, manually (the button) or automatically (capacity
   * reached). Never attempts anything when `issuerPrefix` is null -- pushed
   * all the way down here too, not just at the button's render gate, so a
   * programmatic call can never silently invent a fallback prefix either
   * (Task 13's correction).
   *
   * Guarded by `closingRef` (Task 13 review, Finding 2), checked and set
   * synchronously before the first `await`: the manual button is not
   * otherwise serialized against an auto-close the very same accepted scan
   * can trigger via `refreshBoxAndMaybeClose`, and a double-tap (or a tap
   * racing that auto-close) could otherwise run this twice concurrently --
   * both calls would burn a serial and print a label each, and the box's
   * stored SSCC would end up as whichever write lands second.
   */
  async function closeTheBox(): Promise<void> {
    if (issuerPrefix === null) return;
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    try {
      // `boxRef.current`, not the `box` state variable: this file's own
      // comments on `boxRef` document that `box` can lag a `process()`-driven
      // close (a scan can update the ref before React has committed the
      // matching state update), and this is exactly the situation that
      // matters here -- reading a stale `box` would record the verification
      // against the WRONG box id (or null), and the `if (boxId)` guard around
      // `markPrintVerified`/`markPrintSkipped` would then silently drop the
      // record entirely (Task 13 review, Finding 4).
      const closingBoxId = boxRef.current?.boxId ?? null;
      const impl =
        closeCurrentBoxProp ??
        ((sid: string, operatorId: string | null) =>
          closeCurrentBoxLib({ exec, issuerPrefix }, sid, operatorId));

      let result: CloseBoxResult;
      try {
        result = await impl(shiftId, operatorId);
      } catch (err) {
        console.error("station: closeCurrentBox failed", err);
        return;
      }

      if (result.status === "empty") return;
      if (result.status === "no-serials") {
        setNoSerials(true);
        return;
      }
      if (result.status === "invalid-serial") {
        setInvalidSerial(true);
        return;
      }

      setNoSerials(false);
      setInvalidSerial(false);
      setPrintUnavailable(false);
      const newBoxId = crypto.randomUUID();
      try {
        await openBox(exec, shiftId, newBoxId, new Date().toISOString(), terminalId);
        updateBox({ boxId: newBoxId, itemCount: 0 });
      } catch (err) {
        console.error("station: failed to open the next box after closing", err);
        updateBox(null);
      }
      void reloadClosedBoxes();

      void printAndMaybeVerify(result, closingBoxId);
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  }

  /**
   * Re-reads the box's authoritative item count after an accepted, boxed
   * scan -- `currentBox`'s COUNT(*) already excludes items the sync engine
   * displaced out from under this device (Task 9/10), which a naive local
   * increment would not. Closes the box once capacity is reached.
   */
  async function refreshBoxAndMaybeClose(boxId: string): Promise<void> {
    let updated: DeviceBox | null;
    try {
      updated = await currentBox(exec, shiftId);
    } catch (err) {
      console.error("station: failed to refresh the current box", err);
      return;
    }
    // The box moved on under us (e.g. already closed by another path) --
    // nothing to reconcile here.
    if (!updated || updated.boxId !== boxId) return;
    updateBox({ boxId: updated.boxId, itemCount: updated.itemCount });
    if (boxCapacity !== null && updated.itemCount >= boxCapacity) {
      await closeTheBox();
    }
  }

  // `t`, `i18n.language`, `sound`, `onScanRecorded` and `onScan` all change
  // over the life of one mounted WorkScreen (a language switch, a
  // mute/volume change in setup, a fresh callback identity from App on every
  // render), and `refreshBox` closes over box/print/verification state and
  // props that change too -- but the queue below must NOT be recreated when
  // any of them do: `source.start(...)` (further down) is bound to one queue
  // instance, and a fresh queue has its own buffer and `draining` flag — if
  // the `useMemo` depended on these values, a change would leave the old
  // queue's buffer (still fed by the bound source) draining concurrently
  // with a brand new queue, breaking the "exactly one scan in flight"
  // guarantee the whole pipeline rests on. So `process`/`onOutcome`/
  // `onError` read the current values through this ref instead of closing
  // over the props/hooks directly.
  const live = useRef({
    t,
    language: i18n.language,
    sound,
    onScanRecorded,
    onScan,
    operatorId,
    refreshBox: refreshBoxAndMaybeClose,
  });
  useEffect(() => {
    live.current = {
      t,
      language: i18n.language,
      sound,
      onScanRecorded,
      onScan,
      operatorId,
      refreshBox: refreshBoxAndMaybeClose,
    };
  });

  const queue = useMemo(
    () =>
      createScanQueue({
        async process(raw): Promise<ScanOutcome> {
          // Test-only observability that the scan loop keeps running --
          // called unconditionally, before anything about the box's state is
          // even looked at, so a bug that stops labelling from also stopping
          // scanning (Task 13's "no-serials" floor rule) cannot hide behind
          // it never firing.
          live.current.onScan?.(raw);

          await keysReady.current;
          // Awaited before `boxRef` is read below, the same reasoning as
          // `keysReady`: this screen's box-loading effect starts an async
          // load/open the instant it mounts, and a scan can arrive before
          // that settles. Without this, such a scan would be judged against
          // a still-null `boxRef` and land with no box at all, exactly the
          // gap `boxReady` exists to close.
          await boxReady.current;
          const verdict = validateShiftScan(raw, {
            expectedGtin14,
            isDuplicate: (key) => keys.current.has(key),
          });
          const scannedAt = new Date().toISOString();
          const event = {
            shiftId,
            terminalId,
            raw,
            verdict: verdict.status,
            scannedAt,
            operatorId: live.current.operatorId,
          };
          const boxId = boxRef.current?.boxId ?? null;

          if (verdict.status === "ok") {
            const scan = classifyScan(raw);
            // `ok` is only produced for a parsed KM, so this branch always holds.
            const km = scan.kind === "km" ? scan.km : null;
            const codeHash = km ? kmKey(km) : null;
            const result = await recordScan(
              exec,
              event,
              km && codeHash
                ? {
                    codeHash,
                    shiftId,
                    gtin14: km.gtin14,
                    serial: km.serial,
                    scannedAt,
                    boxId,
                  }
                : null,
            );
            if (result.alreadyPresent && codeHash) {
              // The in-memory duplicate index missed this one; codes_mirror's
              // PRIMARY KEY is the real backstop (see journal.ts's recordScan
              // doc comment), so the verdict is corrected here instead of
              // reporting a false accept.
              keys.current.add(codeHash);
              const firstSeen = await findFirstSeen(exec, codeHash);
              return { raw, verdict: { status: "duplicate", key: codeHash }, firstSeen };
            }
            if (codeHash) keys.current.add(codeHash);
            // Awaited HERE, inside process(): the queue drains strictly one
            // scan at a time (see scan-queue.ts's doc comment), so this is
            // the only place a box's count-then-maybe-close can run without
            // racing the very next scan for the same box. Printing itself is
            // NOT awaited (see printAndMaybeVerify) -- only the fast SQL
            // bookkeeping is on this critical path.
            if (codeHash && boxId !== null) {
              setLastScanned({ boxId, codeHash });
              await live.current.refreshBox(boxId);
            }
            return { raw, verdict, firstSeen: null };
          }

          await recordScan(exec, event, null);
          const firstSeen =
            verdict.status === "duplicate" ? await findFirstSeen(exec, verdict.key) : null;
          return { raw, verdict, firstSeen };
        },
        onOutcome(outcome) {
          const {
            t: liveT,
            language,
            sound: liveSound,
            onScanRecorded: liveOnScanRecorded,
          } = live.current;
          const tone = toneOf(outcome.verdict);
          if (outcome.verdict.status === "ok") setAccepted((n) => n + 1);
          else setRejected((n) => n + 1);

          const title =
            outcome.verdict.status === "duplicate"
              ? liveT("signal.duplicate")
              : outcome.verdict.status === "wrong_gtin"
                ? liveT("signal.wrongGtin")
                : outcome.verdict.status === "invalid"
                  ? liveT("signal.wrongCode")
                  : "";
          const detail =
            outcome.firstSeen === null
              ? undefined
              : liveT("signal.firstSeen", {
                  time: new Intl.DateTimeFormat(language.startsWith("ru") ? "ru-RU" : "en-US", {
                    timeStyle: "medium",
                  }).format(new Date(outcome.firstSeen)),
                });

          playSignalTone(tone, liveSound);
          setSignal({ tone, title, ...(detail === undefined ? {} : { detail }) });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS[tone]);

          // Nudged last, strictly after the operator-visible signal is
          // rendered: `process()` above already wrote this outcome's outbox
          // row (every branch calls `recordScan`, whatever the verdict), so
          // the sync engine has real work to nudge for either way, and
          // `nudge()` cannot throw synchronously -- but the operator's
          // feedback must stay ahead of background sync work regardless.
          liveOnScanRecorded?.();
        },
        onError(raw, err) {
          // A throw from process() (e.g. the journal write) must never leave
          // the operator with silence: they scanned something and need SOME
          // signal, distinct from an ordinary rejection, so they know to
          // rescan rather than assume the code was accepted.
          console.error("station: scan write failed", raw, err);
          setRejected((n) => n + 1);
          const { t: liveT, sound: liveSound } = live.current;
          playSignalTone("error", liveSound);
          setSignal({ tone: "error", title: liveT("signal.systemError") });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS.error);
        },
        onJobError() {
          const { t: liveT, sound: liveSound } = live.current;
          playSignalTone("error", liveSound);
          setSignal({ tone: "error", title: liveT("signal.systemError") });
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setSignal(null), FLASH_MS.error);
        },
      }),
    [exec, shiftId, terminalId, expectedGtin14],
  );

  function handleUndo(): void {
    const target = lastScanned;
    if (!target) return;
    queue.enqueueJob(async () => {
      await undoLastScan(exec, {
        boxId: target.boxId,
        codeHash: target.codeHash,
        shiftId,
        terminalId,
        operatorId,
        at: new Date().toISOString(),
      });
      setLastScanned(null);
      keys.current.delete(target.codeHash);
      await live.current.refreshBox(target.boxId);
      live.current.onScanRecorded?.();
    });
  }

  function confirmClearBox(): void {
    setConfirmClear(false);
    const boxId = boxRef.current?.boxId;
    if (!boxId) return;
    queue.enqueueJob(async () => {
      const clearedCodes = await exec.all<{ code_hash: string }>(
        "SELECT code_hash FROM codes_mirror WHERE box_id = ?",
        [boxId],
      );
      await clearBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        at: new Date().toISOString(),
      });
      setLastScanned(null);
      for (const code of clearedCodes) keys.current.delete(code.code_hash);
      await live.current.refreshBox(boxId);
      live.current.onScanRecorded?.();
    });
  }

  function handleReprint(boxId: string, reason: string): void {
    const target = closedBoxes.find((candidate) => candidate.boxId === boxId);
    if (!target) return;
    queue.enqueueJob(async () => {
      await reprintBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        at: new Date().toISOString(),
      });
      void printAndMaybeVerify({ sscc: target.sscc, itemCount: target.itemCount }, boxId);
      await reloadClosedBoxes();
      live.current.onScanRecorded?.();
    });
  }

  function handleDisassemble(boxId: string, reason: string): void {
    queue.enqueueJob(async () => {
      const releasedCodes = await exec.all<{ code_hash: string }>(
        "SELECT code_hash FROM codes_mirror WHERE box_id = ?",
        [boxId],
      );
      await disassembleBox(exec, {
        boxId,
        shiftId,
        terminalId,
        operatorId,
        reason,
        at: new Date().toISOString(),
      });
      for (const code of releasedCodes) keys.current.delete(code.code_hash);
      await reloadClosedBoxes();
      live.current.onScanRecorded?.();
    });
  }

  // Paused while print verification is up: that scan source is reading the
  // box label's SSCC, not a product KM, and feeding it into this ordinary
  // queue would misjudge it as an invalid code and flash an error signal
  // over the verification prompt -- the one place a scan verdict is allowed
  // to compete with anything is print verification itself, not a stray
  // rejection from the loop underneath it.
  useEffect(() => {
    if (verification || confirmClear || boxActionPending) return;
    return source.start((raw) => queue.enqueue(raw));
  }, [source, queue, verification, confirmClear, boxActionPending]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Stable across renders (Task 13 review, "also fix, cheap"): `PrintVerification`
  // lists this in its own scan-subscription effect's deps, so a fresh arrow
  // here on every unrelated re-render (a sync-drain tick, a signal flash
  // timing out) would tear down and re-establish that subscription mid-
  // verification, risking a lost scan during the async re-subscribe. Reads
  // the current box id through `verificationRef` (see above) rather than
  // closing over `verification` directly, which is what lets this have a
  // stable identity in the first place.
  const handleVerified = useCallback(() => {
    const boxId = verificationRef.current?.boxId ?? null;
    // Reveals the next queued prompt (if any), rather than clearing to
    // empty outright (Finding 9) -- see `verificationQueue`'s own doc
    // comment.
    dequeueVerification();
    // `.catch`, not a bare `void` (Task 13 review, "also fix, cheap"): a
    // locked-DB write here would otherwise become an unhandled rejection,
    // and unlike a rendering/printing failure (which the operator can see
    // and retry), a failed verification record is silently dropped with
    // nothing but a console trace to find it by -- the same discipline
    // `hardware.ts`'s scan/status subscriptions already apply to their own
    // fallible calls.
    if (boxId) {
      markPrintVerified(exec, boxId, new Date().toISOString()).catch((err: unknown) => {
        console.error("station: recording print verification failed", err);
      });
    }
  }, [exec]);

  return (
    <main
      style={{ minHeight: "100%", padding: 32, display: "flex", flexDirection: "column", gap: 24 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: "2rem", fontWeight: 700 }}>{productName}</span>
          {counterpartyName ? (
            <span style={{ fontSize: "1.25rem", opacity: 0.85 }}>
              {t("shifts.forCounterparty")} {counterpartyName}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="secondary"
          style={{ minHeight: 64 }}
          onClick={(event) => {
            requestExit();
            // A tap leaves this button focused in Chromium-based webviews.
            // Left focused, the terminating Enter of the operator's next
            // scan would fire a native click on it (see scan-source.ts) --
            // possibly re-running requestExit() with the queue since
            // drained and exiting with no operator decision. Blur it so no
            // control holds focus while scanning continues.
            event.currentTarget.blur();
          }}
        >
          {t("work.exit")}
        </Button>
      </div>

      {confirmExit ? (
        // Given a higher stacking context (not just later JSX) than
        // SignalOverlay: SignalOverlay is `position: fixed`, so it is a
        // positioned box that paints after this alert's normal-flow content
        // regardless of DOM order (CSS painting order puts non-positioned
        // in-flow content before positioned descendants). An explicit
        // z-index here -- but not on SignalOverlay -- lifts this whole
        // block, including its buttons, above the fixed flash so the
        // confirmation stays reachable while a verdict is still showing,
        // without touching the flash's own full-screen visibility.
        <Alert tone="warn" style={{ position: "relative", zIndex: 1 }}>
          <p>{t("work.exitPending", { count: pendingSync })}</p>
          <Button
            type="button"
            style={{ minHeight: 64 }}
            onClick={(event) => {
              onExit();
              event.currentTarget.blur();
            }}
          >
            {t("work.exitAnyway")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            style={{ minHeight: 64 }}
            onClick={(event) => {
              setConfirmExit(false);
              event.currentTarget.blur();
            }}
          >
            {t("work.stay")}
          </Button>
        </Alert>
      ) : null}

      <div style={{ display: "flex", gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "1.25rem", opacity: 0.8 }}>{t("work.accepted")}</span>
          <span style={{ fontSize: "6rem", fontWeight: 800, lineHeight: 1 }}>{accepted}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: "1.25rem", opacity: 0.8 }}>{t("work.rejected")}</span>
          <span style={{ fontSize: "6rem", fontWeight: 800, lineHeight: 1 }}>{rejected}</span>
        </div>
      </div>

      <span style={{ fontSize: "1.25rem", opacity: 0.7 }}>{t("work.waiting")}</span>

      {/* Null `issuerPrefix` is a validation-mode shift, or a device the
          server could not resolve one for -- no box section at all, not
          even a disabled one. */}
      {issuerPrefix !== null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {box ? (
            <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
              <div data-testid="box-progress" style={{ fontSize: "1.5rem" }}>
                {boxCapacity !== null
                  ? t("box.progress", { items: box.itemCount, capacity: boxCapacity })
                  : box.itemCount}
              </div>
              <Button
                type="button"
                variant="secondary"
                style={{ minHeight: 64 }}
                disabled={closing}
                onClick={(event) => {
                  void closeTheBox();
                  event.currentTarget.blur();
                }}
              >
                {t("box.close")}
              </Button>
              {lastScanned?.boxId === box.boxId ? (
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 64 }}
                  onClick={(event) => {
                    handleUndo();
                    event.currentTarget.blur();
                  }}
                >
                  {t("box.undoLastScan")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                style={{ minHeight: 64 }}
                onClick={(event) => {
                  setConfirmClear(true);
                  event.currentTarget.blur();
                }}
              >
                {t("box.clear")}
              </Button>
            </div>
          ) : null}
          {confirmClear ? (
            <Alert tone="warn" title={t("box.confirmClearTitle")}>
              <p>{t("box.confirmClearDetail")}</p>
              <Button type="button" onClick={confirmClearBox}>
                {t("box.confirmClear")}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirmClear(false)}>
                {t("box.cancelClear")}
              </Button>
            </Alert>
          ) : null}
          {noSerials ? <Alert tone="warn" title={t("box.noSerials")} /> : null}
          {invalidSerial ? <Alert tone="warn" title={t("box.invalidSerial")} /> : null}
          {printUnavailable ? <Alert tone="warn" title={t("box.printNotAvailable")} /> : null}
          {verification ? null : (
            <ShiftBoxesPanel
              boxes={closedBoxes}
              onReprint={handleReprint}
              onDisassemble={handleDisassemble}
              onPendingChange={setBoxActionPending}
            />
          )}
        </div>
      ) : null}

      {signal ? (
        <SignalOverlay
          tone={signal.tone}
          title={signal.title}
          {...(signal.detail === undefined ? {} : { detail: signal.detail })}
        />
      ) : null}

      {verification ? (
        <PrintVerification
          expected={verification.sscc}
          onVerified={handleVerified}
          onReprint={() => {
            // `.catch`, not a bare `void` (Task 13 review, "also fix,
            // cheap"): a rejected printer call must not become an unhandled
            // rejection just because this handler cannot itself await it.
            // Routed through `serializePrint` too (Finding 9): a manual
            // reprint shares the same physical printer as an ordinary
            // box-close print, and could otherwise overlap with one for a
            // DIFFERENT box closing at the same moment.
            if (verification.bytes && printing) {
              const reprintBytes = verification.bytes;
              serializePrint(() => printing.print(printing.target, reprintBytes)).catch(
                (err: unknown) => {
                  console.error("station: reprinting the box label failed", err);
                },
              );
            }
          }}
          onSkip={() => {
            const boxId = verification.boxId;
            // Reveals the next queued prompt (if any) -- see
            // `verificationQueue`'s own doc comment (Finding 9).
            dequeueVerification();
            // `.catch`, not a bare `void` -- see `handleVerified` above for
            // why.
            if (boxId) {
              markPrintSkipped(exec, boxId, new Date().toISOString()).catch((err: unknown) => {
                console.error("station: recording print skip failed", err);
              });
            }
          }}
          scanSource={source}
        />
      ) : null}
    </main>
  );
}
