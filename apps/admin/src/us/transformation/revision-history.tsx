import type { TransformationRevisionList } from "@markiro/platform-contracts";
import { Button, StatusChip } from "@markiro/ui";
import { useTranslation } from "react-i18next";

export function TransformationRevisionHistory({
  list,
  selectedEventId,
  onPage,
  onOpenRevision,
  pending,
  failure,
  onRetry,
}: {
  list: TransformationRevisionList | null;
  selectedEventId: string;
  onPage: (offset: number) => void;
  onOpenRevision: (id: string) => void;
  pending: boolean;
  failure: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const currentId = list?.items[0]?.currentEventId;
  const pendingId = list?.items[0]?.pendingDraftId;
  const next =
    list !== null && list.items.length === list.limit && list.offset + list.limit <= 100000;
  return (
    <section
      className="us-tr-section"
      aria-label={t("transformation.history.title")}
      aria-busy={pending}
    >
      <h2>{t("transformation.history.title")}</h2>
      {failure ? (
        <p role="alert">
          {t("transformation.history.failed")}{" "}
          <Button type="button" variant="secondary" onClick={onRetry}>
            {t("md.retry")}
          </Button>
        </p>
      ) : null}
      <ol className="us-tr-history">
        {list?.items.map((row) => (
          <li key={row.id}>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={pending || row.id === selectedEventId}
              onClick={() => onOpenRevision(row.id)}
            >
              {t("receiving.revision")} {row.revision}
            </Button>
            <StatusChip
              status={row.status === "finalized" ? "ok" : "neutral"}
              label={t(`events.${row.status}`)}
            />
            {row.id === selectedEventId ? (
              <strong>{t("transformation.history.selected")}</strong>
            ) : null}
            {row.id === currentId ? <span>{t("transformation.history.current")}</span> : null}
            {row.id === pendingId ? <span>{t("transformation.history.pending")}</span> : null}
            {row.amendmentReason ? <span>{row.amendmentReason}</span> : null}
            {row.voidReason ? <span>{row.voidReason}</span> : null}
          </li>
        ))}
      </ol>
      <div className="us-tr-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={pending || !list || list.offset === 0}
          onClick={() => {
            if (list) onPage(Math.max(0, list.offset - list.limit));
          }}
        >
          {t("md.previousPage")}
        </Button>
        {list ? (
          <span>{t("md.page", { page: Math.floor(list.offset / list.limit) + 1 })}</span>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={pending || !next}
          onClick={() => {
            if (list) onPage(list.offset + list.limit);
          }}
        >
          {t("md.nextPage")}
        </Button>
      </div>
    </section>
  );
}
