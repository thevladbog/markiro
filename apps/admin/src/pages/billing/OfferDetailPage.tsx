import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Table,
  Textarea,
} from "@markiro/ui";
import type { CabinetCapability } from "@markiro/domain";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { formatBillingDate, formatMoney } from "./format.js";
import {
  acceptOffer,
  downloadOfferDocument,
  invalidateTenantBilling,
  requestOfferChanges,
  type OfferDecision,
  useOffer,
} from "./api.js";

type Attempt = { decision: OfferDecision["decision"]; message: string; key: string };
type TerminalOfferErrorCode =
  | "offer_version_stale"
  | "offer_expired"
  | "offer_not_published"
  | "offer_already_decided"
  | "idempotency_key_reused";
type ActionError =
  | { kind: "validation" }
  | { kind: "retryable" }
  | { kind: "terminal"; code: TerminalOfferErrorCode | "conflict" | "rejected" };

const TERMINAL_OFFER_ERROR_CODES = new Set<TerminalOfferErrorCode>([
  "offer_version_stale",
  "offer_expired",
  "offer_not_published",
  "offer_already_decided",
  "idempotency_key_reused",
]);
const BILLING_REQUEST_CAPABILITY: CabinetCapability = "billing.request";

function classifyActionError(cause: unknown): ActionError {
  if (!(cause instanceof ApiRequestError) || cause.status >= 500) {
    return { kind: "retryable" };
  }
  if (cause.status === 409) {
    if (cause.code && TERMINAL_OFFER_ERROR_CODES.has(cause.code as TerminalOfferErrorCode)) {
      return { kind: "terminal", code: cause.code as TerminalOfferErrorCode };
    }
    return { kind: "terminal", code: "conflict" };
  }
  return { kind: "terminal", code: "rejected" };
}

export function OfferDetailPage() {
  const { t, i18n } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const canRequest = useCan(BILLING_REQUEST_CAPABILITY);
  const query = useOffer(id);
  const attempt = useRef<Attempt | null>(null);
  const actionLock = useRef(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<OfferDecision["decision"] | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const offer = query.data;

  const submit = (decision: OfferDecision["decision"], retry = false) =>
    void (async () => {
      if (!offer || pending || actionLock.current) return;
      const next = retry
        ? attempt.current
        : { decision, message: message.trim(), key: crypto.randomUUID() };
      if (!next || next.decision !== decision) return;
      if (
        decision === "changes_requested" &&
        (next.message.length < 1 || next.message.length > 2000)
      ) {
        attempt.current = null;
        setError({ kind: "validation" });
        return;
      }
      if (!retry) attempt.current = next;
      actionLock.current = true;
      setPending(decision);
      setError(null);
      try {
        if (decision === "accepted") await acceptOffer(offer.id, next.key);
        else await requestOfferChanges(offer.id, next.message, next.key);
        await invalidateTenantBilling(client);
        attempt.current = null;
        setAcceptOpen(false);
        setChangeOpen(false);
        void navigate("/billing/documents");
      } catch (cause) {
        const nextError = classifyActionError(cause);
        if (nextError.kind === "terminal") {
          attempt.current = null;
          if (cause instanceof ApiRequestError && cause.status === 409) {
            try {
              await invalidateTenantBilling(client);
              await query.refetch();
            } catch {
              // The authoritative refresh can be retried through normal query controls.
            }
          }
        }
        setError(nextError);
      } finally {
        actionLock.current = false;
        setPending(null);
      }
    })();

  if (query.isPending) return <Spinner label={t("pages.billing.offer.loading")} />;
  if (query.isError) {
    const status = query.error instanceof ApiRequestError ? query.error.status : 0;
    return (
      <EmptyState
        title={
          status === 404
            ? t("pages.billing.offer.notFound")
            : status === 403
              ? t("pages.billing.offer.forbidden")
              : t("pages.billing.offer.loadError")
        }
        action={
          status === 404 || status === 403 ? undefined : (
            <Button onClick={() => void query.refetch()}>{t("pages.billing.retry")}</Button>
          )
        }
      />
    );
  }
  if (!offer) return <EmptyState title={t("pages.billing.offer.notFound")} />;
  const retry = () => {
    if (error?.kind === "retryable" && attempt.current && !pending) {
      submit(attempt.current.decision, true);
    }
  };
  const selectAction = (decision: OfferDecision["decision"]) => {
    attempt.current = null;
    setError(null);
    setAcceptOpen(decision === "accepted");
    setChangeOpen(decision === "changes_requested");
  };
  const download = (documentId: string) =>
    void (async () => {
      try {
        setDownloadBusy(documentId);
        setDownloadError(false);
        const result = await downloadOfferDocument(offer.id, documentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError(true);
      } finally {
        setDownloadBusy(null);
      }
    })();
  return (
    <section aria-labelledby="billing-offer-heading" className="mk-billing-offer-detail">
      <h2 className="mk-billing-section-heading" id="billing-offer-heading">
        {t("pages.billing.offer.heading", {
          number: offer.number ?? t("pages.billing.offer.withoutNumber"),
        })}
      </h2>
      <Card title={t("pages.billing.offer.conditions")} titleAs="h3">
        <dl className="mk-billing-definition-list">
          <div>
            <dt>{t("pages.billing.offer.lifecycleStatus")}</dt>
            <dd>{t(`pages.billing.offer.status.${offer.status}`)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.offer.currentnessLabel")}</dt>
            <dd>
              {t(`pages.billing.offer.currentness.${offer.isCurrent ? "current" : "notCurrent"}`)}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.offer.latestDecisionLabel")}</dt>
            <dd>
              {t(`pages.billing.offer.latestDecision.${offer.latestDecision?.decision ?? "none"}`)}
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.offer.expiresAt")}</dt>
            <dd>{formatBillingDate(offer.expiresAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.offer.publishedAt")}</dt>
            <dd>{formatBillingDate(offer.publishedAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.offer.total")}</dt>
            <dd className="mk-billing-money">{formatMoney(offer.total, "RUB", i18n.language)}</dd>
          </div>
        </dl>
        {offer.termsMarkdown ? (
          <p className="mk-billing-offer-terms">{offer.termsMarkdown}</p>
        ) : null}
        {offer.latestDecision?.message ? <p>{offer.latestDecision.message}</p> : null}
      </Card>
      {error ? (
        <Alert tone="error">
          {t(
            error.kind === "validation"
              ? "pages.billing.offer.validationError"
              : error.kind === "retryable"
                ? "pages.billing.offer.actionErrors.retryable"
                : `pages.billing.offer.actionErrors.${error.code}`,
          )}{" "}
          {error.kind === "retryable" && attempt.current ? (
            <Button variant="secondary" onClick={retry}>
              {t("pages.billing.retry")}
            </Button>
          ) : null}
        </Alert>
      ) : null}
      {downloadError ? <Alert tone="error">{t("pages.billing.offer.downloadError")}</Alert> : null}
      <Card title={t("pages.billing.offer.lines")} titleAs="h3">
        <div className="mk-billing-table-wrap">
          <Table
            scrollLabel={t("pages.billing.offer.linesRegistry")}
            columns={[
              {
                key: "position",
                title: t("pages.billing.invoices.lineColumns.position"),
                mono: true,
              },
              {
                key: "nameRu",
                title: t("pages.billing.invoices.lineColumns.name"),
                wrap: true,
              },
              {
                key: "quantity",
                title: t("pages.billing.invoices.lineColumns.quantity"),
                mono: true,
              },
              {
                key: "lineTotal",
                title: t("pages.billing.invoices.lineColumns.total"),
                mono: true,
                align: "right",
                render: (row) => formatMoney(row.lineTotal, "RUB", i18n.language),
              },
            ]}
            rows={offer.lines}
          />
        </div>
      </Card>
      <Card title={t("pages.billing.offer.documents")} titleAs="h3">
        {offer.documents.map((document) => (
          <div className="mk-billing-invoice-document" key={document.id}>
            <span>
              {t("pages.billing.offer.documentMeta", {
                format: document.format.toUpperCase(),
                revision: document.revision,
                status: t(`pages.billing.documents.status.${document.status}`),
              })}
            </span>
            {document.status === "ready" ? (
              <Button
                disabled={downloadBusy === document.id}
                loading={downloadBusy === document.id}
                onClick={() => download(document.id)}
              >
                {t("pages.billing.offer.download")}
              </Button>
            ) : null}
          </div>
        ))}
      </Card>
      {canRequest && offer.actionable ? (
        <Card title={t("pages.billing.offer.decision")} titleAs="h3">
          <Button disabled={pending !== null} onClick={() => selectAction("accepted")}>
            {t("pages.billing.offer.accept")}
          </Button>
          <Button
            variant="secondary"
            disabled={pending !== null}
            onClick={() => selectAction("changes_requested")}
          >
            {t("pages.billing.offer.requestChanges")}
          </Button>
          {changeOpen ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit("changes_requested");
              }}
            >
              <Textarea
                label={t("pages.billing.offer.changeLabel")}
                value={message}
                maxLength={2000}
                aria-describedby="offer-change-help"
                onChange={(event) => {
                  setMessage(event.target.value);
                  attempt.current = null;
                  setError(null);
                }}
              />
              <p id="offer-change-help">{t("pages.billing.offer.changeHelp")}</p>
              <Button type="submit" disabled={pending !== null}>
                {t("pages.billing.offer.submitChanges")}
              </Button>
            </form>
          ) : null}
        </Card>
      ) : null}
      <ConfirmDialog
        open={acceptOpen}
        title={t("pages.billing.offer.confirmTitle")}
        description={t("pages.billing.offer.confirmDescription")}
        confirmLabel={t("pages.billing.offer.confirmAccept")}
        cancelLabel={t("pages.billing.offer.cancel")}
        busy={pending === "accepted"}
        onConfirm={() => submit("accepted")}
        onCancel={() => setAcceptOpen(false)}
      />
    </section>
  );
}
