import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import { Alert, Button, PageHeader, StatusChip } from "@markiro/ui";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import {
  applyInvoice,
  getInvoice,
  issueInvoice,
  recordInvoicePayment,
  renderInvoice,
  type InvoiceDetail,
  type RecordInvoicePaymentInput,
} from "./api.js";
import { InvoiceFlowSteps, type FlowState } from "./InvoiceFlowSteps.js";

function flowState(invoice: InvoiceDetail): FlowState {
  if (invoice.status === "draft") return "draft";
  if (!invoice.payment) return "waiting_payment";
  if (invoice.application.status === "applied") return "applied";
  if (invoice.application.status === "partial_failure") return "partial_failure";
  return "waiting_application";
}

function money(value: string): string {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB" }).format(
    Number(value),
  );
}

function date(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value))
    : "—";
}

export function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { invoiceId = "" } = useParams();
  const principal = usePlatformPrincipal();
  const canWrite = principal.capabilities.includes("billing.write");
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["platform", "invoices", invoiceId],
    queryFn: () => getInvoice(invoiceId),
    enabled: Boolean(invoiceId),
  });
  const [bankReference, setBankReference] = useState("");
  const [paymentKey] = useState(() => crypto.randomUUID());
  const paymentPayload = useRef<RecordInvoicePaymentInput | null>(null);
  const [reason, setReason] = useState("");
  const [decisions, setDecisions] = useState<Record<string, "immediate" | "after_current">>({});

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "invoices", invoiceId] }),
      client.invalidateQueries({ queryKey: ["platform", "invoices"] }),
    ]);
  };
  const payment = useMutation({
    mutationFn: () => {
      paymentPayload.current ??= {
        amount: detail.data!.total,
        paidAt: new Date().toISOString(),
        bankReference,
        idempotencyKey: paymentKey,
      };
      return recordInvoicePayment(invoiceId, paymentPayload.current);
    },
    onSuccess: refresh,
  });
  const issue = useMutation({ mutationFn: () => issueInvoice(invoiceId), onSuccess: refresh });
  const document = useMutation({ mutationFn: () => renderInvoice(invoiceId), onSuccess: refresh });

  const latestByLine = useMemo(
    () =>
      new Map(detail.data?.application.latestByLine.map((event) => [event.invoiceLineId, event])),
    [detail.data],
  );
  const pendingLines = useMemo(
    () =>
      detail.data?.lines.filter((line) => {
        const status = latestByLine.get(line.id)?.status;
        return status === "pending" || status === "failed";
      }) ?? [],
    [detail.data, latestByLine],
  );
  const application = useMutation({
    mutationFn: () =>
      applyInvoice(invoiceId, {
        reason,
        lines: pendingLines.map((line) => ({
          lineId: line.id,
          ...((line.kind === "plan" || line.kind === "addon") && line.activationPolicy === "manual"
            ? { activationPolicy: decisions[line.id] }
            : {}),
        })),
      }),
    onSuccess: refresh,
  });

  if (detail.isPending) {
    return (
      <section className="invoice-detail-page" aria-busy="true">
        <p>{t("billing.loadingDetail")}</p>
      </section>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <section className="invoice-detail-page">
        <Alert tone="error">{t("billing.detailLoadError")}</Alert>
      </section>
    );
  }
  const invoice = detail.data;
  const state = flowState(invoice);
  const manualDecisionMissing = pendingLines.some(
    (line) =>
      (line.kind === "plan" || line.kind === "addon") &&
      line.activationPolicy === "manual" &&
      !decisions[line.id],
  );

  return (
    <section className="invoice-detail-page">
      <div className="invoice-detail-backline">
        <Link to="/invoices">← {t("billing.back")}</Link>
      </div>
      <PageHeader
        title={t("billing.detailTitle", { number: invoice.number })}
        actions={
          <StatusChip
            status={invoice.status === "paid" ? "ok" : "warn"}
            label={t(`billing.statuses.${invoice.status}`)}
          />
        }
      />
      <p className="invoice-coordinate mono">
        {invoice.id} · {invoice.tenantId}
      </p>

      <InvoiceFlowSteps state={state} />

      <div className="invoice-summary-grid">
        <article className="invoice-hero" data-state={state}>
          <span className="invoice-kicker">{t(`billing.states.${state}.eyebrow`)}</span>
          <h2>{t(`billing.states.${state}.title`)}</h2>
          <p>{t(`billing.states.${state}.body`)}</p>
        </article>
        <dl className="invoice-facts">
          <div>
            <dt>{t("billing.issueDate")}</dt>
            <dd>{date(invoice.issueDate)}</dd>
          </div>
          <div>
            <dt>{t("billing.dueDate")}</dt>
            <dd>{date(invoice.dueDate)}</dd>
          </div>
          <div>
            <dt>{t("billing.applicationMode")}</dt>
            <dd>{t(`billing.modes.${invoice.applicationMode}`)}</dd>
          </div>
          <div>
            <dt>{t("billing.total")}</dt>
            <dd className="mono">{money(invoice.total)}</dd>
          </div>
        </dl>
      </div>

      <section className="invoice-panel" aria-labelledby="invoice-lines-title">
        <header>
          <div>
            <span className="invoice-kicker">02 / LINES</span>
            <h2 id="invoice-lines-title">{t("billing.invoiceLines")}</h2>
          </div>
        </header>
        <div className="invoice-table-scroll" tabIndex={0}>
          <table className="invoice-lines-table">
            <thead>
              <tr>
                <th>{t("billing.position")}</th>
                <th>{t("billing.item")}</th>
                <th>{t("billing.activation")}</th>
                <th>{t("billing.applicationStatus")}</th>
                <th>{t("billing.total")}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => {
                const event = latestByLine.get(line.id);
                return (
                  <tr key={line.id}>
                    <td className="mono">{String(line.position).padStart(2, "0")}</td>
                    <td>
                      <strong>{line.nameRu}</strong>
                      <small>
                        {line.kind} · {line.quantity} {line.unit}
                      </small>
                    </td>
                    <td>
                      {line.activationPolicy ? t(`billing.policies.${line.activationPolicy}`) : "—"}
                    </td>
                    <td>
                      <StatusChip
                        status={
                          event?.status === "applied"
                            ? "ok"
                            : event?.status === "failed"
                              ? "error"
                              : "warn"
                        }
                        label={t(`billing.applicationStatuses.${event?.status ?? "not_started"}`)}
                      />
                    </td>
                    <td className="mono">{money(line.lineTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {invoice.status === "draft" && canWrite ? (
        <section className="invoice-action-panel">
          <h2>{t("billing.issue")}</h2>
          <Button loading={issue.isPending} onClick={() => issue.mutate()}>
            {t("billing.issue")}
          </Button>
        </section>
      ) : null}

      {invoice.status === "issued" ? (
        <section className="invoice-action-panel" aria-labelledby="payment-title">
          <div>
            <span className="invoice-kicker">03 / PAYMENT</span>
            <h2 id="payment-title">{t("billing.paymentTitle")}</h2>
            <p>{t("billing.paymentDoesNotApply")}</p>
          </div>
          {payment.isError ? <Alert tone="error">{t("billing.paymentError")}</Alert> : null}
          {canWrite ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                payment.mutate();
              }}
              className="invoice-action-form"
            >
              <label className="native-field">
                <span>{t("billing.bankReference")}</span>
                <input
                  value={bankReference}
                  onChange={(event) => setBankReference(event.target.value)}
                  required
                />
              </label>
              <Button type="submit" loading={payment.isPending}>
                {payment.isError ? t("billing.retryPayment") : t("billing.confirmPayment")}
              </Button>
            </form>
          ) : (
            <p>{t("billing.readOnly")}</p>
          )}
        </section>
      ) : null}

      {invoice.payment ? (
        <section className="invoice-action-panel" aria-labelledby="application-title">
          <div>
            <span className="invoice-kicker">04 / APPLICATION</span>
            <h2 id="application-title">{t("billing.applicationTitle")}</h2>
            <p>
              {state === "waiting_application"
                ? t("billing.operatorDecision")
                : t(`billing.states.${state}.body`)}
            </p>
          </div>
          {application.isError ? <Alert tone="error">{t("billing.applicationError")}</Alert> : null}
          {pendingLines.length > 0 && canWrite ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                application.mutate();
              }}
              className="invoice-application-form"
            >
              {pendingLines
                .filter(
                  (line) =>
                    (line.kind === "plan" || line.kind === "addon") &&
                    line.activationPolicy === "manual",
                )
                .map((line) => (
                  <label className="native-field" key={line.id}>
                    <span>{t("billing.applyHow", { name: line.nameRu })}</span>
                    <select
                      value={decisions[line.id] ?? ""}
                      onChange={(event) =>
                        setDecisions((current) => ({
                          ...current,
                          [line.id]: event.target.value as "immediate" | "after_current",
                        }))
                      }
                      required
                    >
                      <option value="" disabled>
                        {t("billing.choosePolicy")}
                      </option>
                      <option value="immediate">{t("billing.policies.immediate")}</option>
                      <option value="after_current">{t("billing.policies.after_current")}</option>
                    </select>
                  </label>
                ))}
              <label className="native-field">
                <span>{t("billing.applicationReason")}</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  required
                  rows={3}
                />
              </label>
              <Button
                type="submit"
                loading={application.isPending}
                disabled={manualDecisionMissing || reason.trim().length === 0}
              >
                {t("billing.applySelected")}
              </Button>
            </form>
          ) : pendingLines.length > 0 ? (
            <p>{t("billing.readOnly")}</p>
          ) : null}
        </section>
      ) : null}

      {canWrite ? (
        <div className="invoice-document-action">
          <Button loading={document.isPending} onClick={() => document.mutate()}>
            {t("billing.document")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
