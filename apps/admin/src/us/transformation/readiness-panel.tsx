import { Button } from "@markiro/ui";
import { useTranslation } from "react-i18next";
import type {
  TransformationDraftRecord,
  TransformationReadiness,
} from "@markiro/platform-contracts";

export function TransformationReadinessPanel({
  record,
  dirty,
  busy,
  readiness,
  issues,
  onCheck,
}: {
  record: TransformationDraftRecord | null;
  dirty: boolean;
  busy: boolean;
  readiness: TransformationReadiness | null;
  issues: TransformationReadiness["issues"];
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const current =
    record !== null &&
    !dirty &&
    readiness?.eventId === record.id &&
    readiness.expectedDraftVersion === record.draftVersion;
  const groups = ["event", "inputs", "outputs", "documents"] as const;
  return (
    <section className="us-tr-section" aria-labelledby="us-tr-readiness">
      <div className="us-tr-section__heading">
        <h2 id="us-tr-readiness">{t("transformation.readiness")}</h2>
        <Button
          type="button"
          variant="secondary"
          disabled={!record || dirty || busy}
          onClick={onCheck}
        >
          {t("transformation.check")}
        </Button>
      </div>
      <div role="status" aria-live="polite">
        {!record ? (
          <p>{t("transformation.saveFirst")}</p>
        ) : dirty ? (
          <p>{t("transformation.saveChanges")}</p>
        ) : null}
        {current ? (
          <p>
            {t(`transformation.${readiness.state}`)} · v{record.draftVersion}
          </p>
        ) : null}
      </div>
      {groups.map((group) => {
        const selected = issues.filter((issue) => issue.group === group);
        return selected.length ? (
          <div key={group} className="us-tr-issues" role="alert">
            <h3>{t(`transformation.${group === "event" ? "title" : group}`)}</h3>
            <ul>
              {selected.map((issue, index) => (
                <li key={`${issue.code}/${issue.line ?? 0}/${index}`}>
                  {issue.line ? `${issue.line}. ` : ""}
                  {t("transformation.issue", { field: issue.field, code: issue.code })}
                  {issue.detail ? ` · ${issue.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null;
      })}
    </section>
  );
}
