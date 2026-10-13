import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Input, VisuallyHidden, type AlertTone } from "@markiro/ui";

import type { FloorSession } from "../../app/shell.js";
import {
  WAREHOUSE_REASONS,
  WAREHOUSE_SUBJECT_KINDS,
  type WarehouseLookup,
  type WarehouseLookupResult,
} from "../../host/protocol.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { Pairing } from "../../local/reference-sync.js";
import type { PrintRuntime } from "../print/print-runtime.js";
import type { ScanSource } from "../scan-source.js";
import { createWorkQueue } from "../work/work-queue.js";
import "../floor-fit.css";
import { TemplatePicker } from "./TemplatePicker.js";
import { WarehousePanel } from "./WarehousePanel.js";
import "./warehouse.css";
import { realClock, useViewGuard } from "./view-guard.js";
import {
  countSent,
  countUnsentRecords,
  finishSession,
  readOpenSession,
  startSession,
  updateSession,
  type WarehouseJob,
  type WarehouseReason,
  type WarehouseRepair,
  type WarehouseSession,
  type WarehouseTemplates,
} from "./warehouse-store.js";
import {
  initialTemplates,
  readOrgDefaults,
  readWarehouseTemplates,
  type WarehouseTemplate,
} from "./warehouse-templates.js";
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
  /** `WorkGate.track`: every write and send of the screen, so a leave waits for it (N9). */
  track: <T>(work: Promise<T>) => Promise<T>;
  /** Starts the operator's idle wait again. */
  touch: () => void;
  /** True from the moment a leave is asked for: no scan is taken after it. */
  isLeaving: () => boolean;
  source: ScanSource;
  /** `HostApi.warehouseLookup`. */
  lookup: (lookup: WarehouseLookup) => Promise<WarehouseLookupResult>;
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
  | { kind: "templates" }
  | { kind: "reason"; picked: WarehouseReason }
  | { kind: "again"; job: WarehouseJob; picked: WarehouseReason | null }
  | { kind: "manual" }
  | { kind: "finish" };

/** What the screen says of the last thing it did; the tone is said by the words too. */
interface Said {
  tone: AlertTone;
  text: string;
}

/** A button that waits for the work in hand: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/** A reason as the cloud's radio tile (its style is inline, as the kit's button's is). */
const TILE_STYLE: CSSProperties = {
  justifyContent: "flex-start",
  width: "100%",
  minHeight: 72,
  height: "auto",
  padding: "0 16px",
  textAlign: "left",
};
const CHOSEN_TILE_STYLE: CSSProperties = {
  border: "1px solid var(--ok-solid)",
  background: "var(--ok-bg)",
};

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
  track,
  touch,
  isLeaving,
  source,
  lookup,
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
  const { t } = useTranslation();
  const { hostId, deviceId } = pairing;
  const context = useMemo<WarehouseContext>(
    () => ({
      local,
      pairing: { hostId, deviceId },
      runtime: printing,
      now,
      newId,
      ...(render === undefined ? {} : { render }),
    }),
    [local, hostId, deviceId, printing, now, newId, render],
  );
  const [queue] = useState(createWorkQueue);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [templates, setTemplates] = useState<WarehouseTemplate[]>([]);
  const [job, setJob] = useState<WarehouseJob | null>(null);
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
      if (alive.current) setCounts({ sent, waiting });
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
          : t(`floor.print.codes.${code}`, { defaultValue: code });

  const jobSaid = (shown: WarehouseJob, repair: WarehouseRepair | null = null): Said => {
    const note = repair === null ? "" : ` ${t("floor.warehouse.legacyRepair")}`;
    switch (shown.state) {
      case "sent":
        return {
          tone: "ok",
          text: `${t("floor.warehouse.status.sent")}. ${t("floor.warehouse.hint.sent")}${note}`,
        };
      case "verified":
        return { tone: "ok", text: t("floor.warehouse.status.verified") };
      case "unknown":
        return {
          tone: "warn",
          text: `${t("floor.warehouse.status.unknown")}. ${codeText(shown.errorCode)} ${t("floor.warehouse.hint.unknown")}`,
        };
      case "failed":
        return {
          tone: "error",
          text: `${t("floor.warehouse.status.failed")}. ${codeText(shown.errorCode)}`,
        };
      case "cancelled":
        return { tone: "info", text: t("floor.warehouse.status.cancelled") };
      case "prepared":
        return { tone: "info", text: t("floor.warehouse.status.prepared") };
      case "sending":
        return { tone: "info", text: t("floor.warehouse.status.sending") };
    }
  };

  // What the queued work reads when its turn comes, and the props the screen's effects must not
  // restart on: a parent that passes a new function on each render does not reload the session.
  const latest = useRef({ phase, panel, verifying, online, job });
  const live = useRef({
    context,
    operatorId: operator.id,
    track,
    onRecorded,
    onHostError,
    jobSaid,
  });
  useLayoutEffect(() => {
    latest.current = { phase, panel, verifying, online, job };
    live.current = { context, operatorId: operator.id, track, onRecorded, onHostError, jobSaid };
  });

  // The session as stored: none — a new one is set up; an open one is continued, its
  // waiting job recovered (a send cut by a restart becomes unknown). Runs again only for
  // another pairing or on «Повторить», never because a parent passed a new function.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const { context: loading, operatorId } = live.current;
      const [found, copies, defaults] = await Promise.all([
        readOpenSession(local, { hostId, deviceId }),
        readWarehouseTemplates(local),
        readOrgDefaults(local),
      ]);
      if (found === null) {
        return {
          phase: {
            kind: "setup",
            reason: null,
            templates: initialTemplates(copies, defaults),
          } satisfies Phase,
          copies,
          job: null,
        };
      }
      const open = await recoverWarehouseJob(loading, found.id, operatorId);
      return { phase: { kind: "working", session: found } satisfies Phase, copies, job: open };
    };
    void live.current.track(queue.run(load)).then(
      (loaded) => {
        if (cancelled || !alive.current) return;
        setTemplates(loaded.copies);
        setJob(loaded.job);
        setPhase(loaded.phase);
        if (loaded.phase.kind === "working") {
          const resumed = t("floor.warehouse.resumed");
          const state = loaded.job === null ? null : live.current.jobSaid(loaded.job);
          setSaid({
            tone: state?.tone ?? "info",
            text: state === null ? resumed : `${resumed} ${state.text}`,
          });
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

  const show = (outcome: ScanOutcome): void => {
    switch (outcome.kind) {
      case "printed":
        setJob(outcome.job);
        setVerifying(false);
        setSaid(jobSaid(outcome.job, outcome.repair));
        return;
      case "busy":
        setJob(outcome.job);
        setSaid({ tone: "warn", text: t("floor.warehouse.errors.busy") });
        return;
      case "duplicate":
        setJob(outcome.job);
        setSaid({
          tone: "warn",
          text: `${t("floor.warehouse.status.duplicate")}. ${t("floor.warehouse.hint.duplicate")}`,
        });
        return;
      case "host_error":
        setSaid({ tone: "error", text: t("floor.warehouse.errors.lookup_failed") });
        return;
      case "unavailable":
        setSaid({ tone: "warn", text: t(`floor.warehouse.errors.${outcome.reason}`) });
        return;
      case "refused":
        setSaid({ tone: "error", text: t(`floor.warehouse.errors.${outcome.reason}`) });
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
        // «Ничего не напечатано» would be false for a send that was cut: say what it came to.
        if (open.state === "unknown") setSaid(live.current.jobSaid(open));
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
            setSaid({ tone: "error", text: codeText(error.code) });
          } else {
            setSaid({ tone: "error", text: t("floor.warehouse.errors.write_failed") });
          }
          await settleAfterFailure();
        } finally {
          if (alive.current) setBusy((count) => count - 1);
        }
      }),
    );
  };

  const reprint = async (session: WarehouseSession, raw: string): Promise<void> => {
    if (latest.current.online) setSaid({ tone: "info", text: t("floor.warehouse.status.looking") });
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
      setSaid(jobSaid(answer.job));
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
      setSaid({ tone: "info", text: t("floor.warehouse.status.sending") });
      const after = await sendWarehouseJob(context, current, intent, operator.id);
      live.current.onRecorded();
      if (!alive.current) return;
      setJob(after);
      setSaid(jobSaid(after));
      await recount(after.sessionId);
    });

  const templateLines = (chosen: WarehouseTemplates) => (
    <ul className="warehouse-templates">
      {WAREHOUSE_SUBJECT_KINDS.map((kind) => (
        <li key={kind}>
          {t("floor.warehouse.templateLine", {
            kind: t(`floor.warehouse.templateFor.${kind}`),
            name:
              templates.find((template) => template.id === chosen[kind])?.name ??
              t("floor.warehouse.templateNone"),
          })}
        </li>
      ))}
    </ul>
  );

  /** A reason as the cloud's radio tile: its dot, then its words; the chosen one is outlined. */
  const reasonChoices = (
    picked: WarehouseReason | null,
    pick: (reason: WarehouseReason) => void,
  ) => (
    <fieldset className="warehouse-reasons">
      <legend>{t("floor.warehouse.reason")}</legend>
      <div className="warehouse-reasons__options">
        {WAREHOUSE_REASONS.map((reason) => {
          const chosen = picked === reason;
          const props = press(() => pick(reason));
          return (
            <Button
              key={reason}
              size="floor"
              variant="secondary"
              aria-pressed={chosen}
              className="warehouse-reason"
              {...props}
              style={{
                ...TILE_STYLE,
                ...(chosen ? CHOSEN_TILE_STYLE : {}),
                ...(busy > 0 ? WAITING_STYLE : {}),
              }}
            >
              <span className="warehouse-reason__dot" aria-hidden="true" />
              {t(`floor.warehouse.reasons.${reason}`)}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );

  /** The screen's frame: the cloud's heading, the work and the session side by side, the footer. */
  const frame = (heading: ReactNode, body: ReactNode, footer: ReactNode = null) => (
    <main
      className="warehouse-reprint floor-fit"
      aria-labelledby="warehouse-title"
      tabIndex={-1}
      ref={viewRef}
    >
      <header className="warehouse-heading">
        <div>
          <p>{t("floor.warehouse.eyebrow")}</p>
          <h1 id="warehouse-title">{t("floor.warehouse.title")}</h1>
        </div>
        <div className="warehouse-heading-actions">{heading}</div>
      </header>
      {body}
      {footer === null ? null : <footer className="warehouse-footer">{footer}</footer>}
    </main>
  );
  /** A question in the cloud's full-screen dialog layout, inside the same frame. */
  const question = (node: ReactNode) => (
    <main
      className="warehouse-reprint warehouse-reprint--question floor-fit"
      tabIndex={-1}
      ref={viewRef}
    >
      {node}
    </main>
  );
  const pauseButton = (
    <Button size="floor" variant="secondary" {...leave(onLeave)}>
      {t("floor.warehouse.pause")}
    </Button>
  );

  if (phase.kind === "loading") {
    return frame(
      null,
      <section className="warehouse-status" aria-live="polite">
        <p>{t("floor.warehouse.loading")}</p>
      </section>,
    );
  }
  if (phase.kind === "read_failed") {
    return frame(
      pauseButton,
      <section className="warehouse-status warehouse-status--failed">
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
        chosen={phase.kind === "setup" ? phase.templates : phase.session.templates}
        source={source}
        clock={clock}
        onApply={applyTemplates}
        onCancel={() => setPanel({ kind: "none" })}
      />,
    );
  }

  /** «Этот сеанс»: the reason, the count, the templates — the cloud's side panel. */
  const sessionPanel = (
    reason: WarehouseReason | null,
    chosen: WarehouseTemplates,
    templatesButton: Record<string, unknown>,
  ) => (
    <aside className="warehouse-session-panel" aria-labelledby="warehouse-session-title">
      <h2 id="warehouse-session-title">{t("floor.warehouse.session")}</h2>
      {reason !== null && (
        <p>
          {t("floor.warehouse.sessionReason", { reason: t(`floor.warehouse.reasons.${reason}`) })}
        </p>
      )}
      <strong className="warehouse-sent-count" aria-hidden="true">
        {counts.sent}
      </strong>
      <p>
        <VisuallyHidden>{t("floor.warehouse.sentCount", { sent: counts.sent })}</VisuallyHidden>
        <span aria-hidden="true">{t("floor.warehouse.sentLabel")}</span>
      </p>
      {counts.waiting > 0 && <p>{t("floor.warehouse.waiting", { waiting: counts.waiting })}</p>}
      {templateLines(chosen)}
      <Button size="floor" variant="secondary" {...templatesButton}>
        {t("floor.warehouse.chooseTemplates")}
      </Button>
      <p className="warehouse-session-note">{t("floor.warehouse.scope")}</p>
    </aside>
  );

  if (phase.kind === "setup") {
    const { reason } = phase;
    return frame(
      pauseButton,
      <div className="warehouse-work-grid">
        <div className="warehouse-main">
          <section className="warehouse-session-setup" aria-labelledby="warehouse-setup-title">
            <h2 id="warehouse-setup-title">{t("floor.warehouse.sessionSetup")}</h2>
            <p>{t("floor.warehouse.sessionScope")}</p>
            {reasonChoices(reason, (picked) => setPhase({ ...phase, reason: picked }))}
            <Button
              size="floor"
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
                  await recount(started.id);
                });
              })}
            >
              {t("floor.warehouse.start")}
            </Button>
          </section>
        </div>
        {sessionPanel(
          reason,
          phase.templates,
          press(() => setPanel({ kind: "templates" })),
        )}
      </div>,
    );
  }

  const { session } = phase;

  if (panel.kind === "reason" || panel.kind === "again") {
    const again = panel.kind === "again";
    return question(
      <WarehousePanel
        titleId="warehouse-reason-title"
        title={t(again ? "floor.warehouse.againTitle" : "floor.warehouse.changeReason")}
        backLabel={t("floor.warehouse.cancel")}
        back={press(() => setPanel({ kind: "none" }))}
        footer={
          <Button
            size="floor"
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
            {t(again ? "floor.warehouse.againConfirm" : "floor.warehouse.applyReason")}
          </Button>
        }
      >
        <div className="warehouse-confirm-body">
          {again && <p>{t("floor.warehouse.againText")}</p>}
          {reasonChoices(panel.picked, (picked) => setPanel({ ...panel, picked }))}
          {panel.picked !== null && (
            <p>
              {t("floor.warehouse.sessionReason", {
                reason: t(`floor.warehouse.reasons.${panel.picked}`),
              })}
            </p>
          )}
        </div>
      </WarehousePanel>,
    );
  }

  if (panel.kind === "finish") {
    return question(
      <WarehousePanel
        titleId="warehouse-finish-title"
        title={t("floor.warehouse.finishTitle")}
        backLabel={t("floor.warehouse.cancel")}
        back={press(() => setPanel({ kind: "none" }))}
        footer={
          <Button
            size="floor"
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
                  setSaid({ tone: "warn", text: t("floor.warehouse.finishBlocked") });
                }
              }),
            )}
          >
            {t("floor.warehouse.finishConfirm")}
          </Button>
        }
      >
        <div className="warehouse-confirm-body">
          <p>{t("floor.warehouse.finishText", { sent: counts.sent })}</p>
        </div>
      </WarehousePanel>,
    );
  }

  if (panel.kind === "manual") {
    return question(
      <WarehousePanel
        titleId="warehouse-manual-title"
        title={t("floor.warehouse.manual")}
        backLabel={t("floor.warehouse.cancel")}
        back={press(() => setPanel({ kind: "none" }))}
        footer={
          <Button
            size="floor"
            type="submit"
            form="warehouse-manual-form"
            disabled={manual.trim() === ""}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              // The press is the form's submit; one just after the view changed is stopped here.
              if (!settled()) event.preventDefault();
            }}
          >
            {t("floor.warehouse.manualSubmit")}
          </Button>
        }
      >
        <form
          id="warehouse-manual-form"
          className="warehouse-manual-form"
          onSubmit={(event) => {
            event.preventDefault();
            const typed = manual;
            if (typed.trim() === "") return;
            setManual("");
            setPanel({ kind: "none" });
            run(() => reprint(session, typed));
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPanel({ kind: "none" });
          }}
        >
          <Input
            size="floor"
            mono
            label={t("floor.warehouse.manualLabel")}
            value={manual}
            autoFocus
            spellCheck={false}
            onChange={(event) => setManual(event.target.value)}
          />
        </form>
      </WarehousePanel>,
    );
  }

  const jobActions = (current: WarehouseJob) => {
    switch (current.state) {
      case "prepared":
        return (
          <Button size="floor" {...press(() => send(current, { kind: "first" }))}>
            {t("floor.warehouse.send")}
          </Button>
        );
      case "failed":
        return (
          <>
            <Button size="floor" {...press(() => send(current, { kind: "retry" }))}>
              {t("floor.warehouse.retrySend")}
            </Button>
            <Button
              size="floor"
              variant="secondary"
              {...press(() =>
                run(async () => {
                  const after = await cancelWarehouseJob(context, current, operator.id);
                  live.current.onRecorded();
                  if (!alive.current) return;
                  setJob(after);
                  setSaid(jobSaid(after));
                  await recount(after.sessionId);
                }),
              )}
            >
              {t("floor.warehouse.cancelJob")}
            </Button>
            {(current.errorCode === "printer_unconfigured" ||
              current.errorCode === "printer_a4") && (
              <Button size="floor" variant="secondary" {...leave(onSetup)}>
                {t("floor.warehouse.setup")}
              </Button>
            )}
          </>
        );
      case "unknown":
        return (
          <>
            <Button
              size="floor"
              variant="secondary"
              aria-pressed={verifying}
              {...press(() => setVerifying((value) => !value))}
            >
              {t(verifying ? "floor.warehouse.verifyCancel" : "floor.warehouse.verifyButton")}
            </Button>
            <Button
              size="floor"
              {...press(() => setPanel({ kind: "again", job: current, picked: null }))}
            >
              {t("floor.warehouse.printAgain")}
            </Button>
          </>
        );
      case "sent":
      case "verified":
        return (
          <Button
            size="floor"
            variant="secondary"
            {...press(() => setPanel({ kind: "again", job: current, picked: null }))}
          >
            {t("floor.warehouse.printAgain")}
          </Button>
        );
      default:
        return null;
    }
  };

  const subject =
    job === null
      ? null
      : job.kind === "unit"
        ? t("floor.warehouse.subject.unit")
        : t(`floor.warehouse.subject.${job.kind}`, { sscc: job.identity });
  const unresolved = job !== null && (UNRESOLVED as readonly string[]).includes(job.state);
  const statusKey = verifying ? "verify" : (job?.state ?? "ready");
  const actions = job === null ? null : jobActions(job);

  return frame(
    <>
      <Button size="floor" {...press(() => setPanel({ kind: "manual" }))}>
        {t("floor.warehouse.manual")}
      </Button>
      {/* Never held by work: the floor's leave waits for it (N9). */}
      {pauseButton}
    </>,
    <div className="warehouse-work-grid">
      <div className="warehouse-main">
        <section
          className={`warehouse-status warehouse-status--${statusKey}`}
          {...(subject === null ? {} : { "aria-label": subject })}
        >
          <ScanMark className="warehouse-scan-mark" />
          {job === null ? (
            <h2>{t("floor.warehouse.prompt")}</h2>
          ) : (
            <div className="warehouse-result">
              <h2>{subject}</h2>
              <p>
                {t("floor.warehouse.jobLine", {
                  state: t(`floor.warehouse.jobState.${job.state}`),
                })}
              </p>
            </div>
          )}
          <div className="warehouse-status__said" aria-live="polite">
            {!online && (
              <Alert tone="warn" role="presentation">
                {t("floor.warehouse.offlineNotice")}
              </Alert>
            )}
            {said !== null && (
              <Alert tone={said.tone} role="presentation">
                {said.text}
              </Alert>
            )}
            {verifying && (
              <p>{`${t("floor.warehouse.status.verify")}. ${t("floor.warehouse.hint.verify")}`}</p>
            )}
          </div>
        </section>
        {actions !== null && <div className="warehouse-recovery-actions">{actions}</div>}
      </div>
      {sessionPanel(session.reason, session.templates, {
        ...press(() => {
          if (!unresolved) setPanel({ kind: "templates" });
        }),
        ...(unresolved ? { "aria-disabled": true, style: WAITING_STYLE } : {}),
      })}
    </div>,
    <>
      <Button
        size="floor"
        variant="secondary"
        {...press(() => setPanel({ kind: "reason", picked: session.reason }))}
      >
        {t("floor.warehouse.changeReason")}
      </Button>
      <Button size="floor" variant="secondary" {...press(() => setPanel({ kind: "finish" }))}>
        {t("floor.warehouse.finish")}
      </Button>
    </>,
  );
}

/** The cloud's scan mark (apps/station/src/ui/BarcodeIcon.tsx), bundled: the station is offline-first. */
function ScanMark({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 7v18M9 7v18M14 7v18M18 7v18M24 7v18M27 7v18" />
      <path d="M2 10V4h6m16 0h6v6M2 22v6h6m16 0h6v-6" />
    </svg>
  );
}
