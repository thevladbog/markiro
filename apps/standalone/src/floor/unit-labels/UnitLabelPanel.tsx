import { canonicalizeKm } from "@markiro/domain";
import { useTranslation } from "react-i18next";

import type { UnitLabelEntry } from "./unit-label-store.js";
import { unitLabelStatus } from "./unit-label-work.js";
import "./unit-labels.css";

/** What the screens say of a job: its attempt, its check, and the code it prints. */
export type UnitLabelShown = Pick<
  UnitLabelEntry,
  "id" | "attemptNo" | "attemptState" | "verificationPolicy" | "verification" | "fields"
>;

/**
 * The key of a job's state in words (the cloud station's `productLabelStatusKey`): none yet,
 * its check done or skipped, sent with no check left, waiting for its check, an unknown
 * outcome, a send that did not leave, or on its way.
 */
export function unitLabelStatusKey(job: UnitLabelShown | null): string {
  if (job === null) return "floor.unitLabels.waiting";
  if (job.verification === "verified") return "floor.unitLabels.verified";
  if (job.verification === "skipped") return "floor.unitLabels.skipped";
  const status = unitLabelStatus(job);
  if (status === "completed") return "floor.unitLabels.sent";
  if (status === "awaiting_verification") return "floor.unitLabels.verify";
  if (job.attemptState === "delivery_unknown") return "floor.unitLabels.unknown";
  if (job.attemptState === "failed_before_send") return "floor.unitLabels.failedBeforeSend";
  return "floor.unitLabels.printing";
}

/**
 * The last six characters of the code's serial, as the cloud shows a label (`codeSuffix`): the
 * operator tells two labels apart, and the full code stays off the screen. Empty when the
 * job's fields hold no readable code.
 */
export function unitLabelSuffix(job: Pick<UnitLabelEntry, "fields">): string {
  const code = job.fields["km.code"];
  if (code === undefined) return "";
  try {
    return Array.from(canonicalizeKm(code).serial).slice(-6).join("");
  } catch {
    return "";
  }
}

export interface UnitLabelPanelProps {
  /** The shift's current label: the unresolved one, else the newest; `null` — none yet. */
  job: UnitLabelShown | null;
  /** A label is on its way or a decision is being saved. */
  busy: boolean;
  /** The check the shift froze in its snapshot: said before the first scan too. */
  verification: "none" | "required";
}

/**
 * The instrument of a validation shift that prints the Data Matrix duplicate (plan РЕЖ part B,
 * task B6; the cloud station's `ProductLabelInstrument`), under the validation panel: the
 * current label's state in words and its code's end, and whether the next unit waits for the
 * printed label's check. The check is the snapshot's even before any label (the cloud's
 * acceptance found its panel said the job's alone, so nothing before the first scan).
 */
export function UnitLabelPanel({ job, busy, verification }: UnitLabelPanelProps) {
  const { t } = useTranslation();
  const suffix = job === null ? "" : unitLabelSuffix(job);
  const policy = job?.verificationPolicy ?? verification;
  return (
    <section className="work-instrument work-unit-label" aria-labelledby="work-unit-label-title">
      <h2 id="work-unit-label-title">{t("floor.unitLabels.title")}</h2>
      <div className="work-unit-label__readout" role="status">
        <strong>{t(busy ? "floor.unitLabels.saving" : unitLabelStatusKey(job))}</strong>
        {suffix !== "" && <code>…{suffix}</code>}
      </div>
      <p className="work-unit-label__hint">
        {t(policy === "none" ? "floor.unitLabels.noneHint" : "floor.unitLabels.requiredHint")}
      </p>
    </section>
  );
}
