import { BarcodeIcon } from "../BarcodeIcon.js";
import { useTranslation } from "react-i18next";
import type { WarehouseJobView } from "../../lib/warehouse-reprint/types.js";
export function ReprintStatus({
  job,
  duplicate,
  verification,
}: {
  job: WarehouseJobView | null;
  duplicate: boolean;
  verification: boolean;
}) {
  const { t } = useTranslation();
  const key = verification ? "verify" : duplicate ? "duplicate" : (job?.state ?? "ready");
  return (
    <section
      className={`warehouse-status warehouse-status--${key}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <BarcodeIcon className="warehouse-scan-mark" />
      <h2>{t(`warehouse.status.${key}`)}</h2>
      <p>{t(`warehouse.hint.${key}`)}</p>
      {job ? (
        <div className="warehouse-result">
          <strong>{job.productName}</strong>
          <span>
            {t(job.kind === "box" ? "warehouse.box" : "warehouse.unit")} · {job.identity}
          </span>
          <small>
            {job.templateName} · {job.printerName}
          </small>
          {job.repair ? (
            <p className="warehouse-repair-notice">{t("warehouse.legacyRepair")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
