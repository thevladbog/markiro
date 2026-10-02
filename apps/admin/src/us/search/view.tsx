import { useEffect, useRef, useState } from "react";
import { Button, Input, Select } from "@markiro/ui";
import { TRACEABILITY_LOT_STATUSES } from "@markiro/domain";
import { usTraceSearchQuerySchema, type UsTraceSearchPage } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { LotReferencePicker } from "../lots/reference-picker.js";
import {
  emptySearchState,
  normalizeExactLookup,
  type SearchFilters,
  type SearchState,
} from "./filters.js";
import "./search.css";

const textFields = [
  "q",
  "tlc",
  "tlcList",
  "tlcFrom",
  "tlcTo",
  "productText",
  "sourceReferenceValue",
  "eventDateFrom",
  "eventDateTo",
  "documentType",
  "documentNumber",
  "sscc",
] as const;

function civilDate(value: string | null, language: string): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${value}T12:00:00Z`),
  );
}

export function SearchView({
  client,
  state,
  onStateChange,
  onOpenLot,
  onForbidden,
  onSessionLost,
}: {
  client: UsBrowserClient;
  state: SearchState;
  onStateChange: (next: SearchState) => void;
  onOpenLot: (lotId: string) => void;
  onForbidden: () => Promise<void>;
  onSessionLost: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<UsTraceSearchPage | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [retry, setRetry] = useState(0);
  const run = useRef(0);
  const results = useRef<HTMLDivElement>(null);
  const cursor = state.cursors[state.pageIndex] ?? null;
  const applied = state.applied;
  useEffect(() => {
    const token = ++run.current;
    if (applied === null) {
      setPage(null);
      setNames({});
      setPending(false);
      setFailed(false);
      setInvalid(false);
      return;
    }
    const query = { ...applied, limit: "50", ...(cursor ? { cursor } : {}) };
    if (!usTraceSearchQuerySchema.safeParse(query).success) {
      setInvalid(true);
      setPage(null);
      setPending(false);
      return;
    }
    setPending(true);
    setFailed(false);
    setPage(null);
    setNames({});
    void (async () => {
      try {
        const response = await client.searchTraceLots(query);
        if (run.current !== token) return;
        setPage(response);
        setPending(false);
        // A page is fixed at 50; only distinct current product references are resolved.
        const ids = [...new Set(response.items.map((item) => item.productId))].slice(0, 50);
        await Promise.all(
          ids.map(async (id) => {
            try {
              const product = await client.getProduct(id);
              if (run.current === token)
                setNames((current) => ({ ...current, [id]: product.name }));
            } catch (error) {
              if (run.current !== token) return;
              if (error instanceof UsClientError && error.code === "session_required")
                onSessionLost();
              if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
            }
          }),
        );
      } catch (error) {
        if (run.current !== token) return;
        setFailed(true);
        setPending(false);
        if (error instanceof UsClientError && error.code === "session_required") onSessionLost();
        if (error instanceof UsClientError && error.code === "forbidden") void onForbidden();
      }
    })();
    return () => {
      run.current += 1;
    };
  }, [client, applied, cursor, retry, onForbidden, onSessionLost]);
  useEffect(() => {
    if (!page || !state.focusLotId) return;
    results.current
      ?.querySelector<HTMLButtonElement>(`[data-lot-id="${state.focusLotId}"]`)
      ?.focus();
  }, [page, state.focusLotId]);
  function update(field: keyof SearchFilters, value: string) {
    const draft = { ...state.draft, [field]: value };
    if (value === "") delete draft[field];
    onStateChange({ ...state, draft });
    setInvalid(false);
  }
  function apply() {
    const draft = { ...state.draft };
    if (draft.q !== undefined) {
      draft.q = normalizeExactLookup(draft.q);
      if (draft.q === "") delete draft.q;
    }
    if (draft.sscc !== undefined) draft.sscc = normalizeExactLookup(draft.sscc);
    if (!usTraceSearchQuerySchema.safeParse({ ...draft, limit: "50" }).success) {
      setInvalid(true);
      return;
    }
    run.current += 1;
    setInvalid(false);
    onStateChange({ draft, applied: draft, cursors: [null], pageIndex: 0, focusLotId: null });
  }
  function reset() {
    run.current += 1;
    setPage(null);
    setNames({});
    setPending(false);
    setFailed(false);
    setInvalid(false);
    setRetry(0);
    onStateChange({ ...emptySearchState, draft: {}, cursors: [null] });
  }
  const stale = applied !== null && JSON.stringify(state.draft) !== JSON.stringify(applied);
  return (
    <section className="us-search" aria-labelledby="us-search-title">
      <header>
        <h1 id="us-search-title" tabIndex={-1}>
          {t("usSearch.title")}
        </h1>
        <p>{t("usSearch.intro")}</p>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
        noValidate
      >
        <div className="us-search-fields">
          {textFields.map((field) => (
            <Input
              key={field}
              label={t(`usSearch.${field}`)}
              value={state.draft[field] ?? ""}
              onChange={(event) => update(field, event.target.value)}
              maxLength={
                field === "tlcList"
                  ? 8192
                  : field === "sourceReferenceValue"
                    ? 1024
                    : field === "documentType"
                      ? 2000
                      : 200
              }
            />
          ))}
          <Select
            native
            label={t("usSearch.eventType")}
            value={state.draft.eventType ?? ""}
            onValueChange={(value) => update("eventType", value)}
            options={[
              { value: "", label: t("md.all") },
              ...["receiving", "transformation", "shipping"].map((value) => ({
                value,
                label: t(`usSearch.${value}`),
              })),
            ]}
          />
          <Select
            native
            label={t("usSearch.status")}
            value={state.draft.status ?? ""}
            onValueChange={(value) => update("status", value)}
            options={[
              { value: "", label: t("md.all") },
              ...TRACEABILITY_LOT_STATUSES.map((value) => ({
                value,
                label: t(`lots.states.${value}`),
              })),
            ]}
          />
        </div>
        <p>{t("usSearch.rangeHelp")}</p>
        <p>{t("usSearch.dateHelp")}</p>
        <div className="us-search-fields">
          {(["productId", "sourceLocationId", "locationId"] as const).map((field) => (
            <LotReferencePicker
              key={field}
              client={client}
              kind={field === "productId" ? "product" : "location"}
              label={t(`usSearch.${field}`)}
              value={state.draft[field] ?? ""}
              disabled={false}
              includeArchived
              onChange={(value) => update(field, value)}
              onForbidden={onForbidden}
              onSessionLost={onSessionLost}
            />
          ))}
        </div>
        <Button type="submit">{t("md.search")}</Button>
        <Button type="button" variant="secondary" onClick={reset}>
          {t("usSearch.reset")}
        </Button>
      </form>
      {invalid ? <p role="alert">{t("usSearch.invalid")}</p> : null}
      {stale ? <p role="status">{t("usSearch.stale")}</p> : null}
      {pending ? <p role="status">{t("usSearch.loading")}</p> : null}
      {applied === null ? <p>{t("usSearch.idle")}</p> : null}
      {failed ? (
        <div role="alert">
          <p>{t("usSearch.failed")}</p>
          <Button type="button" onClick={() => setRetry((value) => value + 1)}>
            {t("md.retry")}
          </Button>
        </div>
      ) : null}
      {page ? (
        <div ref={results} className="us-search-results">
          <details>
            <summary>{t("usSearch.applied")}</summary>
            <pre>{JSON.stringify(page.appliedFilters, null, 2)}</pre>
          </details>
          {page.items.length === 0 ? <p>{t("usSearch.empty")}</p> : null}
          {page.items.map((item, index) => {
            const source =
              item.source === null
                ? t("lots.absent")
                : item.source.kind === "location"
                  ? `${t("lots.location")} ${item.source.locationId}`
                  : `${item.source.referenceValue} · ${t("lots.resolvedLocation")} ${item.source.resolvedLocationId}`;
            return (
              <article key={item.lotId} className="us-search-hit">
                <h2>{item.tlc}</h2>
                <dl>
                  <dt>{t("usSearch.lotId")}</dt>
                  <dd>{item.lotId}</dd>
                  <dt>{t("usSearch.source")}</dt>
                  <dd>{source}</dd>
                  <dt>{t("usSearch.productId")}</dt>
                  <dd>
                    {names[item.productId]
                      ? `${names[item.productId]} · ${t("usSearch.currentProduct")}`
                      : t("usSearch.productUnavailable")}
                    <br />
                    {item.productId}
                  </dd>
                  <dt>{t("usSearch.status")}</dt>
                  <dd>{t(`lots.states.${item.status}`)}</dd>
                  <dt>{t("usSearch.ctes")}</dt>
                  <dd>{item.currentCteCount}</dd>
                  <dt>{t("usSearch.dates")}</dt>
                  <dd>
                    {civilDate(item.firstEventDate, i18n.language)} –{" "}
                    {civilDate(item.lastEventDate, i18n.language)}
                  </dd>
                  <dt>{t("usSearch.matched")}</dt>
                  <dd>
                    {item.matchedBy
                      .map((reason) => t(`usSearch.${reason === "tlc" ? "tlcMatch" : reason}`))
                      .join(" · ")}
                  </dd>
                </dl>
                {item.ssccLinks.length > 0 ? (
                  <section aria-label={t("usSearch.caseEvidence")}>
                    <h3>{t("usSearch.caseEvidence")}</h3>
                    {item.ssccLinks.map((link) => (
                      <div key={link.linkId}>
                        <p>
                          {link.ssccAtLink} · {t(`usSearch.${link.state}`)}
                        </p>
                        <p>{t(`usSearch.${link.provenance}`)}</p>
                        <p>
                          {t("usSearch.caseId")}: {link.boxId} · {t("usSearch.linkId")}:{" "}
                          {link.linkId}
                        </p>
                        <p>
                          {t("usSearch.linked")}: {link.linkedAt}
                        </p>
                        {link.unlinkedAt ? (
                          <p>
                            {t("usSearch.unlinked")}: {link.unlinkedAt}
                          </p>
                        ) : null}
                        {link.unlinkReason ? <p>{link.unlinkReason}</p> : null}
                      </div>
                    ))}
                  </section>
                ) : null}
                {item.moreCaseHistory ? <p>{t("usSearch.moreCases")}</p> : null}
                <Button
                  type="button"
                  data-lot-id={item.lotId}
                  onClick={() => {
                    onStateChange({ ...state, focusLotId: item.lotId });
                    onOpenLot(item.lotId);
                  }}
                >
                  {t("usSearch.open", { number: index + 1, source, id: item.lotId })}
                </Button>
              </article>
            );
          })}
          <nav aria-label={t("usSearch.pages")} className="us-md-pager">
            <Button
              type="button"
              variant="secondary"
              disabled={pending || state.pageIndex === 0}
              onClick={() =>
                onStateChange({ ...state, pageIndex: state.pageIndex - 1, focusLotId: null })
              }
            >
              {t("usSearch.previous")}
            </Button>
            <span>{t("md.page", { page: state.pageIndex + 1 })}</span>
            <Button
              type="button"
              variant="secondary"
              disabled={pending || !page.nextCursor}
              onClick={() => {
                if (page.nextCursor)
                  onStateChange({
                    ...state,
                    cursors: [...state.cursors.slice(0, state.pageIndex + 1), page.nextCursor],
                    pageIndex: state.pageIndex + 1,
                    focusLotId: null,
                  });
              }}
            >
              {t("usSearch.next")}
            </Button>
          </nav>
        </div>
      ) : null}
    </section>
  );
}
