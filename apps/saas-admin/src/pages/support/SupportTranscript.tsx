import { useEffect } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, Button, Spinner } from "@markiro/ui";
import { getPlatformTranscript } from "./api.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";

export function SupportTranscript({ requestId }: { requestId: string }) {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const client = useQueryClient();
  useEffect(
    () => () => {
      void client.cancelQueries({
        queryKey: ["platform", "support", principal.userId, "transcript"],
      });
      client.removeQueries({ queryKey: ["platform", "support", principal.userId, "transcript"] });
    },
    [client, principal.userId],
  );
  const query = useInfiniteQuery({
    queryKey: ["platform", "support", principal.userId, "transcript", requestId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => getPlatformTranscript(requestId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const current = query.data?.pages[0];
  const messages = Array.from(
    new Map(
      query.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item]) ?? [],
    ).values(),
  ).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return (
    <section className="commerce-detail-panel" aria-label={t("support.transcript")}>
      <h2>{t("support.transcript")}</h2>
      {query.isPending ? <Spinner label={t("support.loading")} /> : null}
      {query.isError ? (
        <Alert tone="error">
          {t("support.loadError")}{" "}
          <Button onClick={() => void query.refetch()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
      {current && !query.isError && current.sync.state !== "healthy" ? (
        <Alert tone={current.sync.state === "error" ? "error" : "warn"}>
          {t(
            current.sync.errorCode === "consent_notice_unknown"
              ? "support.noticeReview"
              : current.sync.state === "error"
                ? "support.syncError"
                : "support.syncPending",
          )}
        </Alert>
      ) : null}
      {current && !query.isError && messages.length === 0 ? (
        <p>{t("support.transcriptEmpty")}</p>
      ) : null}
      {current && !query.isError ? (
        <ol>
          {messages.map((message) => (
            <li key={message.id} style={{ overflowWrap: "anywhere" }}>
              <strong>{t(`support.side.${message.direction}`)}</strong>{" "}
              <time dateTime={message.occurredAt}>
                {new Date(message.occurredAt).toLocaleString(i18n.language)}
              </time>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("support.older")}
        </Button>
      ) : null}
      {query.isFetchNextPageError ? (
        <Alert tone="error">
          {t("support.loadError")}{" "}
          <Button onClick={() => void query.fetchNextPage()}>{t("support.retry")}</Button>
        </Alert>
      ) : null}
    </section>
  );
}
