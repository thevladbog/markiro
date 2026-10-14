import type { ReprintReason } from "@markiro/domain";
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { UnitLabelEntry } from "./unit-label-store.js";
import { unitLabelStatusKey, unitLabelSuffix } from "./UnitLabelPanel.js";
import { UnitLabelReprintReason } from "./UnitLabelVerification.js";
import "./unit-labels.css";

/** A button that waits: on the keyboard still, and a press that does nothing. */
const WAITING_STYLE: CSSProperties = { opacity: 0.45, cursor: "not-allowed" };

export interface UnitLabelHistoryProps {
  /** The shift's labels, newest first; `null` while they are read. */
  entries: readonly UnitLabelEntry[] | null;
  /**
   * The list could not be read or a reprint was not done (`failed`), or a reprint was refused
   * because this station closed the shift (`shift_closed`); `null` — nothing failed.
   */
  failure: "failed" | "shift_closed" | null;
  /** A decision is being saved. */
  busy: boolean;
  /**
   * The station has an unresolved label: no other label is printed again while it waits (one
   * at a time, as the cloud's `canAccept`), and one on its way is not either.
   */
  blocked: boolean;
  /**
   * The office closed the shift (finish mode): no label is printed again, as the cloud holds its
   * reprint in a closed shift (`canAccept`), and the history says so.
   */
  closed: boolean;
  onReprint: (jobId: string, reason: ReprintReason) => void;
  onBack: () => void;
  clock?: () => number;
}

/**
 * «История этикеток» (plan РЕЖ part B, task B6; the cloud station's `ProductLabelHistory`): in a
 * shift that prints the duplicate it stands where an aggregation shift has «Исключения». Each
 * label of the shift — its code's end, its state in words and its attempt — can be printed
 * again with a reason, which asks the reason first (`UnitLabelReprintReason`); the work screen
 * sends it and closes the history. Not while a decision is saved, an unresolved label waits, the
 * office closed the shift, or the label itself waits for its send or is on its way.
 */
export function UnitLabelHistory({
  entries,
  failure,
  busy,
  blocked,
  closed,
  onReprint,
  onBack,
  clock,
}: UnitLabelHistoryProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  if (selected !== null) {
    return (
      <UnitLabelReprintReason
        busy={busy}
        {...(clock === undefined ? {} : { clock })}
        onBack={() => setSelected(null)}
        onConfirm={(reason) => {
          setSelected(null);
          onReprint(selected, reason);
        }}
      />
    );
  }
  return (
    <section className="unit-label-history" aria-labelledby="unit-label-history-title">
      <h2 id="unit-label-history-title">{t("floor.unitLabels.history")}</h2>
      {closed && (
        <p className="unit-label-history__closed">{t("floor.unitLabels.closedHistory")}</p>
      )}
      {failure !== null && (
        <Alert
          tone="error"
          title={t(
            failure === "shift_closed"
              ? "floor.unitLabels.shiftClosed"
              : "floor.unitLabels.reprintFailed",
          )}
        />
      )}
      {entries !== null && entries.length === 0 && failure === null && (
        <p className="unit-label-history__empty">{t("floor.unitLabels.emptyHistory")}</p>
      )}
      {entries !== null && entries.length > 0 && (
        // The one part of the history that scrolls: on the keyboard too, named by its heading.
        <ul
          className="unit-label-history__rows"
          aria-labelledby="unit-label-history-title"
          tabIndex={0}
        >
          {entries.map((job) => {
            const held =
              busy ||
              blocked ||
              closed ||
              job.attemptState === "prepared" ||
              job.attemptState === "sending";
            return (
              <li className="unit-label-history__row" key={job.id}>
                <code>…{unitLabelSuffix(job)}</code>
                <span>
                  {t(unitLabelStatusKey(job))} ·{" "}
                  {t("floor.unitLabels.attempt", { number: job.attemptNo })}
                </span>
                <Button
                  size="floor"
                  variant="secondary"
                  aria-disabled={held ? true : undefined}
                  style={held ? WAITING_STYLE : undefined}
                  onClick={() => {
                    if (!held) setSelected(job.id);
                  }}
                >
                  {t("floor.unitLabels.reprint")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="unit-label-history__actions">
        <Button size="floor" variant="secondary" onClick={onBack}>
          {t("floor.unitLabels.back")}
        </Button>
      </div>
    </section>
  );
}
