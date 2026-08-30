import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import {
  Alert,
  Button,
  Combobox,
  DatePicker,
  SectionHeader,
  Spinner,
  StatusChip,
  type ComboboxOption,
} from "@markiro/ui";
import { platformCommercialContracts, type BillingActCreateDto } from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { useNavigationGuard } from "../../layout/NavigationGuard.js";
import { getInvoice, listInvoices } from "../billing/api.js";
import { invoiceStatusTone } from "../billing/invoice-status.js";
import { createBillingAct, getBillingAct, issueBillingAct } from "./api.js";

type Progress = "idle" | "creating" | "generating" | "draft" | "issued";

interface IssueAttempt {
  create: BillingActCreateDto;
  issueKey: string;
  actId: string | null;
}

export function CreateBillingActPage() {
  const principal = usePlatformPrincipal();
  return <BillingActForm writable={principal.capabilities.includes("billing.write")} />;
}

function BillingActForm({ writable }: { writable: boolean }) {
  const { t, i18n } = useTranslation();
  const [search] = useSearchParams();
  const client = useQueryClient();
  const contextTenantId = search.get("tenantId");
  const contextRequestId = search.get("requestId");
  const [invoiceId, setInvoiceId] = useState(search.get("invoiceId") ?? "");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>("idle");
  const [forbidden, setForbidden] = useState(false);
  const observedRevocation = useRef(false);
  const attemptRef = useRef<IssueAttempt | null>(null);
  const [attempt, setAttempt] = useState<IssueAttempt | null>(null);

  const invoices = useQuery({
    queryKey: ["platform", "invoices"],
    queryFn: listInvoices,
    enabled: writable,
  });
  const eligibleInvoices = useMemo(
    () =>
      (invoices.data?.items ?? []).filter(
        (invoice) =>
          invoice.status !== "draft" &&
          invoice.status !== "cancelled" &&
          (!contextTenantId || invoice.tenantId === contextTenantId),
      ),
    [contextTenantId, invoices.data?.items],
  );
  const invoiceOptions: ComboboxOption[] = eligibleInvoices.map((invoice) => ({
    value: invoice.id,
    label: invoice.number,
    description: `${invoice.tenantName} · ${formatMoney(invoice.total, i18n.language)}`,
    keywords: [invoice.tenantName, invoice.number],
  }));
  const selectedInvoice = eligibleInvoices.find((invoice) => invoice.id === invoiceId);
  const detail = useQuery({
    queryKey: ["platform", "invoices", invoiceId],
    queryFn: () => getInvoice(invoiceId),
    enabled: Boolean(invoiceId) && writable,
  });

  useEffect(() => {
    if (!selectedInvoice?.issueDate || periodStart || periodEnd) return;
    const suggested = previousCalendarMonth(selectedInvoice.issueDate);
    setPeriodStart(suggested.start);
    setPeriodEnd(suggested.end);
  }, [periodEnd, periodStart, selectedInvoice?.issueDate]);

  useEffect(() => {
    if (!writable) {
      observedRevocation.current = true;
      setForbidden(true);
      return;
    }
    if (observedRevocation.current) {
      observedRevocation.current = false;
      setForbidden(false);
    }
  }, [writable]);

  const invalidateActFamilies = async (current: IssueAttempt) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "billing", "acts"] }),
      client.invalidateQueries({ queryKey: ["platform", "billing", "requests"] }),
      current.actId
        ? client.invalidateQueries({ queryKey: ["platform", "billing", "acts", current.actId] })
        : Promise.resolve(),
      current.create.requestId
        ? client.invalidateQueries({
            queryKey: ["platform", "billing", "requests", current.create.requestId],
          })
        : Promise.resolve(),
    ]);
  };

  const latchForbidden = async (current: IssueAttempt | null) => {
    setForbidden(true);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "me"] }),
      current ? invalidateActFamilies(current) : Promise.resolve(),
    ]);
  };

  const issue = useMutation({
    mutationFn: async (current: IssueAttempt) => {
      let next = current;
      let actId = current.actId;
      if (!actId) {
        setProgress("creating");
        const created = await createBillingAct(current.create);
        actId = created.id;
        next = { ...current, actId };
        attemptRef.current = next;
        setAttempt(next);
        setProgress("draft");
        await invalidateActFamilies(next);
      }
      setProgress("generating");
      return issueBillingAct(actId, next.issueKey);
    },
    onSuccess: async (act) => {
      const current = attemptRef.current;
      if (act.status === "issued" && act.document?.state === "ready") {
        attemptRef.current = null;
        setAttempt(null);
        setProgress("issued");
      } else {
        setProgress("draft");
      }
      if (current) await invalidateActFamilies(current);
    },
    onError: async (error) => {
      const current = attemptRef.current;
      if (isForbidden(error)) {
        if (!current?.actId) {
          attemptRef.current = null;
          setAttempt(null);
        }
        await latchForbidden(current);
      } else if (!current?.actId && !retryable(error)) {
        attemptRef.current = null;
        setAttempt(null);
      }
      setProgress(current?.actId ? "draft" : "idle");
      if (current && !isForbidden(error)) await invalidateActFamilies(current);
    },
  });

  const reconcile = useMutation({
    mutationFn: (actId: string) => getBillingAct(actId),
    onSuccess: async (act) => {
      const current = attemptRef.current;
      if (act.status === "issued" && act.document?.state === "ready") {
        attemptRef.current = null;
        setAttempt(null);
        issue.reset();
        setProgress("issued");
      } else {
        setProgress("draft");
      }
      if (current) await invalidateActFamilies(current);
    },
    onError: async (error) => {
      const current = attemptRef.current;
      if (isForbidden(error)) await latchForbidden(current);
    },
  });

  const resetAttempt = () => {
    if (attemptRef.current) return;
    issue.reset();
    setValidationError(null);
    setProgress("idle");
  };
  const submit = () => {
    if (issue.isPending) return;
    const retained = attemptRef.current;
    if (retained) {
      issue.mutate(retained);
      return;
    }
    if (!selectedInvoice || !detail.data) {
      setValidationError(t("billingActs.errors.invoiceRequired"));
      return;
    }
    const sourceRequestId = selectedInvoice.sourceRequestId ?? contextRequestId;
    const parsed = platformCommercialContracts.billingActs.create.body.safeParse({
      tenantId: selectedInvoice.tenantId,
      ...(sourceRequestId ? { requestId: sourceRequestId } : {}),
      invoiceId: selectedInvoice.id,
      number: actNumberFromInvoice(selectedInvoice.number),
      periodStart,
      periodEnd,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!parsed.success) {
      setValidationError(t("billingActs.errors.form"));
      return;
    }
    const next: IssueAttempt = {
      create: parsed.data,
      issueKey: crypto.randomUUID(),
      actId: null,
    };
    attemptRef.current = next;
    setAttempt(next);
    setValidationError(null);
    issue.mutate(next);
  };

  const frozen = attempt !== null;
  useNavigationGuard(false, frozen || issue.isPending || reconcile.isPending);
  const backPath = contextRequestId ? `/billing-requests/${contextRequestId}` : "/billing-acts";

  if (forbidden || !writable) {
    return (
      <section className="catalog-page">
        <SectionHeader
          eyebrow="COMMERCE / ACTS / READ ONLY"
          title={t("billingActs.forbiddenTitle")}
          description={t("billingActs.forbiddenBody")}
          actions={<Link to={backPath}>{t("billingActs.backToRegistry")}</Link>}
        />
        <Alert tone="error">{t("billingActs.forbiddenBody")}</Alert>
        {attempt?.actId ? (
          <Alert tone="info">
            {t("billingActs.progress.draftSaved")}.{" "}
            <Link to={`/billing-acts/${attempt.actId}`}>{attempt.create.number}</Link>
          </Alert>
        ) : null}
      </section>
    );
  }

  return (
    <section className="catalog-page billing-act-page">
      <SectionHeader
        eyebrow="COMMERCE / ACTS / ISSUE"
        title={t("billingActs.title")}
        description={t("billingActs.description")}
        actionsLabel={t("billingActs.actions")}
        actions={<Link to={backPath}>{t("billingActs.backToRegistry")}</Link>}
      />
      <form
        className="billing-act-form billing-act-form--generated"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <section className="billing-act-source" aria-labelledby="billing-act-source-title">
          <div className="billing-act-source__heading">
            <div>
              <span className="commerce-ledger__eyebrow">01 / SOURCE</span>
              <h2 id="billing-act-source-title">{t("billingActs.source.title")}</h2>
            </div>
            <span>{t("billingActs.source.hint")}</span>
          </div>
          <Combobox
            label={t("billingActs.fields.invoiceSource")}
            options={invoiceOptions}
            {...(invoiceId ? { value: invoiceId } : {})}
            onValueChange={(value) => {
              setInvoiceId(value);
              resetAttempt();
            }}
            placeholder={t("billingActs.source.placeholder")}
            searchPlaceholder={t("billingActs.source.searchPlaceholder")}
            emptyText={t("billingActs.source.empty")}
            loadingText={t("billingActs.source.loading")}
            loading={invoices.isPending}
            disabled={frozen}
          />
          {invoices.error ? <Alert tone="error">{t("billingActs.source.loadError")}</Alert> : null}
        </section>

        {invoiceId && detail.isPending ? (
          <Spinner label={t("billingActs.source.loadingDetail")} />
        ) : null}
        {detail.data ? (
          <section className="billing-act-preview" aria-labelledby="billing-act-preview-title">
            <header>
              <div>
                <span className="commerce-ledger__eyebrow">02 / DOCUMENT</span>
                <h2 id="billing-act-preview-title">{t("billingActs.preview.title")}</h2>
              </div>
              <StatusChip
                status={invoiceStatusTone(detail.data.status)}
                label={t(`billing.statuses.${detail.data.status}`)}
              />
            </header>
            <dl className="billing-act-preview__facts">
              <div>
                <dt>{t("billingActs.fields.number")}</dt>
                <dd>{actNumberFromInvoice(detail.data.number)}</dd>
              </div>
              <div>
                <dt>{t("billingActs.fields.invoice")}</dt>
                <dd>
                  <Link to={`/invoices/${detail.data.id}`}>{detail.data.number}</Link>
                </dd>
              </div>
              <div>
                <dt>{t("billingActs.fields.tenant")}</dt>
                <dd>
                  <Link to={`/tenants/${detail.data.tenantId}`}>{detail.data.tenantName}</Link>
                </dd>
              </div>
              <div>
                <dt>{t("billingActs.preview.total")}</dt>
                <dd>{formatMoney(detail.data.total, i18n.language)}</dd>
              </div>
            </dl>
            <div className="billing-act-preview__lines">
              {detail.data.lines.map((line) => (
                <div key={line.id}>
                  <span>{line.position.toString().padStart(2, "0")}</span>
                  <strong>{line.nameRu}</strong>
                  <span>
                    {line.quantity} {line.unit}
                  </span>
                  <strong>{formatMoney(line.lineTotal, i18n.language)}</strong>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="billing-act-period" aria-labelledby="billing-act-period-title">
          <div className="billing-act-source__heading">
            <div>
              <span className="commerce-ledger__eyebrow">03 / PERIOD</span>
              <h2 id="billing-act-period-title">{t("billingActs.period.title")}</h2>
            </div>
            <span>{t("billingActs.period.hint")}</span>
          </div>
          <div className="billing-act-period__fields">
            <DatePicker
              label={t("billingActs.fields.periodStart")}
              value={periodStart}
              onValueChange={(value) => {
                setPeriodStart(value ?? "");
                resetAttempt();
              }}
              locale={i18n.language}
              disabled={frozen}
            />
            <DatePicker
              label={t("billingActs.fields.periodEnd")}
              value={periodEnd}
              onValueChange={(value) => {
                setPeriodEnd(value ?? "");
                resetAttempt();
              }}
              locale={i18n.language}
              disabled={frozen}
            />
          </div>
        </section>

        {validationError ? <Alert tone="error">{validationError}</Alert> : null}
        {issue.error ? (
          <Alert tone="error">
            {retryable(issue.error)
              ? t("billingActs.errors.retryable")
              : t("billingActs.errors.authoritative")}
          </Alert>
        ) : null}
        {progress === "creating" ? <p role="status">{t("billingActs.progress.creating")}</p> : null}
        {progress === "generating" ? (
          <p role="status">{t("billingActs.progress.generating")}</p>
        ) : null}
        {attempt?.actId && progress === "draft" ? (
          <Alert tone="info">{t("billingActs.progress.draftSaved")}</Alert>
        ) : null}
        {progress === "issued" ? <Alert tone="ok">{t("billingActs.progress.issued")}</Alert> : null}
        <div className="billing-act-form__actions">
          {attempt?.actId ? (
            <Button
              type="button"
              variant="secondary"
              disabled={issue.isPending || reconcile.isPending}
              loading={reconcile.isPending}
              onClick={() => reconcile.mutate(attempt.actId!)}
            >
              {t("billingActs.reconcile")}
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={issue.isPending || progress === "issued" || !detail.data}
            loading={issue.isPending}
          >
            {issue.isError && attempt?.actId ? t("billingActs.resume") : t("billingActs.submit")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function actNumberFromInvoice(invoiceNumber: string): string {
  return /^INV-/i.test(invoiceNumber)
    ? invoiceNumber.replace(/^INV-/i, "ACT-")
    : `ACT-${invoiceNumber}`;
}

function formatMoney(value: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 2,
  }).format(Number(value));
}

function previousCalendarMonth(timestamp: string): { start: string; end: string } {
  const issued = new Date(timestamp);
  const first = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth(), 0));
  return { start: isoDay(first), end: isoDay(last) };
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function retryable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === null || error.status >= 500);
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403;
}
