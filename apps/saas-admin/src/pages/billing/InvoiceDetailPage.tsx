import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, Button, Checkbox, ConfirmDialog, SectionHeader, StatusChip } from "@markiro/ui";
import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import {
  applyInvoice,
  cancelInvoice,
  deleteInvoiceDraft,
  getInvoiceDocumentDownload,
  getInvoice,
  issueInvoice,
  recordInvoicePayment,
  renderInvoice,
  type InvoiceDetail,
  type RecordInvoicePaymentInput,
} from "./api.js";
import { InvoiceFlowSteps, type FlowState } from "./InvoiceFlowSteps.js";
import { invoiceStatusTone } from "./invoice-status.js";

const DOCUMENT_PENDING_TIMEOUT_MS = 5 * 60 * 1000;
const DOCUMENT_REFRESH_INTERVAL_MS = 2_000;

function flowState(invoice: InvoiceDetail): FlowState {
  if (invoice.status === "draft") return "draft";
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.paymentSummary?.status !== "paid") return "waiting_payment";
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

function sellerTaxId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || !("taxId" in snapshot)) return null;
  return typeof snapshot.taxId === "string" ? snapshot.taxId : null;
}

export function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { invoiceId = "" } = useParams();
  const principal = usePlatformPrincipal();
  const navigate = useNavigate();
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
  const [confirmDocumentRender, setConfirmDocumentRender] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [downloadBlocked, setDownloadBlocked] = useState(false);
  const [documentsNow, setDocumentsNow] = useState(() => Date.now());
  const [withSignatureSeal, setWithSignatureSeal] = useState(false);

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["platform", "invoices", invoiceId] }),
      client.invalidateQueries({ queryKey: ["platform", "invoices"] }),
    ]);
  };
  const payment = useMutation({
    mutationFn: () => {
      paymentPayload.current ??= {
        amount: detail.data!.paymentSummary!.remainingAmount,
        paidAt: new Date().toISOString(),
        bankReference,
        idempotencyKey: paymentKey,
      };
      return recordInvoicePayment(invoiceId, paymentPayload.current);
    },
    onSuccess: refresh,
  });
  const printVariant = withSignatureSeal ? "signed" : "clean";
  const issue = useMutation({
    mutationFn: () => issueInvoice(invoiceId, printVariant),
    onSuccess: refresh,
  });
  const withdraw = useMutation({
    mutationFn: () => cancelInvoice(invoiceId),
    onSuccess: async () => {
      await refresh();
      setConfirmCancel(false);
    },
  });
  const deleteDraft = useMutation({
    mutationFn: () => deleteInvoiceDraft(invoiceId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["platform", "invoices"] });
      void navigate("/invoices", { replace: true });
    },
  });
  const document = useMutation({
    mutationFn: () => renderInvoice(invoiceId, printVariant),
    onSuccess: async () => {
      await refresh();
      setConfirmDocumentRender(false);
    },
  });
  const downloadDocument = useMutation({
    mutationFn: (documentId: string) => getInvoiceDocumentDownload(invoiceId, documentId),
  });

  useEffect(() => {
    const pendingDocuments =
      detail.data?.documents.filter((item) => item.status === "pending") ?? [];
    if (pendingDocuments.length === 0) return;
    const nextPendingExpiry = Math.min(
      ...pendingDocuments.map(
        (item) => new Date(item.updatedAt).getTime() + DOCUMENT_PENDING_TIMEOUT_MS,
      ),
    );
    const untilExpiry = nextPendingExpiry - Date.now();
    const delay =
      untilExpiry > 0
        ? Math.min(DOCUMENT_REFRESH_INTERVAL_MS, untilExpiry + 1)
        : DOCUMENT_REFRESH_INTERVAL_MS;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void detail.refetch().then((refreshed) => {
        if (!cancelled && refreshed.data?.documents.some((item) => item.status === "pending")) {
          setDocumentsNow(Date.now());
        }
      });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [detail.data?.documents, detail.refetch, documentsNow]);

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
  const signedPrintAllowed = sellerTaxId(invoice.sellerSnapshot) === SIGNED_PRINT_SELLER_TAX_ID;
  const state = flowState(invoice);
  const manualDecisionMissing = pendingLines.some(
    (line) =>
      (line.kind === "plan" || line.kind === "addon") &&
      line.activationPolicy === "manual" &&
      !decisions[line.id],
  );
  const revisions = [...new Set(invoice.documents.map((item) => item.revision))].sort(
    (left, right) => right - left,
  );
  const latestRevision = revisions[0] ?? 0;
  const currentDocuments = invoice.documents.filter((item) => item.revision === latestRevision);
  const htmlDocument = currentDocuments.find((item) => item.format === "html");
  const pdfDocument = currentDocuments.find((item) => item.format === "pdf");
  const stalePending = currentDocuments.some(
    (item) =>
      item.status === "pending" &&
      documentsNow - new Date(item.updatedAt).getTime() > DOCUMENT_PENDING_TIMEOUT_MS,
  );
  const documentsNeedRetry =
    !htmlDocument ||
    !pdfDocument ||
    htmlDocument.status === "failed" ||
    pdfDocument.status === "failed" ||
    stalePending;

  const openDocument = (documentId: string) => {
    setDownloadBlocked(false);
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setDownloadBlocked(true);
      return;
    }
    target.opener = null;
    void downloadDocument
      .mutateAsync(documentId)
      .then(({ url }) => target.location.replace(url))
      .catch(() => target.close());
  };

  return (
    <section className="invoice-detail-page">
      <div className="invoice-detail-backline">
        <Link to="/invoices">← {t("billing.back")}</Link>
      </div>
      <SectionHeader
        eyebrow="COMMERCE / INVOICES / DETAIL"
        title={t("billing.detailTitle", { number: invoice.number })}
        description={t("billing.detailDescription")}
        actionsLabel={t("billing.detailActionsLabel")}
        actions={
          <StatusChip
            status={invoiceStatusTone(invoice.status)}
            label={t(`billing.statuses.${invoice.status}`)}
          />
        }
      />
      <p className="invoice-tenant-link">
        <span>{t("billing.tenant")}</span>
        <Link to={`/tenants/${invoice.tenantId}`}>{invoice.tenantName}</Link>
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
                      {line.descriptionRu ? <small>{line.descriptionRu}</small> : null}
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

      <section
        className="invoice-panel invoice-documents"
        aria-labelledby="invoice-documents-title"
      >
        <header>
          <div>
            <span className="invoice-kicker">03 / DOCUMENTS</span>
            <h2 id="invoice-documents-title">{t("billing.documents.title")}</h2>
            <p>{t("billing.documents.description")}</p>
          </div>
        </header>
        {document.isError && !confirmDocumentRender ? (
          <Alert tone="error">{t("billing.documents.renderError")}</Alert>
        ) : null}
        {downloadDocument.isError || downloadBlocked ? (
          <Alert tone="error">
            {downloadBlocked
              ? t("billing.documents.popupBlocked")
              : t("billing.documents.downloadError")}
          </Alert>
        ) : null}
        {invoice.status === "draft" ? (
          <p className="invoice-documents__draft-note">{t("billing.documents.draftNote")}</p>
        ) : (
          <div className="invoice-documents__list">
            {(revisions.length > 0 ? revisions : [0]).map((revision) => {
              const revisionDocuments = invoice.documents.filter(
                (item) => item.revision === revision,
              );
              return (
                <section className="invoice-documents__revision" key={revision}>
                  {revision > 0 ? <h3>{t("billing.documents.revision", { revision })}</h3> : null}
                  {(["html", "pdf"] as const).map((format) => {
                    const item = revisionDocuments.find((document) => document.format === format);
                    const pendingIsStale =
                      item?.status === "pending" &&
                      documentsNow - new Date(item.updatedAt).getTime() > 5 * 60 * 1000;
                    return (
                      <div className="invoice-documents__row" key={format}>
                        <div>
                          <strong>{format.toUpperCase()}</strong>
                          <span>
                            {item?.status === "ready"
                              ? t("billing.documents.ready")
                              : item?.status === "pending"
                                ? t(
                                    pendingIsStale
                                      ? "billing.documents.pendingStale"
                                      : "billing.documents.pending",
                                  )
                                : t("billing.documents.failed", {
                                    format: format.toUpperCase(),
                                  })}
                          </span>
                          {item ? (
                            <small>{t(`billing.documents.variant.${item.printVariant}`)}</small>
                          ) : null}
                        </div>
                        {item?.status === "ready" ? (
                          <Button
                            variant="secondary"
                            loading={
                              downloadDocument.isPending && downloadDocument.variables === item.id
                            }
                            onClick={() => openDocument(item.id)}
                          >
                            {t(
                              `billing.documents.${format === "html" ? "openHtml" : "downloadPdf"}`,
                            )}
                          </Button>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        )}
        {invoice.status !== "draft" && documentsNeedRetry && canWrite ? (
          <div className="invoice-documents__actions">
            <Button loading={document.isPending} onClick={() => setConfirmDocumentRender(true)}>
              {t("billing.documents.retry")}
            </Button>
          </div>
        ) : null}
        {canWrite ? (
          <Checkbox
            className="invoice-documents__signature-option"
            label={t("billing.documents.signed")}
            checked={withSignatureSeal}
            onCheckedChange={setWithSignatureSeal}
            disabled={!signedPrintAllowed || issue.isPending || document.isPending}
            hint={t(
              signedPrintAllowed
                ? "billing.documents.signedHint"
                : "billing.documents.signedUnavailable",
            )}
          />
        ) : null}
      </section>

      <ConfirmDialog
        open={confirmDocumentRender}
        title={t("billing.documents.confirmTitle")}
        description={t("billing.documents.confirmDescription")}
        entity={t("billing.documents.nextRevision", { revision: latestRevision + 1 })}
        confirmLabel={t("billing.documents.confirm")}
        cancelLabel={t("billing.documents.cancel")}
        busy={document.isPending}
        error={document.isError ? t("billing.documents.renderError") : undefined}
        onCancel={() => setConfirmDocumentRender(false)}
        onConfirm={() => document.mutate()}
      />

      <ConfirmDialog
        open={confirmCancel}
        title={t("billing.withdraw.title")}
        description={t("billing.withdraw.description")}
        entity={invoice.number}
        confirmLabel={t("billing.withdraw.confirm")}
        cancelLabel={t("billing.withdraw.keep")}
        tone="destructive"
        busy={withdraw.isPending}
        error={withdraw.isError ? t("billing.withdraw.error") : undefined}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => withdraw.mutate()}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t("billing.delete.title")}
        description={t("billing.delete.description")}
        entity={invoice.number}
        confirmLabel={t("billing.delete.confirm")}
        cancelLabel={t("billing.delete.keep")}
        tone="destructive"
        busy={deleteDraft.isPending}
        error={deleteDraft.isError ? t("billing.delete.error") : undefined}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => deleteDraft.mutate()}
      />

      {invoice.status === "draft" && canWrite ? (
        <section className="invoice-action-panel">
          <div>
            <h2>{t("billing.draftActions")}</h2>
            <p>{t("billing.draftActionsHelp")}</p>
          </div>
          <div className="invoice-action-buttons">
            <Button loading={issue.isPending} onClick={() => issue.mutate()}>
              {t("billing.issue")}
            </Button>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              {t("billing.delete.action")}
            </Button>
          </div>
        </section>
      ) : null}

      {invoice.status === "issued" && canWrite ? (
        <section className="invoice-action-panel invoice-action-panel--danger">
          <div>
            <h2>{t("billing.withdraw.action")}</h2>
            <p>{t("billing.withdraw.help")}</p>
          </div>
          <Button variant="destructive" onClick={() => setConfirmCancel(true)}>
            {t("billing.withdraw.action")}
          </Button>
        </section>
      ) : null}

      {invoice.status === "issued" || invoice.status === "partially_paid" ? (
        <section className="invoice-action-panel" aria-labelledby="payment-title">
          <div>
            <span className="invoice-kicker">04 / PAYMENT</span>
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

      {invoice.paymentSummary?.status === "paid" ? (
        <section className="invoice-action-panel" aria-labelledby="application-title">
          <div>
            <span className="invoice-kicker">05 / APPLICATION</span>
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
    </section>
  );
}
