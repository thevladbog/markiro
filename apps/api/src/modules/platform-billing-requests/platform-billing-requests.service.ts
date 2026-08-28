import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  platformCommercialContracts,
  type PlatformBillingRequestCommentDto,
  type PlatformBillingRequestEvent,
  type PlatformBillingRequestLink,
  type PlatformBillingRequestLinkDto,
  type PlatformBillingRequestListQueryDto,
  type PlatformBillingRequestStatusMutationDto,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import {
  acquireBillingWorkflowLocks,
  canonicalBillingUuid,
  type BillingWorkflowResource,
} from "../billing-workflow-locks";
import {
  beginPlatformBillingMutation,
  commitPlatformBillingMutation,
} from "../platform-billing-idempotency";

type RequestStatus = typeof schema.tenantBillingRequests.$inferSelect.status;
type LinkType = PlatformBillingRequestLinkDto["type"];
type RequestReadExecutor = Pick<Db, "select">;

const transitions: Record<RequestStatus, readonly RequestStatus[]> = {
  new: ["under_review", "cancelled"],
  under_review: ["clarification_required", "offer_prepared", "in_progress", "cancelled"],
  clarification_required: ["under_review", "cancelled"],
  offer_prepared: ["under_review", "awaiting_payment", "cancelled"],
  awaiting_payment: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

@Injectable()
export class PlatformBillingRequestsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(_actor: PlatformPrincipal, query: PlatformBillingRequestListQueryDto = {}) {
    const conditions = [];
    if (query.tenantId) conditions.push(eq(schema.tenantBillingRequests.tenantId, query.tenantId));
    if (query.status) conditions.push(eq(schema.tenantBillingRequests.status, query.status));
    const requests = await this.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(schema.tenantBillingRequests.updatedAt), desc(schema.tenantBillingRequests.id));
    if (requests.length === 0) return { items: [] };
    const events = await this.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        inArray(
          schema.tenantBillingRequestEvents.requestId,
          requests.map((request) => request.id),
        ),
      )
      .orderBy(
        desc(schema.tenantBillingRequestEvents.createdAt),
        desc(schema.tenantBillingRequestEvents.id),
      );
    const latest = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (!latest.has(event.requestId)) latest.set(event.requestId, event);
    }
    return {
      items: requests.map((request) => ({
        ...requestSource(request),
        latestEvent: latest.has(request.id) ? eventSource(latest.get(request.id)!) : null,
      })),
    };
  }

  async detail(_actor: PlatformPrincipal, requestId: string) {
    return this.detailWith(this.db, requestId);
  }

  async comment(
    actor: PlatformPrincipal,
    requestId: string,
    input: PlatformBillingRequestCommentDto,
  ): Promise<PlatformBillingRequestEvent> {
    const canonicalRequestId = canonicalBillingUuid(requestId);
    const located = await this.locate(canonicalRequestId);
    const message = input.message.trim();
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: located.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.request.comment",
        targetId: canonicalRequestId,
        payload: { message },
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") {
        return platformCommercialContracts.billingRequests.comment.response.parse(mutation.result);
      }
      if (mutation.kind === "pending") mutationInProgress();
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "request", id: canonicalRequestId },
      ]);
      const request = await lockRequest(tx, located.tenantId, canonicalRequestId);
      await rejectExistingEventKey(tx, located.tenantId, input.idempotencyKey);
      const [event] = await tx
        .insert(schema.tenantBillingRequestEvents)
        .values({
          tenantId: request.tenantId,
          requestId: canonicalRequestId,
          kind: "platform_comment",
          actorKind: "platform_user",
          actorPlatformUserId: actor.userId,
          message,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!event) throw new Error("platform billing request comment insert failed");
      const result = eventSource(event);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.request.commented",
        outcome: "success",
        tenantId: request.tenantId,
        targetType: "tenant_billing_request",
        targetId: request.id,
        reason: null,
        before: { status: request.status },
        after: { status: request.status, eventId: event.id },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, event.id, result);
      return result;
    });
  }

  async changeStatus(
    actor: PlatformPrincipal,
    requestId: string,
    input: PlatformBillingRequestStatusMutationDto,
  ): Promise<PlatformBillingRequestEvent> {
    const canonicalRequestId = canonicalBillingUuid(requestId);
    const located = await this.locate(canonicalRequestId);
    const message = input.message?.trim() ?? null;
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: located.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.request.status",
        targetId: canonicalRequestId,
        payload: { status: input.status, message },
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") {
        return platformCommercialContracts.billingRequests.status.response.parse(mutation.result);
      }
      if (mutation.kind === "pending") mutationInProgress();
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "request", id: canonicalRequestId },
      ]);
      const request = await lockRequest(tx, located.tenantId, canonicalRequestId);
      await rejectExistingEventKey(tx, located.tenantId, input.idempotencyKey);
      if (!transitions[request.status].includes(input.status)) {
        throw new ConflictException({ code: "billing_request_transition_invalid" });
      }
      const side = responsibleSide(input.status);
      const now = new Date();
      const [updated] = await tx
        .update(schema.tenantBillingRequests)
        .set({ status: input.status, responsibleSide: side, updatedAt: now })
        .where(
          and(
            eq(schema.tenantBillingRequests.tenantId, request.tenantId),
            eq(schema.tenantBillingRequests.id, request.id),
            eq(schema.tenantBillingRequests.status, request.status),
          ),
        )
        .returning({ id: schema.tenantBillingRequests.id });
      if (!updated) throw new ConflictException({ code: "billing_request_transition_conflict" });
      const [event] = await tx
        .insert(schema.tenantBillingRequestEvents)
        .values({
          tenantId: request.tenantId,
          requestId: canonicalRequestId,
          kind: "status_changed",
          fromStatus: request.status,
          toStatus: input.status,
          actorKind: "platform_user",
          actorPlatformUserId: actor.userId,
          message,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!event) throw new Error("platform billing request status event insert failed");
      const result = eventSource(event);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.request.status_changed",
        outcome: "success",
        tenantId: request.tenantId,
        targetType: "tenant_billing_request",
        targetId: request.id,
        reason: message,
        before: { status: request.status, responsibleSide: request.responsibleSide },
        after: { status: input.status, responsibleSide: side, eventId: event.id },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, event.id, result);
      return result;
    });
  }

  async link(
    actor: PlatformPrincipal,
    requestId: string,
    input: PlatformBillingRequestLinkDto,
  ): Promise<PlatformBillingRequestLink> {
    const canonicalRequestId = canonicalBillingUuid(requestId);
    const canonicalTargetId = canonicalBillingUuid(input.targetId);
    const located = await this.locate(canonicalRequestId);
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: located.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.request.link",
        targetId: canonicalRequestId,
        payload: { type: input.type, targetId: canonicalTargetId },
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") {
        return platformCommercialContracts.billingRequests.link.response.parse(mutation.result);
      }
      if (mutation.kind === "pending") mutationInProgress();
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        linkWorkflowResource(input.type, canonicalTargetId),
        { kind: "request", id: canonicalRequestId },
      ]);
      const request = await lockRequest(tx, located.tenantId, canonicalRequestId);
      await rejectExistingEventKey(tx, located.tenantId, input.idempotencyKey);
      await assertTarget(tx, request.tenantId, input.type, canonicalTargetId);
      await assertTargetNotLinked(tx, request.tenantId, request.id, input.type, canonicalTargetId);
      let link: typeof schema.tenantBillingRequestLinks.$inferSelect | undefined;
      try {
        [link] = await tx
          .insert(schema.tenantBillingRequestLinks)
          .values({
            tenantId: request.tenantId,
            requestId: canonicalRequestId,
            ...linkTargetValues(input.type, canonicalTargetId),
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException({ code: "billing_target_already_linked" });
        }
        throw error;
      }
      if (!link) throw new Error("platform billing request link insert failed");
      const [event] = await tx
        .insert(schema.tenantBillingRequestEvents)
        .values({
          tenantId: request.tenantId,
          requestId: canonicalRequestId,
          kind: linkEventKind(input.type),
          actorKind: "platform_user",
          actorPlatformUserId: actor.userId,
          metadata: { type: input.type, targetId: canonicalTargetId, linkId: link.id },
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!event) throw new Error("platform billing request link event insert failed");
      const result = linkSource(link, input.type, canonicalTargetId);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.request.linked",
        outcome: "success",
        tenantId: request.tenantId,
        targetType: "tenant_billing_request",
        targetId: request.id,
        reason: null,
        before: { status: request.status },
        after: {
          type: input.type,
          targetId: canonicalTargetId,
          linkId: link.id,
          eventId: event.id,
        },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, link.id, result);
      return result;
    });
  }

  private async locate(requestId: string) {
    const [request] = await this.db
      .select({ tenantId: schema.tenantBillingRequests.tenantId })
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, requestId))
      .limit(1);
    if (!request) requestNotFound();
    return request;
  }

  private async detailWith(db: Pick<Db, "select">, requestId: string) {
    const [request] = await db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, requestId))
      .limit(1);
    if (!request) requestNotFound();
    const events = await db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.tenantId, request.tenantId),
          eq(schema.tenantBillingRequestEvents.requestId, request.id),
        ),
      )
      .orderBy(
        asc(schema.tenantBillingRequestEvents.createdAt),
        asc(schema.tenantBillingRequestEvents.id),
      );
    const links = await db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(
        and(
          eq(schema.tenantBillingRequestLinks.tenantId, request.tenantId),
          eq(schema.tenantBillingRequestLinks.requestId, request.id),
        ),
      )
      .orderBy(
        asc(schema.tenantBillingRequestLinks.createdAt),
        asc(schema.tenantBillingRequestLinks.id),
      );
    return {
      ...requestSource(request),
      events: events.map(eventSource),
      links: links.map(inferLinkSource),
    };
  }
}

async function lockRequest(tx: RequestReadExecutor, tenantId: string, requestId: string) {
  const [request] = await tx
    .select()
    .from(schema.tenantBillingRequests)
    .where(
      and(
        eq(schema.tenantBillingRequests.tenantId, tenantId),
        eq(schema.tenantBillingRequests.id, requestId),
      ),
    )
    .for("update")
    .limit(1);
  if (!request) requestNotFound();
  return request;
}

async function rejectExistingEventKey(
  tx: RequestReadExecutor,
  tenantId: string,
  idempotencyKey: string,
) {
  const [event] = await tx
    .select({ id: schema.tenantBillingRequestEvents.id })
    .from(schema.tenantBillingRequestEvents)
    .where(
      and(
        eq(schema.tenantBillingRequestEvents.tenantId, tenantId),
        eq(schema.tenantBillingRequestEvents.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (event) throw new ConflictException({ code: "idempotency_key_reused" });
}

async function assertTarget(
  tx: RequestReadExecutor,
  tenantId: string,
  type: LinkType,
  targetId: string,
) {
  const table = linkTable(type);
  const [target] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, targetId)))
    .for("share")
    .limit(1);
  if (!target) throw new NotFoundException({ code: linkNotFoundCode(type) });
}

async function assertTargetNotLinked(
  tx: RequestReadExecutor,
  tenantId: string,
  requestId: string,
  type: LinkType,
  targetId: string,
) {
  const column = linkColumn(type);
  const existing = await tx
    .select({ requestId: schema.tenantBillingRequestLinks.requestId })
    .from(schema.tenantBillingRequestLinks)
    .where(and(eq(schema.tenantBillingRequestLinks.tenantId, tenantId), eq(column, targetId)));
  if (existing.length > 1) throw new Error("billing request target link ambiguity");
  if (existing[0]) {
    throw new ConflictException({
      code:
        existing[0].requestId === requestId
          ? "billing_request_link_exists"
          : "billing_target_already_linked",
    });
  }
}

function linkWorkflowResource(type: LinkType, targetId: string): BillingWorkflowResource {
  if (type === "offer") return { kind: "offer", id: targetId };
  if (type === "invoice") return { kind: "invoice", id: targetId };
  if (type === "payment") return { kind: "payment", id: targetId };
  if (type === "act") return { kind: "act", id: targetId };
  return { kind: "ordered_service", id: targetId };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return value.code === "23505" || value.cause?.code === "23505";
}

function linkTable(type: LinkType) {
  if (type === "offer") return schema.commercialOffers;
  if (type === "invoice") return schema.invoices;
  if (type === "payment") return schema.billingPayments;
  if (type === "act") return schema.billingActs;
  return schema.orderedServices;
}

function linkColumn(type: LinkType) {
  if (type === "offer") return schema.tenantBillingRequestLinks.offerId;
  if (type === "invoice") return schema.tenantBillingRequestLinks.invoiceId;
  if (type === "payment") return schema.tenantBillingRequestLinks.paymentId;
  if (type === "act") return schema.tenantBillingRequestLinks.actId;
  return schema.tenantBillingRequestLinks.orderedServiceId;
}

function linkTargetValues(type: LinkType, targetId: string) {
  if (type === "offer") return { offerId: targetId };
  if (type === "invoice") return { invoiceId: targetId };
  if (type === "payment") return { paymentId: targetId };
  if (type === "act") return { actId: targetId };
  return { orderedServiceId: targetId };
}

function linkEventKind(type: LinkType) {
  if (type === "offer") return "offer_linked" as const;
  if (type === "invoice") return "invoice_linked" as const;
  if (type === "payment") return "payment_confirmed" as const;
  if (type === "act") return "act_linked" as const;
  return "service_linked" as const;
}

function linkNotFoundCode(type: LinkType) {
  if (type === "ordered_service") return "ordered_service_not_found";
  return `${type}_not_found`;
}

function responsibleSide(status: RequestStatus) {
  if (["clarification_required", "offer_prepared", "awaiting_payment"].includes(status)) {
    return "tenant" as const;
  }
  if (status === "completed" || status === "cancelled") return "none" as const;
  return "markiro" as const;
}

function requestSource(request: typeof schema.tenantBillingRequests.$inferSelect) {
  return {
    id: request.id,
    tenantId: request.tenantId,
    number: request.number,
    type: request.type,
    status: request.status,
    description: request.description,
    desiredAt: request.desiredAt?.toISOString() ?? null,
    context:
      request.contextType && request.contextId
        ? { type: request.contextType, id: request.contextId }
        : null,
    responsibleSide: request.responsibleSide,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

function eventSource(
  event: typeof schema.tenantBillingRequestEvents.$inferSelect,
): PlatformBillingRequestEvent {
  return {
    id: event.id,
    tenantId: event.tenantId,
    requestId: event.requestId,
    kind: event.kind,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorKind: event.actorKind,
    actorUserId: event.actorUserId,
    actorPlatformUserId: event.actorPlatformUserId,
    message: event.message,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  };
}

function linkSource(
  link: typeof schema.tenantBillingRequestLinks.$inferSelect,
  type: LinkType,
  targetId: string,
): PlatformBillingRequestLink {
  return {
    id: link.id,
    tenantId: link.tenantId,
    requestId: link.requestId,
    type,
    targetId,
    createdAt: link.createdAt.toISOString(),
  };
}

function inferLinkSource(link: typeof schema.tenantBillingRequestLinks.$inferSelect) {
  if (link.offerId) return linkSource(link, "offer", link.offerId);
  if (link.invoiceId) return linkSource(link, "invoice", link.invoiceId);
  if (link.paymentId) return linkSource(link, "payment", link.paymentId);
  if (link.actId) return linkSource(link, "act", link.actId);
  if (link.orderedServiceId) return linkSource(link, "ordered_service", link.orderedServiceId);
  throw new Error("Unsupported platform billing request link target");
}

function requestNotFound(): never {
  throw new NotFoundException({ code: "billing_request_not_found" });
}

function mutationInProgress(): never {
  throw new ConflictException({ code: "billing_mutation_in_progress" });
}
