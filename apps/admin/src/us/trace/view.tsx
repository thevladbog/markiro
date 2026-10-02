import { useEffect, useId, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import {
  usTraceSearchQuerySchema,
  type UsCurrentTraceResult,
  type UsTraceSearchPage,
} from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { normalizeExactLookup } from "../search/filters.js";
import { initialTraceTab, type TraceEventTarget } from "./projection.js";
import { TraceGraph } from "./graph.js";
import { TraceTable } from "./table.js";
import { TraceHistory } from "./history.js";
import { traceCopy, traceError } from "./copy.js";
import "./trace.css";

export type TraceEntry = { lotId: string; direction: "backward" | "forward" | "both" };
type Props = {
  client: UsBrowserClient;
  entry: TraceEntry | null;
  onEntryChange: (next: TraceEntry) => void;
  onOpenLot: (id: string) => void;
  onOpenEvent: (target: TraceEventTarget) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
};
export function TraceView(props: Props) {
  const { i18n } = useTranslation();
  const copy = traceCopy(i18n.language);
  return (
    <section className="us-trace-view" aria-label={copy.title}>
      <h1 tabIndex={-1}>{copy.title}</h1>
      <LotSelector {...props} />
      <CurrentTrace key={props.entry?.lotId ?? "unselected"} {...props} />
      {props.entry ? (
        <TraceHistory
          client={props.client}
          lotId={props.entry.lotId}
          onOpenEvent={props.onOpenEvent}
          onForbidden={props.onForbidden}
          onSessionLost={props.onSessionLost}
        />
      ) : null}
    </section>
  );
}
function LotSelector({ client, entry, onEntryChange, onForbidden, onSessionLost }: Props) {
  const { i18n } = useTranslation();
  const copy = traceCopy(i18n.language);
  const [draft, setDraft] = useState("");
  const [applied, setApplied] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors.at(-1) ?? null;
  const [page, setPage] = useState<UsTraceSearchPage | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setPage(null);
    setFailed(false);
    setPending(applied !== null);
    if (applied !== null)
      void client
        .searchTraceLots({ q: applied, limit: "50", ...(cursor === null ? {} : { cursor }) })
        .then((value) => {
          if (active) setPage(value);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setFailed(true);
          if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
          if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
        })
        .finally(() => {
          if (active) setPending(false);
        });
    return () => {
      active = false;
    };
  }, [client, applied, cursor, retry, onForbidden, onSessionLost]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const q = normalizeExactLookup(draft);
        if (!q || !usTraceSearchQuerySchema.safeParse({ q, limit: "50" }).success) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        setApplied(q);
        setCursors([null]);
        setRetry((n) => n + 1);
      }}
    >
      <div className="us-trace-controls">
        <Input
          label={copy.search}
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit">{copy.search}</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDraft("");
            setApplied(null);
            setCursors([null]);
            setInvalid(false);
          }}
        >
          {copy.clear}
        </Button>
      </div>
      {invalid ? <p role="alert">{copy.invalid_input}</p> : null}
      {pending ? <p role="status">{copy.loading}</p> : null}
      {failed ? <p role="alert">{copy.searchError}</p> : null}
      <Select
        native
        label={copy.lot}
        value={entry?.lotId ?? ""}
        disabled={pending || failed}
        onValueChange={(value) => {
          if (page?.items.some((item) => item.lotId === value))
            onEntryChange({ lotId: value, direction: entry?.direction ?? "both" });
        }}
        options={[
          { value: "", label: copy.choose },
          ...(entry && !page?.items.some((item) => item.lotId === entry.lotId)
            ? [{ value: entry.lotId, label: entry.lotId }]
            : []),
          ...(page?.items.map((item) => ({
            value: item.lotId,
            label: `${item.tlc} · ${item.lotId} · ${item.source === null ? copy.sourceMissing : item.source.kind === "location" ? `${copy.location}: ${item.source.locationId}` : `${copy.reference}: ${item.source.referenceValue}`}`,
          })) ?? []),
        ]}
      />
      {page?.items.length === 0 ? <p>{copy.noHits}</p> : null}
      {applied !== null ? (
        <nav className="us-trace-controls" aria-label={copy.searchPages}>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || cursors.length === 1}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            {copy.previous}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending || failed || !page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) setCursors((values) => [...values, page.nextCursor]);
            }}
          >
            {copy.next}
          </Button>
        </nav>
      ) : null}
    </form>
  );
}
function CurrentTrace({
  client,
  entry,
  onEntryChange,
  onOpenLot,
  onOpenEvent,
  onForbidden,
  onSessionLost,
}: Props) {
  const { i18n } = useTranslation();
  const copy = traceCopy(i18n.language);
  const uid = useId();
  const [depth, setDepth] = useState("16");
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<UsCurrentTraceResult | null>(null);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<ReturnType<typeof traceError> | null>(null);
  const [tab, setTab] = useState<"graph" | "table">("graph");
  const lotId = entry?.lotId;
  const direction = entry?.direction;
  useEffect(() => {
    let active = true;
    setResult(null);
    setErrorKey(null);
    setPending(Boolean(lotId));
    if (lotId && direction)
      void client
        .readCurrentTrace(lotId, { direction, maxDepth: depth })
        .then((value) => {
          if (!active) return;
          setResult(value);
          setTab(initialTraceTab(value));
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
  }, [client, lotId, direction, depth, retry, onForbidden, onSessionLost]);
  return (
    <div className="us-trace-current" aria-busy={pending}>
      <div className="us-trace-controls">
        <Select
          native
          label={copy.direction}
          value={direction ?? "both"}
          disabled={!entry}
          options={["backward", "forward", "both"].map((value) => ({
            value,
            label:
              value === "backward" ? copy.backward : value === "forward" ? copy.forward : copy.both,
          }))}
          onValueChange={(value) => {
            if (entry && (value === "backward" || value === "forward" || value === "both"))
              onEntryChange({ ...entry, direction: value });
          }}
        />
        <Select
          native
          label={copy.depth}
          value={depth}
          disabled={!entry}
          onValueChange={setDepth}
          options={Array.from({ length: 21 }, (_, value) => ({
            value: String(value),
            label: String(value),
          }))}
        />
      </div>
      {!entry ? (
        <p>{copy.idle}</p>
      ) : pending ? (
        <p role="status">{copy.loading}</p>
      ) : errorKey ? (
        <div role="alert">
          <p>{copy[errorKey]}</p>
          <Button onClick={() => setRetry((n) => n + 1)}>{copy.retry}</Button>
        </div>
      ) : result ? (
        <>
          <p>
            {result.completion.returnedNodes} {copy.nodes}, {result.completion.returnedEdges}{" "}
            {copy.edges}
          </p>
          {result.completion.state === "limited" ? (
            <p role="alert">
              {copy.incomplete}:{" "}
              {result.completion.limit === "depth"
                ? copy.depthLimit
                : copy[result.completion.limit]}{" "}
              · {result.completion.returnedNodes} {copy.nodes}, {result.completion.returnedEdges}{" "}
              {copy.edges}
            </p>
          ) : (
            <p>{copy.complete}</p>
          )}
          {result.findings.map((finding) => (
            <p key={finding.lotId}>
              {copy.gap}: {finding.lotId}
            </p>
          ))}
          <p>
            {copy.excluded}: {result.excludedSummary.count}
          </p>
          <div role="tablist" aria-label={copy.tabs} className="us-trace-controls">
            {(["graph", "table"] as const).map((value) => (
              <Button
                key={value}
                id={`${uid}-${value}`}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`${uid}-panel`}
                tabIndex={tab === value ? 0 : -1}
                variant="secondary"
                onClick={() => setTab(value)}
                onKeyDown={(event) => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? "graph"
                      : event.key === "End"
                        ? "table"
                        : tab === "graph"
                          ? "table"
                          : "graph";
                  setTab(next);
                  document.getElementById(`${uid}-${next}`)?.focus();
                }}
              >
                {copy[value]}
              </Button>
            ))}
          </div>
          <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${tab}`} tabIndex={0}>
            {tab === "graph" ? (
              <TraceGraph result={result} onOpenLot={onOpenLot} onOpenEvent={onOpenEvent} />
            ) : (
              <TraceTable result={result} onOpenLot={onOpenLot} onOpenEvent={onOpenEvent} />
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
