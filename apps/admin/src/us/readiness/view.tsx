import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Input, Select, StatusChip, Table, type TableColumn } from "@markiro/ui";
import type {
  UsProfileCode,
  UsReadinessFinding,
  UsReadinessQuery,
  UsReadinessResult,
} from "@markiro/platform-contracts";
import { usReadinessQuerySchema } from "@markiro/platform-contracts";
import { useTranslation } from "react-i18next";
import { UsClientError, type UsBrowserClient } from "../client.js";
import { relatedSourceTarget, sourceTarget, type ReadinessEventTarget } from "./source.js";
import { ReadinessScopePicker } from "./scope-controls.js";
import "./readiness.css";

const PAGE_SIZE = 100;
const GROUP_PAGE_SIZE = 100;

export function readinessSourceMatches(
  target: ReadinessEventTarget,
  record: { id: string; revision: number },
  lines: Partial<Record<"items" | "inputs" | "outputs", readonly { lineNo: number }[]>>,
) {
  return (
    record.id.toLowerCase() === target.eventId.toLowerCase() &&
    record.revision === target.revision &&
    (target.lineSide === null
      ? target.lineNo === null
      : lines[target.lineSide]?.some((line) => line.lineNo === target.lineNo) === true)
  );
}

export function useReadinessSourceFocus(
  target: ReadinessEventTarget | undefined,
  recordId?: string,
) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      !target ||
      recordId !== target.eventId ||
      target.lineSide === null ||
      target.lineNo === null
    )
      return;
    const line = ref.current?.querySelector<HTMLElement>(
      `[data-readiness-line="${target.lineSide}:${target.lineNo}"]`,
    );
    line?.focus();
    line?.scrollIntoView?.({ block: "center" });
  }, [target, recordId]);
  return ref;
}

export function ReadinessSourceNotice({ target }: { target: ReadinessEventTarget }) {
  const { t } = useTranslation();
  return (
    <p className="us-readiness-source-context" role="status">
      {t("usReadiness.sourceRevision", { revision: target.revision })}
      {target.lineSide !== null
        ? ` · ${t(`usReadiness.context${target.lineSide}`, { number: target.lineNo })}`
        : ""}
    </p>
  );
}

export const SourceBackLabelContext = createContext<string | undefined>(undefined);

export function ReadinessSourceError({
  onRetry,
  onBack,
  disabled = false,
}: {
  onRetry: () => void;
  onBack: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const backLabel = useContext(SourceBackLabelContext);
  return (
    <div className="us-readiness-source-context">
      <p role="alert">{t("usReadiness.sourceMismatch")}</p>
      <Button disabled={disabled} onClick={onRetry}>
        {t("usReadiness.retry")}
      </Button>
      <Button variant="secondary" disabled={disabled} onClick={onBack}>
        {backLabel ?? t("usReadiness.back")}
      </Button>
    </div>
  );
}
const ruleCodes = new Set([
  "required_kde",
  "invalid_kde",
  "invalid_date",
  "required_reference",
  "source_unresolved",
  "invalid_quantity",
  "invalid_uom",
  "event_lot_mismatch",
  "tlc_source_mismatch",
  "origin_gap",
  "coverage_unresolved",
  "exemption_review_required",
]);

type Props = {
  client: UsBrowserClient;
  profileCode: UsProfileCode;
  initialQuery: UsReadinessQuery;
  onQueryChange: (query: UsReadinessQuery) => void;
  onForbidden: () => void | Promise<void>;
  onSessionLost: () => void;
  onOpenLot: (lotId: string) => void;
  onOpenEvent: (target: ReadinessEventTarget) => void;
  onOpenEvents: () => void;
};

type GroupBy = "cte" | "product" | "severity";

function severityKey(value: UsReadinessFinding["severity"]): string {
  return value === "error"
    ? "errorSeverity"
    : value === "warning"
      ? "warningSeverity"
      : "infoSeverity";
}

export function ReadinessView({
  client,
  profileCode,
  initialQuery,
  onQueryChange,
  onForbidden,
  onSessionLost,
  onOpenLot,
  onOpenEvent,
  onOpenEvents,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState<UsReadinessQuery>(initialQuery);
  const [draft, setDraft] = useState({
    from: initialQuery.eventDateFrom ?? "",
    to: initialQuery.eventDateTo ?? "",
    productId: initialQuery.productId ?? "",
    lotId: initialQuery.lotId ?? "",
  });
  const [result, setResult] = useState<UsReadinessResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("cte");
  const [groupPage, setGroupPage] = useState(0);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [pickerReset, setPickerReset] = useState(0);
  const run = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const current = ++run.current;
    setLoading(true);
    setErrorKey(null);
    try {
      const next = await client.readReadiness(query);
      if (current !== run.current) return;
      setResult(next);
      setPage(0);
      setGroupPage(0);
    } catch (cause) {
      if (current !== run.current) return;
      if (cause instanceof UsClientError) {
        if (cause.code === "session_required") onSessionLost();
        if (cause.code === "forbidden") void onForbidden();
      }
      const key =
        cause instanceof UsClientError
          ? cause.code === "readiness_invalid_scope" || cause.code === "invalid_input"
            ? "invalidScope"
            : cause.code === "readiness_scope_too_large"
              ? "tooLarge"
              : cause.code === "readiness_scope_not_found"
                ? "notFound"
                : cause.code === "session_required"
                  ? "sessionLost"
                  : cause.code === "forbidden"
                    ? "forbidden"
                    : cause.code === "invalid_response"
                      ? "error"
                      : "unavailable"
          : "error";
      setErrorKey(key);
    } finally {
      if (current === run.current) setLoading(false);
    }
  }, [client, query, onForbidden, onSessionLost]);

  useEffect(() => {
    void load();
    return () => {
      run.current += 1;
    };
  }, [load, refresh]);
  useEffect(() => {
    if (errorKey) errorRef.current?.focus();
  }, [errorKey]);

  const visible = useMemo(
    () => result?.findings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) ?? [],
    [result, page],
  );
  const total = result?.findings.length ?? 0;
  const shown = Math.min((page + 1) * PAGE_SIZE, total);
  const totalGroups = result
    ? groupBy === "cte"
      ? result.groups.byCte.length
      : groupBy === "product"
        ? result.groups.byProduct.length
        : result.groups.bySeverity.length
    : 0;
  const groupsShown = Math.min((groupPage + 1) * GROUP_PAGE_SIZE, totalGroups);
  const groups = useMemo(() => {
    if (!result) return [];
    const start = groupPage * GROUP_PAGE_SIZE;
    const end = start + GROUP_PAGE_SIZE;
    if (groupBy === "cte")
      return result.groups.byCte.slice(start, end).map(({ cte, count }) => ({
        key: cte ?? "lot",
        label: t(`usReadiness.${cte ?? "noCte"}`),
        count,
      }));
    if (groupBy === "product")
      return result.groups.byProduct.slice(start, end).map(({ productId, count }) => ({
        key: productId ?? "none",
        label: productId ?? t("usReadiness.noProduct"),
        count,
      }));
    return result.groups.bySeverity.slice(start, end).map(({ severity, count }) => ({
      key: severity,
      label: t(`usReadiness.${severityKey(severity)}`),
      count,
    }));
  }, [result, groupBy, groupPage, t]);

  const columns: TableColumn<UsReadinessFinding>[] = [
    {
      key: "severity",
      title: t("usReadiness.severity"),
      render: (row) => (
        <StatusChip
          status={row.severity === "error" ? "error" : row.severity === "warning" ? "warn" : "info"}
          label={t(`usReadiness.${severityKey(row.severity)}`)}
        />
      ),
    },
    {
      key: "cte",
      title: t("usReadiness.cte"),
      render: (row) => t(`usReadiness.${row.cte ?? "noCte"}`),
    },
    {
      key: "product",
      title: t("usReadiness.product"),
      mono: true,
      render: (row) => row.productId ?? "—",
    },
    { key: "field", title: t("usReadiness.field"), mono: true, render: (row) => row.field },
    {
      key: "message",
      title: t("usReadiness.message"),
      wrap: true,
      render: (row) => (
        <span>
          {ruleCodes.has(row.code)
            ? t(`usReadiness.rules.${row.code}`)
            : t("usReadiness.reviewSource")}{" "}
          <code>
            {row.code} · {row.field}
          </code>
        </span>
      ),
    },
    {
      key: "source",
      title: t("usReadiness.source"),
      render: (row) => {
        const event = sourceTarget(row);
        const relatedEvent = relatedSourceTarget(row);
        const lotId = row.lotId;
        const line =
          row.lineSide && row.lineNo
            ? ` · ${t(`usReadiness.line${row.lineSide[0]?.toUpperCase()}${row.lineSide.slice(1)}`, { number: row.lineNo })}`
            : "";
        return (
          <span className="us-readiness-source">
            {event && row.eventNumber ? (
              <Button
                variant="secondary"
                size="compact"
                onFocus={(focusEvent) =>
                  focusEvent.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })
                }
                onClick={() => onOpenEvent(event)}
              >
                {t("usReadiness.event", { number: row.eventNumber, revision: row.revision })}
                {line}
              </Button>
            ) : null}
            {lotId ? (
              <Button
                variant="secondary"
                size="compact"
                onFocus={(focusEvent) =>
                  focusEvent.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })
                }
                onClick={() => onOpenLot(lotId)}
              >
                {t("usReadiness.openLot")} {lotId}
              </Button>
            ) : null}
            {relatedEvent && row.relatedEvent ? (
              <Button
                variant="secondary"
                size="compact"
                onFocus={(focusEvent) =>
                  focusEvent.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" })
                }
                onClick={() => onOpenEvent(relatedEvent)}
              >
                {t("usReadiness.relatedOrigin", {
                  number: row.relatedEvent.eventNumber,
                  revision: row.relatedEvent.revision,
                })}
              </Button>
            ) : null}
          </span>
        );
      },
    },
  ];

  function applyScope() {
    const next: UsReadinessQuery = {
      ...(draft.from ? { eventDateFrom: draft.from } : {}),
      ...(draft.to ? { eventDateTo: draft.to } : {}),
      ...(draft.productId ? { productId: draft.productId } : {}),
      ...(draft.lotId ? { lotId: draft.lotId } : {}),
    };
    const checked = usReadinessQuerySchema.safeParse(next);
    if (!checked.success) {
      const issue = checked.error.issues[0]?.message;
      setInputError(
        issue === "Both event dates are required together"
          ? "bothDates"
          : issue === "Reversed event-date range"
            ? "dateOrder"
            : issue === "Event-date range exceeds 24 calendar months"
              ? "dateWindow"
              : "invalidScope",
      );
      return;
    }
    setInputError(null);
    setQuery(checked.data);
    onQueryChange(checked.data);
    if (JSON.stringify(next) === JSON.stringify(query)) setRefresh((value) => value + 1);
  }

  function resetScope() {
    setDraft({ from: "", to: "", productId: "", lotId: "" });
    setPickerReset((value) => value + 1);
    setInputError(null);
    setQuery({});
    onQueryChange({});
    if (Object.keys(query).length === 0) setRefresh((value) => value + 1);
  }

  return (
    <section className="us-readiness-page" aria-busy={loading}>
      <header className="us-md-page-header">
        <div>
          <h1 tabIndex={-1}>{t("usReadiness.title")}</h1>
          <p>{t("usReadiness.intro")}</p>
        </div>
      </header>
      {profileCode === "US_GENERIC_LOT_TRACEABILITY" ? (
        <p className="us-readiness-banner">{t("usReadiness.genericBanner")}</p>
      ) : null}
      <p className="us-readiness-note">{t("usReadiness.manualReview")}</p>
      <form
        className="us-readiness-scope"
        onSubmit={(event) => {
          event.preventDefault();
          applyScope();
        }}
      >
        <h2>{t("usReadiness.scope")}</h2>
        {result && (loading || errorKey) ? (
          <p className="us-readiness-previous-label">{t("usReadiness.previousScope")}</p>
        ) : null}
        <p className="us-readiness-applied-scope">
          {result
            ? `${result.scope.defaulted ? `${t("usReadiness.defaultScope")} · ` : ""}${result.scope.eventDateFrom} – ${result.scope.eventDateTo}`
            : ""}
        </p>
        {result?.scope.productId ? (
          <p>
            {t("usReadiness.product")}: {result.scope.productId}
          </p>
        ) : null}
        {result?.scope.lotId ? (
          <p>
            {t("usReadiness.lot")}: {result.scope.lotId}
          </p>
        ) : null}
        <div className="us-readiness-filters">
          <Input
            type="date"
            label={t("usReadiness.from")}
            value={draft.from}
            onChange={(event) => setDraft((old) => ({ ...old, from: event.target.value }))}
          />
          <Input
            type="date"
            label={t("usReadiness.to")}
            value={draft.to}
            onChange={(event) => setDraft((old) => ({ ...old, to: event.target.value }))}
          />
          <ReadinessScopePicker
            key={`product-${pickerReset}`}
            client={client}
            kind="product"
            value={draft.productId}
            onChange={(productId) => setDraft((old) => ({ ...old, productId }))}
            onSessionLost={onSessionLost}
            onForbidden={onForbidden}
          />
          <ReadinessScopePicker
            key={`lot-${pickerReset}`}
            client={client}
            kind="lot"
            value={draft.lotId}
            onChange={(lotId) => setDraft((old) => ({ ...old, lotId }))}
            onSessionLost={onSessionLost}
            onForbidden={onForbidden}
          />
          <div className="us-readiness-actions">
            <Button type="submit">{t("usReadiness.apply")}</Button>
            <Button type="button" variant="secondary" onClick={resetScope}>
              {t("usReadiness.reset")}
            </Button>
          </div>
        </div>
        {inputError ? (
          <p role="alert" className="us-readiness-validation">
            {t(`usReadiness.${inputError}`)}
          </p>
        ) : null}
      </form>
      <div role="status" aria-live="polite" className="us-readiness-status">
        {loading ? t(result ? "usReadiness.refreshing" : "usReadiness.loading") : null}
      </div>
      {errorKey ? (
        <div ref={errorRef} tabIndex={-1} role="alert" className="us-readiness-error">
          <p>{t(`usReadiness.${errorKey}`)}</p>
          <Button onClick={() => setRefresh((value) => value + 1)}>{t("usReadiness.retry")}</Button>
        </div>
      ) : null}
      {result && !errorKey ? (
        <div
          className={loading ? "us-readiness-previous" : ""}
          aria-label={loading ? t("usReadiness.previousResult") : undefined}
        >
          <dl className="us-readiness-metrics">
            <div>
              <dt>{t("usReadiness.events")}</dt>
              <dd>{result.recordsChecked.events}</dd>
            </div>
            <div>
              <dt>{t("usReadiness.lots")}</dt>
              <dd>{result.recordsChecked.lots}</dd>
            </div>
            <div>
              <dt>{t("usReadiness.errors")}</dt>
              <dd>{result.counts.error}</dd>
            </div>
            <div>
              <dt>{t("usReadiness.warnings")}</dt>
              <dd>{result.counts.warning}</dd>
            </div>
            <div>
              <dt>{t("usReadiness.infos")}</dt>
              <dd>{result.counts.info}</dd>
            </div>
          </dl>
          <p className="us-readiness-dependencies">
            {t("usReadiness.dependencies", { count: result.dependenciesChecked })}
          </p>
          {result.state === "empty" ? (
            <p>{t("usReadiness.empty")}</p>
          ) : result.findings.length === 0 ? (
            <p>{t("usReadiness.zero")}</p>
          ) : (
            <section aria-label={t("usReadiness.findings")}>
              <div className="us-readiness-groups">
                <Select
                  native
                  label={t("usReadiness.groupBy")}
                  value={groupBy}
                  onValueChange={(value) => {
                    setGroupBy(value);
                    setGroupPage(0);
                  }}
                  options={(["cte", "product", "severity"] as const).map((value) => ({
                    value,
                    label: t(`usReadiness.${value}`),
                  }))}
                />
                <div
                  role="group"
                  aria-label={t("usReadiness.groups")}
                  className="us-readiness-group-list"
                >
                  {groups.map((group) => (
                    <span key={group.key}>
                      {group.label} · {group.count}
                    </span>
                  ))}
                </div>
              </div>
              {totalGroups > GROUP_PAGE_SIZE ? (
                <div className="us-readiness-group-pager">
                  <span>
                    {t("usReadiness.groupsShown", {
                      from: groupPage * GROUP_PAGE_SIZE + 1,
                      to: groupsShown,
                      total: totalGroups,
                    })}
                  </span>
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={groupPage === 0}
                    onClick={() => setGroupPage((value) => value - 1)}
                  >
                    {t("usReadiness.previousGroups")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={groupsShown === totalGroups}
                    onClick={() => setGroupPage((value) => value + 1)}
                  >
                    {t("usReadiness.nextGroups")}
                  </Button>
                </div>
              ) : null}
              <Table
                columns={columns}
                rows={visible}
                getRowKey={(row) => row.key}
                scrollLabel={t("usReadiness.findings")}
              />
              <div className="us-readiness-pager">
                <span>
                  {t("usReadiness.shown", { from: page * PAGE_SIZE + 1, to: shown, total })}
                </span>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                >
                  {t("usReadiness.previous")}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={shown === total}
                  onClick={() => setPage((value) => value + 1)}
                >
                  {t("usReadiness.next")}
                </Button>
              </div>
            </section>
          )}
          {result.draftWork.total > 0 ? (
            <section
              role="region"
              aria-label={t("usReadiness.drafts")}
              className="us-readiness-drafts"
            >
              <h2>{t("usReadiness.drafts")}</h2>
              <p>{t("usReadiness.draftsIntro")}</p>
              <p>
                {t("usReadiness.draftsShown", {
                  shown: result.draftWork.items.length,
                  total: result.draftWork.total,
                })}
              </p>
              <ul>
                {result.draftWork.items.map((draft) => (
                  <li key={draft.eventId}>
                    <Button
                      variant="secondary"
                      size="compact"
                      onClick={() =>
                        onOpenEvent({
                          type: draft.cte,
                          eventId: draft.eventId,
                          revision: draft.revision,
                          lineSide: null,
                          lineNo: null,
                        })
                      }
                    >
                      {t("usReadiness.event", {
                        number: draft.eventNumber,
                        revision: draft.revision,
                      })}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button variant="secondary" onClick={onOpenEvents}>
                {t("usReadiness.viewEvents")}
              </Button>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
