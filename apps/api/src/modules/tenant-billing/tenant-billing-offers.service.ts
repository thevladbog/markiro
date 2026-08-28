import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import {
  acquireBillingIdempotencyLock,
  acquireBillingWorkflowLocks,
  canonicalBillingUuid,
  type BillingWorkflowResource,
} from "../billing-workflow-locks";
import type { OfferChangeRequestDto } from "./dto";

type DecisionKind = "accepted" | "changes_requested";

@Injectable()
export class TenantBillingOffersService {
  constructor(@Inject(DB) private readonly db: Db) {}

  accept(tenantId: string, userId: string, offerId: string, idempotencyKey: string) {
    return this.decide(tenantId, userId, offerId, "accepted", null, idempotencyKey);
  }

  requestChanges(tenantId: string, userId: string, offerId: string, input: OfferChangeRequestDto) {
    return this.decide(
      tenantId,
      userId,
      offerId,
      "changes_requested",
      input.message.trim(),
      input.idempotencyKey,
    );
  }

  private async decide(
    tenantId: string,
    userId: string,
    offerId: string,
    decision: DecisionKind,
    message: string | null,
    idempotencyKey: string,
  ) {
    const canonicalOfferId = canonicalBillingUuid(offerId);
    const canonicalIdempotencyKey = canonicalBillingUuid(idempotencyKey);
    return this.db.transaction(async (tx) => {
      await acquireBillingIdempotencyLock(
        tx,
        "tenant_offer_decision",
        `tenant-offer-idempotency:${tenantId}:${canonicalIdempotencyKey}`,
      );
      const [discovered] = await tx
        .select({ familyId: schema.commercialOffers.familyId })
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, tenantId),
            eq(schema.commercialOffers.id, canonicalOfferId),
          ),
        )
        .limit(1);
      if (!discovered) offerNotFound();

      const [idempotent] = await tx
        .select()
        .from(schema.commercialOfferDecisionIdempotency)
        .where(
          and(
            eq(schema.commercialOfferDecisionIdempotency.tenantId, tenantId),
            eq(schema.commercialOfferDecisionIdempotency.idempotencyKey, canonicalIdempotencyKey),
          ),
        )
        .limit(1);
      if (idempotent) {
        if (
          idempotent.offerId !== canonicalOfferId ||
          idempotent.decision !== decision ||
          idempotent.message !== message
        ) {
          idempotencyConflict();
        }
        const [canonical] = await tx
          .select()
          .from(schema.commercialOfferDecisions)
          .where(
            and(
              eq(schema.commercialOfferDecisions.tenantId, tenantId),
              eq(schema.commercialOfferDecisions.id, idempotent.decisionId),
            ),
          )
          .limit(1);
        if (!canonical) throw new Error("commercial offer idempotency target is missing");
        return decisionSource(canonical);
      }

      const resources: BillingWorkflowResource[] = [
        { kind: "offer_family", id: discovered.familyId },
        { kind: "offer", id: canonicalOfferId },
      ];
      await acquireBillingWorkflowLocks(tx, tenantId, resources);
      const links = await tx
        .select({ requestId: schema.tenantBillingRequestLinks.requestId })
        .from(schema.tenantBillingRequestLinks)
        .where(
          and(
            eq(schema.tenantBillingRequestLinks.tenantId, tenantId),
            eq(schema.tenantBillingRequestLinks.offerId, canonicalOfferId),
          ),
        )
        .orderBy(
          asc(schema.tenantBillingRequestLinks.createdAt),
          asc(schema.tenantBillingRequestLinks.id),
        );
      if (links.length > 1) {
        throw new ConflictException({ code: "offer_request_link_ambiguous" });
      }
      const requestId = links[0]?.requestId ?? null;
      const family = await tx
        .select()
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, tenantId),
            eq(schema.commercialOffers.familyId, discovered.familyId),
          ),
        )
        .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id))
        .for("update");
      const offer = family.find((candidate) => candidate.id === canonicalOfferId);
      if (!offer) offerNotFound();

      const current = family.find((candidate) => candidate.status !== "draft");
      if (!current || current.id !== canonicalOfferId) {
        throw new ConflictException({ code: "offer_version_stale" });
      }
      if (offer.status !== "published") {
        throw new ConflictException({ code: "offer_not_published" });
      }
      if (offer.expiresAt && offer.expiresAt <= this.now()) {
        throw new ConflictException({ code: "offer_expired" });
      }

      const [latestDecision] = await tx
        .select()
        .from(schema.commercialOfferDecisions)
        .where(
          and(
            eq(schema.commercialOfferDecisions.tenantId, tenantId),
            eq(schema.commercialOfferDecisions.offerId, canonicalOfferId),
          ),
        )
        .orderBy(
          desc(schema.commercialOfferDecisions.createdAt),
          desc(schema.commercialOfferDecisions.id),
        )
        .for("update")
        .limit(1);
      if (latestDecision) {
        if (latestDecision.decision === "accepted" && decision === "accepted") {
          await tx.insert(schema.commercialOfferDecisionIdempotency).values({
            tenantId,
            idempotencyKey: canonicalIdempotencyKey,
            offerId: canonicalOfferId,
            decision,
            message,
            decisionId: latestDecision.id,
          });
          return decisionSource(latestDecision);
        }
        throw new ConflictException({ code: "offer_already_decided" });
      }

      if (requestId) {
        const [request] = await tx
          .select({ id: schema.tenantBillingRequests.id })
          .from(schema.tenantBillingRequests)
          .where(
            and(
              eq(schema.tenantBillingRequests.tenantId, tenantId),
              eq(schema.tenantBillingRequests.id, requestId),
            ),
          )
          .for("update")
          .limit(1);
        if (!request) throw new ConflictException({ code: "offer_request_link_invalid" });
      }

      const [inserted] = await tx
        .insert(schema.commercialOfferDecisions)
        .values({
          tenantId,
          offerId: canonicalOfferId,
          decision,
          message,
          actorUserId: userId,
          idempotencyKey: canonicalIdempotencyKey,
        })
        .returning();
      if (!inserted) throw new Error("commercial offer decision insert failed");
      await tx.insert(schema.commercialOfferDecisionIdempotency).values({
        tenantId,
        idempotencyKey: canonicalIdempotencyKey,
        offerId: canonicalOfferId,
        decision,
        message,
        decisionId: inserted.id,
      });
      if (requestId) {
        await tx.insert(schema.tenantBillingRequestEvents).values({
          tenantId,
          requestId,
          kind: decision === "accepted" ? "offer_accepted" : "offer_changes_requested",
          actorKind: "tenant_user",
          actorUserId: userId,
          message,
          metadata: { offerId: canonicalOfferId },
          idempotencyKey: canonicalIdempotencyKey,
        });
      }
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: userId,
        action:
          decision === "accepted" ? "billing.offer.accepted" : "billing.offer.changes_requested",
        outcome: "success",
        targetType: "commercial_offer",
        targetId: canonicalOfferId,
        before: null,
        after: { decision, requestId },
      });
      return decisionSource(inserted);
    });
  }

  protected now(): Date {
    return new Date();
  }
}

function decisionSource(decision: typeof schema.commercialOfferDecisions.$inferSelect) {
  return {
    id: decision.id,
    offerId: decision.offerId,
    decision: decision.decision,
    message: decision.message,
    createdAt: decision.createdAt.toISOString(),
  };
}

function idempotencyConflict(): never {
  throw new ConflictException({ code: "idempotency_key_reused" });
}

function offerNotFound(): never {
  throw new NotFoundException({ code: "offer_not_found" });
}
