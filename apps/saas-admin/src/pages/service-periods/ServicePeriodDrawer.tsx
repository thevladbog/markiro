import { Alert, Button, Spinner } from "@markiro/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CatalogDrawer } from "../catalog/CatalogDrawer.js";
import { getServicePeriod } from "./api.js";
import { CorrectUsageForm } from "./CorrectUsageForm.js";
import { ExternalApprovalForm } from "./ExternalApprovalForm.js";
import { PostUsageForm } from "./PostUsageForm.js";

export function ServicePeriodDrawer({
  periodId,
  canWriteUsage,
  canApprove,
  onClose,
}: {
  periodId: string;
  canWriteUsage: boolean;
  canApprove: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["platform", "service-periods", periodId],
    queryFn: () => getServicePeriod(periodId),
  });
  const [usageDirty, setUsageDirty] = useState(false);
  const [approvalDirty, setApprovalDirty] = useState(false);
  const [correctionDirty, setCorrectionDirty] = useState(false);
  const [correctionId, setCorrectionId] = useState<string | null>(null);
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "service-periods"] }),
      detail.refetch(),
    ]);
    setCorrectionId(null);
  };
  return (
    <CatalogDrawer
      title={
        detail.data
          ? i18n.language.startsWith("ru")
            ? detail.data.nameRu
            : detail.data.nameEn
          : t("servicePeriods.detailTitle")
      }
      dirty={usageDirty || approvalDirty || correctionDirty}
      busy={false}
      onClose={onClose}
      closeLabel={t("servicePeriods.close")}
    >
      {detail.isPending ? <Spinner label={t("servicePeriods.loading")} /> : null}
      {detail.isError ? <Alert tone="error">{t("servicePeriods.loadError")}</Alert> : null}
      {detail.data ? (
        <div className="catalog-form">
          <dl className="version-data">
            <div>
              <dt>{t("servicePeriods.period")}</dt>
              <dd>
                {new Date(detail.data.startsAt).toLocaleDateString()} —{" "}
                {new Date(detail.data.endsAt).toLocaleDateString()}
              </dd>
            </div>
            <div>
              <dt>{t("servicePeriods.included")}</dt>
              <dd>{detail.data.balance.included}</dd>
            </div>
            <div>
              <dt>{t("servicePeriods.approved")}</dt>
              <dd>{detail.data.balance.externallyApproved}</dd>
            </div>
            <div>
              <dt>{t("servicePeriods.consumed")}</dt>
              <dd>{detail.data.balance.consumed}</dd>
            </div>
            <div>
              <dt>{t("servicePeriods.remaining")}</dt>
              <dd>{detail.data.balance.remaining}</dd>
            </div>
            <div>
              <dt>{t("servicePeriods.revision")}</dt>
              <dd>{detail.data.revision}</dd>
            </div>
          </dl>
          <h3>{t("servicePeriods.ledger")}</h3>
          {detail.data.entries.length ? (
            <ol>
              {detail.data.entries.map((entry) => (
                <li key={entry.id}>
                  <strong>{entry.workReference}</strong> · {entry.actualMinutesDelta} /{" "}
                  {entry.allowanceMinutesDelta} ·{" "}
                  {t(`servicePeriods.classification.${entry.classification}`)}
                  <br />
                  {entry.description} · {new Date(entry.performedAt).toLocaleString()} /{" "}
                  {new Date(entry.postedAt).toLocaleString()}
                  {canWriteUsage && entry.kind === "usage" ? (
                    <Button variant="secondary" onClick={() => setCorrectionId(entry.id)}>
                      {t("servicePeriods.correction.open")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p>{t("servicePeriods.emptyLedger")}</p>
          )}
          {canWriteUsage ? (
            <PostUsageForm
              periodId={periodId}
              revision={detail.data.revision}
              onSuccess={() => void refresh()}
              onDirtyChange={setUsageDirty}
            />
          ) : null}
          {canWriteUsage && correctionId ? (
            <CorrectUsageForm
              periodId={periodId}
              revision={detail.data.revision}
              entry={detail.data.entries.find((entry) => entry.id === correctionId)!}
              onSuccess={() => void refresh()}
              onDirtyChange={setCorrectionDirty}
            />
          ) : null}
          {canApprove ? (
            <ExternalApprovalForm
              periodId={periodId}
              revision={detail.data.revision}
              onSuccess={() => void refresh()}
              onDirtyChange={setApprovalDirty}
            />
          ) : null}
        </div>
      ) : null}
    </CatalogDrawer>
  );
}
