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
import { Glyph } from "../kit/StatusIcons.js";
import type { ScannerIndicator } from "../scanner-indicator.js";
import type { ScanSource } from "../scan-source.js";
import {
  readWorkstationSettings,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import { createWorkQueue } from "../work/work-queue.js";
import { TemplatePicker, type SheetsState } from "./TemplatePicker.js";
import { sheetChoiceName } from "./warehouse-sheet.js";
import {
  Banner,
  FooterButton,
  Journal,
  JournalEmpty,
  JobPrint,
  JobSubject,
  ManualEntry,
  ReasonList,
  ReprintDialog,
  ReprintFooter,
  ReprintHeading,
  ScanZone,
  SummaryList,
  Tag,
  type SummaryLine,
  type ZoneVariant,
} from "./ReprintParts.js";
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
  filterJobs,
  isPrinterSetupFailure,
  jobKindView,
  printerView,
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

/**
 * What the screen says of the last thing it did that is no state of a job (a job's state is its
 * detail's, derived from the job itself); the tone is said by the words and the glyph too.
 * `kind` is the outcome (`not_found`, `offline`, ...), which picks the banner's title and the scan
 * zone's face.
 */
interface Said {
  tone: "ok" | "warn" | "error" | "info";
  text: string;
  kind?: string;
}

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
        setSettings({ printers: loaded.settings.printers, assignments: loaded.settings.assignments });
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

  /** The words of a code a print failed with. */
  const codeWords = (code: string | null): string => codeText(code);

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

  const heading = (setup: boolean, actions?: ReactNode, title?: string) => (
    <ReprintHeading
      eyebrow={t(setup ? "floor.warehouse.eyebrowSetup" : "floor.warehouse.eyebrowSession")}
      title={title ?? t(setup ? "floor.warehouse.title" : "floor.warehouse.titleSession")}
      titleId="warehouse-title"
      {...(actions === undefined ? {} : { actions })}
    />
  );

  /** The screen's frame: the heading, the body, the answers; a question over it takes the view's focus. */
  const frame = (
    head: ReactNode,
    body: ReactNode,
    footer: ReactNode = null,
    overlay: ReactNode = null,
  ) => (
    <section
      className="warehouse-reprint"
      aria-labelledby="warehouse-title"
      tabIndex={-1}
      ref={overlay === null ? viewRef : undefined}
    >
      {head}
      {body}
      {footer}
      {overlay}
    </section>
  );
  /** A question in the cloud's full-screen dialog layout, inside the same frame (the templates' picker). */
  const question = (node: ReactNode) => (
    <section className="warehouse-reprint warehouse-reprint--question" tabIndex={-1} ref={viewRef}>
      {node}
    </section>
  );
  const pauseButton = (
    <FooterButton glyph="arrow-left" {...leave(onLeave)}>
      {t("floor.warehouse.pause")}
    </FooterButton>
  );

  if (phase.kind === "loading") {
    return frame(
      heading(true),
      <section className="rp-status" aria-live="polite">
        <p>{t("floor.warehouse.loading")}</p>
      </section>,
    );
  }
  if (phase.kind === "read_failed") {
    return frame(
      heading(true),
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
      </section>,
      <ReprintFooter>{pauseButton}</ReprintFooter>,
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

  /**
   * What stands above the zones: the last thing the screen said (a refusal, a state of the link),
   * else the link's or the scanner's own state. A job's state is never said here: its detail says it.
   */
  const banner = (() => {
    if (said !== null) {
      const title =
        said.kind !== undefined && i18n.exists(`floor.warehouse.banner.title.${said.kind}`)
          ? t(`floor.warehouse.banner.title.${said.kind}`)
          : "";
      const glyph =
        said.kind === "not_found"
          ? "search-x"
          : said.kind === "offline"
            ? "wifi-slash"
            : said.tone === "error"
              ? "x-circle"
              : said.tone === "warn"
                ? "warning"
                : "info";
      return (
        <Banner
          tone={said.tone === "ok" ? "info" : said.tone}
          glyph={glyph}
          title={title === "" ? undefined : title}
        >
          {said.text}
        </Banner>
      );
    }
    if (!online) {
      return (
        <Banner tone="warn" glyph="wifi-slash" title={t("floor.warehouse.banner.offlineTitle")}>
          {t("floor.warehouse.banner.offlineText")}
        </Banner>
      );
    }
    if (scannerState === "disconnected") {
      return (
        <Banner tone="error" glyph="plugs" title={t("floor.warehouse.banner.scannerTitle")}>
          {t("floor.warehouse.banner.scannerText")}
        </Banner>
      );
    }
    return null;
  })();
  /** The banner's place is always in the tree: a polite region has to stand before it is heard. */
  const bannerRegion = (
    <div className="rp-banner-region" aria-live="polite">
      {banner}
    </div>
  );
  const body = (zones: ReactNode) => (
    <div className={banner === null ? "rp-body" : "rp-body rp-body--banner"}>
      {bannerRegion}
      {zones}
    </div>
  );

  if (phase.kind === "setup") {
    const { reason } = phase;
    return frame(
      heading(true),
      <div className="rp-zones rp-zones--setup">
        <section className="rp-setup-reasons" aria-labelledby="warehouse-setup-title">
          <h3 id="warehouse-setup-title" className="rp-label rp-label--hidden">
            {t("floor.warehouse.sessionSetup")}
          </h3>
          <ReasonList
            picked={reason}
            onPick={(picked) => setPhase({ ...phase, reason: picked })}
            press={press}
            legend={t("floor.warehouse.reason")}
          />
          <p>{t("floor.warehouse.reasonHint")}</p>
          <p>{t("floor.warehouse.scope")}</p>
        </section>
        <section aria-labelledby="warehouse-summary-title">
          <h3 id="warehouse-summary-title" className="rp-label">
            {t("floor.warehouse.summary.title")}
          </h3>
          <SummaryList
            lines={summaryLines(phase.templates)}
            press={press}
            onChange={changeTemplates}
            disabled={false}
          />
        </section>
      </div>,
      <ReprintFooter>
        {pauseButton}
        <FooterButton glyph="gear" {...leave(onSetup)}>
          {t("floor.warehouse.setup")}
        </FooterButton>
        <FooterButton
          primary
          glyph="printer"
          disabled={reason === null}
          {...press(() => {
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
          })}
        >
          {t("floor.warehouse.start")}
        </FooterButton>
      </ReprintFooter>,
    );
  }

  const { session } = phase;
  const reasonText = t("floor.warehouse.sessionReason", {
    reason: t(`floor.warehouse.reasons.${session.reason}`),
  });
  const closePanel = press(() => setPanel({ kind: "none" }));

  /** The typed code: its own screen, the reason beside the title, «Отмена» the only way back. */
  if (panel.kind === "manual") {
    return frame(
      heading(
        false,
        <Tag tone="neutral" glyph="info">
          {reasonText}
        </Tag>,
        t("floor.warehouse.manual"),
      ),
      <div
        className="rp-body"
        onKeyDown={(event) => {
          if (event.key === "Escape") setPanel({ kind: "none" });
        }}
      >
        <ManualEntry
          value={manual}
          onChange={setManual}
          online={online}
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
      </div>,
      <ReprintFooter>
        <FooterButton glyph="x" {...closePanel}>
          {t("floor.warehouse.cancel")}
        </FooterButton>
      </ReprintFooter>,
    );
  }

  const unresolved = job !== null && (UNRESOLVED as readonly string[]).includes(job.state);
  /** The job as the detail shows it: on its way to the printer while its bytes are being sent. */
  const shown: WarehouseJob | null =
    job === null ? null : sending === job.id ? { ...job, state: "sending", errorCode: null } : job;

  const nextCode = () => {
    setDetail(false);
    setVerifying(false);
    setSaid(null);
    setRepaired(false);
  };

  const jobFooter = (current: WarehouseJob) => {
    const again = (primary: boolean) => (
      <FooterButton
        glyph="refresh"
        primary={primary}
        {...press(() => setPanel({ kind: "again", job: current, picked: null }))}
      >
        {t("floor.warehouse.printAgain")}
      </FooterButton>
    );
    const next = (
      <FooterButton primary glyph="barcode" {...press(nextCode)}>
        {t("floor.warehouse.nextCode")}
      </FooterButton>
    );
    switch (current.state) {
      case "sending":
        return (
          <FooterButton primary glyph="circle-notch" aria-disabled="true" style={WAITING_STYLE}>
            {t("floor.warehouse.printing")}
          </FooterButton>
        );
      case "prepared":
        return (
          <FooterButton
            primary
            glyph="printer"
            {...press(() => send(current, { kind: "first" }))}
          >
            {t("floor.warehouse.send")}
          </FooterButton>
        );
      case "failed": {
        const setupFailure = isPrinterSetupFailure(current.errorCode);
        const cancel = (
          <FooterButton
            glyph="x"
            {...press(() =>
              run(async () => {
                const after = await cancelWarehouseJob(context, current, operator.id);
                live.current.onRecorded();
                if (!alive.current) return;
                setJob(after);
                await recount(after.sessionId);
              }),
            )}
          >
            {t("floor.warehouse.cancelJob")}
          </FooterButton>
        );
        const retry = (primary: boolean) => (
          <FooterButton
            glyph="refresh"
            primary={primary}
            {...press(() => send(current, { kind: "retry" }))}
          >
            {t("floor.warehouse.retrySend")}
          </FooterButton>
        );
        return setupFailure ? (
          <>
            {cancel}
            {retry(false)}
            <FooterButton primary glyph="gear" {...leave(onSetup)}>
              {t("floor.warehouse.setup")}
            </FooterButton>
          </>
        ) : (
          <>
            {cancel}
            <FooterButton glyph="gear" {...leave(onSetup)}>
              {t("floor.warehouse.setup")}
            </FooterButton>
            {retry(true)}
          </>
        );
      }
      case "unknown":
        return (
          <>
            {again(false)}
            <FooterButton
              primary={!verifying}
              glyph="scan-frame"
              aria-pressed={verifying}
              {...press(() => setVerifying((value) => !value))}
            >
              {t(verifying ? "floor.warehouse.verifyCancel" : "floor.warehouse.verifyButton")}
            </FooterButton>
          </>
        );
      case "sent":
      case "verified":
        return (
          <>
            {again(false)}
            {next}
          </>
        );
      case "cancelled":
        return next;
    }
  };

  /** What the screen's heading carries: in the session the reason (to change) and the count. */
  const sessionActions = (
    <>
      <FooterButton glyph="info" {...press(() => setPanel({ kind: "reason", picked: session.reason }))}>
        {reasonText}
      </FooterButton>
      <Tag tone="ok" glyph="printer">
        {t("floor.warehouse.sentChip", { sent: counts.sent })}
      </Tag>
    </>
  );
  const jobActions = (
    <>
      <Tag tone="neutral" glyph="info">
        {reasonText}
      </Tag>
      {/* Never held by work: the floor's leave waits for it (N9). */}
      {pauseButton}
    </>
  );

  const overlay =
    panel.kind === "reason" || panel.kind === "again" ? (
      <ReprintDialog
        titleId="warehouse-reason-title"
        title={t(panel.kind === "again" ? "floor.warehouse.againTitle" : "floor.warehouse.changeReason")}
        dialogRef={viewRef}
        onCancel={closePanel.onClick}
        actions={
          <>
            <FooterButton glyph="x" {...closePanel}>
              {t("floor.warehouse.cancel")}
            </FooterButton>
            <FooterButton
              primary
              glyph="printer"
              disabled={panel.picked === null}
              {...press(() => {
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
              })}
            >
              {t(panel.kind === "again" ? "floor.warehouse.againConfirm" : "floor.warehouse.applyReason")}
            </FooterButton>
          </>
        }
      >
        {panel.kind === "again" ? <p>{t("floor.warehouse.againText")}</p> : null}
        <ReasonList
          picked={panel.picked}
          onPick={(picked) => setPanel({ ...panel, picked })}
          press={press}
          legend={t("floor.warehouse.reason")}
          hideLegend
        />
      </ReprintDialog>
    ) : panel.kind === "finish" ? (
      <ReprintDialog
        titleId="warehouse-finish-title"
        title={t("floor.warehouse.finishTitle")}
        dialogRef={viewRef}
        onCancel={closePanel.onClick}
        actions={
          <>
            <FooterButton glyph="x" {...closePanel}>
              {t("floor.warehouse.cancel")}
            </FooterButton>
            <FooterButton
              primary
              glyph="stop"
              {...press(() =>
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
                    setSaid({
                      tone: "warn",
                      text: t("floor.warehouse.finishBlocked"),
                      kind: "busy",
                    });
                  }
                }),
              )}
            >
              {t("floor.warehouse.finishConfirm")}
            </FooterButton>
          </>
        }
      >
        <p>{t("floor.warehouse.finishText", { sent: counts.sent })}</p>
        {counts.waiting > 0 ? (
          <Tag tone="warn" glyph="upload">
            {t("floor.warehouse.waiting", { waiting: counts.waiting })}
          </Tag>
        ) : null}
      </ReprintDialog>
    ) : null;

  if (detail && shown !== null) {
    const result = resultView(shown, verifying);
    const resultText =
      result.body === null
        ? null
        : result.body.kind === "hint"
          ? t(`floor.warehouse.hint.${result.body.key}`)
          : codeWords(result.body.code);
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
    return frame(
      heading(false, jobActions),
      body(
        <div className="rp-zones rp-zones--job">
          <JobSubject job={shown} />
          <JobPrint
            templateName={jobTemplateName(shown)}
            printer={printerView(shown)}
            reason={t(`floor.warehouse.reasons.${shown.reason}`)}
            result={result}
            resultText={resultText}
            note={note === "" ? null : note}
          />
        </div>,
      ),
      <ReprintFooter>{jobFooter(shown)}</ReprintFooter>,
      overlay,
    );
  }

  const variant: ZoneVariant =
    scannerState === "disconnected"
      ? "scanner"
      : !online
        ? "offline"
        : said?.kind === "not_found"
          ? "not_found"
          : "ready";
  const visible = filterJobs(journal, filter);
  return frame(
    heading(false, sessionActions),
    body(
      <div className="rp-zones">
        {journal.length === 0 ? (
          <JournalEmpty />
        ) : (
          <Journal
            jobs={visible}
            filter={filter}
            onFilter={setFilter}
            onOpen={(opened) => {
              setJob(opened);
              setDetail(true);
              setRepaired(false);
              setSaid(null);
            }}
            press={press}
          />
        )}
        <ScanZone
          variant={variant}
          manual={
            <Button
              size="floor"
              variant={variant === "scanner" ? "primary" : "secondary"}
              icon={<Glyph name="keyboard" size={26} />}
              disabled={!online}
              {...press(() => setPanel({ kind: "manual" }))}
            >
              {t("floor.warehouse.manual")}
            </Button>
          }
        />
      </div>,
    ),
    <ReprintFooter>
      {pauseButton}
      <FooterButton
        glyph="file"
        {...press(() => {
          if (!unresolved) setPanel({ kind: "templates", initial: "unit" });
        })}
      >
        {t("floor.warehouse.chooseTemplates")}
      </FooterButton>
      <FooterButton glyph="stop" end {...press(() => setPanel({ kind: "finish" }))}>
        {t("floor.warehouse.finish")}
      </FooterButton>
    </ReprintFooter>,
    overlay,
  );
}
