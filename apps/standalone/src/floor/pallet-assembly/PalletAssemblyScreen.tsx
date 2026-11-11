import { classifyScan, isValidSscc, parseScannedSscc } from "@markiro/domain";
import { Alert, Button, Input, type SignalTone } from "@markiro/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { FloorSession } from "../../app/shell.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import { Glyph } from "../kit/StatusIcons.js";
import type { RenderLabel } from "../print/print-jobs.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import {
  readWorkstationSettings,
  resolvePrinter,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { FloorFooter, FloorScreen } from "../shifts/FloorScreen.js";
import { formatClock } from "../shifts/shift-text.js";
import { realClock, useViewGuard } from "../warehouse/view-guard.js";
import { warehouseLabelRender } from "../warehouse/warehouse-work.js";
import { createWorkQueue } from "../work/work-queue.js";
import {
  BoxList,
  ClosedSummary,
  ConflictList,
  Feedback,
  PalletSummary,
  type AssemblyFeedback,
} from "./assembly-panels.js";
import { assemblyIssuerPrefix, assemblyTemplate, sendAssemblyLabel } from "./assembly-print.js";
import type { PalletAssemblyPallet, PalletAssemblyStore, PalletAssemblyView } from "./contracts.js";

import "./pallet-assembly.css";

export interface PalletAssemblyScreenProps {
  local: LocalExecutor;
  store: PalletAssemblyStore;
  operator: FloorSession;
  pairing: Pairing;
  source: ScanSource;
  printing: PrintRuntime;
  online: boolean;
  refresh: () => Promise<void>;
  onRecorded: () => void;
  onLeave: () => void;
  track: <T>(work: Promise<T>) => Promise<T>;
  touch: () => void;
  isLeaving: () => boolean;
  version?: number;
  blockReason?: "feature_disabled" | "host_update" | "operator_required" | null;
  onTopUp?: () => Promise<void>;
  onSetup?: () => void;
  showPrintQueue?: boolean;
  signal?: (tone: SignalTone) => void;
  render?: RenderLabel;
  clock?: () => number;
}

type Panel =
  | { kind: "assembly" | "resume" | "manual" | "contents" | "labels" | "conflicts" }
  | { kind: "close"; pallet: PalletAssemblyPallet }
  | { kind: "remove"; sscc: string }
  | { kind: "abandon"; palletId: string }
  | { kind: "print"; fromQueue: boolean; printerName: string | null }
  | { kind: "verify"; fromQueue: boolean }
  | { kind: "printers"; fromQueue: boolean }
  | { kind: "retry"; fromQueue: boolean; printer: PrinterProfile };

type LoadedAssembly = { view: PalletAssemblyView; settings: WorkstationSettings };
type AssemblyLoad = { kind: "loading" | "error" } | { kind: "ready"; data: LoadedAssembly };

function thermalPrinter(settings: WorkstationSettings): PrinterProfile | null {
  const assigned = resolvePrinter(settings, "pallet");
  return assigned?.paper === "a4" ? null : assigned;
}

export function PalletAssemblyScreen({
  local,
  store,
  pairing,
  source,
  printing,
  online,
  refresh,
  onRecorded,
  onLeave,
  track,
  touch,
  isLeaving,
  version = 0,
  blockReason = null,
  onTopUp,
  onSetup,
  showPrintQueue = false,
  signal,
  render,
  clock = realClock,
}: PalletAssemblyScreenProps) {
  const { t } = useTranslation(undefined, { keyPrefix: "floor.palletAssembly" });
  const { t: all, i18n } = useTranslation();
  const [queue] = useState(createWorkQueue);
  const [load, setLoad] = useState<AssemblyLoad>({ kind: "loading" });
  const [panel, setPanel] = useState<Panel>({ kind: "assembly" });
  const [job, setJob] = useState<PalletAssemblyPallet | null>(null);
  const [feedback, setFeedback] = useState<AssemblyFeedback | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [manualInvalid, setManualInvalid] = useState(false);
  const [pending, setPending] = useState(0);
  const alive = useRef(false);
  const manualForm = useRef<HTMLFormElement>(null);
  const epoch = useRef(0);
  const loadGeneration = useRef(0);
  const latest = useRef({ panel, load, job });
  const callbacks = useRef({ refresh, isLeaving, track, touch, onRecorded, onTopUp, online });
  useLayoutEffect(() => {
    callbacks.current = { refresh, isLeaving, track, touch, onRecorded, onTopUp, online };
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      loadGeneration.current += 1;
    };
  }, []);

  const change = useCallback(
    (next: Panel) => {
      epoch.current += 1;
      latest.current.panel = next;
      source.clearPendingInput();
      setPanel(next);
    },
    [source],
  );

  const receive = useCallback((next: AssemblyLoad) => {
    if (!alive.current) return;
    latest.current.load = next;
    setLoad(next);
  }, []);

  const updateJob = useCallback((next: PalletAssemblyPallet | null) => {
    if (!alive.current) return;
    latest.current.job = next;
    setJob(next);
  }, []);

  const reread = useCallback(async () => {
    const current = latest.current.load;
    if (current.kind !== "ready") return;
    const [next, selected] = await Promise.all([
      store.read(),
      latest.current.job === null ? null : store.get(latest.current.job.id),
    ]);
    if (!alive.current) return;
    receive({ kind: "ready", data: { settings: current.data.settings, view: next } });
    if (selected !== null && selected.id === latest.current.job?.id) updateJob(selected);
  }, [receive, store, updateJob]);

  const initialise = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      await store.recoverPrints(printing.inFlight());
      const [view, settings] = await Promise.all([store.read(), readWorkstationSettings(local)]);
      if (!alive.current || loadGeneration.current !== generation) return;
      change({ kind: showPrintQueue ? "labels" : view.open === null ? "assembly" : "resume" });
      receive({ kind: "ready", data: { view, settings } });
    } catch {
      if (loadGeneration.current === generation) receive({ kind: "error" });
    }
  }, [change, local, printing, receive, showPrintQueue, store]);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  useEffect(() => {
    let active = true;
    void queue.run(reread).catch(() => {
      if (active && alive.current) setFailure("systemError");
    });
    return () => {
      active = false;
    };
  }, [load.kind, queue, reread, version]);

  function run(work: () => Promise<void>) {
    const live = callbacks.current;
    if (!alive.current || live.isLeaving()) return;
    live.touch();
    setPending((count) => count + 1);
    const task = queue.run(async () => {
      if (!alive.current || callbacks.current.isLeaving()) return;
      setFailure(null);
      try {
        await work();
      } catch {
        if (alive.current) setFailure("systemError");
      } finally {
        await reread();
      }
    });
    void live
      .track(task)
      .catch(() => {
        if (alive.current) setFailure("systemError");
      })
      .finally(() => {
        if (alive.current) setPending((count) => count - 1);
      });
  }

  async function printLabel(
    pallet: PalletAssemblyPallet,
    printer: PrinterProfile,
    fromQueue: boolean,
    allowUnknown = false,
  ) {
    const canSend = () => alive.current && !callbacks.current.isLeaving();
    if (!canSend()) return;
    change({ kind: "print", fromQueue, printerName: printer.name });
    updateJob(pallet);
    if (printing.isInFlight(pallet.id)) {
      setFailure("stillPrinting");
      return;
    }
    const draw =
      render ??
      ((spec, fields, profile) => warehouseLabelRender(local, pairing)(spec, fields, profile, {}));
    const saved = await sendAssemblyLabel({
      store,
      pallet,
      printer,
      printing,
      render: draw,
      allowUnknown,
      canSend,
    });
    if (!saved) setFailure("stale");
    callbacks.current.onRecorded();
  }

  async function closePallet(pallet: PalletAssemblyPallet, settings: WorkstationSettings) {
    const printer = thermalPrinter(settings);
    if (printer === null) {
      setFailure(
        resolvePrinter(settings, "pallet")?.paper === "a4" ? "printerA4" : "printerMissing",
      );
      return;
    }
    const [prefix, template] = await Promise.all([
      assemblyIssuerPrefix(local),
      assemblyTemplate(local, pallet.product),
    ]);
    if (prefix === null || template === null) {
      setFailure(prefix === null ? "issuerMissing" : "templateMissing");
      return;
    }
    const result = await store.close(
      pallet.id,
      prefix,
      template,
      pallet.boxes.map(({ sscc }) => sscc),
    );
    if (result.kind !== "closed") {
      setFailure(result.kind);
      if (result.kind === "stale" && latest.current.panel.kind === "close")
        change({ kind: "assembly" });
      if (result.kind === "no_serials" && callbacks.current.online) {
        void callbacks.current.onTopUp?.().catch(() => undefined);
      }
      return;
    }
    callbacks.current.onRecorded();
    await printLabel(result.pallet, printer, false);
    if (callbacks.current.online) void callbacks.current.onTopUp?.().catch(() => undefined);
  }

  function showFeedback(message: AssemblyFeedback, tone: SignalTone) {
    if (!alive.current) return;
    signal?.(tone);
    setFeedback(message);
  }

  async function addBox(raw: string) {
    const scan = classifyScan(raw);
    if (scan.kind !== "sscc" || scan.sscc.startsWith("1")) {
      const key =
        scan.kind === "sscc"
          ? "palletCode"
          : scan.kind === "km" || scan.kind === "gtin"
            ? "unitCode"
            : "invalidCode";
      showFeedback({ title: t(key), tone: "error" }, "error");
      return;
    }
    const { sscc } = scan;
    let result = await store.add(sscc);
    if (result.kind === "unknown_box" && callbacks.current.online) {
      let refreshed = false;
      try {
        await callbacks.current.refresh();
        refreshed = true;
      } catch {
        // The first attempt changed nothing. Keep the original result if the link goes down.
      }
      if (refreshed && alive.current && !callbacks.current.isLeaving())
        result = await store.add(sscc);
    }
    if (result.kind === "added") {
      showFeedback({ title: t("added"), sscc, tone: "ok" }, "ok");
      callbacks.current.onRecorded();
      const current = latest.current.load;
      if (result.full && current.kind === "ready")
        await closePallet(result.pallet, current.data.settings);
      return;
    }
    const tone = result.kind === "duplicate" ? "warn" : "error";
    const detail =
      result.kind === "occupied" && result.palletSscc !== null
        ? t("winningPallet", { sscc: result.palletSscc })
        : result.kind === "unknown_box"
          ? t(callbacks.current.online ? "unknownOnline" : "unknownOffline")
          : null;
    showFeedback(
      { title: t(result.kind), sscc, detail, tone },
      tone === "warn" ? "duplicate" : "error",
    );
  }

  const data = load.kind === "ready" ? load.data : null;
  const view = data?.view;
  const open = view?.open ?? null;
  const assigned = data === null ? null : resolvePrinter(data.settings, "pallet");
  const printer = data === null ? null : thermalPrinter(data.settings);
  const hasConflict = view?.conflicts.some((conflict) => conflict.blocksAssembly) ?? false;
  const knownRegistry = view?.registrySyncedAt != null;
  const operatorBlocked = blockReason === "operator_required";
  const licenseBlocked =
    open === null && (blockReason === "feature_disabled" || view?.canOpenPallets !== true);
  const hostBlocked = blockReason === "host_update";
  const canScan =
    load.kind === "ready" &&
    knownRegistry &&
    !operatorBlocked &&
    !hostBlocked &&
    !licenseBlocked &&
    !hasConflict &&
    assigned?.paper !== "a4";
  const busy = pending > 0;

  const onScan = useRef<(raw: string) => void>(() => undefined);
  useLayoutEffect(() => {
    onScan.current = (raw) => {
      const scanPanel = latest.current.panel.kind;
      if (scanPanel !== "verify" && (scanPanel !== "assembly" || !canScan)) return;
      const acceptedEpoch = epoch.current;
      const pallet = scanPanel === "verify" ? latest.current.job : null;
      if (pallet?.isCorrection) return;
      run(async () => {
        if (acceptedEpoch !== epoch.current) return;
        if (scanPanel === "verify") {
          if (pallet === null || parseScannedSscc(raw.trim()) !== pallet.sscc) {
            setFailure("verifyMismatch");
            signal?.("error");
          } else {
            await confirmLabel(pallet, true);
          }
          return;
        }
        await addBox(raw);
      });
    };
  });
  useEffect(() => source.start((raw) => onScan.current(raw)), [source]);

  const { viewRef, settled } = useViewGuard<HTMLHeadingElement>(
    `${panel.kind}:${job?.id ?? ""}:${job?.labelVersion ?? ""}:${job?.printState ?? ""}:${load.kind}`,
    clock,
  );
  const manualPanel = panel.kind === "manual";
  useLayoutEffect(() => {
    if (!manualPanel) return undefined;
    source.setManualTextEntryActive(true);
    return () => source.setManualTextEntryActive(false);
  }, [manualPanel, source]);
  useEffect(() => {
    if (manualPanel) manualForm.current?.querySelector("input")?.focus();
  }, [manualPanel]);

  async function confirmLabel(pallet: PalletAssemblyPallet, verified = false) {
    if (
      (verified && pallet.isCorrection) ||
      !(await store.confirmPrint(pallet.id, pallet.labelVersion, verified))
    ) {
      setFailure("stale");
      return;
    }
    const previous = latest.current.panel;
    change({
      kind: "print",
      fromQueue: "fromQueue" in previous && previous.fromQueue,
      printerName: null,
    });
    callbacks.current.onRecorded();
    signal?.("ok");
  }

  function action(doIt: () => void) {
    return () => {
      if (!settled() || queue.pending() > 0 || isLeaving()) return;
      touch();
      setFailure(null);
      doIt();
    };
  }

  function refreshRegistry() {
    run(async () => {
      try {
        await refresh();
      } catch {
        setFailure("refreshError");
      }
    });
  }

  function send(pallet: PalletAssemblyPallet, profile: PrinterProfile, fromQueue: boolean) {
    if (pallet.printState === "unknown" || pallet.printState === "sent")
      change({ kind: "retry", printer: profile, fromQueue });
    else run(() => printLabel(pallet, profile, fromQueue));
  }

  function leavePrint(fromQueue: boolean) {
    updateJob(null);
    setFeedback(null);
    change({
      kind: fromQueue
        ? "labels"
        : latest.current.load.kind === "ready" && latest.current.load.data.view.open !== null
          ? "resume"
          : "assembly",
    });
  }

  const button = (
    label: string,
    onClick: () => void,
    { primary = false, disabled = false }: { primary?: boolean; disabled?: boolean } = {},
  ) => (
    <Button
      size="floor"
      variant={primary ? "primary" : "secondary"}
      className={primary ? "floor-primary" : undefined}
      disabled={disabled || busy}
      onClick={action(onClick)}
    >
      {label}
    </Button>
  );
  const back = button(t("back"), onLeave);
  const scanBack = button(t("backToScan"), () => change({ kind: "assembly" }));
  const settingsButton = onSetup === undefined ? null : button(t("setup"), onSetup);
  const fault = failure === null ? null : <Alert tone="error">{t(failure)}</Alert>;

  let title = t("title");
  let header: ReactNode;
  let body: ReactNode;
  let footer: ReactNode = back;

  if (load.kind !== "ready" || view === undefined) {
    body =
      load.kind === "error" ? (
        <Alert tone="error">{t("readError")}</Alert>
      ) : (
        <p role="status">{t("working")}</p>
      );
    if (load.kind === "error")
      footer = (
        <>
          {back}
          {button(
            t("readRetry"),
            () => {
              receive({ kind: "loading" });
              void initialise();
            },
            { primary: true },
          )}
        </>
      );
  } else if (panel.kind === "manual") {
    title = t("manualTitle");
    body = (
      <form
        ref={manualForm}
        id="pallet-assembly-manual"
        className="pallet-assembly__surface pallet-assembly__manual"
        onSubmit={(event) => {
          event.preventDefault();
          action(() => {
            const entered = manual.trim();
            if (!/^\d{18}$/.test(entered) || !isValidSscc(entered)) {
              setManualInvalid(true);
              return;
            }
            change({ kind: "assembly" });
            run(() => addBox(entered));
          })();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            change({ kind: "assembly" });
          }
        }}
      >
        <Glyph name="keyboard" size={32} />
        <Input
          size="floor"
          label={t("boxSscc")}
          hint={t("manualHelp")}
          {...(manualInvalid ? { error: t("manualInvalid") } : {})}
          mono
          inputMode="numeric"
          maxLength={18}
          value={manual}
          onChange={(event) => {
            setManual(event.target.value);
            setManualInvalid(false);
          }}
        />
      </form>
    );
    footer = (
      <>
        {scanBack}
        <Button
          size="floor"
          className="floor-primary"
          type="submit"
          form="pallet-assembly-manual"
          disabled={busy}
        >
          {t("manualSubmit")}
        </Button>
      </>
    );
  } else if (panel.kind === "resume") {
    body = (
      <div className="pallet-assembly__split">
        <section className="pallet-assembly__surface">
          <Feedback title={t("resumed")} detail={t("resumeHelp")} tone="info" />
        </section>
        <PalletSummary pallet={open} />
      </div>
    );
    footer = (
      <>
        {back}
        {button(t("resume"), () => change({ kind: "assembly" }), { primary: true })}
      </>
    );
  } else if (panel.kind === "contents" || panel.kind === "remove") {
    title = t(panel.kind === "contents" ? "contentsTitle" : "removeTitle");
    const removeBox = panel.kind === "remove" ? panel.sscc : null;
    body = (
      <section className="pallet-assembly__surface pallet-assembly__long">
        {removeBox === null ? (
          open === null || open.boxes.length === 0 ? (
            <p>{t("noBoxes")}</p>
          ) : (
            <>
              <h3>{open.product.name}</h3>
              <BoxList
                boxes={open.boxes}
                busy={busy}
                onRemove={(box) => action(() => change({ kind: "remove", sscc: box.sscc }))()}
              />
            </>
          )
        ) : (
          <>
            <code className="pallet-assembly__sscc">{removeBox}</code>
            <p>{t("removeHelp")}</p>
          </>
        )}
      </section>
    );
    footer =
      removeBox === null ? (
        scanBack
      ) : (
        <>
          {button(t("cancel"), () => change({ kind: "contents" }))}
          {button(
            t("remove"),
            () =>
              run(async () => {
                if (open === null || !(await store.remove(open.id, removeBox))) {
                  setFailure("stale");
                  return;
                }
                callbacks.current.onRecorded();
                setFeedback({ title: t("removeDone"), sscc: removeBox, tone: "info" });
                change({ kind: "contents" });
              }),
            { primary: true },
          )}
        </>
      );
  } else if (panel.kind === "close") {
    const { pallet } = panel;
    const capacity = pallet.product.capacity;
    const count = pallet.boxes.length;
    title = t(capacity !== null && count < capacity ? "earlyCloseTitle" : "closeTitle");
    body = (
      <section className="pallet-assembly__surface pallet-assembly__long">
        <h3>{pallet.product.name}</h3>
        <p className="pallet-assembly__close-count">
          {capacity === null
            ? t("boxCount", { count })
            : t("capacity", { current: count, capacity })}
        </p>
        {printer !== null ? (
          <p>{t("closeHelp", { printer: printer.name })}</p>
        ) : (
          <p>{t(assigned?.paper === "a4" ? "printerA4" : "printerMissing")}</p>
        )}
      </section>
    );
    footer = (
      <>
        {scanBack}
        {button(t("closeAndPrint"), () => run(() => closePallet(pallet, load.data.settings)), {
          primary: true,
          disabled:
            count === 0 || printer === null || hasConflict || operatorBlocked || hostBlocked,
        })}
        {printer === null && settingsButton}
      </>
    );
  } else if (panel.kind === "labels") {
    title = t("labelQueueTitle");
    body = (
      <section className="pallet-assembly__surface pallet-assembly__long">
        {view.pendingLabels.length === 0 ? (
          <p>{t("emptyQueue")}</p>
        ) : (
          <ul className="pallet-assembly__label-list">
            {view.pendingLabels.map((pallet) => (
              <li key={pallet.id}>
                <Button
                  size="floor"
                  variant="secondary"
                  disabled={busy}
                  onClick={action(() => {
                    updateJob(pallet);
                    change({ kind: "print", fromQueue: true, printerName: null });
                  })}
                >
                  <code>{pallet.sscc}</code>
                  <span>{pallet.product.name}</span>
                  <span>{t(`print_${pallet.printState}`)}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
    footer = (
      <>
        {back}
        {button(t("backToScan"), () => change({ kind: open === null ? "assembly" : "resume" }))}
      </>
    );
  } else if (panel.kind === "abandon") {
    title = t("abandonTitle");
    body = (
      <section className="pallet-assembly__surface pallet-assembly__long">
        <p>{t("abandonHelp")}</p>
      </section>
    );
    footer = (
      <>
        {button(t("cancel"), () => change({ kind: "conflicts" }))}
        {button(
          t("abandon"),
          () =>
            run(async () => {
              if (!(await store.abandonOpenConflict(panel.palletId))) {
                setFailure("stale");
                return;
              }
              callbacks.current.onRecorded();
              change({ kind: "conflicts" });
            }),
          { primary: true },
        )}
      </>
    );
  } else if (panel.kind === "conflicts") {
    title = t("conflictTitle");
    body = (
      <ConflictList
        conflicts={view.conflicts}
        busy={busy}
        onAbandon={(palletId) => action(() => change({ kind: "abandon", palletId }))()}
        onAcknowledge={(palletId) => action(() => run(() => store.acknowledgeConflict(palletId)))()}
      />
    );
    footer = scanBack;
  } else if (job !== null && "fromQueue" in panel) {
    const returnToPrint = () =>
      change({ kind: "print", fromQueue: panel.fromQueue, printerName: null });
    const stopPrint = button(t("cancel"), returnToPrint);
    title = t("closed");
    if (panel.kind === "retry") {
      title = t("retryUnknownTitle");
      body = (
        <section className="pallet-assembly__surface pallet-assembly__long">
          <p>{t(job.printState === "sent" ? "retrySentHelp" : "retryUnknownHelp")}</p>
          <code className="pallet-assembly__sscc">{job.sscc}</code>
        </section>
      );
      footer = (
        <>
          {stopPrint}
          {button(
            t("retryPrint"),
            () => run(() => printLabel(job, panel.printer, panel.fromQueue, true)),
            { primary: true, disabled: job.cancelled || job.syncState === "rejected" },
          )}
        </>
      );
    } else if (panel.kind === "printers") {
      title = t("printerChoice");
      const choices = load.data.settings.printers.filter((profile) => profile.paper !== "a4");
      body = (
        <section className="pallet-assembly__surface pallet-assembly__long">
          {choices.length === 0 ? (
            <p>{t("printerMissing")}</p>
          ) : (
            <ul className="pallet-assembly__label-list">
              {choices.map((profile) => (
                <li key={profile.id}>
                  {button(profile.name, () => send(job, profile, panel.fromQueue))}
                </li>
              ))}
            </ul>
          )}
        </section>
      );
      footer = (
        <>
          {stopPrint}
          {settingsButton}
        </>
      );
    } else if (panel.kind === "verify" && !job.isCorrection) {
      body = (
        <div className="pallet-assembly__split">
          <section className="pallet-assembly__surface">
            <Feedback title={t("verifyTitle")} tone="info" />
          </section>
          <ClosedSummary pallet={job} />
        </div>
      );
      footer = stopPrint;
    } else {
      const printerName = panel.kind === "print" ? panel.printerName : null;
      const state = busy && printerName !== null ? "printing" : job.printState;
      const reviewRequired = job.syncState === "rejected" && !job.cancelled;
      const confirmable =
        !reviewRequired && !job.cancelled && (state === "sent" || state === "unknown");
      const retryable =
        confirmable ||
        (!reviewRequired && !job.cancelled && (state === "failed" || state === "pending"));
      const settledLabel = state === "confirmed";
      const detail =
        state === "unknown"
          ? t("labelUnknownHelp")
          : state === "sent" && !job.isCorrection
            ? t("labelAttach")
            : settledLabel && job.syncState !== "rejected"
              ? t("labelReady")
              : null;
      const reasonKey = `floor.print.codes.${job.printReason ?? ""}`;
      body = (
        <div className="pallet-assembly__split">
          <section className="pallet-assembly__surface pallet-assembly__print">
            {reviewRequired ? (
              <Feedback title={t("conflictTitle")} tone="error" />
            ) : job.cancelled ? (
              <Feedback title={t("cancelledLabel")} tone="warn" />
            ) : (
              <Feedback
                title={t(`print_${state}`)}
                detail={detail}
                tone={
                  state === "failed"
                    ? "error"
                    : state === "unknown"
                      ? "warn"
                      : settledLabel
                        ? "ok"
                        : "info"
                }
              />
            )}
            {confirmable && job.isCorrection && <p>{t("correctedLabelAttach")}</p>}
            {printerName !== null && <p>{printerName}</p>}
            {job.printReason !== null && i18n.exists(reasonKey) && <p>{all(reasonKey)}</p>}
            {retryable && (
              <div className="pallet-assembly__inline-actions">
                {printer === null
                  ? settingsButton
                  : button(t(state === "pending" ? "print" : "retryPrint"), () =>
                      send(job, printer, panel.fromQueue),
                    )}
                {button(t("otherPrinter"), () =>
                  change({ kind: "printers", fromQueue: panel.fromQueue }),
                )}
              </div>
            )}
            {confirmable &&
              !job.isCorrection &&
              button(t("verifyLabel"), () =>
                change({ kind: "verify", fromQueue: panel.fromQueue }),
              )}
            {reviewRequired && button(t("conflictTitle"), () => change({ kind: "conflicts" }))}
          </section>
          <ClosedSummary pallet={job} />
        </div>
      );
      footer =
        reviewRequired || job.cancelled ? (
          <>
            {back}
            {button(t("backToScan"), () => leavePrint(panel.fromQueue))}
          </>
        ) : settledLabel ? (
          <>
            {back}
            {button(t("nextPallet"), () => leavePrint(panel.fromQueue), { primary: true })}
          </>
        ) : (
          <>
            {button(
              t("deferLabel"),
              () =>
                run(async () => {
                  if (!(await store.deferPrint(job.id))) {
                    setFailure("stale");
                    return;
                  }
                  leavePrint(panel.fromQueue);
                }),
              { disabled: state === "printing" },
            )}
            {confirmable &&
              button(
                t(job.isCorrection ? "confirmCorrectedLabel" : "confirmLabel"),
                () => run(() => confirmLabel(job)),
                { primary: true },
              )}
          </>
        );
    }
  } else {
    const readiness = operatorBlocked
      ? "operator_required"
      : hostBlocked
        ? "host_update"
        : !knownRegistry
          ? "registryHelp"
          : licenseBlocked
            ? "feature_disabled"
            : assigned?.paper === "a4"
              ? "printerA4"
              : null;
    header = button(
      t("manual"),
      () => {
        setManual("");
        setManualInvalid(false);
        change({ kind: "manual" });
      },
      { disabled: !canScan },
    );
    body = (
      <div className="pallet-assembly__split">
        <section className="pallet-assembly__surface pallet-assembly__scan">
          {hasConflict && <Alert tone="error">{t("conflictBlock")}</Alert>}
          {readiness !== null ? (
            <Feedback
              title={t(
                !knownRegistry && !hostBlocked && !operatorBlocked
                  ? "registryRequired"
                  : "newPalletDisabled",
              )}
              detail={t(readiness)}
              tone="warn"
            />
          ) : (
            <>
              <div role="status" aria-live="polite">
                <Feedback
                  {...(feedback ?? {
                    title: t("scanFirst"),
                    detail: t("scanFirstHelp"),
                    tone: "info",
                  })}
                />
              </div>
              {feedback !== null && (
                <div className="pallet-assembly__next">
                  <Glyph name="barcode" size={28} />
                  <div>
                    <h4>{t("scanNext")}</h4>
                    <p>{t("scanNextHelp")}</p>
                  </div>
                </div>
              )}
            </>
          )}
          {!online && view.registrySyncedAt !== null && (
            <p className="pallet-assembly__as-of">
              {t("registryDate", { at: formatClock(view.registrySyncedAt) })}
            </p>
          )}
          {assigned?.paper === "a4" && settingsButton}
        </section>
        <PalletSummary
          pallet={open}
          disabled={busy}
          onContents={action(() => change({ kind: "contents" }))}
        />
      </div>
    );
    const conflictCount = new Set(view.conflicts.map(({ palletId }) => palletId)).size;
    footer = (
      <>
        {back}
        <div className="pallet-assembly__inline-actions">
          {view.pendingLabels.length > 0 &&
            button(t("labelQueue", { count: view.pendingLabels.length }), () =>
              change({ kind: "labels" }),
            )}
          {conflictCount > 0 &&
            button(t("conflicts", { count: conflictCount }), () => change({ kind: "conflicts" }))}
          {!knownRegistry && !hostBlocked
            ? button(t("refresh"), refreshRegistry, { primary: true, disabled: !online })
            : button(
                t("closeAndPrint"),
                () => {
                  if (open !== null) change({ kind: "close", pallet: open });
                },
                {
                  primary: true,
                  disabled:
                    (open?.boxes.length ?? 0) === 0 ||
                    hasConflict ||
                    operatorBlocked ||
                    hostBlocked,
                },
              )}
        </div>
      </>
    );
  }

  return (
    <FloorScreen
      title={title}
      subtitle={t("section")}
      titleRef={viewRef}
      header={header}
      className="pallet-assembly"
      actions={<FloorFooter ariaLabel={t("actions")}>{footer}</FloorFooter>}
    >
      {fault}
      {body}
    </FloorScreen>
  );
}
