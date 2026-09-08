import type { ReceivingLiveRecord } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";

export function ReceivingLifecycleNotice({ record }: { record: ReceivingLiveRecord }) {
  const { t, i18n } = useTranslation();
  const lifecycle = record.lifecycle;
  const at = record.status === "void" ? lifecycle.voidedAt : lifecycle.supersededAt;
  const actor = record.status === "void" ? lifecycle.voidedBy : lifecycle.supersededBy;
  if (record.status !== "void" && record.status !== "amended") return null;
  return (
    <section className="us-rec-section us-md-notice" aria-label={t("receiving.lifecycle")}>
      <p>{t(record.status === "void" ? "receiving.voidHint" : "receiving.amendedHint")}</p>
      <dl>
        <dt>{t("receiving.revision")}</dt>
        <dd>{record.revision}</dd>
        {lifecycle.voidReason ? (
          <>
            <dt>{t("receiving.reason")}</dt>
            <dd>{lifecycle.voidReason}</dd>
          </>
        ) : null}
        <dt>{t("receiving.changedBy")}</dt>
        <dd>{actor}</dd>
        <dt>{t("receiving.changedAt")}</dt>
        <dd>
          {at
            ? new Intl.DateTimeFormat(i18n.language, {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: record.timeZone,
              }).format(new Date(at))
            : "—"}{" "}
          · {record.timeZone}
        </dd>
      </dl>
    </section>
  );
}
