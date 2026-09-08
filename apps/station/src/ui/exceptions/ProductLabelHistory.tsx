import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button } from "@markiro/ui";
import type { ReprintReason } from "@markiro/domain";
import type { ProductLabelWork } from "../../lib/use-product-label-work.js";
import type { ProductLabelJobView } from "../../lib/product-labels/types.js";
import { productLabelStatusKey } from "../work/ProductLabelInstrument.js";
import { ProductLabelReprintReason } from "../work/ProductLabelVerification.js";
export function ProductLabelHistory({
  work,
  onBack,
}: {
  work: ProductLabelWork;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ProductLabelJobView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void work.list().then(
      (rows) => {
        if (active) setJobs(rows);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [work]);
  async function reprint(reason: ReprintReason) {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await work.reprint(selected, reason);
      onBack();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="work-instrument product-label-history">
      <h2>{t("productLabels.history")}</h2>
      {error ? <Alert tone="error" title={t("productLabels.reprintFailed")} /> : null}
      <div className="product-label-history__rows">
        {jobs.map((job) => (
          <div className="product-label-history__row" key={job.jobId}>
            <code>…{job.codeSuffix}</code>
            <span>
              {t(productLabelStatusKey(job))} ·{" "}
              {t("productLabels.attempt", { count: job.attemptNo })}
            </span>
            <Button
              size="floor"
              variant="secondary"
              disabled={busy || job.ownershipConflict || !work.canAccept()}
              onClick={() => setSelected(job.jobId)}
            >
              {t("productLabels.reprint")}
            </Button>
          </div>
        ))}
      </div>
      {!jobs.length && !error ? <p>{t("productLabels.emptyHistory")}</p> : null}
      <Button size="floor" variant="secondary" onClick={onBack}>
        {t("productLabels.back")}
      </Button>
      {selected ? (
        <ProductLabelReprintReason
          busy={busy}
          error={error}
          onConfirm={(reason) => void reprint(reason)}
          onBack={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
