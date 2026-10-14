import type { ReprintReason } from "@markiro/domain";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, FullScreenDialog } from "@markiro/ui";

import { REPRINT_REASONS } from "../../host/protocol.js";
import { VIEW_GUARD_MS } from "../print/LabelPanel.js";
import type { UnitLabelEntry } from "./unit-label-store.js";
import { unitLabelStatus } from "./unit-label-work.js";
import { unitLabelStatusKey, unitLabelSuffix } from "./UnitLabelPanel.js";
import "./unit-labels.css";

/**
 * Where the operator finds the shift of another shift's label: in the list of this station's line
 * (`listed`: «Вернитесь к выбору смены» leads to it), on another line (`other_line`: the office
 * moved the station after the label), or in no list at all (`unavailable`: no copy of the shift is
 * left, or the list does not show it any more). Only the office can help in the last two.
 */
export type AnotherShiftReach = "listed" | "other_line" | "unavailable";

/**
 * What the window of a unit label stands for: the station's unresolved label of this shift
 * (`job`), another shift's (`another_shift`: no unit is taken here; the label, its shift's
 * number from the station's copy — `null` when none is left — and where that shift is found),
 * no duplicate printer assigned (`printer`), or the label's job not read or written (`storage`).
 */
export type UnitLabelWindow =
  | { kind: "job"; job: UnitLabelEntry }
  | {
      kind: "another_shift";
      job: UnitLabelEntry;
      number: string | null;
      reach: AnotherShiftReach;
    }
  | { kind: "printer" }
  | { kind: "storage" };

/**
 * What the window says under the label: a scan that is not its label, a decision not saved
 * (`failed`), or not saved because this station closed the label's shift (`shift_closed`).
 */
export type UnitLabelNote = "mismatch" | "invalid" | "failed" | "shift_closed";

/** A button that waits for a decision's answer: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

const realClock = () => performance.now();

/**
 * Presses guarded as the box label's panel guards them (`VIEW_GUARD_MS`): while a decision
 * runs, and for a moment after the view changed, a press does nothing, so a gloved double tap
 * never lands on what the new view put under the finger.
 */
function useGuard(view: string, busy: boolean, clock: () => number) {
  const changedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (shown.current === view) return;
    // The first view of the window is guarded too: the tap that opened it may come twice.
    shown.current = view;
    changedAt.current = clock();
  }, [view, clock]);
  return (action: () => void) => ({
    "aria-disabled": busy ? true : undefined,
    style: busy ? WAITING_STYLE : undefined,
    onClick: () => {
      if (busy) return;
      const since = clock() - changedAt.current;
      if (since >= 0 && since < VIEW_GUARD_MS) return;
      action();
    },
  });
}

export interface UnitLabelReprintReasonProps {
  busy: boolean;
  onConfirm: (reason: ReprintReason) => void;
  onBack: () => void;
  /** How many scans the window refused while it stood (see `UnitLabelVerificationProps`). */
  refused?: number;
  clock?: () => number;
}

/**
 * A scan the window refused, said where the operator looks (the cloud only drops it): announced,
 * and again for every next refusal (`count` remounts it). Nothing for none.
 */
function RefusedScan({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return <Alert key={count} tone="error" title={t("floor.unitLabels.refused")} />;
}

/**
 * «Повторная печать этикетки» (the cloud station's `ProductLabelReprintReason`): the reason is
 * chosen first — each a 64 px floor choice, the chosen one marked by a sign as well as its
 * colour — and «Напечатать повторно» prints the label again with it; nothing prints before.
 */
export function UnitLabelReprintReason({
  busy,
  onConfirm,
  onBack,
  refused = 0,
  clock = realClock,
}: UnitLabelReprintReasonProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReprintReason | null>(null);
  const press = useGuard("reason", busy, clock);
  const confirm = press(() => {
    if (reason !== null) onConfirm(reason);
  });
  return (
    <FullScreenDialog
      open
      title={t("floor.unitLabels.reprintTitle")}
      backLabel={t("floor.unitLabels.back")}
      backPlacement="footer"
      backDisabled={busy}
      onClose={onBack}
      initialFocus="dialog"
      className="unit-label-window"
      footer={
        <Button
          size="floor"
          {...confirm}
          aria-disabled={busy || reason === null ? true : undefined}
          style={busy || reason === null ? WAITING_STYLE : undefined}
        >
          {t("floor.unitLabels.reprint")}
        </Button>
      }
    >
      <div className="unit-label-window__body">
        <RefusedScan count={refused} />
        <div className="unit-label-reasons" role="group" aria-labelledby="unit-label-reason-hint">
          <p id="unit-label-reason-hint">{t("floor.unitLabels.reasonHint")}</p>
          <div className="unit-label-reasons__choices">
            {REPRINT_REASONS.map((value) => (
              <Button
                key={value}
                size="floor"
                variant="secondary"
                className="unit-label-reasons__choice"
                data-checked={reason === value ? "true" : undefined}
                aria-pressed={reason === value}
                {...press(() => setReason(value))}
              >
                <span aria-hidden="true" className="unit-label-reasons__mark">
                  {reason === value ? "✓" : ""}
                </span>
                <span>{t(`floor.unitLabels.reasons.${value}`)}</span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </FullScreenDialog>
  );
}

export interface UnitLabelVerificationProps {
  view: UnitLabelWindow;
  note: UnitLabelNote | null;
  /**
   * How many scans the window refused in this view (a scan that checks no label: a new unit, one
   * while a decision runs or while the reasons are open); 0 — none. Said in the window in words.
   */
  refused: number;
  /** A decision or a check is being saved, or the leave waits: every button waits. */
  busy: boolean;
  /**
   * A decision or a send runs: «Пауза» waits, and the status line says the result is being
   * saved («Сохраняем результат…»). Not while the leave waits, which keeps «Пауза» on the
   * keyboard (a press then does nothing).
   */
  running: boolean;
  /** The office closed the shift: the label is finished, no new unit (no skip, as the cloud's). */
  closed: boolean;
  /** «Пауза»: out of the shift, the label kept for the next entry. */
  onPause: () => void;
  onSkip: () => void;
  onReprint: (reason: ReprintReason) => void;
  /** «Отправить сохранённую этикетку»: the first send of a label prepared before a restart. */
  onSendPrepared: () => void;
  /** «Повторить»: the label read again (a send the app lost becomes unknown first). */
  onRetry: () => void;
  /** «Настройки принтера»: the workstation; none — no button. */
  onSetup?: () => void;
  /**
   * Told whether the reprint's reasons are open: the work screen checks no label meanwhile (the
   * cloud pauses its verification), and refuses the scan in words. Told `false` when they close,
   * when the window's view changes under them, and when the window goes.
   */
  onReasonOpen?: (open: boolean) => void;
  clock?: () => number;
}

/**
 * The window of the station's unresolved unit label (plan РЕЖ part B, task B6; the cloud
 * station's `ProductLabelVerification`): a full-screen dialog over the work, which takes the
 * focus and keeps it (`FullScreenDialog`), as long as the label is not resolved. The floor's
 * scanner stays with the work screen, which hands it the printed label's scan; this window only
 * says the state in words and holds the operator's decisions: the check skipped (only after the
 * label went to the printer, never in a shift the office closed), the label printed again with a
 * reason, a label prepared before a restart sent, the workstation when no duplicate printer
 * prints it, and «Пауза» — out of the shift, the label kept.
 */
export function UnitLabelVerification({
  view,
  note,
  refused,
  busy,
  running,
  closed,
  onPause,
  onSkip,
  onReprint,
  onSendPrepared,
  onRetry,
  onSetup,
  onReasonOpen,
  clock = realClock,
}: UnitLabelVerificationProps) {
  const { t } = useTranslation();
  const job = view.kind === "job" ? view.job : null;
  const status = job === null ? null : unitLabelStatus(job);
  const awaiting = status === "awaiting_verification";
  const viewKey =
    job !== null
      ? `${job.id}:${job.attemptNo}:${job.attemptState}:${job.verification}`
      : view.kind === "another_shift"
        ? `${view.kind}:${view.job.id}:${view.reach}`
        : view.kind;
  // The reasons belong to the view they were opened in: a view that changes under them (another
  // label, or this one moved on) closes them, so a reason is never given for what is not shown.
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const reasonOpen = job !== null && reasonFor === viewKey;
  useLayoutEffect(() => {
    onReasonOpen?.(reasonOpen);
  }, [reasonOpen, onReasonOpen]);
  useLayoutEffect(() => () => onReasonOpen?.(false), [onReasonOpen]);
  const press = useGuard(viewKey, busy, clock);
  // The button pressed may be gone with the view it was in: the focus goes back to the window
  // itself, which decides nothing, never to a button a second press would activate.
  const body = useRef<HTMLDivElement>(null);
  const viewShown = useRef(viewKey);
  useLayoutEffect(() => {
    if (viewShown.current === viewKey) return;
    viewShown.current = viewKey;
    const dialog = body.current?.closest<HTMLElement>('[role="dialog"]');
    if (dialog !== null && dialog !== undefined && !dialog.contains(document.activeElement)) {
      dialog.focus();
    }
  }, [viewKey]);

  if (reasonOpen) {
    return (
      <UnitLabelReprintReason
        busy={busy}
        refused={refused}
        clock={clock}
        onBack={() => setReasonFor(null)}
        onConfirm={(reason) => {
          setReasonFor(null);
          onReprint(reason);
        }}
      />
    );
  }

  const title =
    view.kind === "printer"
      ? t("floor.unitLabels.printerSetup")
      : view.kind === "storage"
        ? t("floor.unitLabels.storageError")
        : view.kind === "another_shift"
          ? t("floor.unitLabels.title")
          : awaiting
            ? t("floor.unitLabels.scanTitle")
            : t(unitLabelStatusKey(job));
  const instruction =
    job === null
      ? null
      : closed
        ? "floor.unitLabels.closedHint"
        : job.attemptState === "delivery_unknown"
          ? "floor.unitLabels.unknownHint"
          : job.attemptState === "prepared"
            ? "floor.unitLabels.preparedHint"
            : job.attemptState === "failed_before_send"
              ? "floor.unitLabels.failedHint"
              : "floor.unitLabels.scanHint";
  // The printed label's scan settles a required check after the send, and an unknown outcome.
  const scanned = awaiting || job?.attemptState === "delivery_unknown";
  const labelled = job ?? (view.kind === "another_shift" ? view.job : null);
  const suffix = labelled === null ? "" : unitLabelSuffix(labelled);
  // Another shift's label: which shift (its number from the station's copy) and which label.
  const code =
    view.kind === "another_shift" && view.number !== null
      ? t("floor.unitLabels.anotherShiftNumber", { number: view.number, suffix })
      : suffix === ""
        ? null
        : `…${suffix}`;
  const alert =
    view.kind === "printer"
      ? t("floor.unitLabels.failedHint")
      : note === "shift_closed"
        ? t("floor.unitLabels.shiftClosed")
        : view.kind === "storage" || note === "failed"
          ? t("floor.unitLabels.storageError")
          : view.kind === "another_shift"
            ? t(
                view.reach === "listed"
                  ? "floor.unitLabels.anotherShift"
                  : view.reach === "other_line"
                    ? "floor.unitLabels.anotherShiftLine"
                    : "floor.unitLabels.anotherShiftGone",
              )
            : null;

  let main: ReactNode;
  if (job === null || job.attemptState === "sending") {
    // Nothing to decide here but to read the label again: a send the app lost becomes unknown.
    main = (
      <Button key="retry" size="floor" {...press(onRetry)}>
        {t("floor.unitLabels.retry")}
      </Button>
    );
  } else if (job.attemptState === "prepared") {
    main = (
      <Button key="send-prepared" size="floor" {...press(onSendPrepared)}>
        {t("floor.unitLabels.sendPrepared")}
      </Button>
    );
  } else {
    main = (
      <Button
        // One node per action: a view that changes the action never leaves the focus on it.
        key={awaiting ? "label-problem" : "reprint"}
        size="floor"
        {...press(() => setReasonFor(viewKey))}
      >
        {t(awaiting ? "floor.unitLabels.labelProblem" : "floor.unitLabels.reprint")}
      </Button>
    );
  }
  const setup =
    onSetup !== undefined &&
    (view.kind === "printer" || job?.attemptState === "failed_before_send") ? (
      <Button size="floor" variant="secondary" {...press(onSetup)}>
        {t("floor.unitLabels.printerSetup")}
      </Button>
    ) : null;

  return (
    <FullScreenDialog
      open
      title={title}
      backLabel={t("floor.unitLabels.pause")}
      backPlacement="footer"
      backDisabled={running}
      onClose={onPause}
      initialFocus="dialog"
      className={`unit-label-window${awaiting ? " unit-label-window--awaiting" : ""}`}
      footer={
        <>
          {main}
          {awaiting && !closed && (
            <Button size="floor" variant="secondary" {...press(onSkip)}>
              {t("floor.unitLabels.skip")}
            </Button>
          )}
          {setup}
        </>
      }
    >
      <div className="unit-label-window__body" ref={body}>
        {instruction !== null && <p className="unit-label-window__instruction">{t(instruction)}</p>}
        {code !== null && <p className="unit-label-window__code">{code}</p>}
        {(note === "mismatch" || note === "invalid") && (
          <Alert tone="error" title={t(`floor.unitLabels.${note}`)} />
        )}
        {alert !== null && <Alert tone="error" title={alert} />}
        <RefusedScan count={refused} />
        {awaiting && !closed && (
          <p className="unit-label-window__skip-hint">{t("floor.unitLabels.skipHint")}</p>
        )}
        {/*
          Always in the window, so that its words are announced (the cloud's status line): the
          result being saved while a decision or a send runs, and the printed label's scan only
          where that scan checks it.
        */}
        <p className="unit-label-window__waiting" role="status">
          {running
            ? t("floor.unitLabels.saving")
            : scanned && !busy
              ? t("floor.unitLabels.waitScan")
              : ""}
        </p>
      </div>
    </FullScreenDialog>
  );
}
