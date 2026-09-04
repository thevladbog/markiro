import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, EmptyState, Pager } from "@markiro/ui";

import {
  exportChannelJournal,
  useChannelJournal,
  type ChannelState,
  type JournalPageResponse,
  type JournalQuery,
  type JournalSessionDto,
} from "./api.js";
import { JournalFilters } from "./JournalFilters.js";
import { JournalSessionRow } from "./JournalSessionRow.js";
import "./journal.css";

const DEFAULT_QUERY: JournalQuery = {
  page: 1,
  pageSize: 20,
  outcome: "all",
  direction: "all",
  period: "30d",
};

function isDefaultFilter(query: JournalQuery): boolean {
  return query.outcome === "all" && query.direction === "all" && query.period === "30d";
}

function groupSessions(
  sessions: JournalSessionDto[],
  locale: string,
  timeZone: string,
): { label: string; sessions: JournalSessionDto[] }[] {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone });
  const groups: { label: string; sessions: JournalSessionDto[] }[] = [];
  for (const session of sessions) {
    const label = formatter.format(new Date(session.startedAt));
    const current = groups.at(-1);
    if (current?.label === label) current.sessions.push(session);
    else groups.push({ label, sessions: [session] });
  }
  return groups;
}

function JournalSkeleton({ label }: { label: string }) {
  return (
    <div className="mk-journal-skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function JournalList({ type, channelState }: { type: string; channelState: ChannelState }) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState<JournalQuery>(DEFAULT_QUERY);
  const [lastSuccess, setLastSuccess] = useState<
    { type: string; data: JournalPageResponse } | undefined
  >();
  const [exportState, setExportState] = useState<"idle" | "loading" | "error">("idle");
  const journal = useChannelJournal(type, query);
  const data = journal.data;
  const displayData = data ?? (lastSuccess?.type === type ? lastSuccess.data : undefined);
  const totalItems = displayData?.pageInfo.totalItems ?? 0;
  const groups = useMemo(
    () =>
      groupSessions(
        displayData?.sessions ?? [],
        i18n.language,
        displayData?.timeZone ?? "Europe/Moscow",
      ),
    [displayData, i18n.language],
  );

  useEffect(() => {
    if (data) setLastSuccess({ type, data });
  }, [data, type]);

  useEffect(() => {
    if (!data || data.pageInfo.totalPages === 0 || query.page <= data.pageInfo.totalPages) return;
    setQuery((current) => ({ ...current, page: Math.max(1, data.pageInfo.totalPages) }));
  }, [data, query.page]);

  const reset = () => setQuery(DEFAULT_QUERY);
  const changeFilters = (patch: Partial<JournalQuery>) => {
    setQuery((current) => ({ ...current, ...patch, page: 1 }));
  };
  const exportJournal = async () => {
    setExportState("loading");
    try {
      await exportChannelJournal(type, query);
      setExportState("idle");
    } catch {
      setExportState("error");
    }
  };

  return (
    <Card title={t("pages.integrations.channel.journal.title")} className="mk-journal" padding={0}>
      <div className="mk-journal__controls">
        <div className="mk-journal__toolbar">
          <Button
            type="button"
            variant="secondary"
            size="compact"
            loading={exportState === "loading"}
            disabled={totalItems === 0 || journal.isFetching || exportState === "loading"}
            onClick={() => void exportJournal()}
          >
            {exportState === "loading"
              ? t("pages.integrations.channel.journal.exporting")
              : t("pages.integrations.channel.journal.export")}
          </Button>
        </div>
        {exportState === "error" ? (
          <Alert tone="error">{t("pages.integrations.channel.journal.exportError")}</Alert>
        ) : null}
        <JournalFilters
          channelState={channelState}
          value={query}
          totalItems={totalItems}
          disabled={journal.isFetching}
          onChange={changeFilters}
          onReset={reset}
        />
      </div>

      <div className="mk-journal__content" aria-busy={journal.isFetching || undefined}>
        {journal.isPending && !displayData ? (
          <JournalSkeleton label={t("common.loading")} />
        ) : journal.isError && !displayData ? (
          <Alert
            tone="error"
            action={
              <Button
                type="button"
                variant="secondary"
                size="compact"
                onClick={() => void journal.refetch()}
              >
                {t("pages.integrations.channel.journal.retry")}
              </Button>
            }
          >
            {t("pages.integrations.channel.journal.loadError")}
          </Alert>
        ) : (
          <>
            {journal.isError && displayData ? (
              <Alert
                tone="warn"
                action={
                  <Button
                    type="button"
                    variant="secondary"
                    size="compact"
                    onClick={() => void journal.refetch()}
                  >
                    {t("pages.integrations.channel.journal.retry")}
                  </Button>
                }
              >
                {t("pages.integrations.channel.journal.refreshError")}
              </Alert>
            ) : null}
            {journal.isFetching && displayData ? (
              <p className="mk-journal__refreshing" role="status">
                {t("pages.integrations.channel.journal.refreshing")}
              </p>
            ) : null}

            {displayData?.sessions.length === 0 ? (
              isDefaultFilter(query) && query.page === 1 ? (
                <EmptyState
                  title={t("pages.integrations.channel.journal.emptyTitle")}
                  hint={t("pages.integrations.channel.journal.emptyHint")}
                />
              ) : (
                <EmptyState
                  title={t("pages.integrations.channel.journal.filteredEmptyTitle")}
                  hint={t("pages.integrations.channel.journal.filteredEmptyHint")}
                  action={
                    <Button type="button" variant="secondary" onClick={reset}>
                      {t("pages.integrations.channel.journal.reset")}
                    </Button>
                  }
                />
              )
            ) : (
              <div className="mk-journal-days">
                {groups.map((group) => (
                  <section className="mk-journal-day" key={group.label}>
                    <h3>{group.label}</h3>
                    <ol className="mk-journal-day__sessions">
                      {group.sessions.map((session) => (
                        <JournalSessionRow
                          key={session.id}
                          session={session}
                          locale={i18n.language}
                          timeZone={displayData?.timeZone ?? "Europe/Moscow"}
                        />
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}

            {totalItems > 0 ? (
              <fieldset className="mk-journal__pager" disabled={journal.isFetching}>
                <Pager
                  page={query.page}
                  pageCount={Math.max(1, displayData?.pageInfo.totalPages ?? 1)}
                  onPageChange={(page) => setQuery((current) => ({ ...current, page }))}
                  ariaLabel={t("pages.integrations.channel.journal.pagination.label")}
                  previousLabel={t("pages.integrations.channel.journal.pagination.previous")}
                  nextLabel={t("pages.integrations.channel.journal.pagination.next")}
                  pageLabel={(page, count) =>
                    t("pages.integrations.channel.journal.pagination.page", { page, count })
                  }
                />
              </fieldset>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
