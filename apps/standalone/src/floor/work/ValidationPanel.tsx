import { useTranslation } from "react-i18next";

import { formatQuantity } from "../shifts/shift-text.js";
import { OfCount, type LastTone } from "./WorkInstruments.js";

/** One outcome of the panel's list: when, in words, and its tone. */
export interface ValidationOutcome {
  /** Unique within the screen's life: the list's key. */
  id: number;
  /** The time it was said, on this computer's clock («06:15:02»). */
  time: string;
  text: string;
  tone: LastTone;
}

export interface ValidationPanelProps {
  /** Codes this station holds in the shift: its actual quantity. */
  accepted: number;
  /** Codes refused as taken already, here or on the host. */
  duplicates: number;
  /** Codes of another product and scans that are no code of marking. */
  errors: number;
  plannedQty: number | null;
  /** The last outcomes of this entry, newest first. */
  outcomes: readonly ValidationOutcome[];
}

/**
 * The instrument of a validation shift (plan РЕЖ, A7), where an aggregation shift has its box:
 * the accepted codes against the plan, the refused ones by kind, and the last outcomes in words
 * (the cloud station's validation view: its scan result and its recent operations with their
 * counts). Built from the work screen's instruments; it has no action of its own — the floor's
 * scanner is its input, and the footer's «Закрыть смену» its end.
 */
export function ValidationPanel({
  accepted,
  duplicates,
  errors,
  plannedQty,
  outcomes,
}: ValidationPanelProps) {
  const { t } = useTranslation();
  const unit = t("floor.validation.unit");
  return (
    <section className="work-instrument work-validation" aria-labelledby="work-validation-title">
      <div className="work-box-fill__head">
        <h2 id="work-validation-title">{t("floor.validation.title")}</h2>
        {plannedQty === null ? (
          <strong className="work-validation__count">
            <span className="work-of-count__number">{formatQuantity(accepted)}</span>{" "}
            <span className="work-of-count__word">{unit}</span>
          </strong>
        ) : (
          <OfCount
            className="work-validation__count"
            quantity={accepted}
            capacity={plannedQty}
            unit={unit}
          />
        )}
      </div>
      <p className="work-validation__hint">{t("floor.validation.hint")}</p>
      <dl className="work-validation__figures">
        <div>
          <dt>{t("floor.validation.duplicates")}</dt>
          <dd>{formatQuantity(duplicates)}</dd>
        </div>
        <div>
          <dt>{t("floor.validation.errors")}</dt>
          <dd>{formatQuantity(errors)}</dd>
        </div>
      </dl>
      <h3 id="work-validation-recent">{t("floor.validation.recent")}</h3>
      {outcomes.length === 0 ? (
        <p className="work-validation__empty">{t("floor.validation.recentEmpty")}</p>
      ) : (
        <ol className="work-validation__recent" aria-labelledby="work-validation-recent">
          {outcomes.map((outcome) => (
            <li key={outcome.id} data-verdict={outcome.tone}>
              <span className="work-validation__time">{outcome.time}</span>
              <span className="work-validation__word">{outcome.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
