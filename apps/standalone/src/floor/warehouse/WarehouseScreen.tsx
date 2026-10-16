import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import {
  type PalletSheets,
  type WarehouseLookup,
  type WarehouseLookupResult,
  type WarehouseSubjectKind,
} from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScannerIndicator } from "../scanner-indicator.js";
import type { ScanSource } from "../scan-source.js";
import {
  readWorkstationSettings,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { createWorkQueue } from "../work/work-queue.js";
import { TemplatePicker, type SheetsState } from "./TemplatePicker.js";
import { sheetChoiceName } from "./warehouse-sheet.js";
import { FooterButton, ReprintFooter, type SummaryLine } from "./ReprintParts.js";
import {
  FinishDialog,
  JobView,
  ManualView,
  ReasonDialog,
  ReprintFrame,
  SessionView,
  SetupView,
  useHeading,
  type Said,
} from "./ReprintViews.js";
import "./warehouse.css";
import { realClock, useViewGuard } from "./view-guard.js";
import {
  countSent,
  countUnsentRecords,
  finishSession,
  listSessionJobs,
  readOpenSession,
  startSession,
  updateSession,
  type WarehouseJob,
  type WarehouseReason,
  type WarehouseSession,
  type WarehouseTemplates,
} from "./warehouse-store.js";
import {
  initialTemplates,
  palletPaperOf,
  readOrgDefaults,
  readWarehouseTemplates,
  type PalletPaper,
  type WarehouseTemplate,
} from "./warehouse-templates.js";
import {
  jobKindView,
  resultView,
  summaryRows,
  type JobKindView,
  type JournalFilter,
  type SummaryRow,
} from "./warehouse-view.js";
import {
  cancelWarehouseJob,
  recoverWarehouseJob,
  reprintScan,
  sendWarehouseJob,
  verifyWarehouseJob,
  WarehousePrinterError,
  type RenderWarehouseLabel,
  type ScanOutcome,
  type SendIntent,
  type WarehouseContext,
} from "./warehouse-work.js";

export interface WarehouseScreenProps {
  /** The signed-in operator (offline PIN or badge): the screen is the floor's, never the office's. */
  operator: FloorSession;
  local: LocalExecutor;
  pairing: Pairing;
  /** The link to the host is online: only then is a code looked up. */
  online: boolean;
  /** The scanner as the header says it; a scanner away makes the typed code the main way in. */
  scannerState?: ScannerIndicator;
  /** `WorkGate.track`: every write and send of the screen, so a leave waits for it (N9). */
  track: <T>(work: Promise<T>) => Promise<T>;
  /** Starts the operator's idle wait again. */
  touch: () => void;
  /** True from the moment a leave is asked for: no scan is taken after it. */
  isLeaving: () => boolean;
  source: ScanSource;
  /** `HostApi.warehouseLookup`. */
  lookup: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
  /**
   * `HostApi.getDevicePalletSheets` (beta 3.2): the A4 sheets for a pallet reprinted on a printer of
   * sheets; none — no sheet is offered and such a pallet is refused.
   */
  palletSheets?: (productId?: string) => Promise<PalletSheets>;
  /** A refused key or a changed certificate: the shell's to route. */
  onHostError: (error: unknown) => void;
  /** A record was written: the delivery goes. */
  onRecorded: () => void;
  printing: PrintRuntime;
  /** «К сменам» and a finished session. */
  onLeave: () => void;
  /** «Рабочее место»; back to this session. */
  onSetup: () => void;
  render?: RenderWarehouseLabel;
  now?: () => Date;
  newId?: () => string;
  /**
   * Milliseconds from a clock that does not go back; the guard after a change of view
   * reads it. The same function on every render: a new one starts the guard again.
   */
  clock?: () => number;
}

type Phase =
  | { kind: "loading" }
  | { kind: "read_failed" }
  | { kind: "setup"; reason: WarehouseReason | null; templates: WarehouseTemplates }
  | { kind: "working"; session: WarehouseSession };

type Panel =
  | { kind: "none" }
  | { kind: "templates"; initial: WarehouseSubjectKind }
  | { kind: "reason"; picked: WarehouseReason }
  | { kind: "again"; job: WarehouseJob; picked: WarehouseReason | null }
  | { kind: "manual" }
  | { kind: "finish" };

/** A button that waits for the work in hand: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/** The job states of a job that waits for the printer or the operator; no other work goes beside it. */
const UNRESOLVED = ["prepared", "sending", "failed", "unknown"] as const;

const defaultNow = () => new Date();
const defaultNewId = () => crypto.randomUUID();

/**
 * «Повторная печать этикеток» (plan СКЛ, pilot spec §30): the cloud station's warehouse
 * reprint for one site. A session (its reason and templates) is started, paused by
 * «К сменам» and continued by the next entry, and finished with a confirmation. A scan
 * or a typed code is looked up on the host (only with the link) and printed once on the
 * printer of its kind; a code of the session is printed again only on «Напечатать ещё
 * раз» with a reason; a failed job is retried or cancelled, an unknown one checked by a
 * scan of the new label or printed again with a reason — never sent again by itself.
 * All work runs one thing at a time (`createWorkQueue`) and is handed to `track`; a
 * press just after the view changed does nothing (`useViewGuard`).
 */
export function WarehouseScreen({
  operator,
  local,
  pairing,
  online,
  scannerState = "keyboard",
  track,
  touch,
  isLeaving,
  source,
  lookup,
  palletSheets,
  onHostError,
  onRecorded,
  printing,
  onLeave,
  onSetup,
  render,
  now = defaultNow,
  newId = defaultNewId,
  clock = realClock,
}: WarehouseScreenProps) {
  const { t, i18n } = useTranslation();
  const { hostId, deviceId } = pairing;
  const context = useMemo<WarehouseContext>(
    () => ({
      local,
      pairing: { hostId, deviceId },
      runtime: printing,
      now,
      newId,
      ...(render === undefined ? {} : { render }),
      ...(palletSheets === undefined ? {} : { sheets: palletSheets }),
    }),
    [local, hostId, deviceId, printing, now, newId, render, palletSheets],
  );
  const [queue] = useState(createWorkQueue);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [templates, setTemplates] = useState<WarehouseTemplate[]>([]);
  // What the pallets' printer prints, and the host's A4 sheets when it prints them (beta 3.2).
  const [palletPaper, setPalletPaper] = useState<PalletPaper>("thermal");
  const [sheets, setSheets] = useState<SheetsState>({ kind: "loading" });
  const [settings, setSettings] = useState<Pick<WorkstationSettings, "printers" | "assignments">>({
    printers: [],
    assignments: { box: null, pallet: null, duplicate: null },
  });
  const [job, setJob] = useState<WarehouseJob | null>(null);
  /** The job's detail is on screen (a scan, a row of the journal, a job found waiting). */
  const [detail, setDetail] = useState(false);
  /** The job whose bytes are on their way to the printer: its detail says «Передаём…». */
  const [sending, setSending] = useState<string | null>(null);
  /** The journal of this session and the kind it is filtered to. */
  const [journal, setJournal] = useState<WarehouseJob[]>([]);
  const [filter, setFilter] = useState<JournalFilter>("all");
  /** The job on screen was an old label with «!1», made anew (the detail says so). */
  const [repaired, setRepaired] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [verifying, setVerifying] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [counts, setCounts] = useState({ sent: 0, waiting: 0 });
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(0);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const recount = useCallback(
    async (sessionId: string | null) => {
      const pairingNow = { hostId, deviceId };
      const sent = sessionId === null ? 0 : await countSent(local, pairingNow, sessionId);
      const waiting = await countUnsentRecords(local, pairingNow);
      const jobs = sessionId === null ? [] : await listSessionJobs(local, pairingNow, sessionId);
      if (!alive.current) return;
      setCounts({ sent, waiting });
      setJournal(jobs);
    },
    [local, hostId, deviceId],
  );

  const codeText = (code: string | null): string =>
    code === null
      ? ""
      : code === "printer_unconfigured"
        ? t("floor.warehouse.printerUnconfigured")
        : code === "printer_a4"
          ? t("floor.warehouse.printerA4")
          : code === "printer_not_a4"
            ? t("floor.warehouse.printerNotA4")
            : t(`floor.print.codes.${code}`, { defaultValue: code });

  // What the queued work reads when its turn comes, and the props the screen's effects must not
  // restart on: a parent that passes a new function on each render does not reload the session.
  const latest = useRef({ phase, panel, verifying, online, job });
  const live = useRef({
    context,
    operatorId: operator.id,
    track,
    onRecorded,
    onHostError,
  });
  useLayoutEffect(() => {
    latest.current = { phase, panel, verifying, online, job };
    live.current = { context, operatorId: operator.id, track, onRecorded, onHostError };
  });

  // The session as stored: none — a new one is set up; an open one is continued, its
  // waiting job recovered (a send cut by a restart becomes unknown). Runs again only for
  // another pairing or on «Повторить», never because a parent passed a new function.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { context: loading, operatorId } = live.current;
      const [found, copies, defaults, settings] = await Promise.all([
        readOpenSession(local, { hostId, deviceId }),
        readWarehouseTemplates(local),
        readOrgDefaults(local),
        readWorkstationSettings(local),
      ]);
      const paper = palletPaperOf(settings);
      if (found === null) {
        return {
          phase: {
            kind: "setup",
            reason: null,
            templates: initialTemplates(copies, defaults, paper),
          } satisfies Phase,
          copies,
          paper,
          settings,
          job: null,
        };
      }
      const open = await recoverWarehouseJob(loading, found.id, operatorId);
      return {
        phase: { kind: "working", session: found } satisfies Phase,
        copies,
        paper,
        settings,
        job: open,
      };
    };
    void live.current.track(queue.run(load)).then(
      (loaded) => {
        if (cancelled || !alive.current) return;
        setTemplates(loaded.copies);
        setPalletPaper(loaded.paper);
        setSettings({
          printers: loaded.settings.printers,
          assignments: loaded.settings.assignments,
        });
        setJob(loaded.job);
        setDetail(loaded.job !== null);
        setPhase(loaded.phase);
        if (loaded.phase.kind === "working") {
          // The waiting job, if any, is on screen as its detail says it; this line says the session was kept.
          setSaid({ tone: "info", text: t("floor.warehouse.resumed"), kind: "resumed" });
          void recount(loaded.phase.session.id);
          live.current.onRecorded();
        }
      },
      () => {
        if (!cancelled && alive.current) setPhase({ kind: "read_failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt, local, hostId, deviceId, queue, recount, t]);

  // The host's A4 sheets, asked once the screen knows its pallets go to a printer of sheets, and
  // again on «Повторить»: they are for the picker and its lines; a pallet's job asks them itself.
  const [sheetsAttempt, setSheetsAttempt] = useState(0);
  useEffect(() => {
    if (palletPaper !== "a4") return undefined;
    if (palletSheets === undefined) {
      setSheets({ kind: "failed" });
      return undefined;
    }
    let cancelled = false;
    setSheets({ kind: "loading" });
    palletSheets().then(
      (listed) => {
        if (!cancelled) setSheets({ kind: "ready", sheets: listed });
      },
      () => {
        if (!cancelled) setSheets({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [palletPaper, palletSheets, sheetsAttempt]);

  const show = (outcome: ScanOutcome): void => {
    switch (outcome.kind) {
      case "printed":
        setJob(outcome.job);
        setDetail(true);
        setRepaired(outcome.repair !== null);
        setVerifying(false);
        setSaid(null);
        return;
      case "busy":
        setJob(outcome.job);
        setDetail(true);
        setSaid({ tone: "warn", text: t("floor.warehouse.errors.busy"), kind: "busy" });
        return;
      case "duplicate":
        setJob(outcome.job);
        setDetail(true);
        setRepaired(false);
        setSaid({
          tone: "warn",
          text: `${t("floor.warehouse.status.duplicate")}. ${t("floor.warehouse.hint.duplicate")}`,
          kind: "duplicate",
        });
        return;
      case "host_error":
        setSaid({
          tone: "error",
          text: t("floor.warehouse.errors.lookup_failed"),
          kind: "lookup_failed",
        });
        return;
      case "unavailable":
        setSaid({
          tone: "warn",
          text: t(`floor.warehouse.errors.${outcome.reason}`),
          kind: outcome.reason,
        });
        return;
      case "refused":
        setSaid({
          tone: "error",
          text: t(`floor.warehouse.errors.${outcome.reason}`),
          kind: "refused",
        });
        return;
      case "invalid_scan":
      case "offline":
      case "host_outdated":
      case "restore_pending":
      case "lookup_failed":
      case "not_found":
        setSaid({
          tone: outcome.kind === "not_found" || outcome.kind === "offline" ? "warn" : "error",
          text: t(`floor.warehouse.errors.${outcome.kind}`),
          kind: outcome.kind,
        });
        return;
    }
  };

  /**
   * After a work of the screen failed: what this computer holds of the session's waiting job
   * is shown, a send that was cut becoming `unknown` for the operator to decide — never
   * resent. Run inside the queue, so no send of this screen is beside it.
   */
  const settleAfterFailure = async (): Promise<void> => {
    const { phase: current } = latest.current;
    if (current.kind !== "working") return;
    try {
      const open = await recoverWarehouseJob(
        live.current.context,
        current.session.id,
        live.current.operatorId,
      );
      // A record may have been written: the delivery goes, shown or not.
      live.current.onRecorded();
      if (!alive.current) return;
      if (open !== null) {
        setJob(open);
        // «Ничего не напечатано» would be false for a send that was cut: the detail says what it came to.
        setDetail(true);
        if (open.state === "unknown") setSaid(null);
      }
      await recount(current.session.id);
    } catch {
      // This computer cannot be read: the failure already said is all there is to say.
    }
  };

  /** Runs `work` in its turn, tracked; a failure of this computer is said, never thrown. */
  const run = (work: () => Promise<void>): void => {
    touch();
    if (isLeaving()) return;
    setBusy((count) => count + 1);
    void track(
      queue.run(async () => {
        try {
          await work();
        } catch (error) {
          if (!alive.current) return;
          if (error instanceof WarehousePrinterError) {
            setSaid({ tone: "error", text: codeText(error.code), kind: "printer" });
          } else {
            setSaid({
              tone: "error",
              text: t("floor.warehouse.errors.write_failed"),
              kind: "write_failed",
            });
          }
          await settleAfterFailure();
        } finally {
          if (alive.current) setBusy((count) => count - 1);
        }
      }),
    );
  };

  const reprint = async (session: WarehouseSession, raw: string): Promise<void> => {
    if (latest.current.online) {
      setSaid({ tone: "info", text: t("floor.warehouse.status.looking"), kind: "looking" });
    }
    const outcome = await reprintScan(context, {
      session,
      raw,
      operatorId: operator.id,
      online: latest.current.online,
      ask: lookup,
    });
    // The job and its record are written, and the host's refusal is the shell's, whether the
    // screen is still there or not.
    if (outcome.kind === "host_error") live.current.onHostError(outcome.error);
    live.current.onRecorded();
    if (!alive.current) return;
    show(outcome);
    await recount(session.id);
  };

  const verify = async (current: WarehouseJob, raw: string): Promise<void> => {
    const answer = await verifyWarehouseJob(context, current, raw, operator.id);
    if (answer.kind === "verified") live.current.onRecorded();
    if (!alive.current) return;
    if (answer.kind === "verified") {
      setVerifying(false);
      setJob(answer.job);
      setSaid(null);
      await recount(current.sessionId);
      return;
    }
    setSaid({
      tone: "error",
      text: t(
        answer.kind === "mismatch"
          ? "floor.warehouse.errors.verify_mismatch"
          : "floor.warehouse.errors.verify_invalid",
      ),
      kind: answer.kind === "mismatch" ? "verify_mismatch" : "verify_invalid",
    });
  };

  // The scanner, for the life of the screen; each scan in its turn.
  const onScan = useRef<(raw: string) => void>(() => undefined);
  useLayoutEffect(() => {
    onScan.current = (raw) =>
      run(async () => {
        const state = latest.current;
        // A form or a panel takes no scan; the setup takes none either.
        if (state.phase.kind !== "working" || state.panel.kind !== "none") return;
        if (state.verifying && state.job !== null) {
          await verify(state.job, raw);
          return;
        }
        await reprint(state.phase.session, raw);
      });
  });
  useEffect(() => source.start((raw) => onScan.current(raw)), [source]);
  // The typed code's field is the keyboard's while it is open, and is given back when it goes
  // (closed, or the screen leaves with it open).
  useEffect(() => {
    if (panel.kind !== "manual") return undefined;
    source.setManualTextEntryActive(true);
    return () => source.setManualTextEntryActive(false);
  }, [panel.kind, source]);

  // The view, its guard and its focus: whatever puts other buttons under the finger is a new view.
  const view = [
    phase.kind,
    panel.kind,
    job === null ? "" : `${job.id}:${job.state}:${job.attempts}`,
    detail ? "detail" : "",
    verifying ? "verifying" : "",
  ].join("|");
  const { viewRef, settled } = useViewGuard<HTMLElement>(view, clock);
  /** Props of a button: while work is in hand, or just after the view changed, a press does nothing. */
  const press = (action: () => void) => ({
    "aria-disabled": busy > 0 ? true : undefined,
    style: busy > 0 ? WAITING_STYLE : undefined,
    onClick: () => {
      if (busy > 0 || !settled()) return;
      touch();
      action();
    },
  });
  /** The same for a button that only leaves: never held by work (the floor's leave waits for it, N9). */
  const leave = (action: () => void) => ({
    onClick: () => {
      if (!settled()) return;
      action();
    },
  });

  const send = (current: WarehouseJob, intent: SendIntent) =>
    run(async () => {
      setSending(current.id);
      setSaid(null);
      try {
        const after = await sendWarehouseJob(context, current, intent, operator.id);
        live.current.onRecorded();
        if (!alive.current) return;
        setJob(after);
        await recount(after.sessionId);
      } finally {
        if (alive.current) setSending(null);
      }
    });

  /** One line of «Что и на чём печатаем»: the template (or the sheet) and the printer, in words. */
  const summaryDetail = (row: SummaryRow, chosen: WarehouseTemplates): string => {
    const printer = row.printer?.name ?? t("floor.warehouse.summary.noPrinter");
    if (row.kind === "sheet") {
      if (row.printer === null) return t("floor.warehouse.summary.noSheetPrinter");
      const named = sheetChoiceName(chosen.pallet, sheets.kind === "ready" ? sheets.sheets : null);
      const sheet =
        named === null
          ? t("floor.warehouse.summary.noSheet")
          : named.kind === "auto"
            ? t("floor.warehouse.sheets.auto")
            : (named.name ?? t("floor.warehouse.sheets.lineSome"));
      return t("floor.warehouse.summary.sheetLine", { template: sheet, printer: row.printer.name });
    }
    if (row.state === "sheets_only") return t("floor.warehouse.summary.sheetsOnly");
    const kind = row.kind;
    const picked = templates.find((template) => template.id === chosen[kind])?.name ?? null;
    return t("floor.warehouse.summary.line", {
      template: picked === null ? t("floor.warehouse.summary.noTemplate") : `«${picked}»`,
      printer,
    });
  };

  const summaryLines = (chosen: WarehouseTemplates): SummaryLine[] =>
    summaryRows(settings).map((row) => ({ row, detail: summaryDetail(row, chosen) }));

  /** The template a job froze, by name; a sheet is named by the host's list when it is at hand. */
  const jobTemplateName = (shown: WarehouseJob): string | null => {
    if (jobKindView(shown) === "sheet") {
      const sheet =
        sheets.kind === "ready"
          ? sheets.sheets.sheets.find((candidate) => candidate.id === shown.templateId)
          : undefined;
      return sheet?.name ?? t("floor.warehouse.sheets.lineSome");
    }
    return templates.find((template) => template.id === shown.templateId)?.name ?? null;
  };

  /** A question in the cloud's full-screen dialog layout, inside the same frame (the templates' picker). */
  const question = (node: ReactNode) => (
    <section className="warehouse-reprint warehouse-reprint--question" tabIndex={-1} ref={viewRef}>
      {node}
    </section>
  );
  const heading = useHeading();
  const pauseButton = (
    <FooterButton glyph="arrow-left" {...leave(onLeave)}>
      {t("floor.warehouse.pause")}
    </FooterButton>
  );

  if (phase.kind === "loading") {
    return (
      <ReprintFrame
        viewRef={viewRef}
        head={heading(true)}
        body={
          <section className="rp-status" aria-live="polite">
            <p>{t("floor.warehouse.loading")}</p>
          </section>
        }
      />
    );
  }
  if (phase.kind === "read_failed") {
    return (
      <ReprintFrame
        viewRef={viewRef}
        head={heading(true)}
        body={
          <section className="rp-status">
            <Alert
              tone="error"
              action={
                <Button
                  size="floor"
                  variant="secondary"
                  {...leave(() => setAttempt((value) => value + 1))}
                >
                  {t("floor.warehouse.retry")}
                </Button>
              }
            >
              {t("floor.warehouse.readFailed")}
            </Alert>
          </section>
        }
        footer={<ReprintFooter>{pauseButton}</ReprintFooter>}
      />
    );
  }

  const applyTemplates = (next: WarehouseTemplates) => {
    setPanel({ kind: "none" });
    if (phase.kind === "setup") {
      setPhase({ ...phase, templates: next });
      return;
    }
    const session = { ...phase.session, templates: next };
    run(async () => {
      await updateSession(local, { hostId, deviceId }, session, now().toISOString());
      if (alive.current) setPhase({ kind: "working", session });
    });
  };

  if (panel.kind === "templates") {
    return question(
      <TemplatePicker
        templates={templates}
        palletPaper={palletPaper}
        sheets={sheets}
        onReloadSheets={() => setSheetsAttempt((value) => value + 1)}
        chosen={phase.kind === "setup" ? phase.templates : phase.session.templates}
        initialKind={panel.initial}
        source={source}
        clock={clock}
        onApply={applyTemplates}
        onCancel={() => setPanel({ kind: "none" })}
      />,
    );
  }

  /** «Изменить» of a row of the summary: its templates, on the tab of its kind. */
  const changeTemplates = (kind: JobKindView) =>
    setPanel({ kind: "templates", initial: kind === "sheet" ? "pallet" : kind });

  if (phase.kind === "setup") {
    const { reason } = phase;
    return (
      <SetupView
        viewRef={viewRef}
        reason={reason}
        lines={summaryLines(phase.templates)}
        press={press}
        leave={leave}
        onPick={(picked) => setPhase({ ...phase, reason: picked })}
        onChangeTemplates={changeTemplates}
        onLeave={onLeave}
        onSetup={onSetup}
        onStart={() => {
          if (reason === null) return;
          run(async () => {
            const started = await startSession(
              local,
              { hostId, deviceId },
              {
                id: newId(),
                reason,
                templates: phase.templates,
                operatorId: operator.id,
                at: now().toISOString(),
              },
            );
            if (!alive.current) return;
            setPhase({ kind: "working", session: started });
            setSaid(null);
            setDetail(false);
            await recount(started.id);
          });
        }}
      />
    );
  }

  const { session } = phase;
  const reasonText = t("floor.warehouse.sessionReason", {
    reason: t(`floor.warehouse.reasons.${session.reason}`),
  });
  const closePanel = press(() => setPanel({ kind: "none" }));
  const closeProps = { ...closePanel, onClick: closePanel.onClick };

  if (panel.kind === "manual") {
    return (
      <ManualView
        viewRef={viewRef}
        value={manual}
        onChange={setManual}
        online={online}
        reasonText={reasonText}
        press={press}
        onCancel={() => setPanel({ kind: "none" })}
        onSubmit={() => {
          const typed = manual;
          if (typed.trim() === "") return;
          setManual("");
          setPanel({ kind: "none" });
          run(() => reprint(session, typed));
        }}
        submitProps={{
          onClick: (event: { preventDefault: () => void }) => {
            // The press is the form's submit; one just after the view changed is stopped here.
            if (!settled()) event.preventDefault();
          },
        }}
      />
    );
  }

  const unresolved = job !== null && (UNRESOLVED as readonly string[]).includes(job.state);
  /** The job as the detail shows it: on its way to the printer while its bytes are being sent. */
  const shown: WarehouseJob | null =
    job === null ? null : sending === job.id ? { ...job, state: "sending", errorCode: null } : job;

  const overlay =
    panel.kind === "reason" || panel.kind === "again" ? (
      <ReasonDialog
        again={panel.kind === "again"}
        picked={panel.picked}
        onPick={(picked) => setPanel({ ...panel, picked })}
        closeProps={closeProps}
        press={press}
        dialogRef={viewRef}
        onConfirm={() => {
          const { picked } = panel;
          if (picked === null) return;
          setPanel({ kind: "none" });
          if (panel.kind === "again") {
            send(panel.job, { kind: "again", reason: picked });
            return;
          }
          const changed = { ...session, reason: picked };
          run(async () => {
            await updateSession(local, { hostId, deviceId }, changed, now().toISOString());
            if (alive.current) setPhase({ kind: "working", session: changed });
          });
        }}
      />
    ) : panel.kind === "finish" ? (
      <FinishDialog
        sent={counts.sent}
        waiting={counts.waiting}
        closeProps={closeProps}
        press={press}
        dialogRef={viewRef}
        onConfirm={() =>
          run(async () => {
            const done = await finishSession(
              local,
              { hostId, deviceId },
              session.id,
              operator.id,
              now().toISOString(),
            );
            if (done === "finished") live.current.onRecorded();
            if (!alive.current) return;
            setPanel({ kind: "none" });
            if (done === "finished") {
              onLeave();
            } else {
              setSaid({ tone: "warn", text: t("floor.warehouse.finishBlocked"), kind: "busy" });
            }
          })
        }
      />
    ) : null;

  if (detail && shown !== null) {
    const result = resultView(shown, verifying);
    const resultText =
      result.body === null
        ? null
        : result.body.kind === "hint"
          ? t(`floor.warehouse.hint.${result.body.key}`)
          : codeText(result.body.code);
    const outcomeNote =
      shown.state === "unknown" &&
      !verifying &&
      shown.errorCode !== null &&
      i18n.exists(`floor.print.codes.${shown.errorCode}`)
        ? t(`floor.print.codes.${shown.errorCode}`)
        : "";
    const note = [repaired ? t("floor.warehouse.legacyRepair") : "", outcomeNote]
      .filter((line) => line !== "")
      .join(" ");
    return (
      <JobView
        viewRef={viewRef}
        job={shown}
        verifying={verifying}
        templateName={jobTemplateName(shown)}
        resultText={resultText}
        note={note === "" ? null : note}
        said={said}
        online={online}
        scanner={scannerState}
        reasonText={reasonText}
        press={press}
        leave={leave}
        overlay={overlay}
        handlers={{
          onSend: () => send(shown, { kind: "first" }),
          onRetry: () => send(shown, { kind: "retry" }),
          onCancelJob: () =>
            run(async () => {
              const after = await cancelWarehouseJob(context, shown, operator.id);
              live.current.onRecorded();
              if (!alive.current) return;
              setJob(after);
              await recount(after.sessionId);
            }),
          onAgain: () => setPanel({ kind: "again", job: shown, picked: null }),
          onNext: () => {
            setDetail(false);
            setVerifying(false);
            setSaid(null);
            setRepaired(false);
          },
          onVerify: () => setVerifying((value) => !value),
          onSetup: () => onSetup(),
          onLeave,
        }}
      />
    );
  }

  return (
    <SessionView
      viewRef={viewRef}
      journal={journal}
      filter={filter}
      onFilter={setFilter}
      onOpen={(opened) => {
        setJob(opened);
        setDetail(true);
        setRepaired(false);
        setSaid(null);
      }}
      said={said}
      online={online}
      scanner={scannerState}
      reasonText={reasonText}
      sent={counts.sent}
      press={press}
      leave={leave}
      overlay={overlay}
      onReason={() => setPanel({ kind: "reason", picked: session.reason })}
      onManual={() => setPanel({ kind: "manual" })}
      onTemplates={() => {
        if (!unresolved) setPanel({ kind: "templates", initial: "unit" });
      }}
      onFinish={() => setPanel({ kind: "finish" })}
      onLeave={onLeave}
    />
  );
}
