import { formatSsccHri } from "@markiro/domain";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, VisuallyHidden } from "@markiro/ui";

import { REPRINT_REASONS } from "../exception-reasons.js";
import {
  printerMode,
  printsPurpose,
  type PrinterProfile,
  type WorkstationSettings,
} from "../setup/workstation-settings.js";
import type { PrintJob } from "./print-jobs.js";
import { awaitsCheck, printerForAgain, type PrintAgain } from "./print-resolution.js";
import type { WindowsQueueCheck } from "./print-runtime.js";
import "./label-panel.css";
import { printerFormatText } from "./printer-format.js";

/** What the panel says under the label: a scan that did not match, a decision that could not be done. */
export type LabelNote =
  | { kind: "mismatch"; sscc: string }
  | { kind: "not_sscc" }
  | { kind: "no_printer" }
  | { kind: "render_failed" }
  | { kind: "moved" };

/** The part of the workstation's settings the panel reads to say where a label will go. */
export type PanelSettings = Pick<WorkstationSettings, "printers" | "assignments">;

export interface LabelPanelProps {
  /** A job that waits: prepared, sending, failed, unknown, or sent with its check to do. */
  job: PrintJob;
  /** A decision is being carried out: every button waits (and keeps its focus). */
  busy: boolean;
  note: LabelNote | null;
  /** The workstation's settings, read when the panel opens: which printer a reprint goes to. */
  loadSettings: () => Promise<PanelSettings>;
  onPrintAgain: (request: PrintAgain) => void;
  onPrinted: () => void;
  onSkip: () => void;
  /** The workstation setup; absent where the floor gives none. */
  onSetup?: () => void;
  /**
   * Present only for a job left `sending` that no send of this app holds (its
   * final write failed): the operator's own act, which asks the work screen to
   * turn it into `unknown` so the decisions of an unknown label apply. It
   * sends nothing.
   */
  onRecover?: () => void;
  /**
   * «Проверить очередь Windows» (plan ДРВ): the spooler's word on the job's
   * newest driver send. Offered only for a printer in driver mode, while the
   * label may exist (unknown, or a check waits); diagnostic only — it decides
   * nothing and never confirms a printed label.
   */
  checkQueue?: () => Promise<WindowsQueueCheck>;
  /** Milliseconds from a clock that does not go back; the guard after a view change reads it. */
  clock?: () => number;
}

/**
 * How long a press on the panel is ignored after it changed its view. A
 * second Space press, or the second tap of a gloved double tap, lands on
 * whatever the new view put under the finger: a reason nobody chose, a printer
 * nobody chose, a decision on the label. 400 ms is longer than a double tap
 * and shorter than an operator reading the view.
 */
export const VIEW_GUARD_MS = 400;

const realClock = () => performance.now();

type Mode =
  | { kind: "main" }
  | { kind: "reason"; printer: PrinterProfile | null }
  | { kind: "printers"; printers: PrinterProfile[] | null }
  | { kind: "skip" };

type Settings = { kind: "loading" } | { kind: "ready"; value: PanelSettings } | { kind: "failed" };

/** A button that is waiting for a decision's answer: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/** The SSCC in the cloud's PrintVerification groups: extension, prefix and serial, check digit. */
function groupedSscc(value: string): string {
  return `${value.slice(0, 1)} ${value.slice(1, 10)} ${value.slice(10, 17)} ${value.slice(17)}`;
}

function noteText(note: LabelNote, t: TFunction, pallet: boolean): string {
  switch (note.kind) {
    case "mismatch":
      return t(pallet ? "floor.print.pallet.mismatch" : "floor.print.check.mismatch", {
        sscc: formatSsccHri(note.sscc),
      });
    case "not_sscc":
      return t(pallet ? "floor.print.pallet.notSscc" : "floor.print.check.notSscc");
    case "no_printer":
      return t("floor.print.notes.noPrinter");
    case "render_failed":
      return t("floor.print.notes.renderFailed");
    case "moved":
      return t("floor.print.notes.moved");
  }
}

/**
 * Which printer a reprint of `job` goes to, in words, before the operator
 * confirms it: the chosen one, the job's own as the settings have it now, or —
 * when the job's own printer was deleted from the settings — the purpose's
 * printer, which the operator is told is another one — and, only when the
 * label may exist (`mayExist`), that it may have come out on the deleted one.
 */
function targetText(
  t: TFunction,
  job: PrintJob,
  settings: Settings,
  chosen: PrinterProfile | null,
  mayExist: boolean,
): string | null {
  if (settings.kind === "loading") return null;
  if (settings.kind === "failed") return t("floor.print.target.unknown");
  const printer = printerForAgain(job, settings.value, chosen);
  if (printer === null) return t("floor.print.target.none");
  const former = job.printer;
  const gone =
    chosen === null &&
    former !== null &&
    !settings.value.printers.some((candidate) => candidate.id === former.id);
  const key = !gone
    ? "floor.print.target.label"
    : mayExist
      ? "floor.print.target.replaced"
      : "floor.print.target.replacedFailed";
  return t(key, {
    name: printer.name,
    language: printerFormatText(t, printer),
    dpi: printer.dpi,
    former: former?.name ?? "",
  });
}

/**
 * The label of the box — or of the pallet (plan ПЛ-Ц), said so in its own
 * words — the work stopped for (stage 2a spec §5.7.5): its check — scan the
 * SSCC, or skip it — or its recovery when it failed or its outcome is
 * unknown. Only the operator sends a label again: a label that
 * may already exist only with a reason, which the panel asks before the
 * send and builds from its buttons alone; «Продолжить без этикетки» after a
 * confirmation. Before a reprint is confirmed the panel says which printer
 * it goes to. It sits in the work screen's polite region, so its alerts have
 * no role of their own; the work screen's «Выйти из смены» stays outside it,
 * so nobody is held here.
 */
export function LabelPanel({
  job,
  busy,
  note,
  loadSettings,
  onPrintAgain,
  onPrinted,
  onSkip,
  onSetup,
  onRecover,
  checkQueue,
  clock = realClock,
}: LabelPanelProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>({ kind: "main" });
  const [settings, setSettings] = useState<Settings>({ kind: "loading" });
  const root = useRef<HTMLDivElement>(null);
  const shownMode = useRef(mode.kind);
  // When the view last changed: presses are ignored for `VIEW_GUARD_MS` after.
  const viewChangedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const checking = awaitsCheck(job);
  // A label that may already be on a box: a second one needs a reason.
  const mayExist = checking || job.state === "unknown";
  const pallet = job.purpose === "pallet";
  const [queue, setQueue] = useState<WindowsQueueCheck | "asking" | null>(null);
  const askQueue =
    checkQueue !== undefined &&
    job.printer !== null &&
    printerMode(job.printer) === "windows_driver"
      ? checkQueue
      : null;
  const sscc = t(pallet ? "floor.print.pallet.sscc" : "floor.print.sscc", {
    sscc: formatSsccHri(job.sscc),
  });

  useEffect(() => {
    let cancelled = false;
    loadSettings().then(
      (value) => {
        if (!cancelled) setSettings({ kind: "ready", value });
      },
      () => {
        if (!cancelled) setSettings({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
    // Read once, when the panel opens: a new job, state or attempt opens a new panel.
  }, [loadSettings]);

  // The button that was pressed is gone when the panel changes its view: the
  // focus goes to a control that decides nothing — «Назад» of a view that
  // asks, the panel itself when it is back at its first view — never to a
  // button that sends, which a second press would activate.
  useEffect(() => {
    if (shownMode.current === mode.kind) return;
    shownMode.current = mode.kind;
    const target =
      mode.kind === "main"
        ? root.current
        : root.current?.querySelector<HTMLElement>("[data-panel-back]");
    target?.focus();
  }, [mode.kind]);

  /** Opens a view, and starts the guard against the press that follows the one that opened it. */
  const show = (next: Mode) => {
    viewChangedAt.current = clock();
    setMode(next);
  };

  /** Props of a button: while a decision runs, or a view has just opened, it does nothing. */
  const press = (action: () => void) => ({
    "aria-disabled": busy ? true : undefined,
    style: busy ? WAITING_STYLE : undefined,
    onClick: () => {
      if (busy) return;
      const since = clock() - viewChangedAt.current;
      if (since >= 0 && since < VIEW_GUARD_MS) return;
      action();
    },
  });

  const again = (printer: PrinterProfile | null) => {
    if (mayExist) {
      show({ kind: "reason", printer });
      return;
    }
    show({ kind: "main" });
    onPrintAgain({ reason: null, printer });
  };

  const choosePrinter = () => {
    show({ kind: "printers", printers: null });
    loadSettings().then(
      (loaded) =>
        setMode((now) =>
          now.kind === "printers" ? { kind: "printers", printers: loaded.printers } : now,
        ),
      () => setMode((now) => (now.kind === "printers" ? { kind: "printers", printers: [] } : now)),
    );
  };

  const back = (
    <Button
      size="floor"
      variant="secondary"
      data-panel-back=""
      {...press(() => show({ kind: "main" }))}
    >
      {t("floor.print.back")}
    </Button>
  );

  const queueText =
    askQueue !== null && queue !== null ? (
      <p>
        {queue === "asking"
          ? t("floor.print.queue.checking")
          : t(`floor.print.queue.${queue.state}`)}
      </p>
    ) : null;
  const queueButton =
    askQueue !== null ? (
      <Button
        size="floor"
        variant="secondary"
        {...press(() => {
          if (queue === "asking") return;
          setQueue("asking");
          void askQueue().then(setQueue, () => setQueue({ state: "unavailable" }));
        })}
      >
        {t("floor.print.queue.check")}
      </Button>
    ) : null;

  /** The SSCC as the cloud's dialogs show it: a quiet caption over the number in large digits. */
  const ssccBlock = (
    <p className="label-panel__sscc">
      <VisuallyHidden>{sscc}</VisuallyHidden>
      <span aria-hidden="true">
        {t(pallet ? "floor.print.pallet.ssccCaption" : "floor.print.ssccCaption")}
      </span>
      {/* The bare 18 digits, as the cloud shows them; grouped while a scan is awaited. */}
      <strong aria-hidden="true">{checking ? groupedSscc(job.sscc) : job.sscc}</strong>
    </p>
  );
  /**
   * One state of the label in the cloud station's full-screen print dialog layout
   * (BoxPrintRecovery, PalletClose, PrintVerification): the title with its main action across
   * the top, the label's words and its SSCC in the middle, the other actions at the bottom.
   * A pallet's label is announced as the cloud's «Паллета закрыта», its state said inside.
   */
  const dialog = (view: {
    tone: "info" | "warn" | "error";
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
    variant?: "verify";
  }) => (
    <div
      role="presentation"
      className={`work-screen__label label-panel label-panel--${view.tone}${
        view.variant === "verify" ? " label-panel--verify" : ""
      }`}
    >
      <header className="label-panel__header">
        <h2>{pallet ? t("floor.print.pallet.closed") : view.title}</h2>
        {view.headerAction}
      </header>
      <div className="label-panel__body">
        {pallet && <Alert tone={view.tone} role="presentation" title={view.title} />}
        {view.children}
      </div>
      {view.footer === undefined ? null : (
        <footer className="label-panel__footer">{view.footer}</footer>
      )}
    </div>
  );

  let body: ReactNode;
  if (mode.kind === "reason") {
    const target = targetText(t, job, settings, mode.printer, mayExist);
    body = dialog({
      tone: "warn",
      title: t("floor.print.reason.title"),
      children: (
        <>
          <p>{t(pallet ? "floor.print.pallet.reasonHint" : "floor.print.reason.hint")}</p>
          {ssccBlock}
          {target !== null && <p className="label-panel__target">{target}</p>}
          <div className="label-panel__choices work-screen__reasons">
            {REPRINT_REASONS.map((reason) => (
              <Button
                key={reason}
                size="floor"
                variant="secondary"
                {...press(() => {
                  show({ kind: "main" });
                  onPrintAgain({ reason, printer: mode.printer });
                })}
              >
                {t(`floor.print.reason.${reason}`)}
              </Button>
            ))}
          </div>
        </>
      ),
      footer: back,
    });
  } else if (mode.kind === "printers") {
    // A printer of A4 sheets (plan А4) is offered for a pallet's label only.
    const choices = mode.printers?.filter((printer) => printsPurpose(printer, job.purpose)) ?? null;
    body = dialog({
      tone: "warn",
      title: t("floor.print.printers.title"),
      children: (
        <>
          {ssccBlock}
          {choices !== null && choices.length === 0 && <p>{t("floor.print.printers.none")}</p>}
          <div className="label-panel__choices">
            {(choices ?? []).map((printer) => (
              <Button
                key={printer.id}
                size="floor"
                variant="secondary"
                {...press(() => again(printer))}
              >
                {t("floor.print.printers.option", {
                  name: printer.name,
                  language: printerFormatText(t, printer),
                  dpi: printer.dpi,
                })}
              </Button>
            ))}
          </div>
        </>
      ),
      footer: back,
    });
  } else if (mode.kind === "skip") {
    body = dialog({
      tone: "warn",
      title: t("floor.print.skipConfirm.title"),
      children: (
        <>
          <p>{t(pallet ? "floor.print.pallet.skipBody" : "floor.print.skipConfirm.body")}</p>
          {ssccBlock}
        </>
      ),
      footer: (
        <>
          {back}
          <Button
            size="floor"
            {...press(() => {
              show({ kind: "main" });
              onSkip();
            })}
          >
            {t("floor.print.skipConfirm.confirm")}
          </Button>
        </>
      ),
    });
  } else if (onRecover !== undefined) {
    // The send's end was not written and no send of this app holds the bytes:
    // nobody is going to answer. Only the operator's act (never an automatic one)
    // turns it into an unknown label to decide on.
    body = dialog({
      tone: "warn",
      title: t("floor.print.stalled.title"),
      children: (
        <>
          <p>{t("floor.print.stalled.body")}</p>
          {ssccBlock}
        </>
      ),
      footer: (
        <Button size="floor" {...press(onRecover)}>
          {t("floor.print.stalled.action")}
        </Button>
      ),
    });
  } else if (job.state === "prepared" || job.state === "sending") {
    // On its way to the printer, or a send whose answer is still to come: nothing
    // to decide yet (a restart reads a send left so as unknown).
    body = dialog({
      tone: "info",
      title: t("floor.print.pending.title"),
      children: (
        <>
          {ssccBlock}
          <p className="label-panel__waiting">
            <span aria-hidden="true" />
            {t("floor.print.pending.body")}
          </p>
        </>
      ),
    });
  } else if (checking) {
    body = dialog({
      tone: "info",
      variant: "verify",
      title: t("floor.print.check.title"),
      children: (
        <section className="label-panel__stage">
          <div className="label-panel__scanner" aria-hidden="true">
            <span />
          </div>
          <p className="label-panel__instruction">
            {t(pallet ? "floor.print.pallet.checkBody" : "floor.print.check.body")}
          </p>
          {ssccBlock}
          {note !== null ? (
            <p className="label-panel__note">{noteText(note, t, pallet)}</p>
          ) : (
            <p className="label-panel__waiting">
              <span aria-hidden="true" />
              {t("floor.print.check.waiting")}
            </p>
          )}
          {queueText}
        </section>
      ),
      footer: (
        <>
          <Button size="floor" variant="secondary" {...press(onSkip)}>
            {t("floor.print.check.skip")}
          </Button>
          {queueButton}
          <Button size="floor" {...press(() => again(null))}>
            {t("floor.print.printAgain")}
          </Button>
        </>
      ),
    });
  } else {
    const target = targetText(t, job, settings, null, mayExist);
    const unknown = job.state === "unknown";
    body = dialog({
      tone: unknown ? "warn" : "error",
      title: t(
        unknown
          ? "floor.print.unknownTitle"
          : pallet
            ? "floor.print.pallet.failedTitle"
            : "floor.print.failedTitle",
      ),
      headerAction: unknown ? (
        <Button size="floor" {...press(onPrinted)}>
          {t("floor.print.printed")}
        </Button>
      ) : (
        <Button size="floor" {...press(() => again(null))}>
          {t("floor.print.printAgain")}
        </Button>
      ),
      children: (
        <>
          {target !== null && <p className="label-panel__target">{target}</p>}
          <Button size="floor" variant="secondary" {...press(choosePrinter)}>
            {t("floor.print.otherPrinter")}
          </Button>
          {job.errorCode !== null && (
            <p className="label-panel__message">
              {pallet && job.errorCode === "printer_unconfigured"
                ? t("floor.print.pallet.printerUnconfigured")
                : t(`floor.print.codes.${job.errorCode}`)}
            </p>
          )}
          {ssccBlock}
          {note !== null && <p className="label-panel__note">{noteText(note, t, pallet)}</p>}
          {unknown && queueText}
        </>
      ),
      footer: (
        <>
          {unknown && queueButton}
          {unknown && (
            <Button size="floor" variant="secondary" {...press(() => again(null))}>
              {t("floor.print.printAgain")}
            </Button>
          )}
          {onSetup !== undefined && (
            <Button size="floor" variant="secondary" {...press(onSetup)}>
              {t("floor.print.setup")}
            </Button>
          )}
          <Button size="floor" variant="secondary" {...press(() => show({ kind: "skip" }))}>
            {t("floor.print.skip")}
          </Button>
        </>
      ),
    });
  }
  return (
    <div ref={root} tabIndex={-1} data-label-panel="" className="label-panel-root">
      {body}
    </div>
  );
}
