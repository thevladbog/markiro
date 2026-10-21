import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  LANDING_LEAD_REQUEST_KINDS,
  LANDING_LEAD_STATUSES,
  platformLeadListQuerySchema,
} from "@markiro/platform-contracts";
import {
  Alert,
  Button,
  Card,
  DatePicker,
  EmptyState,
  Input,
  SectionHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
  type TableColumn,
} from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { leadKeys, listLeads, type LeadListItem } from "./api.js";
import { formatLeadDate, formatLeadDateTime, LEAD_STATUS_TO_PHASE } from "./leadFormat.js";

const PAGE_SIZE = 50;
const FILTER_KEYS = ["search", "status", "kind", "from", "to", "page"] as const;

export function LeadsPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("search") ?? "");
  const parsed = platformLeadListQuerySchema.safeParse({
    ...Object.fromEntries(
      [...params].filter(([key]) => (FILTER_KEYS as readonly string[]).includes(key)),
    ),
    limit: PAGE_SIZE,
  });
  const query = parsed.success ? parsed.data : { page: 1, limit: PAGE_SIZE };
  const canRead = principal.capabilities.includes("leads.read");
  const leads = useQuery({
    queryKey: leadKeys.list(query),
    queryFn: () => listLeads(query),
    placeholderData: keepPreviousData,
    enabled: canRead && parsed.success,
  });

  useEffect(() => {
    setText(params.get("search") ?? "");
  }, [params]);
  useEffect(() => {
    if (text.trim() === (params.get("search") ?? "")) return;
    const timer = window.setTimeout(
      () =>
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            next.delete("page");
            if (text.trim()) next.set("search", text.trim());
            else next.delete("search");
            return next;
          },
          { replace: true },
        ),
      350,
    );
    return () => window.clearTimeout(timer);
  }, [text, params, setParams]);

  function change(key: (typeof FILTER_KEYS)[number], value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (key !== "page") next.delete("page");
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }

  const language = i18n.resolvedLanguage ?? i18n.language;
  const calendar = {
    locale: i18n.language,
    placeholder: t("reports.calendar.placeholder"),
    clearLabel: t("reports.calendar.clear"),
    calendarLabel: t("reports.calendar.title"),
    previousMonthLabel: t("reports.calendar.previousMonth"),
    nextMonthLabel: t("reports.calendar.nextMonth"),
  };
  const filtered = FILTER_KEYS.some((key) => key !== "page" && params.has(key));

  const columns: TableColumn<LeadListItem>[] = [
    {
      key: "company",
      title: t("leads.columns.company"),
      wrap: true,
      minWidth: 220,
      render: (lead) => (
        <Link className="table-link" to={`/leads/${lead.id}`}>
          <span>{lead.company}</span>
          <small>
            {lead.anonymized ? t("leads.anonymizedShort") : (lead.email ?? "—")}
            {lead.inn ? ` · ${t("leads.innShort", { inn: lead.inn })}` : ""}
          </small>
        </Link>
      ),
    },
    {
      key: "lastEvent",
      title: t("leads.columns.lastEvent"),
      render: (lead) =>
        lead.lastEvent ? (
          <span className="leads-cell">
            <span>{t(`leads.eventKind.${lead.lastEvent.kind}`)}</span>
            <small>{formatLeadDateTime(lead.lastEvent.createdAt, language)}</small>
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "tariff",
      title: t("leads.columns.tariff"),
      mono: true,
      render: (lead) => lead.tariffCode ?? "—",
    },
    {
      key: "status",
      title: t("leads.columns.status"),
      render: (lead) => (
        <StatusChip
          phase={LEAD_STATUS_TO_PHASE[lead.status]}
          label={t(`leads.status.${lead.status}`)}
        />
      ),
    },
    {
      key: "nextTouch",
      title: t("leads.columns.nextTouch"),
      mono: true,
      render: (lead) => (lead.nextTouchAt ? formatLeadDate(lead.nextTouchAt, language) : "—"),
    },
  ];
  const pageCount = Math.max(1, Math.ceil((leads.data?.total ?? 0) / PAGE_SIZE));

  return (
    <section className="leads-page">
      <SectionHeader
        eyebrow="OPERATIONS / LEADS"
        title={t("leads.title")}
        description={t("leads.description")}
      />
      {!canRead ? (
        <Alert tone="error">{t("leads.forbidden")}</Alert>
      ) : (
        <>
          <form
            className="leads-filters"
            aria-label={t("leads.filters.label")}
            onSubmit={(event) => event.preventDefault()}
          >
            <Input
              label={t("leads.filters.search")}
              value={text}
              maxLength={200}
              type="search"
              onChange={(event) => setText(event.target.value)}
            />
            <Select
              label={t("leads.filters.status")}
              value={query.status ?? ""}
              options={[
                { value: "", label: t("leads.filters.allStatuses") },
                ...LANDING_LEAD_STATUSES.map((value) => ({
                  value,
                  label: t(`leads.status.${value}`),
                })),
              ]}
              onValueChange={(value) => change("status", value)}
            />
            <Select
              label={t("leads.filters.kind")}
              value={query.kind ?? ""}
              options={[
                { value: "", label: t("leads.filters.allKinds") },
                ...LANDING_LEAD_REQUEST_KINDS.map((value) => ({
                  value,
                  label: t(`leads.eventKind.${value}`),
                })),
              ]}
              onValueChange={(value) => change("kind", value)}
            />
            <DatePicker
              {...calendar}
              label={t("leads.filters.from")}
              value={query.from ?? ""}
              onValueChange={(value) => change("from", value ?? "")}
            />
            <DatePicker
              {...calendar}
              label={t("leads.filters.to")}
              value={query.to ?? ""}
              onValueChange={(value) => change("to", value ?? "")}
            />
            <Button
              variant="secondary"
              disabled={!filtered && !text}
              onClick={() => {
                setText("");
                setParams({});
              }}
            >
              {t("leads.filters.clear")}
            </Button>
          </form>
          <p className="leads-muted">{t("leads.filters.timezone")}</p>
          {!parsed.success ? (
            <Alert tone="error">{t("leads.filters.invalid")}</Alert>
          ) : leads.isPending ? (
            <div role="status">
              <Spinner label={t("leads.loading")} />
            </div>
          ) : leads.error ? (
            <Alert tone="error">
              {t("leads.loadError")}{" "}
              <Button size="compact" variant="secondary" onClick={() => void leads.refetch()}>
                {t("leads.retry")}
              </Button>
            </Alert>
          ) : leads.data.items.length === 0 ? (
            <Card padding={0}>
              <EmptyState
                title={t(filtered ? "leads.filteredEmpty.title" : "leads.empty.title")}
                hint={t(filtered ? "leads.filteredEmpty.hint" : "leads.empty.hint")}
              />
            </Card>
          ) : (
            <section
              className="commerce-ledger"
              aria-label={t("leads.registry")}
              aria-busy={leads.isFetching}
            >
              <header className="commerce-ledger__header">
                <h2>{t("leads.registry")}</h2>
                <span className="commerce-ledger__count" aria-live="polite">
                  {t("leads.count", { count: leads.data.total })}
                </span>
              </header>
              <Table
                scrollLabel={t("leads.tableRegion")}
                rows={leads.data.items}
                columns={columns}
                empty={t("leads.empty.title")}
                onRowClick={(lead) => void navigate(`/leads/${lead.id}`)}
              />
              {pageCount > 1 ? (
                <nav className="leads-pagination" aria-label={t("leads.pagination.label")}>
                  <Button
                    variant="secondary"
                    disabled={query.page <= 1}
                    onClick={() => change("page", query.page > 2 ? String(query.page - 1) : "")}
                  >
                    {t("leads.pagination.previous")}
                  </Button>
                  <span aria-live="polite">
                    {t("leads.pagination.page", { page: query.page, pageCount })}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={query.page >= pageCount}
                    onClick={() => change("page", String(query.page + 1))}
                  >
                    {t("leads.pagination.next")}
                  </Button>
                </nav>
              ) : null}
            </section>
          )}
        </>
      )}
    </section>
  );
}
