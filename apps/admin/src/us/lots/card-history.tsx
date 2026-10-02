import { useEffect, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsTraceHistoryPage } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError } from "../client.js";
import type { LotCardPanelProps } from "./card-panels.js";
import { traceCivilDate } from "../trace/projection.js";

export function CardHistory({
  client,
  lotId,
  disabled,
  onOpenEvent,
  onForbidden,
  onSessionLost,
}: LotCardPanelProps) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<UsTraceHistoryPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setPending(true);
    setFailed(false);
    setPage(null);
    void client
      .listTraceHistory(lotId, { limit: "50", ...(cursor === null ? {} : { cursor }) })
      .then((value) => {
        if (active) setPage(value);
      })
      .catch(async (error: unknown) => {
        if (!active) return;
        setFailed(true);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") await onForbidden();
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, lotId, cursor, refresh, onForbidden, onSessionLost]);
  return (
    <section
      className="us-lot-panel us-lot-card"
      aria-label={t("lots.cardHistory")}
      aria-busy={pending}
    >
      <div className="us-lot-basis-header">
        <h2>{t("lots.cardHistory")}</h2>
        <Button
          variant="secondary"
          disabled={pending || disabled}
          onClick={() => {
            setCursor(null);
            setRefresh((n) => n + 1);
          }}
        >
          {t("lots.cardHistoryRefresh")}
        </Button>
      </div>
      <p className="us-lot-note">{t("lots.cardHistoryHint")}</p>
      {pending ? (
        <p role="status">{t("lots.cardHistoryLoading")}</p>
      ) : failed ? (
        <p role="alert">{t("lots.cardHistoryError")}</p>
      ) : page ? (
        <>
          {page.items.length === 0 ? (
            <p>{t("lots.cardHistoryEmpty")}</p>
          ) : (
            <ul className="us-lot-basis-list">
              {page.items.map((item) => (
                <li key={item.eventId}>
                  {onOpenEvent ? (
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      onClick={() =>
                        onOpenEvent({
                          type: item.type,
                          eventId: item.eventId,
                          revision: item.revision,
                          lineSide: null,
                          lineNo: null,
                        })
                      }
                    >
                      {t("usReadiness.event", {
                        number: item.eventNumber,
                        revision: item.revision,
                      })}
                    </Button>
                  ) : (
                    <span>
                      {t("usReadiness.event", {
                        number: item.eventNumber,
                        revision: item.revision,
                      })}
                    </span>
                  )}
                  <span>
                    {t(`lots.cardHistoryStatus.${item.status}`)} ·{" "}
                    {item.eventDate
                      ? traceCivilDate(item.eventDate, i18n.language)
                      : t("lots.absent")}
                  </span>
                  <span>{item.reason ?? t("lots.absent")}</span>
                  <span>
                    {t("lots.cardHistoryPrevious", { id: item.previousRevisionId ?? "—" })}
                  </span>
                  <span>{t("lots.cardHistoryFollowing", { id: item.nextRevisionId ?? "—" })}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <Button
        variant="secondary"
        disabled={pending || disabled || !page?.nextCursor}
        onClick={() => {
          if (page?.nextCursor) setCursor(page.nextCursor);
        }}
      >
        {t("lots.cardHistoryNext")}
      </Button>
    </section>
  );
}
