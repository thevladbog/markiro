import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, Button, PageHeader, StatusChip, Table } from "@markiro/ui";

import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import {
  importPayments,
  listPaymentMatches,
  listPayments,
  resolvePaymentMatch,
  type BillingPayment,
  type PaymentMatch,
  type PaymentMatchResolveInput,
} from "./api.js";

const PAYMENTS_KEY = ["platform", "payments"] as const;
const MATCHES_KEY = ["platform", "payment-matches"] as const;

export function PaymentsPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  const queryClient = useQueryClient();
  const canWrite = principal.capabilities.includes("billing.write");
  const payments = useQuery({ queryKey: PAYMENTS_KEY, queryFn: listPayments });
  const matches = useQuery({ queryKey: MATCHES_KEY, queryFn: listPaymentMatches });
  const [file, setFile] = useState<File | null>(null);
  const importMutation = useMutation({
    mutationFn: importPayments,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY }),
        queryClient.invalidateQueries({ queryKey: MATCHES_KEY }),
      ]);
    },
  });

  const submitImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) return;
    await importMutation.mutateAsync({ fileName: file.name, content: await readFile(file) });
  };

  return (
    <section className="payments-page">
      <PageHeader title={t("payments.title")} />
      <div className="catalog-coordinate" aria-hidden="true">
        BILLING / PAYMENTS / RECONCILIATION
      </div>

      {canWrite ? (
        <section className="payments-panel" aria-labelledby="payment-import-title">
          <header>
            <div>
              <h2 id="payment-import-title">{t("payments.import.title")}</h2>
              <p>{t("payments.import.help")}</p>
            </div>
          </header>
          {importMutation.error ? <Alert tone="error">{t("payments.import.error")}</Alert> : null}
          {importMutation.isSuccess ? (
            <Alert tone="ok">{t("payments.import.success")}</Alert>
          ) : null}
          <form className="payment-import-form" onSubmit={(event) => void submitImport(event)}>
            <label className="payment-file-field">
              <span>{t("payments.import.file")}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
              />
            </label>
            <Button type="submit" loading={importMutation.isPending} disabled={!file}>
              {t("payments.import.submit")}
            </Button>
          </form>
        </section>
      ) : null}

      <section className="payments-panel" aria-labelledby="payment-review-title">
        <header>
          <div>
            <h2 id="payment-review-title">{t("payments.review.title")}</h2>
            <p>{t("payments.review.help")}</p>
          </div>
          <span className="payments-count">{matches.data?.items.length ?? 0}</span>
        </header>
        {matches.isPending ? <p>{t("payments.loading")}</p> : null}
        {matches.error ? <Alert tone="error">{t("payments.review.loadError")}</Alert> : null}
        {!matches.isPending && !matches.error && matches.data?.items.length === 0 ? (
          <p className="payments-empty">{t("payments.review.empty")}</p>
        ) : null}
        <div className="payment-match-list">
          {matches.data?.items.map((match) => (
            <PaymentMatchCard key={match.id} match={match} canWrite={canWrite} />
          ))}
        </div>
      </section>

      <section className="payments-panel" aria-labelledby="recorded-payments-title">
        <header>
          <div>
            <h2 id="recorded-payments-title">{t("payments.recorded.title")}</h2>
            <p>{t("payments.recorded.help")}</p>
          </div>
        </header>
        {payments.isPending ? <p>{t("payments.loading")}</p> : null}
        {payments.error ? <Alert tone="error">{t("payments.recorded.loadError")}</Alert> : null}
        {!payments.isPending && !payments.error ? (
          <Table
            columns={[
              {
                key: "paidAt",
                title: t("payments.columns.date"),
                render: (payment: BillingPayment) => new Date(payment.paidAt).toLocaleDateString(),
              },
              {
                key: "invoiceId",
                title: t("payments.columns.invoice"),
                render: (payment: BillingPayment) => (
                  <Link className="table-link" to={`/billing/${payment.invoiceId}`}>
                    {payment.bankReference}
                  </Link>
                ),
              },
              { key: "amount", title: t("payments.columns.amount") },
              { key: "source", title: t("payments.columns.source") },
            ]}
            rows={payments.data?.items ?? []}
            empty={t("payments.recorded.empty")}
          />
        ) : null}
      </section>
    </section>
  );
}

function PaymentMatchCard({ match, canWrite }: { match: PaymentMatch; canWrite: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const resolve = useMutation({
    mutationFn: (input: PaymentMatchResolveInput) => resolvePaymentMatch(match.id, input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: PAYMENTS_KEY }),
        queryClient.invalidateQueries({ queryKey: MATCHES_KEY }),
        queryClient.invalidateQueries({ queryKey: ["platform", "invoices"] }),
      ]);
    },
  });
  const canMatch = match.tenantId !== null && match.invoiceId !== null;
  const pendingDecision = match.status === "suggested" || match.status === "needs_review";
  const reference = match.bankReference ?? match.sourceRowId;
  const statusTone =
    match.status === "matched"
      ? "ok"
      : match.status === "rejected"
        ? "neutral"
        : match.status === "needs_review"
          ? "warn"
          : "neutral";

  const confirm = async () => {
    if (!canMatch || match.tenantId === null || match.invoiceId === null) return;
    await resolve.mutateAsync({
      decision: "matched",
      tenantId: match.tenantId,
      invoiceId: match.invoiceId,
      tenantBankAccountId: match.tenantBankAccountId,
      reason,
    });
  };

  return (
    <article className="payment-match-card">
      <header>
        <div>
          <span className="payment-match-reference">{reference}</span>
          <h3>{match.payerName ?? t("payments.review.payerUnavailable")}</h3>
        </div>
        <StatusChip status={statusTone} label={t(`payments.statuses.${match.status}`)} />
      </header>
      <dl className="payment-match-data">
        <div>
          <dt>{t("payments.columns.account")}</dt>
          <dd>{accountEvidenceLabel(match, t)}</dd>
        </div>
        <div>
          <dt>{t("payments.columns.amount")}</dt>
          <dd>{match.amount ? `${match.amount} ${match.currency ?? ""}`.trim() : "—"}</dd>
        </div>
        <div>
          <dt>{t("payments.columns.invoice")}</dt>
          <dd>
            {match.invoiceId && match.invoiceNumber ? (
              <Link to={`/billing/${match.invoiceId}`}>{match.invoiceNumber}</Link>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div>
          <dt>{t("payments.columns.legal")}</dt>
          <dd>
            {match.tenantId ? (
              <Link to={`/tenants/${match.tenantId}?tab=legal`}>
                {t("payments.review.legalData")}
              </Link>
            ) : (
              "—"
            )}
          </dd>
        </div>
      </dl>
      {match.paymentPurpose ? <p className="payment-purpose">{match.paymentPurpose}</p> : null}
      {resolve.error ? <Alert tone="error">{t("payments.review.resolveError")}</Alert> : null}
      {canWrite && pendingDecision ? (
        <div className="payment-match-actions">
          <label>
            <span>{t("payments.review.reason", { reference })}</span>
            <input
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
          </label>
          <div>
            {canMatch ? (
              <Button
                disabled={!reason.trim()}
                loading={resolve.isPending}
                onClick={() => void confirm()}
              >
                {match.payerAccountEvidence?.kind !== "known"
                  ? t("payments.review.confirmUnknown")
                  : t("payments.review.confirm")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={!reason.trim()}
              loading={resolve.isPending}
              onClick={() => void resolve.mutateAsync({ decision: "rejected", reason })}
            >
              {t("payments.review.reject")}
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function accountEvidenceLabel(match: PaymentMatch, t: TFunction) {
  const evidence = match.payerAccountEvidence;
  if (!evidence || evidence.kind === "unavailable") return t("payments.accounts.unavailable");
  if (evidence.kind === "unknown") {
    return t("payments.accounts.unknown", { last4: evidence.last4 });
  }
  return t("payments.accounts.known", {
    label: evidence.label,
    last4: evidence.last4,
    status: t(`payments.accounts.statuses.${evidence.accountStatus}`),
  });
}

function readFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("file_read_failed"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("file_read_failed")));
    reader.readAsText(file);
  });
}
