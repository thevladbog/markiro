import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, FullScreenDialog } from "@markiro/ui";
import type { ReprintReason } from "@markiro/domain";
import type { ProductLabelWork, ProductLabelWorkState } from "../../lib/use-product-label-work.js";
import { productLabelStatusKey } from "./ProductLabelInstrument.js";

export function ProductLabelReprintReason({
  busy,
  onConfirm,
  onBack,
  error = false,
}: {
  busy: boolean;
  onConfirm: (reason: ReprintReason) => void;
  onBack: () => void;
  error?: boolean;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<ReprintReason | null>(null);
  return (
    <FullScreenDialog
      open
      title={t("productLabels.reprintTitle")}
      backLabel={t("productLabels.back")}
      backPlacement="footer"
      backDisabled={busy}
      onClose={onBack}
      initialFocus="dialog"
      footer={
        <Button
          size="floor"
          disabled={!reason || busy}
          onClick={() => {
            if (reason) onConfirm(reason);
          }}
        >
          {t("productLabels.reprint")}
        </Button>
      }
    >
      {error ? <Alert tone="error" title={t("productLabels.reprintFailed")} /> : null}
      <fieldset className="setup-choice-group">
        <legend>{t("productLabels.reasonHint")}</legend>
        {(["not_printed", "damaged", "lost"] as const).map((value) => (
          <label key={value} className="setup-touch-choice">
            <input
              type="radio"
              name="product-label-reprint-reason"
              checked={reason === value}
              disabled={busy}
              onChange={() => setReason(value)}
            />
            <span>{t(`productLabels.reasons.${value}`)}</span>
          </label>
        ))}
      </fieldset>
    </FullScreenDialog>
  );
}

/** Scanner intake remains in WorkScreen: this dialog never subscribes a second sink. */
export function ProductLabelVerification({
  state,
  work,
  onPause,
  onSetup,
  onSkipped,
}: {
  state: ProductLabelWorkState;
  work: ProductLabelWork;
  onPause: () => void;
  onSetup?: () => void;
  onSkipped?: () => void;
}) {
  const { t } = useTranslation();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [error, setError] = useState(false);
  const job = state.job;
  const awaiting = job?.status === "awaiting_verification" && !state.error;
  useEffect(() => () => work.setVerificationPaused(false), [work]);
  async function reprint(reason: ReprintReason) {
    if (!job) return;
    setError(false);
    try {
      await work.reprint(job.jobId, reason);
      work.setVerificationPaused(false);
      setReasonOpen(false);
    } catch {
      setError(true);
    }
  }
  if (reasonOpen)
    return (
      <ProductLabelReprintReason
        busy={state.busy}
        error={error}
        onConfirm={(reason) => void reprint(reason)}
        onBack={() => {
          work.setVerificationPaused(false);
          setReasonOpen(false);
        }}
      />
    );
  return (
    <FullScreenDialog
      open
      title={t(
        state.error === "printer"
          ? "productLabels.printerSetup"
          : state.error
            ? "productLabels.storageError"
            : awaiting
              ? "productLabels.scanTitle"
              : productLabelStatusKey(job),
      )}
      backLabel={t("productLabels.pause")}
      backPlacement="footer"
      backDisabled={state.busy}
      onClose={onPause}
      initialFocus="dialog"
      className={`print-verification-dialog${awaiting ? " product-label-verification--awaiting" : ""}`}
      style={awaiting ? { background: "var(--warn-solid)", color: "var(--fg-on-warn-solid)" } : {}}
      footer={
        <>
          {state.error ? (
            <Button
              size="floor"
              disabled={state.busy}
              onClick={() => void work.retry().catch(() => setError(true))}
            >
              {t("productLabels.retry")}
            </Button>
          ) : job?.status === "prepared" ? (
            <Button
              size="floor"
              disabled={state.busy}
              onClick={() => void work.resumePrepared().catch(() => setError(true))}
            >
              {t("productLabels.sendPrepared")}
            </Button>
          ) : (
            <Button
              size="floor"
              disabled={state.busy || job?.status === "sending" || job?.ownershipConflict}
              onClick={() => {
                work.setVerificationPaused(true);
                setReasonOpen(true);
              }}
            >
              {t(awaiting ? "productLabels.labelProblem" : "productLabels.reprint")}
            </Button>
          )}
          {awaiting && !state.closed && !job.ownershipConflict ? (
            <Button
              size="floor"
              variant="secondary"
              disabled={state.busy}
              onClick={() => {
                setError(false);
                void work
                  .skip(job.jobId, job.attemptId)
                  .then((applied) => {
                    if (applied) onSkipped?.();
                  })
                  .catch(() => setError(true));
              }}
            >
              {t("productLabels.skip")}
            </Button>
          ) : null}
          {onSetup && (state.error === "printer" || job?.attemptState === "failed_before_send") ? (
            <Button size="floor" variant="secondary" disabled={state.busy} onClick={onSetup}>
              {t("productLabels.printerSetup")}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="print-verification">
        <section className="print-verification__stage">
          {awaiting ? (
            <svg
              className="product-label-verification__icon"
              aria-hidden="true"
              viewBox="0 0 48 48"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
            >
              <path d="M16 6H8a2 2 0 0 0-2 2v8m26-10h8a2 2 0 0 1 2 2v8M6 32v8a2 2 0 0 0 2 2h8m26-10v8a2 2 0 0 1-2 2h-8M14 18v12m7-12v12m6-12v12m7-12v12" />
            </svg>
          ) : null}
          <p className="print-verification__instruction">
            {t(
              state.closed
                ? "productLabels.closedHint"
                : job?.attemptState === "delivery_unknown"
                  ? "productLabels.unknownHint"
                  : job?.status === "prepared"
                    ? "productLabels.preparedHint"
                    : job?.attemptState === "failed_before_send"
                      ? "productLabels.failedHint"
                      : "productLabels.scanHint",
            )}
          </p>
          {job ? <p className="print-verification__sscc">…{job.codeSuffix}</p> : null}
          {state.result === "mismatch" || state.result === "invalid" ? (
            <Alert tone="error" title={t(`productLabels.${state.result}`)} />
          ) : null}
          {state.error || error ? (
            <Alert
              tone="error"
              title={t(
                state.error === "another_shift"
                  ? "productLabels.anotherShift"
                  : state.error === "printer"
                    ? "productLabels.failedHint"
                    : "productLabels.storageError",
              )}
            />
          ) : null}
          {job?.ownershipConflict ? (
            <Alert tone="warn" title={t("productLabels.ownershipConflict")} />
          ) : null}
          {awaiting && !state.closed ? (
            <p className="product-label-verification__skip-hint">{t("productLabels.skipHint")}</p>
          ) : null}
          <p role="status">{t(state.busy ? "productLabels.saving" : "productLabels.waitScan")}</p>
        </section>
      </div>
    </FullScreenDialog>
  );
}
