import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router";
import type { TFunction } from "i18next";

import { CABINET_CAPABILITY } from "@markiro/domain";
import { Alert, Button, Card, EmptyState, Spinner, Textarea } from "@markiro/ui";

import { useCan } from "../../access/context.js";
import { ApiRequestError } from "../../api/client.js";
import { BillingStatusChip } from "./BillingSections.js";
import type { AttachmentUploadResult } from "./CreateRequestPage.js";
import {
  downloadRequestAttachment,
  invalidateTenantBillingRequests,
  isRetryableApiError,
  mergeBillingRequestAttachment,
  replyToBillingRequest,
  type TenantBillingRequestEvent,
  type TenantBillingRequestLink,
  uploadBillingRequestAttachment,
  useBillingRequest,
} from "./api.js";
import { formatBillingDate, formatBillingDateTime } from "./format.js";

interface ReplyAttempt {
  body: string;
  key: string;
}

function isAttachmentUploadState(value: unknown): value is AttachmentUploadResult["state"] {
  return value === "uploading" || value === "failed_retryable" || value === "failed_terminal";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function attachmentUploadsFromState(state: unknown): AttachmentUploadResult[] {
  if (!state || typeof state !== "object" || !("attachmentUploads" in state)) return [];
  const uploads = state.attachmentUploads;
  if (!Array.isArray(uploads)) return [];
  return uploads.filter(
    (item): item is AttachmentUploadResult =>
      isRecord(item) && item.file instanceof File && isAttachmentUploadState(item.state),
  );
}

function eventBody(event: TenantBillingRequestEvent, t: TFunction) {
  if (event.message) return event.message;
  if (event.kind === "status_changed" && event.fromStatus && event.toStatus) {
    return t("pages.billing.requests.detail.eventStatusBody", {
      from: t(`pages.billing.status.request.${event.fromStatus}`),
      to: t(`pages.billing.status.request.${event.toStatus}`),
    });
  }
  return t(`pages.billing.requests.detail.eventBodies.${event.kind}`);
}

function EventSide({ actorKind }: { actorKind: TenantBillingRequestEvent["actorKind"] }) {
  const { t } = useTranslation();
  const side =
    actorKind === "tenant_user" ? "tenant" : actorKind === "platform_user" ? "markiro" : "system";
  return <span>{t(`pages.billing.requests.detail.eventSides.${side}`)}</span>;
}

function LinkedObject({ link }: { link: TenantBillingRequestLink }) {
  const { t } = useTranslation();
  if (link.offerId) {
    return (
      <Link to={`/billing/offers/${link.offerId}`}>
        {t("pages.billing.requests.detail.links.offer")}
      </Link>
    );
  }
  if (link.invoiceId) {
    return (
      <Link to={`/billing/invoices/${link.invoiceId}`}>
        {t("pages.billing.requests.detail.links.invoice")}
      </Link>
    );
  }
  const kind = link.paymentId
    ? "payment"
    : link.actId
      ? "act"
      : link.orderedServiceId
        ? "service"
        : "subscription";
  return <span>{t(`pages.billing.requests.detail.links.${kind}`)}</span>;
}

export function RequestDetailPage() {
  const { id = "" } = useParams();
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const location = useLocation();
  const query = useBillingRequest(id);
  const canMutate = useCan(CABINET_CAPABILITY.BILLING_REQUEST);
  const [uploads, setUploads] = useState<AttachmentUploadResult[]>(() =>
    attachmentUploadsFromState(location.state),
  );
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState(false);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<"validation" | "retryable" | "terminal" | null>(
    null,
  );
  const [replyBusy, setReplyBusy] = useState(false);
  const attempt = useRef<ReplyAttempt | null>(null);
  const replyLock = useRef(false);
  const uploadLocks = useRef(new Set<File>());

  if (query.isPending) return <Spinner label={t("pages.billing.requests.detail.loading")} />;
  if (query.isError) {
    const status = query.error instanceof ApiRequestError ? query.error.status : 0;
    return (
      <EmptyState
        title={
          status === 404
            ? t("pages.billing.requests.detail.notFound")
            : status === 403
              ? t("pages.billing.requests.detail.forbidden")
              : t("pages.billing.requests.detail.loadError")
        }
        action={
          status === 404 || status === 403 ? undefined : (
            <Button onClick={() => void query.refetch()}>{t("pages.billing.retry")}</Button>
          )
        }
      />
    );
  }
  const request = query.data;
  if (!request) return <EmptyState title={t("pages.billing.requests.detail.notFound")} />;

  const download = (attachmentId: string) =>
    void (async () => {
      setDownloadBusy(attachmentId);
      setDownloadError(false);
      try {
        const result = await downloadRequestAttachment(request.id, attachmentId);
        window.open(result.url, "_blank", "noopener,noreferrer");
      } catch {
        setDownloadError(true);
      } finally {
        setDownloadBusy(null);
      }
    })();

  const retryUpload = (index: number) =>
    void (async () => {
      const item = uploads[index];
      if (
        !canMutate ||
        !item ||
        item.state !== "failed_retryable" ||
        uploadLocks.current.has(item.file)
      ) {
        return;
      }
      uploadLocks.current.add(item.file);
      setUploads((current) =>
        current.map((upload, currentIndex) =>
          currentIndex === index ? { ...upload, state: "uploading" } : upload,
        ),
      );
      try {
        try {
          const attachment = await uploadBillingRequestAttachment(request.id, item.file);
          mergeBillingRequestAttachment(client, request.id, attachment);
          setUploads((current) => current.filter((upload) => upload.file !== item.file));
        } catch (cause) {
          setUploads((current) =>
            current.map((upload) =>
              upload.file === item.file
                ? {
                    ...upload,
                    state: isRetryableApiError(cause) ? "failed_retryable" : "failed_terminal",
                  }
                : upload,
            ),
          );
          return;
        }
        try {
          await invalidateTenantBillingRequests(client, request.id);
        } catch {
          // The complete returned row is already reconciled into the exact detail cache.
        }
      } finally {
        uploadLocks.current.delete(item.file);
      }
    })();

  const submitReply = (reuse = false) =>
    void (async () => {
      if (replyLock.current) return;
      const body = reply.trim();
      if (body.length < 1 || body.length > 2000) {
        attempt.current = null;
        setReplyError("validation");
        return;
      }
      const next = reuse ? attempt.current : { body, key: crypto.randomUUID() };
      if (!next) return;
      attempt.current = next;
      replyLock.current = true;
      setReplyBusy(true);
      setReplyError(null);
      try {
        await replyToBillingRequest(request.id, next.body, next.key);
        await invalidateTenantBillingRequests(client, request.id);
        attempt.current = null;
        setReply("");
      } catch (cause) {
        if (!(cause instanceof ApiRequestError) || cause.status >= 500) {
          setReplyError("retryable");
        } else {
          attempt.current = null;
          setReplyError("terminal");
          try {
            await query.refetch();
          } catch {
            // The normal detail retry remains available if this refresh also fails.
          }
        }
      } finally {
        replyLock.current = false;
        setReplyBusy(false);
      }
    })();

  const events = [...request.events].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
  );
  return (
    <section className="mk-billing-request-detail" aria-labelledby="billing-request-heading">
      <div className="mk-billing-section-intro">
        <div>
          <h2 className="mk-billing-section-heading" id="billing-request-heading">
            {t("pages.billing.requests.detail.heading", { number: request.number })}
          </h2>
          <p>{t(`pages.billing.requests.types.${request.type}`)}</p>
        </div>
        <Link className="mk-billing-inline-link" to="/billing/requests">
          {t("pages.billing.requests.detail.back")}
        </Link>
      </div>
      <Card title={t("pages.billing.requests.detail.summary")} titleAs="h3">
        <dl className="mk-billing-definition-list">
          <div>
            <dt>{t("pages.billing.requests.detail.status")}</dt>
            <dd>
              <BillingStatusChip kind="request" value={request.status} />
            </dd>
          </div>
          <div>
            <dt>{t("pages.billing.requests.detail.responsible")}</dt>
            <dd>{t(`pages.billing.requests.responsible.${request.responsibleSide}`)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.requests.detail.desiredAt")}</dt>
            <dd>{formatBillingDate(request.desiredAt, i18n.language)}</dd>
          </div>
          <div>
            <dt>{t("pages.billing.requests.detail.createdAt")}</dt>
            <dd>{formatBillingDate(request.createdAt, i18n.language)}</dd>
          </div>
          {request.context ? (
            <div>
              <dt>{t("pages.billing.requests.detail.context")}</dt>
              <dd>
                {t(`pages.billing.requests.contextTypes.${request.context.type}`, {
                  defaultValue: request.context.type,
                })}{" "}
                —{" "}
                {request.context.type === "limit"
                  ? t(`pages.billing.limits.${request.context.id}`, {
                      defaultValue: request.context.id,
                    })
                  : request.context.id}
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>
      <Card title={t("pages.billing.requests.detail.requestText")} titleAs="h3">
        <p className="mk-billing-request-description">{request.description}</p>
      </Card>
      {request.links.length > 0 ? (
        <Card title={t("pages.billing.requests.detail.linkedObjects")} titleAs="h3">
          <ul className="mk-billing-linked-list">
            {request.links.map((link) => (
              <li key={link.id}>
                <LinkedObject link={link} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card title={t("pages.billing.requests.detail.attachments")} titleAs="h3">
        {downloadError ? (
          <Alert tone="error">{t("pages.billing.requests.detail.downloadError")}</Alert>
        ) : null}
        {request.attachments.length === 0 && uploads.length === 0 ? (
          <p className="mk-billing-muted">{t("pages.billing.requests.detail.noAttachments")}</p>
        ) : (
          <ul className="mk-billing-attachment-list">
            {request.attachments.map((attachment) => {
              return (
                <li key={attachment.id}>
                  <span>{attachment.fileName}</span>
                  <Button
                    size="compact"
                    disabled={downloadBusy === attachment.id}
                    loading={downloadBusy === attachment.id}
                    aria-label={t("pages.billing.requests.detail.downloadNamed", {
                      name: attachment.fileName,
                    })}
                    onClick={() => download(attachment.id)}
                  >
                    {t("pages.billing.requests.detail.download")}
                  </Button>
                </li>
              );
            })}
            {uploads.map((upload, index) => (
              <li key={`${upload.file.name}-${index}`}>
                <span>
                  {t(`pages.billing.requests.detail.uploadResult.${upload.state}`, {
                    name: upload.file.name,
                  })}
                </span>
                {canMutate && upload.state === "failed_retryable" ? (
                  <Button
                    size="compact"
                    variant="secondary"
                    aria-label={t("pages.billing.requests.detail.retryUploadNamed", {
                      name: upload.file.name,
                    })}
                    onClick={() => retryUpload(index)}
                  >
                    {t("pages.billing.retry")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={t("pages.billing.requests.detail.history")} titleAs="h3">
        <ol
          className="mk-billing-request-events"
          aria-label={t("pages.billing.requests.detail.history")}
        >
          {events.map((event) => (
            <li key={event.id}>
              <div className="mk-billing-request-event__meta">
                <EventSide actorKind={event.actorKind} />
                <time dateTime={event.createdAt}>
                  {formatBillingDateTime(event.createdAt, i18n.language)}
                </time>
              </div>
              <strong>{t(`pages.billing.requests.detail.eventKinds.${event.kind}`)}</strong>
              <p>{eventBody(event, t)}</p>
            </li>
          ))}
        </ol>
      </Card>
      {canMutate && request.status === "clarification_required" ? (
        <Card title={t("pages.billing.requests.detail.replyTitle")} titleAs="h3">
          {replyError ? (
            <Alert tone="error">
              {t(`pages.billing.requests.detail.replyErrors.${replyError}`)}{" "}
              {replyError === "retryable" && attempt.current ? (
                <Button variant="secondary" onClick={() => submitReply(true)}>
                  {t("pages.billing.requests.create.retry")}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <form
            className="mk-billing-request-form"
            onSubmit={(event) => {
              event.preventDefault();
              submitReply();
            }}
          >
            <Textarea
              label={t("pages.billing.requests.detail.replyLabel")}
              value={reply}
              maxLength={2001}
              disabled={replyBusy}
              onChange={(event) => {
                setReply(event.target.value);
                attempt.current = null;
                setReplyError(null);
              }}
            />
            <Button type="submit" loading={replyBusy} disabled={replyBusy}>
              {t("pages.billing.requests.detail.replySubmit")}
            </Button>
          </form>
        </Card>
      ) : null}
    </section>
  );
}
