import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Alert, Button, Input, SectionHeader, Spinner, StatusChip, Table } from "@markiro/ui";
import {
  platformCommercialContracts,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestStatusMutationDto,
} from "@markiro/platform-contracts";

import { ApiRequestError } from "../../api/client.js";
import { usePlatformPrincipal } from "../../auth/PlatformAuthBoundary.js";
import { reviseOffer } from "../offers/api.js";
import {
  commentBillingRequest,
  getBillingRequest,
  linkBillingRequest,
  listBillingRequests,
  transitionBillingRequest,
  type BillingRequestListItem,
} from "./api.js";

const listKey = ["platform", "billing", "requests"] as const;
const requestStatuses = [
  "new",
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
] as const;
const requestTypes = [
  "renewal",
  "capacity_change",
  "additional_service",
  "documents",
  "other",
] as const;
const linkTypes = ["offer", "invoice", "payment", "act", "ordered_service"] as const;

export function BillingRequestsPage() {
  const { t } = useTranslation();
  const principal = usePlatformPrincipal();
  if (!principal.capabilities.includes("billing.read")) {
    return (
      <section className="catalog-page">
        <h1>{t("billingRequests.forbiddenTitle")}</h1>
        <Alert tone="error">{t("billingRequests.forbiddenBody")}</Alert>
      </section>
    );
  }
  return <BillingRequestsWorkspace writable={principal.capabilities.includes("billing.write")} />;
}

function BillingRequestsWorkspace({ writable }: { writable: boolean }) {
  const { requestId } = useParams();
  return requestId ? <RequestDetail requestId={requestId} writable={writable} /> : <RequestList />;
}

function RequestList() {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const query = useMemo(() => {
    const candidate = Object.fromEntries(
      ["tenantId", "status", "type"]
        .map((key) => [key, search.get(key)] as const)
        .filter(
          (entry): entry is readonly [string, string] => entry[1] !== null && entry[1] !== "",
        ),
    );
    return platformCommercialContracts.billingRequests.list.query.safeParse(candidate).data ?? {};
  }, [search]);
  const requests = useQuery({
    queryKey: [...listKey, query],
    queryFn: () => listBillingRequests(query),
  });
  const updateFilter = (name: string, value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearch(next, { replace: true });
  };
  return (
    <section className="catalog-page billing-requests-page">
      <SectionHeader
        eyebrow="COMMERCE / REQUESTS"
        title={t("billingRequests.title")}
        description={t("billingRequests.description")}
      />
      <form className="billing-request-filters" aria-label={t("billingRequests.filters.title")}>
        <Input
          label={t("billingRequests.fields.tenant")}
          value={search.get("tenantId") ?? ""}
          onChange={(event) => updateFilter("tenantId", event.target.value)}
        />
        <label>
          <span>{t("billingRequests.fields.status")}</span>
          <select
            value={search.get("status") ?? ""}
            onChange={(event) => updateFilter("status", event.target.value)}
          >
            <option value="">{t("billingRequests.filters.all")}</option>
            {requestStatuses.map((status) => (
              <option key={status} value={status}>
                {t(`billingRequests.status.${status}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("billingRequests.fields.type")}</span>
          <select
            value={search.get("type") ?? ""}
            onChange={(event) => updateFilter("type", event.target.value)}
          >
            <option value="">{t("billingRequests.filters.all")}</option>
            {requestTypes.map((type) => (
              <option key={type} value={type}>
                {t(`billingRequests.type.${type}`)}
              </option>
            ))}
          </select>
        </label>
      </form>
      {requests.isPending ? <Spinner label={t("shell.routeLoading")} /> : null}
      {requests.error ? <Alert tone="error">{t("billingRequests.loadError")}</Alert> : null}
      {requests.data?.truncated ? (
        <Alert tone="warn">{t("billingRequests.truncated")}</Alert>
      ) : null}
      {requests.data ? (
        <Table
          columns={[
            {
              key: "number",
              title: t("billingRequests.fields.number"),
              render: (request: BillingRequestListItem) => (
                <Link to={`/billing-requests/${request.id}`}>{request.number}</Link>
              ),
            },
            {
              key: "tenantName",
              title: t("billingRequests.fields.tenant"),
              render: (request: BillingRequestListItem) => (
                <Link to={`/tenants/${request.tenantId}`}>{request.tenantName}</Link>
              ),
            },
            {
              key: "type",
              title: t("billingRequests.fields.type"),
              render: (request: BillingRequestListItem) =>
                t(`billingRequests.type.${request.type}`),
            },
            {
              key: "status",
              title: t("billingRequests.fields.status"),
              render: (request: BillingRequestListItem) => (
                <StatusChip
                  status="neutral"
                  label={t(`billingRequests.status.${request.status}`)}
                />
              ),
            },
            {
              key: "responsibleSide",
              title: t("billingRequests.fields.responsible"),
              render: (request: BillingRequestListItem) =>
                t(`billingRequests.side.${request.responsibleSide}`),
            },
            {
              key: "latestEvent",
              title: t("billingRequests.fields.latestEvent"),
              render: (request: BillingRequestListItem) =>
                request.latestEvent
                  ? t(`billingRequests.event.${request.latestEvent.kind}`)
                  : t("billingRequests.none"),
            },
          ]}
          rows={requests.data.items}
          empty={t("billingRequests.empty")}
        />
      ) : null}
    </section>
  );
}

function RequestDetail({ requestId, writable }: { requestId: string; writable: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [comment, setComment] = useState("");
  const [commentAttempt, setCommentAttempt] = useState<PlatformBillingRequestCommentDto | null>(
    null,
  );
  const [transitionAttempt, setTransitionAttempt] =
    useState<PlatformBillingRequestStatusMutationDto | null>(null);
  const [linkType, setLinkType] = useState<PlatformBillingRequestLinkDto["type"]>("offer");
  const [targetId, setTargetId] = useState("");
  const [linkAttempt, setLinkAttempt] = useState<PlatformBillingRequestLinkDto | null>(null);
  const [reviseAttempt, setReviseAttempt] = useState<{
    offerId: string;
    idempotencyKey: string;
  } | null>(null);
  const detailKey = [...listKey, requestId] as const;
  const detail = useQuery({ queryKey: detailKey, queryFn: () => getBillingRequest(requestId) });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: listKey }),
      client.invalidateQueries({ queryKey: detailKey }),
    ]);
  };
  const commentMutation = useMutation({
    mutationFn: (input: PlatformBillingRequestCommentDto) =>
      commentBillingRequest(requestId, input),
    onSuccess: async () => {
      setComment("");
      setCommentAttempt(null);
      await refresh();
    },
    onError: async (error) => {
      if (!retryable(error)) {
        setCommentAttempt(null);
        await refresh();
      }
    },
  });
  const transition = useMutation({
    mutationFn: (input: PlatformBillingRequestStatusMutationDto) =>
      transitionBillingRequest(requestId, input),
    onSuccess: async () => {
      setTransitionAttempt(null);
      await refresh();
    },
    onError: async (error) => {
      if (!retryable(error)) {
        setTransitionAttempt(null);
        await refresh();
      }
    },
  });
  const link = useMutation({
    mutationFn: (input: PlatformBillingRequestLinkDto) => linkBillingRequest(requestId, input),
    onSuccess: async () => {
      setTargetId("");
      setLinkAttempt(null);
      await refresh();
    },
    onError: async (error) => {
      if (!retryable(error)) {
        setLinkAttempt(null);
        await refresh();
      }
    },
  });
  const revise = useMutation({
    mutationFn: (attempt: { offerId: string; idempotencyKey: string }) =>
      reviseOffer(attempt.offerId, attempt.idempotencyKey),
    onSuccess: async (offer) => {
      setReviseAttempt(null);
      await refresh();
      void navigate(`/offers?selected=${offer.id}`);
    },
    onError: async (error) => {
      if (!retryable(error)) {
        setReviseAttempt(null);
        await refresh();
      }
    },
  });
  if (detail.isPending) return <Spinner label={t("shell.routeLoading")} />;
  if (detail.error) {
    const forbidden = detail.error instanceof ApiRequestError && detail.error.status === 403;
    return (
      <section className="catalog-page">
        <h1>{forbidden ? t("billingRequests.forbiddenTitle") : t("billingRequests.title")}</h1>
        <Alert tone="error">
          {forbidden ? t("billingRequests.forbiddenBody") : t("billingRequests.loadError")}
        </Alert>
      </section>
    );
  }
  const request = detail.data;
  if (!request) return null;
  const offerAction = request.offerAction;
  const retainedAction = commentAttempt
    ? "comment"
    : transitionAttempt
      ? "transition"
      : linkAttempt
        ? "link"
        : reviseAttempt
          ? "revise"
          : null;
  const actionPending =
    commentMutation.isPending || transition.isPending || link.isPending || revise.isPending;
  const submitComment = () => {
    if (retainedAction && retainedAction !== "comment") return;
    const attempt = commentAttempt ?? { message: comment, idempotencyKey: crypto.randomUUID() };
    setCommentAttempt(attempt);
    commentMutation.mutate(attempt);
  };
  const submitTransition = (status: PlatformBillingRequestStatusMutationDto["status"]) => {
    if (retainedAction && retainedAction !== "transition") return;
    const attempt =
      transitionAttempt?.status === status
        ? transitionAttempt
        : { status, idempotencyKey: crypto.randomUUID() };
    setTransitionAttempt(attempt);
    transition.mutate(attempt);
  };
  const submitLink = () => {
    if (retainedAction && retainedAction !== "link") return;
    const attempt = linkAttempt ?? {
      type: linkType,
      targetId,
      idempotencyKey: crypto.randomUUID(),
    };
    setLinkAttempt(attempt);
    link.mutate(attempt);
  };
  const submitRevision = (offerId: string) => {
    if (retainedAction && retainedAction !== "revise") return;
    const attempt = reviseAttempt ?? { offerId, idempotencyKey: crypto.randomUUID() };
    setReviseAttempt(attempt);
    revise.mutate(attempt);
  };
  return (
    <section className="catalog-page billing-request-detail">
      <SectionHeader
        eyebrow="COMMERCE / REQUESTS / DETAIL"
        title={request.number}
        description={request.description}
        actionsLabel={t("billingRequests.actions")}
        actions={<Link to="/billing-requests">{t("billingRequests.back")}</Link>}
      />
      <dl className="billing-request-facts">
        <div>
          <dt>{t("billingRequests.fields.tenant")}</dt>
          <dd>
            <Link to={`/tenants/${request.tenantId}`}>{request.tenantName}</Link>
          </dd>
        </div>
        <div>
          <dt>{t("billingRequests.fields.type")}</dt>
          <dd>{t(`billingRequests.type.${request.type}`)}</dd>
        </div>
        <div>
          <dt>{t("billingRequests.fields.status")}</dt>
          <dd>{t(`billingRequests.status.${request.status}`)}</dd>
        </div>
        <div>
          <dt>{t("billingRequests.fields.responsible")}</dt>
          <dd>{t(`billingRequests.side.${request.responsibleSide}`)}</dd>
        </div>
      </dl>
      <section className="commerce-detail-panel" aria-labelledby="request-links-title">
        <header>
          <h2 id="request-links-title">{t("billingRequests.links.title")}</h2>
        </header>
        <ul>
          {request.links.map((item) => (
            <li key={item.id}>
              {t(`billingRequests.links.${item.type}`)} ·{" "}
              <strong>{item.targetLabel ?? t("billingRequests.links.unnamed")}</strong>
            </li>
          ))}
        </ul>
        {writable ? (
          <div className="billing-request-actions">
            {!retainedAction ? (
              <Link to={`/billing-requests/${request.id}/offers/new`}>
                {t("billingRequests.createOffer")}
              </Link>
            ) : null}
            {offerAction?.canCreateInvoice && !retainedAction ? (
              <Link
                to="/invoices/new"
                state={{
                  sourceOfferId: offerAction.offerId,
                  sourceRequestId: request.id,
                }}
              >
                {t("billingRequests.createInvoice")}
              </Link>
            ) : null}
            {offerAction?.canRevise ? (
              <Button
                disabled={
                  actionPending ||
                  (retainedAction !== null && retainedAction !== "revise") ||
                  (revise.isError && !retryable(revise.error))
                }
                loading={revise.isPending}
                onClick={() => submitRevision(offerAction.offerId)}
              >
                {t("billingRequests.reviseOffer")}
              </Button>
            ) : null}
            {!retainedAction ? (
              <Link
                to={`/billing-acts/new?tenantId=${encodeURIComponent(request.tenantId)}&requestId=${request.id}`}
              >
                {t("billingRequests.issueAct")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="commerce-detail-panel" aria-labelledby="request-events-title">
        <header>
          <h2 id="request-events-title">{t("billingRequests.history")}</h2>
        </header>
        <ol className="billing-request-events">
          {request.events.map((item) => (
            <li key={item.id}>
              <strong>{t(`billingRequests.event.${item.kind}`)}</strong>
              <span>
                {t(`billingRequests.actor.${item.actorKind}`)} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </span>
              {item.message ? <p>{item.message}</p> : null}
            </li>
          ))}
        </ol>
      </section>
      {writable ? (
        <section className="commerce-detail-panel" aria-labelledby="request-mutations-title">
          <header>
            <h2 id="request-mutations-title">{t("billingRequests.actions")}</h2>
          </header>
          <div className="billing-request-actions">
            {request.allowedTransitions.map((status) => (
              <Button
                key={status}
                variant="secondary"
                disabled={
                  actionPending ||
                  (retainedAction !== null &&
                    (retainedAction !== "transition" || transitionAttempt?.status !== status)) ||
                  (transition.isError && !retryable(transition.error))
                }
                onClick={() => submitTransition(status)}
              >
                {t(`billingRequests.status.${status}`)}
              </Button>
            ))}
          </div>
          <div
            className="billing-request-comment-form"
            role="group"
            aria-label={t("billingRequests.comment")}
          >
            <Input
              label={t("billingRequests.comment")}
              value={comment}
              disabled={retainedAction !== null}
              onChange={(event) => {
                setComment(event.target.value);
                setCommentAttempt(null);
                commentMutation.reset();
              }}
            />
            <Button
              disabled={
                !comment.trim() ||
                actionPending ||
                (retainedAction !== null && retainedAction !== "comment") ||
                (commentMutation.isError && !retryable(commentMutation.error))
              }
              loading={commentMutation.isPending}
              onClick={submitComment}
            >
              {commentMutation.isError && retryable(commentMutation.error)
                ? t("billingRequests.retry")
                : t("billingRequests.addComment")}
            </Button>
          </div>
          <div className="billing-request-link-form">
            <label>
              <span>{t("billingRequests.links.type")}</span>
              <select
                value={linkType}
                disabled={retainedAction !== null}
                onChange={(event) => {
                  const type = linkTypes.find((candidate) => candidate === event.target.value);
                  if (type) {
                    setLinkType(type);
                    setLinkAttempt(null);
                    link.reset();
                  }
                }}
              >
                {linkTypes.map((type) => (
                  <option key={type} value={type}>
                    {t(`billingRequests.links.${type}`)}
                  </option>
                ))}
              </select>
            </label>
            <Input
              label={t("billingRequests.links.target")}
              value={targetId}
              disabled={retainedAction !== null}
              onChange={(event) => {
                setTargetId(event.target.value);
                setLinkAttempt(null);
                link.reset();
              }}
            />
            <Button
              variant="secondary"
              disabled={
                !targetId ||
                actionPending ||
                (retainedAction !== null && retainedAction !== "link") ||
                (link.isError && !retryable(link.error))
              }
              onClick={submitLink}
            >
              {link.isError && retryable(link.error)
                ? t("billingRequests.retry")
                : t("billingRequests.links.add")}
            </Button>
          </div>
          {commentMutation.error || transition.error || link.error || revise.error ? (
            <Alert tone="error">{t("billingRequests.actionError")}</Alert>
          ) : null}
        </section>
      ) : (
        <Alert tone="info">{t("billingRequests.readOnly")}</Alert>
      )}
    </section>
  );
}

function retryable(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === null || error.status >= 500);
}
