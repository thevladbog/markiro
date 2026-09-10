import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Input,
  RadioGroup,
  SectionHeader,
  Select,
  StatusChip,
  Table,
} from "@markiro/ui";
import {
  platformReportInputSchema,
  type PlatformReport,
  type PlatformReportInput,
} from "@markiro/platform-contracts";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { listTenants } from "../tenants/api.js";
import { createReport, downloadReport, listReportOptions, listReports } from "./api.js";

const defaultTimezone = "Europe/Moscow";
const isoToday = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: defaultTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
type PlatformReportType = PlatformReportInput["reportType"];
type PlatformReportPrivacy = PlatformReportInput["privacy"];

function statusTone(status: PlatformReport["status"]) {
  if (status === "ready") return "ok" as const;
  if (status === "failed") return "error" as const;
  if (status === "expired") return "neutral" as const;
  return "info" as const;
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const calendarProps = {
    locale: i18n.language,
    placeholder: t("reports.calendar.placeholder"),
    clearLabel: t("reports.calendar.clear"),
    calendarLabel: t("reports.calendar.title"),
    previousMonthLabel: t("reports.calendar.previousMonth"),
    nextMonthLabel: t("reports.calendar.nextMonth"),
  };
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const canRead = principal.capabilities.includes("reports.read");
  const canCreate = principal.capabilities.includes("reports.create");
  const canDownload = principal.capabilities.includes("reports.download");
  const canIdentify = principal.capabilities.includes("reports.identified");
  const [tenantPage, setTenantPage] = useState(1);
  const [reportType, setReportType] = useState<PlatformReportType>("shifts");
  const [tenantIds, setTenantIds] = useState<string[]>([]);
  const [initialDate] = useState(isoToday);
  const [fromDate, setFromDate] = useState(initialDate);
  const [toDate, setToDate] = useState(initialDate);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [periodBasis, setPeriodBasis] = useState<"events" | "production_date">("events");
  const [privacy, setPrivacy] = useState<PlatformReportPrivacy>("pseudonymous");
  const [status, setStatus] = useState<string>("");
  const [outcome, setOutcome] = useState<string>("");
  const [lineId, setLineId] = useState("");
  const [productId, setProductId] = useState("");
  const [operatorId, setOperatorId] = useState("");
  const [gtin14, setGtin14] = useState("");
  const [optionSearch, setOptionSearch] = useState("");
  const [optionOffsets, setOptionOffsets] = useState({ lines: 0, products: 0, operators: 0 });
  const [historyOffset, setHistoryOffset] = useState(0);
  const [submitError, setSubmitError] = useState(false);
  const [validationError, setValidationError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [deadlineNow, setDeadlineNow] = useState(() => Date.now());
  const [deliveryAttempt, setDeliveryAttempt] = useState<{
    input: PlatformReportInput;
    key: string;
  } | null>(null);

  const tenants = useQuery({
    queryKey: ["platform", principal.userId, "report-tenants", tenantPage],
    queryFn: () => listTenants({ page: tenantPage, limit: 50 }),
    enabled: canRead,
  });
  const history = useQuery({
    queryKey: ["platform", principal.userId, "reports", historyOffset],
    queryFn: () => listReports(historyOffset),
    enabled: canRead,
    refetchInterval: (query) =>
      query.state.data?.items.some((report) => ["queued", "processing"].includes(report.status))
        ? 3_000
        : false,
  });
  const useReportOption = (kind: "lines" | "products" | "operators", enabled: boolean) =>
    useQuery({
      queryKey: [
        "platform",
        principal.userId,
        "report-options",
        tenantIds,
        kind,
        optionSearch,
        optionOffsets[kind],
      ],
      queryFn: () =>
        listReportOptions({ tenantIds, kind, search: optionSearch, offset: optionOffsets[kind] }),
      enabled,
    });
  const optionQueries = {
    lines: useReportOption("lines", canRead && tenantIds.length > 0 && reportType !== "commerceml"),
    products: useReportOption(
      "products",
      canRead && tenantIds.length > 0 && reportType !== "commerceml",
    ),
    operators: useReportOption(
      "operators",
      canIdentify &&
        tenantIds.length > 0 &&
        ["shifts", "shift_operators"].includes(reportType) &&
        privacy !== "aggregate",
    ),
  };
  const create = useMutation({
    mutationFn: ({ input, key }: { input: PlatformReportInput; key: string }) =>
      createReport(input, key),
    onSuccess: async () => {
      setSubmitError(false);
      setValidationError(false);
      await queryClient.invalidateQueries({ queryKey: ["platform", principal.userId, "reports"] });
    },
    onError: () => setSubmitError(true),
  });
  const download = useMutation({
    mutationFn: downloadReport,
    onSuccess: async ({ url }) => {
      setActionError(false);
      window.location.assign(url);
      await queryClient.invalidateQueries({ queryKey: ["platform", principal.userId, "reports"] });
    },
    onError: async () => {
      setActionError(true);
      await queryClient.invalidateQueries({ queryKey: ["platform", principal.userId, "reports"] });
    },
  });

  useEffect(() => {
    const nextExpiry = history.data?.items
      .filter((report) => report.status === "ready")
      .map((report) => new Date(report.expiresAt).getTime())
      .filter((expiresAt) => expiresAt > Date.now())
      .sort((left, right) => left - right)[0];
    if (nextExpiry === undefined) return;
    const timer = window.setTimeout(() => setDeadlineNow(Date.now()), nextExpiry - Date.now() + 10);
    return () => window.clearTimeout(timer);
  }, [deadlineNow, history.data?.items]);

  const selectedNames = useMemo(
    () => new Map((tenants.data?.items ?? []).map((tenant) => [tenant.id, tenant.name])),
    [tenants.data?.items],
  );

  if (!canRead) {
    return (
      <section className="platform-page">
        <SectionHeader eyebrow="PLATFORM / REPORTS" title={t("reports.title")} />
        <Alert tone="error">{t("reports.forbidden")}</Alert>
      </section>
    );
  }

  const changeType = (next: PlatformReportType) => {
    setReportType(next);
    setStatus("");
    setOutcome("");
    setLineId("");
    setProductId("");
    setOperatorId("");
    setGtin14("");
    setOptionOffsets({ lines: 0, products: 0, operators: 0 });
    if (!(["shifts", "shift_operators"] as PlatformReportType[]).includes(next)) {
      setPeriodBasis("events");
    }
  };
  const submit = () => {
    const input: Record<string, unknown> = {
      reportType,
      tenantIds,
      fromDate,
      toDate,
      timezone,
      periodBasis,
      privacy,
    };
    if (status) input.status = status;
    if (outcome) input.outcome = outcome;
    if (lineId) input.lineId = lineId;
    if (productId) input.productId = productId;
    if (operatorId) input.operatorId = operatorId;
    if (gtin14) input.gtin14 = gtin14;
    const parsed = platformReportInputSchema.safeParse(input);
    if (!parsed.success) {
      setValidationError(true);
      return;
    }
    const attempt = { input: parsed.data, key: crypto.randomUUID() };
    setDeliveryAttempt(attempt);
    create.mutate(attempt);
  };
  const retry = (report: PlatformReport) => {
    const attempt = { input: report.parameters, key: crypto.randomUUID() };
    setDeliveryAttempt(attempt);
    create.mutate(attempt);
  };

  return (
    <section className="platform-page reports-page">
      <SectionHeader
        eyebrow="PLATFORM / REPORTS"
        title={t("reports.title")}
        description={t("reports.description")}
      />
      <form
        className="report-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset>
          <legend>{t("reports.sections.report")}</legend>
          <Select<PlatformReportType>
            label={t("reports.fields.template")}
            value={reportType}
            onValueChange={changeType}
            options={(
              ["shifts", "shift_operators", "inventories", "summary", "commerceml"] as const
            ).map((value) => ({ value, label: t(`reports.types.${value}`) }))}
          />
          <div className="report-tenants">
            <span>{t("reports.fields.tenants")}</span>
            {(tenants.data?.items ?? []).map((tenant) => (
              <Checkbox
                key={tenant.id}
                label={tenant.name}
                checked={tenantIds.includes(tenant.id)}
                onCheckedChange={(checked) => {
                  setLineId("");
                  setProductId("");
                  setOperatorId("");
                  setOptionOffsets({ lines: 0, products: 0, operators: 0 });
                  setTenantIds((current) =>
                    checked
                      ? [...current, tenant.id].slice(0, 10)
                      : current.filter((id) => id !== tenant.id),
                  );
                }}
              />
            ))}
            <div className="report-pagination">
              <Button
                type="button"
                variant="secondary"
                disabled={tenantPage === 1}
                onClick={() => setTenantPage((page) => page - 1)}
              >
                {t("reports.previous")}
              </Button>
              <span>{tenantPage}</span>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  (tenants.data?.items.length ?? 0) === 0 ||
                  tenantPage * 50 >= (tenants.data?.total ?? 0)
                }
                onClick={() => setTenantPage((page) => page + 1)}
              >
                {t("reports.next")}
              </Button>
            </div>
            {tenants.isPending ? <span role="status">{t("reports.loadingTenants")}</span> : null}
            {tenants.error ? <Alert tone="error">{t("reports.tenantError")}</Alert> : null}
          </div>
        </fieldset>
        <fieldset className="report-form__grid">
          <legend>{t("reports.sections.period")}</legend>
          <DatePicker
            {...calendarProps}
            label={t("reports.fields.from")}
            name="fromDate"
            value={fromDate}
            onValueChange={(value) => setFromDate(value ?? "")}
          />
          <DatePicker
            {...calendarProps}
            label={t("reports.fields.to")}
            name="toDate"
            value={toDate}
            onValueChange={(value) => setToDate(value ?? "")}
          />
          <Input
            label={t("reports.fields.timezone")}
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
          />
          <Select<"events" | "production_date">
            label={t("reports.fields.basis")}
            value={periodBasis}
            onValueChange={setPeriodBasis}
            options={[
              { value: "events", label: t("reports.basis.events") },
              ...(["shifts", "shift_operators"].includes(reportType)
                ? [{ value: "production_date" as const, label: t("reports.basis.production_date") }]
                : []),
            ]}
          />
        </fieldset>
        <fieldset className="report-form__grid">
          <legend>{t("reports.sections.filters")}</legend>
          {reportType === "commerceml" ? (
            <Select
              label={t("reports.fields.outcome")}
              value={outcome}
              onValueChange={setOutcome}
              options={[
                { value: "", label: t("reports.any") },
                ...["ok", "warn", "error"].map((value) => ({
                  value,
                  label: t(`reports.outcomes.${value}`),
                })),
              ]}
            />
          ) : (
            <>
              <Input
                label={t("reports.fields.optionSearch")}
                value={optionSearch}
                onChange={(event) => {
                  setOptionSearch(event.target.value);
                  setOptionOffsets({ lines: 0, products: 0, operators: 0 });
                  setLineId("");
                  setProductId("");
                  setOperatorId("");
                }}
              />
              <div className="report-option-field">
                <Select
                  label={t("reports.fields.line")}
                  value={lineId}
                  onValueChange={setLineId}
                  options={[
                    { value: "", label: t("reports.any") },
                    ...(optionQueries.lines.data?.items ?? []).map((option) => ({
                      value: option.id,
                      label: option.name,
                    })),
                  ]}
                />
                {optionQueries.lines.data?.nextOffset != null ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setLineId("");
                      setOptionOffsets((value) => ({
                        ...value,
                        lines: optionQueries.lines.data!.nextOffset!,
                      }));
                    }}
                  >
                    {t("reports.moreOptions")}
                  </Button>
                ) : null}
              </div>
              <div className="report-option-field">
                <Select
                  label={t("reports.fields.product")}
                  value={productId}
                  onValueChange={setProductId}
                  options={[
                    { value: "", label: t("reports.any") },
                    ...(optionQueries.products.data?.items ?? []).map((option) => ({
                      value: option.id,
                      label: option.name,
                    })),
                  ]}
                />
                {optionQueries.products.data?.nextOffset != null ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setProductId("");
                      setOptionOffsets((value) => ({
                        ...value,
                        products: optionQueries.products.data!.nextOffset!,
                      }));
                    }}
                  >
                    {t("reports.moreOptions")}
                  </Button>
                ) : null}
              </div>
              <Input
                label={t("reports.fields.gtin14")}
                mono
                inputMode="numeric"
                pattern="[0-9]{14}"
                value={gtin14}
                onChange={(event) => setGtin14(event.target.value)}
              />
              {reportType !== "summary" ? (
                <Select
                  label={t("reports.fields.status")}
                  value={status}
                  onValueChange={setStatus}
                  options={[
                    { value: "", label: t("reports.any") },
                    ...(reportType === "inventories"
                      ? [
                          "draft",
                          "preparing",
                          "ready",
                          "cancelled",
                          "running",
                          "closed",
                          "completed",
                        ]
                      : ["planned", "active", "closed"]
                    ).map((value) => ({ value, label: t(`reports.filterStatuses.${value}`) })),
                  ]}
                />
              ) : null}
              {canIdentify &&
              ["shifts", "shift_operators"].includes(reportType) &&
              privacy !== "aggregate" ? (
                <div className="report-option-field">
                  <Select
                    label={t("reports.fields.operator")}
                    value={operatorId}
                    onValueChange={setOperatorId}
                    options={[
                      { value: "", label: t("reports.any") },
                      ...(optionQueries.operators.data?.items ?? []).map((option) => ({
                        value: option.id,
                        label: option.name,
                      })),
                    ]}
                  />
                  {optionQueries.operators.data?.nextOffset != null ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setOperatorId("");
                        setOptionOffsets((value) => ({
                          ...value,
                          operators: optionQueries.operators.data!.nextOffset!,
                        }));
                      }}
                    >
                      {t("reports.moreOptions")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          {[optionQueries.lines, optionQueries.products, optionQueries.operators].some(
            (query) => query.error,
          ) ? (
            <Alert tone="error">{t("reports.optionError")}</Alert>
          ) : null}
        </fieldset>
        <fieldset>
          <legend>{t("reports.sections.privacy")}</legend>
          <RadioGroup
            aria-label={t("reports.sections.privacy")}
            name="privacy"
            value={privacy}
            options={["pseudonymous", "aggregate", ...(canIdentify ? ["identified"] : [])].map(
              (value) => ({ value, label: t(`reports.privacy.${value}`) }),
            )}
            onValueChange={(mode) => {
              setPrivacy(mode as PlatformReportPrivacy);
              if (mode === "aggregate") setOperatorId("");
            }}
          />
          <p className="report-help">{t(`reports.privacyHelp.${privacy}`)}</p>
        </fieldset>
        {validationError ? <Alert tone="error">{t("reports.validationError")}</Alert> : null}
        {submitError ? (
          <Alert tone="error">
            <span>{t("reports.createError")}</span>
            {deliveryAttempt ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => create.mutate(deliveryAttempt)}
              >
                {t("reports.retryDelivery")}
              </Button>
            ) : null}
          </Alert>
        ) : null}
        <Button
          type="submit"
          disabled={!canCreate || tenantIds.length === 0 || create.isPending}
          loading={create.isPending}
        >
          {t("reports.create")}
        </Button>
      </form>
      <details className="report-help">
        <summary>{t("reports.help.title")}</summary>
        <p>{t("reports.help.metrics")}</p>
        <p>{t("reports.help.metadata")}</p>
        <p>{t("reports.help.commerceml")}</p>
      </details>
      <section className="commerce-ledger" aria-labelledby="reports-history-title">
        <header className="commerce-ledger__header">
          <div>
            <span className="commerce-ledger__eyebrow">HISTORY</span>
            <h2 id="reports-history-title">{t("reports.history")}</h2>
          </div>
          <span className="commerce-ledger__count">{history.data?.items.length ?? 0}</span>
        </header>
        {history.error ? <Alert tone="error">{t("reports.loadError")}</Alert> : null}
        {actionError ? <Alert tone="error">{t("reports.downloadError")}</Alert> : null}
        <Table
          columns={[
            {
              key: "template",
              title: t("reports.fields.template"),
              render: (report: PlatformReport) =>
                t(`reports.types.${report.parameters.reportType}`),
            },
            {
              key: "scope",
              title: t("reports.fields.scope"),
              render: (report: PlatformReport) =>
                `${report.parameters.tenantIds.map((id) => selectedNames.get(id) ?? id).join(", ")} · ${report.parameters.fromDate}—${report.parameters.toDate} · ${t(`reports.privacy.${report.parameters.privacy}`)}`,
            },
            {
              key: "status",
              title: t("reports.fields.status"),
              render: (report: PlatformReport) => (
                <>
                  <StatusChip
                    status={statusTone(report.status)}
                    label={t(`reports.statuses.${report.status}`)}
                  />
                  {report.errorCode ? (
                    <small>{t(`reports.errors.${report.errorCode}`)}</small>
                  ) : null}
                </>
              ),
            },
            {
              key: "created",
              title: t("reports.fields.created"),
              render: (report: PlatformReport) => (
                <>
                  <time>{new Date(report.createdAt).toLocaleString()}</time>
                  <small>
                    {t("reports.expires")}: {new Date(report.expiresAt).toLocaleString()}
                  </small>
                </>
              ),
            },
            {
              key: "rows",
              title: t("reports.fields.rows"),
              render: (report: PlatformReport) => report.rowCount ?? "—",
            },
            {
              key: "actions",
              title: t("reports.fields.actions"),
              render: (report: PlatformReport) => (
                <div className="report-actions">
                  {report.status === "ready" &&
                  new Date(report.expiresAt).getTime() > Math.max(deadlineNow, Date.now()) &&
                  canDownload ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (new Date(report.expiresAt).getTime() <= Date.now()) {
                          setDeadlineNow(Date.now());
                          setActionError(true);
                          return;
                        }
                        download.mutate(report.id);
                      }}
                    >
                      {t("reports.download")}
                    </Button>
                  ) : null}
                  {["failed", "expired"].includes(report.status) && canCreate ? (
                    <Button type="button" variant="secondary" onClick={() => retry(report)}>
                      {t("reports.retry")}
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rows={history.data?.items ?? []}
          empty={t("reports.empty")}
        />
        <div className="report-pagination">
          <Button
            type="button"
            variant="secondary"
            disabled={historyOffset === 0}
            onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}
          >
            {t("reports.previous")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={history.data?.nextOffset == null}
            onClick={() => setHistoryOffset(history.data?.nextOffset ?? historyOffset)}
          >
            {t("reports.next")}
          </Button>
        </div>
      </section>
    </section>
  );
}
