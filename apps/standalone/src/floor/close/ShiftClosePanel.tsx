import { SHIFT_CLOSE_REASON_CODES, type ShiftCloseReasonCode } from "@markiro/domain";
import type { TFunction } from "i18next";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import { VIEW_GUARD_MS } from "../print/LabelPanel.js";
import { formatQuantity } from "../shifts/shift-text.js";
import type { CloseBlocker, CloseSummary } from "./shift-close.js";
import "./shift-close.css";

/**
 * Why the summary is shown again: the shift changed meanwhile, no reason was
 * chosen, the write failed (and the shift was read back open), or the write
 * failed and the shift could not be read back at all (`unknown`: it may be closed).
 */
export type CloseNote = "stale" | "reason" | "failed" | "unknown";

/** What the closed shift's panel says of it: the figures of the record, or of the shift when its record was written unseen. */
export interface ClosedNumbers {
  actualQty: number;
  closedBoxCount: number;
}

const AVERAGE = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

/** Units per closed box, one decimal at most; `null` without boxes. */
export function averagePerBox(actualQty: number, closedBoxes: number): string | null {
  return closedBoxes === 0 ? null : AVERAGE.format(actualQty / closedBoxes);
}

/** The fact against the plan, signed: «+5», «−3», «0». */
export function deviation(plannedQty: number, actualQty: number): string {
  const difference = actualQty - plannedQty;
  const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
  return `${sign}${formatQuantity(Math.abs(difference))}`;
}

/**
 * Whether two readings of the summary say the same to the operator: the plan,
 * the fact, the closed boxes, whether a reason is needed, and what keeps the
 * shift open (the open box's codes and the open pallet's boxes included). A
 * close goes on the reading that was shown, never on another.
 */
export function sameSummary(shown: CloseSummary, read: CloseSummary): boolean {
  const a = shown.blocker;
  const b = read.blocker;
  const sameBlocker =
    a === null || b === null
      ? a === b
      : a.kind === b.kind &&
        (a.kind !== "open_box" || (b.kind === "open_box" && a.items === b.items)) &&
        // The question names the boxes of the open pallet (plan ПЛ-Ц): other boxes, another question.
        (a.kind !== "open_pallet" || (b.kind === "open_pallet" && a.boxes === b.boxes));
  return (
    shown.plannedQty === read.plannedQty &&
    shown.actualQty === read.actualQty &&
    shown.closedBoxes === read.closedBoxes &&
    shown.reasonRequired === read.reasonRequired &&
    sameBlocker
  );
}

const realClock = () => performance.now();

/**
 * What keeps the shift open, in words. Every blocker has its own: the `switch`
 * is exhaustive, so a blocker added to `CloseBlocker` fails to compile here
 * instead of being said with another one's words (the open pallet was once
 * said as «closed»).
 */
function blockerText(blocker: CloseBlocker, waitingSscc: string | null, t: TFunction): string {
  switch (blocker.kind) {
    case "open_box":
      return t("floor.close.blocked.open_box", { quantity: formatQuantity(blocker.items) });
    case "label":
      return waitingSscc === null
        ? t("floor.close.blocked.labelUnknown")
        : t("floor.close.blocked.label", { sscc: waitingSscc });
    case "label_unresolved":
      // A unit label of a shift that prints the duplicate (plan РЕЖ part B): the cloud's words.
      return t("floor.unitLabels.closeBlocked");
    case "open_pallet":
      return t("floor.close.blocked.open_pallet", { quantity: formatQuantity(blocker.boxes) });
    case "closed":
      return t("floor.close.blocked.closed");
    default: {
      const unsaid: never = blocker;
      return unsaid;
    }
  }
}

/** A button that is waiting for the write's answer: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

/**
 * The guard against a second tap (the label panel's and the exceptions'): a
 * press is ignored for `VIEW_GUARD_MS` after the panel changed its view — the
 * second tap of a gloved double tap on «Закрыть смену» lands on whatever the
 * summary put under the finger, and with the plan met that is «Подтвердить
 * закрытие», which cannot be taken back. The focus goes to the view itself,
 * never to a button.
 */
function useViewGuard<T extends HTMLElement>(view: string, clock: () => number) {
  const changedAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const viewRef = useRef<T>(null);
  useLayoutEffect(() => {
    changedAt.current = clock();
  }, [view, clock]);
  useEffect(() => {
    viewRef.current?.focus();
  }, [view]);
  /** Whether a press now is the operator's own and not the second of a double tap. */
  const settled = () => {
    const since = clock() - changedAt.current;
    return !(since >= 0 && since < VIEW_GUARD_MS);
  };
  return { viewRef, settled };
}

/**
 * The view the summary shows, which the guard and the focus follow: loading,
 * the summary (or what keeps the shift open), and each showing that brings a
 * new one — a summary read again lands under the finger that pressed the old
 * one, and two showings in a row may say the same, which only the `attempt`
 * tells apart.
 */
function viewOf(summary: CloseSummary | null, note: CloseNote | null, attempt: number): string {
  if (summary === null) return "loading";
  return `summary:${summary.blocker?.kind ?? "ready"}:${note ?? ""}:${attempt}`;
}

export interface ShiftClosePanelProps {
  number: string;
  productName: string;
  /** `null` while the summary is read. */
  summary: CloseSummary | null;
  note: CloseNote | null;
  /** How many times the summary has been shown again: each showing restarts the guard. */
  attempt: number;
  /** The SSCC of the label that keeps the shift open, when it is known. */
  waitingSscc: string | null;
  /** The close is being written: every button waits. */
  busy: boolean;
  onClose: (reason: ShiftCloseReasonCode | null) => void;
  /** Back to the work, never held but while the close writes. */
  onBack: () => void;
  /** To the label that waits: its panel decides it. */
  onLabel: () => void;
  /** Boxes per pallet of a shift with pallets (plan ПЛ-Ц); `null` — none. */
  palletCapacity?: number | null;
  /**
   * «Закрыть паллету и смену»: the open pallet first, then the shift with this
   * reason. Without it an open pallet only keeps the shift open.
   */
  onClosePallet?: (reason: ShiftCloseReasonCode | null) => void;
  /** Milliseconds from a clock that does not go back; the guard after a change of view reads it. */
  clock?: () => number;
  /** A validation shift (plan РЕЖ): its codes have no box, and the summary names none. */
  boxless?: boolean;
}

/**
 * The summary of a shift's close (stage 2a spec §5.7.7, the cloud station's
 * close summary): the shift's number and product, the plan, the fact, the
 * deviation, the closed boxes and the units per box, and what the press cannot
 * take back. A shift that cannot close yet says why — an open box with codes,
 * a label that waits, named by its SSCC — and sends the operator back to the
 * work, or to the label, where both are resolved. When the plan is given and
 * not met, one of the domain's six reasons is chosen from the buttons before
 * «Подтвердить закрытие». An open pallet with boxes (plan ПЛ-Ц) shows the
 * whole summary and asks «На паллете N из M коробов — закрыть?» under it, and
 * the close becomes «Закрыть паллету и смену», as at the cloud station; the
 * question names the counts, since the press closes the pallet, prints its
 * label and closes the shift, none of which can be taken back. It sits in the
 * work screen's polite region, so its alerts have no role of their own; the
 * work screen's «Выйти из смены» stays outside it, so nobody is held here.
 */
export function ShiftClosePanel({
  number,
  productName,
  summary,
  note,
  attempt,
  waitingSscc,
  busy,
  onClose,
  onBack,
  onLabel,
  palletCapacity = null,
  onClosePallet,
  clock = realClock,
  boxless = false,
}: ShiftClosePanelProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ShiftCloseReasonCode | null>(null);
  const { viewRef, settled } = useViewGuard<HTMLElement>(viewOf(summary, note, attempt), clock);
  /** Props of a button: while the close writes, or just after the view changed, a press does nothing. */
  const press = (action: () => void) => ({
    "aria-disabled": busy ? true : undefined,
    style: busy ? WAITING_STYLE : undefined,
    onClick: () => {
      if (busy || !settled()) return;
      action();
    },
  });
  const back = (
    <Button size="floor" variant="secondary" {...press(onBack)}>
      {t("floor.close.back")}
    </Button>
  );
  const body = () => {
    if (summary === null) {
      return (
        <>
          <p className="shift-close__loading">{t("floor.close.loading")}</p>
          <div className="shift-close__actions">{back}</div>
        </>
      );
    }
    // An open pallet that «Закрыть паллету и смену» can close is asked about under
    // the summary; without that button it only keeps the shift open, like any blocker.
    const openPallet = summary.blocker?.kind === "open_pallet" ? summary.blocker : null;
    const palletAsked =
      openPallet !== null && onClosePallet !== undefined && palletCapacity !== null;
    if (summary.blocker !== null && !palletAsked) {
      const { blocker } = summary;
      return (
        <>
          <Alert tone="warn" role="presentation" title={t("floor.close.blockedTitle")}>
            <p>{blockerText(blocker, waitingSscc, t)}</p>
          </Alert>
          <div className="shift-close__actions">
            {back}
            {(blocker.kind === "label" || blocker.kind === "label_unresolved") && (
              <Button size="floor" {...press(onLabel)}>
                {t("floor.close.toLabel")}
              </Button>
            )}
          </div>
        </>
      );
    }
    const average = averagePerBox(summary.actualQty, summary.closedBoxes);
    const chosen = summary.reasonRequired ? reason : null;
    return (
      <>
        <dl className="shift-close__facts">
          <div>
            <dt>{t("floor.close.product")}</dt>
            <dd>{productName}</dd>
          </div>
          <div>
            <dt>{t("floor.close.plan")}</dt>
            <dd>
              {summary.plannedQty === null
                ? t("floor.close.noPlan")
                : formatQuantity(summary.plannedQty)}
            </dd>
          </div>
          <div>
            <dt>{t("floor.close.actual")}</dt>
            <dd>{formatQuantity(summary.actualQty)}</dd>
          </div>
          {summary.plannedQty !== null && (
            <div>
              <dt>{t("floor.close.deviation")}</dt>
              <dd>{deviation(summary.plannedQty, summary.actualQty)}</dd>
            </div>
          )}
          {!boxless && (
            <>
              <div>
                <dt>{t("floor.close.boxes")}</dt>
                <dd>{formatQuantity(summary.closedBoxes)}</dd>
              </div>
              <div>
                <dt>{t("floor.close.average")}</dt>
                <dd>{average ?? t("floor.close.none")}</dd>
              </div>
            </>
          )}
        </dl>
        {summary.plannedQty !== null && (
          <p
            className="shift-close__result"
            data-tone={
              summary.actualQty === summary.plannedQty
                ? "ok"
                : summary.actualQty < summary.plannedQty
                  ? "warn"
                  : "info"
            }
          >
            {summary.actualQty === summary.plannedQty
              ? t("floor.close.result.met")
              : summary.actualQty < summary.plannedQty
                ? t("floor.close.result.short", {
                    quantity: formatQuantity(summary.plannedQty - summary.actualQty),
                  })
                : t("floor.close.result.over", {
                    quantity: formatQuantity(summary.actualQty - summary.plannedQty),
                  })}
          </p>
        )}
        {summary.reasonRequired && (
          <div
            className="shift-close__reasons"
            role="group"
            aria-label={t("floor.close.reasonTitle")}
          >
            <p className="shift-close__reasons-title">{t("floor.close.reasonTitle")}</p>
            {/* The cloud's floor choices: every reason a visible 64 px target, two to a row. */}
            <div className="floor-choice-group">
              {SHIFT_CLOSE_REASON_CODES.map((code) => (
                <Button
                  key={code}
                  size="floor"
                  variant="secondary"
                  className="floor-choice"
                  data-checked={reason === code ? "true" : undefined}
                  aria-pressed={reason === code}
                  {...press(() => setReason(code))}
                >
                  {/* The chosen reason is marked by a sign too, not by its colour alone. */}
                  <span aria-hidden="true" className="floor-choice__mark">
                    {reason === code ? "✓" : ""}
                  </span>
                  <span className="floor-choice__label">{t(`floor.close.reasons.${code}`)}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
        <p className="shift-close__note">{t("floor.close.irreversible")}</p>
        {palletAsked && (
          <Alert
            tone="warn"
            role="presentation"
            title={t("floor.close.palletOpen", {
              quantity: formatQuantity(openPallet.boxes),
              capacity: formatQuantity(palletCapacity),
            })}
          >
            <p>{t("floor.close.palletIrreversible")}</p>
          </Alert>
        )}
        <div className="shift-close__actions">
          {back}
          <Button
            size="floor"
            disabled={summary.reasonRequired && chosen === null}
            {...press(() => (palletAsked ? onClosePallet(chosen) : onClose(chosen)))}
          >
            {t(palletAsked ? "floor.close.confirmPallet" : "floor.close.confirm")}
          </Button>
        </div>
      </>
    );
  };
  return (
    <section
      className="shift-close"
      aria-label={t("floor.close.title", { number })}
      tabIndex={-1}
      ref={viewRef}
    >
      <h3>{t("floor.close.title", { number })}</h3>
      {note !== null && (
        <Alert
          tone={note === "failed" ? "error" : "warn"}
          role="presentation"
          title={t(`floor.close.notes.${note}`)}
        />
      )}
      {busy && (
        <p className="work-screen__waiting">
          {t(
            summary?.blocker?.kind === "open_pallet"
              ? "floor.close.closingPallet"
              : "floor.close.closing",
          )}
        </p>
      )}
      {body()}
    </section>
  );
}

export interface ShiftClosedPanelProps {
  number: string;
  record: ClosedNumbers;
  /** The link to the host is held until the operator leaves: the data goes later. */
  linkHeld: boolean;
  /** The floor waits for the work to end before it leaves the shift. */
  leaving: boolean;
  onDone: () => void;
  /** Milliseconds from a clock that does not go back; the guard after a change of view reads it. */
  clock?: () => number;
  /** A validation shift (plan РЕЖ): the numbers name its codes and no box. */
  boxless?: boolean;
}

/**
 * The shift closed on this station: the same words with the link and without
 * it (stage 2a spec §5.7.7) — the record waits in the outbox until the host
 * takes it — and the way back to the list. It is the end of the shift's work
 * screen: nothing here takes a scan, and the way out is never held.
 */
export function ShiftClosedPanel({
  number,
  record,
  linkHeld,
  leaving,
  onDone,
  clock = realClock,
  boxless = false,
}: ShiftClosedPanelProps) {
  const { t } = useTranslation();
  const { viewRef, settled } = useViewGuard<HTMLDivElement>("closed", clock);
  const title = t("floor.close.done.title", { number });
  return (
    <div role="group" aria-label={title} tabIndex={-1} ref={viewRef} className="shift-close">
      <Alert tone="ok" role="presentation" className="shift-close__done" title={title}>
        <p>{t("floor.close.done.body")}</p>
        <p>
          {boxless
            ? t("floor.validation.closedNumbers", { quantity: formatQuantity(record.actualQty) })
            : t("floor.close.done.numbers", {
                quantity: formatQuantity(record.actualQty),
                boxes: formatQuantity(record.closedBoxCount),
              })}
        </p>
        {linkHeld && <p>{t("floor.close.done.held")}</p>}
      </Alert>
      <div className="shift-close__actions">
        <Button
          size="floor"
          aria-disabled={leaving ? true : undefined}
          style={leaving ? WAITING_STYLE : undefined}
          onClick={() => {
            if (leaving || !settled()) return;
            onDone();
          }}
        >
          {t("floor.close.done.toList")}
        </Button>
      </div>
    </div>
  );
}
