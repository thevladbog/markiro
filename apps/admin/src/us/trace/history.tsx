import { useEffect, useState } from "react";
import { Button } from "@markiro/ui";
import type { UsTraceHistoryPage } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { historyTarget, traceCivilDate, type TraceEventTarget } from "./projection.js";
import { traceCopy, traceError } from "./copy.js";

export function TraceHistory(props: {
  client: UsBrowserClient;
  lotId: string;
  onOpenEvent: (target: TraceEventTarget) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
}) {
  // A new lot owns a fresh cursor stack, including when this component is used alone.
  return <HistoryPages key={props.lotId} {...props} />;
}
function HistoryPages({
  client,
  lotId,
  onOpenEvent,
  onForbidden,
  onSessionLost,
}: Parameters<typeof TraceHistory>[0]) {
  const { i18n } = useTranslation();
  const copy = traceCopy(i18n.language);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<UsTraceHistoryPage | null>(null);
  const [pending, setPending] = useState(true);
  const [errorKey, setErrorKey] = useState<ReturnType<typeof traceError> | null>(null);
  const [retry, setRetry] = useState(0);
  const cursor = cursors.at(-1) ?? null;
  useEffect(() => {
    let active = true;
    setPending(true);
    setErrorKey(null);
    setPage(null);
    void client
      .listTraceHistory(lotId, { limit: "50", ...(cursor === null ? {} : { cursor }) })
      .then((value) => {
        if (active) setPage(value);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setErrorKey(traceError(error));
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [client, lotId, cursor, retry, onForbidden, onSessionLost]);
  return (
    <section className="us-trace-history" aria-label={copy.history} aria-busy={pending}>
      <h2>{copy.history}</h2>
      <p>{copy.historyHint}</p>
      {pending ? (
        <p role="status">{copy.loading}</p>
      ) : errorKey ? (
        <div role="alert">
          <p>{errorKey === "unavailable" ? copy.historyError : copy[errorKey]}</p>
          {errorKey === "unavailable" ? (
            <Button onClick={() => setRetry((n) => n + 1)}>{copy.historyRetry}</Button>
          ) : null}
        </div>
      ) : page ? (
        <>
          {page.items.length === 0 ? (
            <p>{copy.historyEmpty}</p>
          ) : (
            <ul>
              {page.items.map((item) => (
                <li key={item.eventId}>
                  <Button variant="secondary" onClick={() => onOpenEvent(historyTarget(item))}>
                    {item.eventNumber} · {copy.revision} {item.revision}
                  </Button>
                  <span>
                    {copy[item.status]} ·{" "}
                    {item.eventDate ? (
                      <time dateTime={item.eventDate}>
                        {traceCivilDate(item.eventDate, i18n.language)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </span>
                  <span>{item.reason ?? "—"}</span>
                  <span>
                    {copy.predecessor}: {item.previousRevisionId ?? "—"}
                  </span>
                  <span>
                    {copy.successor}: {item.nextRevisionId ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <nav aria-label={copy.historyPages} className="us-trace-controls">
        <Button
          variant="secondary"
          disabled={pending || cursors.length === 1}
          onClick={() => setCursors((values) => values.slice(0, -1))}
        >
          {copy.previous}
        </Button>
        <Button
          variant="secondary"
          disabled={pending || errorKey !== null || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) setCursors((values) => [...values, page.nextCursor]);
          }}
        >
          {copy.next}
        </Button>
      </nav>
    </section>
  );
}
