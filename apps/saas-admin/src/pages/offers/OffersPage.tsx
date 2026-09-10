import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import {
  Alert,
  Button,
  DatePicker,
  Input,
  SectionHeader,
  Select,
  Spinner,
  StatusChip,
  Table,
} from "@markiro/ui";
import {
  platformOfferWorkspaceContracts,
  platformUuidSchema,
  type OfferRegistryQuery,
} from "@markiro/platform-contracts";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listOfferRegistry } from "./api.js";
import { OfferTenantFilter } from "./OfferTenantFilter.js";
import { offerDate, offerMoney, registryReturnTo } from "./offerPresentation.js";

const statuses = ["draft", "published", "paid", "superseded", "cancelled", "expired"] as const;

function nextMoscowMidnight(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T00:00:00+03:00`;
}

function inclusiveMoscowDay(exclusiveEnd: string | undefined): string {
  if (!exclusiveEnd) return "";
  // Read the last included instant in Moscow, including legacy end-of-day URLs.
  return new Date(new Date(exclusiveEnd).getTime() - 1 + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function OffersPage() {
  const [search] = useSearchParams();
  const location = useLocation();
  const selected = platformUuidSchema.safeParse(search.get("selected"));
  if (selected.success)
    return (
      <Navigate
        replace
        to={`/offers/${selected.data}`}
        state={{
          ...((location.state ?? {}) as object),
          returnTo: registryReturnTo(`/offers${location.search}`),
        }}
      />
    );
  return <OfferRegistryPage />;
}

function OfferRegistryPage() {
  const { t, i18n } = useTranslation();
  const principal = usePlatformPrincipal();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const [text, setText] = useState(search.get("search") ?? "");
  const parsed = platformOfferWorkspaceContracts.registry.query.safeParse(
    Object.fromEntries(
      [...search].filter(([key]) =>
        ["search", "tenantId", "status", "createdFrom", "createdTo", "page", "limit"].includes(key),
      ),
    ),
  );
  const query: OfferRegistryQuery = parsed.success ? parsed.data : { page: 1, limit: 25 };
  const canRead = principal.capabilities.includes("billing.read");
  const offers = useQuery({
    queryKey: ["platform", "offers", "registry", query],
    queryFn: () => listOfferRegistry(query),
    placeholderData: keepPreviousData,
    enabled: canRead && parsed.success,
  });
  useEffect(() => {
    setText(search.get("search") ?? "");
  }, [search]);
  useEffect(() => {
    if (text.trim() === (search.get("search") ?? "")) return;
    const timer = window.setTimeout(
      () =>
        setSearch(
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
  }, [text, search, setSearch]);
  function change(key: string, value: string) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("page");
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    });
  }
  const calendar = {
    locale: i18n.language,
    placeholder: t("reports.calendar.placeholder"),
    clearLabel: t("reports.calendar.clear"),
    calendarLabel: t("reports.calendar.title"),
    previousMonthLabel: t("reports.calendar.previousMonth"),
    nextMonthLabel: t("reports.calendar.nextMonth"),
  };
  return (
    <section className="catalog-page offers-page">
      <SectionHeader
        title={t("offers.title")}
        description={t("offers.description")}
        actionsLabel={t("offers.actionsLabel")}
        actions={
          principal.capabilities.includes("billing.write") ? (
            <Link to="/offers/new">{t("offers.create")}</Link>
          ) : undefined
        }
      />
      {!canRead ? (
        <Alert tone="error">{t("offerWorkspace.errors.forbidden")}</Alert>
      ) : (
        <>
          {!principal.capabilities.includes("billing.write") ? (
            <p className="offer-muted">{t("offerWorkspace.readOnly")}</p>
          ) : null}
          <div className="offer-filters">
            <Input
              label={t("offerWorkspace.search")}
              value={text}
              maxLength={200}
              onChange={(event) => setText(event.target.value)}
            />
            <OfferTenantFilter
              value={query.tenantId ?? ""}
              onChange={(value) => change("tenantId", value)}
            />
            <Select
              label={t("offers.status")}
              value={query.status ?? ""}
              options={[
                { value: "", label: t("offerWorkspace.allStatuses") },
                ...statuses.map((value) => ({ value, label: t(`offerWorkspace.status.${value}`) })),
              ]}
              onValueChange={(value) => change("status", value)}
            />
            <DatePicker
              {...calendar}
              label={t("offerWorkspace.createdFrom")}
              value={query.createdFrom?.slice(0, 10) ?? ""}
              onValueChange={(value) =>
                change("createdFrom", value ? `${value}T00:00:00+03:00` : "")
              }
            />
            <DatePicker
              {...calendar}
              label={t("offerWorkspace.createdTo")}
              value={inclusiveMoscowDay(query.createdTo)}
              onValueChange={(value) => change("createdTo", value ? nextMoscowMidnight(value) : "")}
            />
            <Button
              variant="secondary"
              disabled={!search.size && !text}
              onClick={() => {
                setText("");
                setSearch({});
              }}
            >
              {t("offerWorkspace.clearFilters")}
            </Button>
          </div>
          <p className="offer-muted">{t("offerWorkspace.periodTimezone")}</p>
          {!parsed.success ? (
            <Alert tone="error">{t("offerWorkspace.invalidFilters")}</Alert>
          ) : offers.isPending ? (
            <Spinner label={t("shell.routeLoading")} />
          ) : offers.error ? (
            <Alert tone="error">
              {t("offers.loadError")}{" "}
              <Button variant="secondary" onClick={() => void offers.refetch()}>
                {t("offerWorkspace.retry")}
              </Button>
            </Alert>
          ) : (
            <section
              className="commerce-ledger"
              aria-label={t("offers.registryTitle")}
              aria-busy={offers.isFetching}
            >
              <header className="commerce-ledger__header">
                <h2>{t("offers.registryTitle")}</h2>
                <span className="offer-money" aria-live="polite">
                  {t("offerWorkspace.count", { count: offers.data.total })}
                </span>
              </header>
              <Table
                scrollLabel={t("offerWorkspace.registryScroll")}
                rows={offers.data.items}
                empty={t("offerWorkspace.empty")}
                columns={[
                  {
                    key: "number",
                    title: t("offerWorkspace.offer"),
                    render: (offer) => (
                      <div className="offer-cell">
                        <Link
                          className="table-link"
                          to={`/offers/${offer.id}`}
                          state={{ returnTo: `/offers${location.search}` }}
                        >
                          {offer.number ?? t("offerWorkspace.status.draft")}
                        </Link>
                        <small>{t("offerWorkspace.revision", { revision: offer.revision })}</small>
                        <small>{offerDate(offer.createdAt, i18n.language)}</small>
                      </div>
                    ),
                  },
                  {
                    key: "tenantName",
                    title: t("offers.tenant"),
                    wrap: true,
                    render: (offer) => (
                      <div className="offer-cell">
                        <strong>{offer.tenantName}</strong>
                        <small>{offer.buyerLegalName ?? t("offerWorkspace.noRequisites")}</small>
                        {offer.buyerTaxId ? (
                          <small>
                            {t("offerWorkspace.inn")} {offer.buyerTaxId}
                          </small>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "lineSummary",
                    title: t("offerWorkspace.composition"),
                    wrap: true,
                    render: (offer) => (
                      <div className="offer-cell">
                        {offer.lineSummary.map((line, index) => (
                          <span key={index}>{line}</span>
                        ))}
                        {offer.lineCount > offer.lineSummary.length ? (
                          <small>
                            {t("offerWorkspace.moreLines", {
                              count: offer.lineCount - offer.lineSummary.length,
                            })}
                          </small>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    key: "total",
                    title: t("offers.total"),
                    mono: true,
                    align: "right",
                    render: (offer) => offerMoney(offer.total, i18n.language),
                  },
                  {
                    key: "status",
                    title: t("offers.status"),
                    render: (offer) => (
                      <StatusChip
                        status={
                          offer.status === "paid"
                            ? "ok"
                            : offer.status === "draft"
                              ? "neutral"
                              : "info"
                        }
                        label={t(`offerWorkspace.status.${offer.status}`)}
                      />
                    ),
                  },
                  {
                    key: "expiresAt",
                    title: t("offerWorkspace.expiresAt"),
                    render: (offer) =>
                      offerDate(offer.expiresAt, i18n.language) ?? t("offerWorkspace.noExpiry"),
                  },
                ]}
              />
              <footer className="offer-pagination">
                <Select
                  label={t("offerWorkspace.pageSize")}
                  value={String(query.limit)}
                  options={["25", "50", "100"]}
                  onValueChange={(value) => change("limit", value)}
                />
                <div className="offer-pagination__navigation">
                  <Button
                    variant="secondary"
                    disabled={query.page <= 1}
                    onClick={() =>
                      setSearch((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set("page", String(query.page - 1));
                        return next;
                      })
                    }
                  >
                    {t("offerWorkspace.previous")}
                  </Button>
                  <span>
                    {t("offerWorkspace.pageOf", {
                      page: offers.data.page,
                      pages: Math.max(1, Math.ceil(offers.data.total / offers.data.limit)),
                    })}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={query.page * query.limit >= offers.data.total}
                    onClick={() =>
                      setSearch((previous) => {
                        const next = new URLSearchParams(previous);
                        next.set("page", String(query.page + 1));
                        return next;
                      })
                    }
                  >
                    {t("offerWorkspace.next")}
                  </Button>
                </div>
              </footer>
            </section>
          )}
        </>
      )}
    </section>
  );
}
