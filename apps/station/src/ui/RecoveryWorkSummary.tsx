import { useTranslation } from "react-i18next";
import type { SealedWorkSummary } from "../lib/credential-recovery.js";

/** Read-only counts stay visible even when no owner can be established. */
export function RecoveryWorkSummary({ summary }: { summary?: SealedWorkSummary }) {
  const { t } = useTranslation();
  if (!summary) return <p>{t("enroll.summaryUnknown")}</p>;
  return (
    <>
      <p data-testid="sealed-work-summary">
        {t("enroll.sealedWork", { ...summary, closes: summary.closes ?? "—" })}
      </p>
      <p>
        {t("enroll.savedAttention", {
          conflicts: summary.conflicts ?? "—",
          quarantined: summary.quarantinedLabels ?? "—",
          unknownPrints: summary.unknownPrints ?? "—",
        })}
      </p>
    </>
  );
}
