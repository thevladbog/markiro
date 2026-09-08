import { useTranslation } from "react-i18next";
import type { ProductLabelJobView } from "../../lib/product-labels/types.js";
export function productLabelStatusKey(job: ProductLabelJobView | null): string {
  if (!job) return "productLabels.waiting";
  if (job.verificationOutcome === "verified") return "productLabels.verified";
  if (job.status === "completed") return "productLabels.sent";
  if (job.status === "awaiting_verification") return "productLabels.verify";
  if (job.attemptState === "delivery_unknown") return "productLabels.unknown";
  if (job.attemptState === "failed_before_send") return "productLabels.failedBeforeSend";
  return "productLabels.printing";
}
export function ProductLabelInstrument({
  job,
  busy,
  verification,
}: {
  job: ProductLabelJobView | null;
  busy: boolean;
  verification: ProductLabelJobView["verification"] | null;
}) {
  const { t } = useTranslation();
  return (
    <section className="work-instrument work-product-label" aria-labelledby="product-label-title">
      <h2 id="product-label-title">{t("productLabels.title")}</h2>
      <div className="work-product-label__readout" role="status">
        <strong>{t(busy ? "productLabels.saving" : productLabelStatusKey(job))}</strong>
        {job ? <code>…{job.codeSuffix}</code> : null}
      </div>
      <p>
        {t(
          (job?.verification ?? verification) === "none"
            ? "productLabels.noneHint"
            : "productLabels.requiredHint",
        )}
      </p>
    </section>
  );
}
