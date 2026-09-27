import type { ShippingRevisionList } from "@markiro/platform-contracts";
import { Button, StatusChip } from "@markiro/ui";
import { useTranslation } from "react-i18next";

export function ShippingRevisionHistory({
  list,
  selectedId,
  pending,
  failure,
  onOpen,
  onPage,
  onRetry,
}: {
  list: ShippingRevisionList | null;
  selectedId: string;
  pending: boolean;
  failure: boolean;
  onOpen: (id: string) => void;
  onPage: (offset: number) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="us-sh-section" aria-label={t("shipping.history")} aria-busy={pending}>
      <h2>{t("shipping.history")}</h2>
      {failure ? (
        <p role="alert">
          {t("shipping.historyFailed")}{" "}
          <Button variant="secondary" onClick={onRetry}>
            {t("md.retry")}
          </Button>
        </p>
      ) : null}
      <ol className="us-sh-history">
        {list?.items.map((row) => (
          <li key={row.id}>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={pending || row.id === selectedId}
              onClick={() => onOpen(row.id)}
            >
              {t("shipping.revision", { number: row.revision })}
            </Button>
            <StatusChip
              status={
                row.status === "finalized"
                  ? "ok"
                  : row.status === "void"
                    ? "error"
                    : row.status === "amended"
                      ? "info"
                      : "neutral"
              }
              label={t(`events.${row.status}`)}
            />
            {row.id === selectedId ? <strong>{t("shipping.selected")}</strong> : null}
            {row.id === row.currentEventId ? <span>{t("shipping.current")}</span> : null}
            {row.id === row.pendingDraftId ? <span>{t("shipping.pending")}</span> : null}
            {row.amendmentReason ? <span>{row.amendmentReason}</span> : null}
            {row.voidReason ? <span>{row.voidReason}</span> : null}
          </li>
        ))}
      </ol>
      <div className="us-sh-actions">
        <Button
          type="button"
          variant="secondary"
          disabled={!list || pending || list.offset === 0}
          onClick={() => list && onPage(Math.max(0, list.offset - list.limit))}
        >
          {t("shipping.previousPage")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={
            !list || pending || list.items.length < list.limit || list.offset + list.limit > 100000
          }
          onClick={() => list && onPage(list.offset + list.limit)}
        >
          {t("shipping.nextPage")}
        </Button>
      </div>
    </section>
  );
}
