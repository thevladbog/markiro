import { canonicalizeKm } from "@markiro/domain";
import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

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

/** The state of one step of the duplicate: done, waiting its turn, in hand, or stopped. */
export type DuplicateStepState = "ready" | "pending" | "current" | "error";

export interface DuplicateSteps {
  /** «Код принят», «Этикетка напечатана», «Проверка этикетки», in this order. */
  steps: readonly [DuplicateStepState, DuplicateStepState, DuplicateStepState];
  /** The check is switched off in the shift's snapshot: the third step says so and is not asked. */
  checkOff: boolean;
}

/**
 * The three steps of a duplicate, derived from the job's own state — the state machine itself
 * (`unitLabelStatus`, the attempt and the check) is not touched:
 * - no job: all three wait for the first scan;
 * - «Код принят»: ready as soon as the job exists (the unit's code is taken with its job);
 * - «Этикетка напечатана»: ready once the label was sent or its check is done; in hand while the
 *   job is prepared or sending, or a send or a decision is saved (`busy`); stopped when the send
 *   did not leave (`failed_before_send`) or its outcome is unknown (`delivery_unknown`) and the
 *   check has not settled it;
 * - «Проверка этикетки»: ready when verified or skipped; in hand while the sent label waits for
 *   its check; waiting before that; not asked (`checkOff`) when the shift's policy is none.
 */
export function duplicateSteps(
  job: UnitLabelShown | null,
  busy: boolean,
  policy: "none" | "required",
): DuplicateSteps {
  const checkOff = policy === "none";
  if (job === null) return { steps: ["pending", "pending", "pending"], checkOff };
  const checked = job.verification === "verified" || job.verification === "skipped";
  let printed: DuplicateStepState;
  if (checked || job.attemptState === "sent") printed = "ready";
  else if (job.attemptState === "failed_before_send" || job.attemptState === "delivery_unknown") {
    printed = busy ? "current" : "error";
  } else printed = "current";
  let check: DuplicateStepState;
  if (checked) check = "ready";
  else if (printed === "ready" && !checkOff) check = "current";
  else check = "pending";
  return { steps: ["ready", printed, check], checkOff };
}

export interface UnitLabelPanelProps {
  /** The shift's current label: the unresolved one, else the newest; `null` — none yet. */
  job: UnitLabelShown | null;
  /** A label is on its way or a decision is being saved. */
  busy: boolean;
  /** The check the shift froze in its snapshot: said before the first scan too. */
  verification: "none" | "required";
  /** The error step's recovery: the label read again (`unit.retry`). */
  onRecover?: () => void;
}

const STEP_KEYS = ["accepted", "printed", "checked"] as const;

function StepGlyph({ state }: { state: DuplicateStepState }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="work-unit-label__glyph"
    >
      {state === "ready" && <path d="m6 15 6 6 11-12" />}
      {state === "error" && <path d="m8 8 12 12M20 8 8 20" />}
      {state === "current" && <circle cx="14" cy="14" r="5" fill="currentColor" />}
      {state === "pending" && <circle cx="14" cy="14" r="8" strokeDasharray="3 4" />}
    </svg>
  );
}

/**
 * «Дубликат Data Matrix», the instrument of a validation shift that prints the duplicate (plan РЕЖ
 * part B, task B6; the cloud station's `ProductLabelInstrument`), under the last scan: three
 * vertical steps (kit step C), each ready, waiting, in hand or stopped (with its recovery action),
 * and one line of the label's state in words with its code's end. Whether the next unit waits for
 * the printed label's check is said in the third step and to a screen reader. The check is the
 * snapshot's even before any label (the cloud's acceptance found its panel said the job's alone).
 */
export function UnitLabelPanel({ job, busy, verification, onRecover }: UnitLabelPanelProps) {
  const { t } = useTranslation();
  const suffix = job === null ? "" : unitLabelSuffix(job);
  const policy = job?.verificationPolicy ?? verification;
  const { steps, checkOff } = duplicateSteps(job, busy, policy);
  const status = t(busy ? "floor.unitLabels.saving" : unitLabelStatusKey(job));
  return (
    <section className="work-instrument work-unit-label" aria-labelledby="work-unit-label-title">
      <h2 id="work-unit-label-title">{t("floor.unitLabels.title")}</h2>
      <ol className="work-unit-label__steps" aria-describedby="work-unit-label-hint">
        {steps.map((state, index) => {
          const key = STEP_KEYS[index] ?? "accepted";
          const off = index === 2 && checkOff && state === "pending";
          const skipped = index === 2 && job?.verification === "skipped";
          return (
            <li key={key} className="work-unit-label__step" data-state={state}>
              <StepGlyph state={state} />
              <span className="work-unit-label__step-name">
                {t(
                  off
                    ? "floor.unitLabels.steps.checkedOff"
                    : skipped
                      ? "floor.unitLabels.skipped"
                      : `floor.unitLabels.steps.${key}`,
                )}
              </span>
              {state === "error" && onRecover !== undefined && (
                <Button size="floor" variant="secondary" onClick={onRecover}>
                  {t("floor.unitLabels.retry")}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="work-unit-label__status" role="status">
        {suffix === "" ? status : `${status} …${suffix}`}
      </p>
      <p id="work-unit-label-hint" className="work-sr">
        {t(policy === "none" ? "floor.unitLabels.noneHint" : "floor.unitLabels.requiredHint")}
      </p>
    </section>
  );
}
