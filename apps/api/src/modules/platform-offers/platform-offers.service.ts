import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  platformCommercialContracts,
  offerServiceDetailSchema,
  type OfferPaymentResultSource,
  type OfferReviseDto,
  type OfferServiceDetailSource,
  type OfferServiceRecordSource,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import {
  bankAccountLast4,
  bankAccountSnapshot,
  billingProfileSnapshot,
  resolveCommercialBillingDetails,
} from "../billing/commercial-snapshots";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { EntitlementsExecutor } from "../../subscriptions/entitlements.types";
import {
  acquireBillingWorkflowLocks,
  canonicalBillingResourceId,
  canonicalBillingUuid,
  postgresUniqueConstraint,
} from "../billing-workflow-locks";
import { calculateOfferTotals } from "./offer-totals";
import { normalizeOfferTerms } from "./offer-terms";
import type { CreateOfferDto, PaymentDto } from "./dto";
import {
  beginPlatformBillingMutation,
  commitPlatformBillingMutation,
} from "../platform-billing-idempotency";

@Injectable()
export class PlatformOffersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async create(actor: PlatformPrincipal, input: CreateOfferDto): Promise<OfferServiceDetailSource> {
    let termsMarkdown: string | null;
    try {
      termsMarkdown = normalizeOfferTerms(input.termsMarkdown).markdown;
    } catch (error) {
      if (error instanceof Error && error.message === "offer_terms_too_long") {
        throw new BadRequestException({ code: error.message });
      }
      throw error;
    }
    const total = calculateOfferTotals(
      input.lines.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.agreedUnitPrice,
        vatRateBps: line.vatRateBps ?? null,
        vatIncluded: line.vatIncluded,
      })),
    );
    return this.db.transaction(async (tx) => {
      const validatedLines: Array<{
        line: CreateOfferDto["lines"][number];
        catalogUnitPrice: string | null;
        priceOverrideReason: string | null;
      }> = [];
      for (const line of input.lines) {
        if (!line.catalogVersionId) {
          if (line.kind !== "service") {
            throw new BadRequestException({ code: "offer_catalog_version_invalid" });
          }
          validatedLines.push({ line, catalogUnitPrice: null, priceOverrideReason: null });
          continue;
        }
        const [version] = await tx
          .select({
            kind: schema.catalogItemVersions.kind,
            status: schema.catalogItemVersions.status,
            unitPrice: schema.catalogItemVersions.unitPrice,
          })
          .from(schema.catalogItemVersions)
          .where(eq(schema.catalogItemVersions.id, line.catalogVersionId))
          .for("share");
        if (!version || version.kind !== line.kind || version.status !== "published") {
          throw new BadRequestException({ code: "offer_catalog_version_invalid" });
        }
        const priceOverrideReason = line.priceOverrideReason?.trim() || null;
        if (line.agreedUnitPrice !== version.unitPrice && !priceOverrideReason) {
          throw new BadRequestException({ code: "offer_price_override_reason_required" });
        }
        validatedLines.push({
          line,
          catalogUnitPrice: version.unitPrice,
          priceOverrideReason:
            line.agreedUnitPrice === version.unitPrice ? null : priceOverrideReason,
        });
      }
      const [offer] = await tx
        .insert(schema.commercialOffers)
        .values({
          tenantId: input.tenantId,
          sellerBankAccountId: input.sellerBankAccountId ?? null,
          revision: 1,
          status: "draft",
          total: total.total,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          termsMarkdown,
          createdByPlatformUserId: actor.userId,
        })
        .returning();
      if (!offer) throw new Error("offer insert failed");
      await tx.insert(schema.commercialOfferLines).values(
        validatedLines.map(({ line, catalogUnitPrice, priceOverrideReason }, index) => ({
          tenantId: input.tenantId,
          offerId: offer.id,
          position: index + 1,
          kind: line.kind,
          catalogVersionId: line.catalogVersionId ?? null,
          nameRu: line.nameRu,
          nameEn: line.nameEn,
          descriptionRu: line.descriptionRu ?? null,
          descriptionEn: line.descriptionEn ?? null,
          quantity: line.quantity,
          unit: line.unit,
          catalogUnitPrice,
          agreedUnitPrice: line.agreedUnitPrice,
          vatRate:
            line.vatRateBps === null || line.vatRateBps === undefined
              ? null
              : String(line.vatRateBps / 100),
          vatIncluded: line.vatIncluded,
          priceOverrideReason,
          activationPolicy: line.kind === "plan" ? (line.activationPolicy ?? "immediately") : null,
          lineTotal: (Number(line.agreedUnitPrice) * line.quantity).toFixed(2),
        })),
      );
      return this.detailWith(tx, input.tenantId, offer.id);
    });
  }

  async list(actor: PlatformPrincipal, tenantId?: string): Promise<OfferServiceRecordSource[]> {
    const rows = await this.db
      .select()
      .from(schema.commercialOffers)
      .where(tenantId ? eq(schema.commercialOffers.tenantId, tenantId) : undefined)
      .orderBy(desc(schema.commercialOffers.createdAt));
    return rows;
  }

  async detail(actor: PlatformPrincipal, id: string): Promise<OfferServiceDetailSource> {
    const [offer] = await this.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.id, id))
      .limit(1);
    if (!offer) throw new NotFoundException({ code: "offer_not_found" });
    return this.detailWith(this.db, offer.tenantId, id);
  }

  async publish(actor: PlatformPrincipal, id: string): Promise<OfferServiceDetailSource> {
    const canonicalOfferId = canonicalBillingUuid(id);
    return this.db.transaction(async (tx) => {
      const [located] = await tx
        .select({
          tenantId: schema.commercialOffers.tenantId,
          familyId: schema.commercialOffers.familyId,
          revision: schema.commercialOffers.revision,
        })
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, canonicalOfferId))
        .limit(1);
      if (!located) throw new ConflictException({ code: "offer_not_draft" });
      const offerYear = new Date().getFullYear();
      const primaryNumber = `KP-${offerYear}-${located.revision.toString().padStart(6, "0")}`;
      const fallbackNumber = `KP-${offerYear}-${canonicalOfferId.slice(0, 8).toUpperCase()}`;
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id: canonicalOfferId },
        { kind: "offer_number", id: primaryNumber },
        { kind: "offer_number", id: fallbackNumber },
      ]);
      const family = await tx
        .select()
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, located.tenantId),
            eq(schema.commercialOffers.familyId, located.familyId),
          ),
        )
        .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id))
        .for("update");
      const draft = family.find((candidate) => candidate.id === canonicalOfferId);
      if (!draft || draft.status !== "draft") {
        throw new ConflictException({ code: "offer_not_draft" });
      }
      if (family[0]?.id !== draft.id) {
        throw new ConflictException({ code: "offer_version_stale" });
      }
      const { seller, buyer, sellerAccount, buyerAccount } = await resolveCommercialBillingDetails(
        tx,
        draft.tenantId,
        draft.sellerBankAccountId,
      );
      const [latest] = await tx
        .select({ number: schema.commercialOffers.number })
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.number, primaryNumber))
        .limit(1);
      const number = latest ? fallbackNumber : primaryNumber;
      const now = new Date();
      await tx
        .update(schema.commercialOffers)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(schema.commercialOffers.tenantId, draft.tenantId),
            eq(schema.commercialOffers.familyId, draft.familyId),
            eq(schema.commercialOffers.status, "published"),
          ),
        );
      let updated: typeof schema.commercialOffers.$inferSelect | undefined;
      try {
        [updated] = await tx
          .update(schema.commercialOffers)
          .set({
            status: "published",
            number,
            publishedAt: now,
            publishedByPlatformUserId: actor.userId,
            sellerBankAccountId: sellerAccount.id,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.commercialOffers.id, canonicalOfferId),
              eq(schema.commercialOffers.status, "draft"),
            ),
          )
          .returning();
      } catch (error) {
        if (postgresUniqueConstraint(error) === "commercial_offers_number_uq") {
          throw new ConflictException({ code: "offer_number_conflict" });
        }
        throw error;
      }
      if (!updated) throw new ConflictException({ code: "offer_not_draft" });
      const lines = await tx
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.offerId, canonicalOfferId))
        .orderBy(asc(schema.commercialOfferLines.position));
      const terms = normalizeOfferTerms(updated.termsMarkdown);
      await tx.insert(schema.commercialOfferPrintSnapshots).values({
        tenantId: updated.tenantId,
        offerId: updated.id,
        revision: updated.revision,
        number,
        publishedAt: updated.publishedAt ?? new Date(),
        expiresAt: updated.expiresAt,
        sellerSnapshot: billingProfileSnapshot(seller),
        buyerSnapshot: billingProfileSnapshot(buyer),
        sellerBankAccountSnapshot: bankAccountSnapshot(sellerAccount),
        buyerBankAccountSnapshot: buyerAccount ? bankAccountSnapshot(buyerAccount) : null,
        linesSnapshot: lines,
        subtotal: updated.total,
        vatTotal: "0.00",
        total: updated.total,
        termsMarkdown: terms.markdown,
        termsHtml: terms.html,
      });
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.offer.published",
        outcome: "success",
        tenantId: updated.tenantId,
        targetType: "commercial_offer",
        targetId: updated.id,
        reason: null,
        before: { status: draft.status },
        after: {
          status: updated.status,
          number,
          sellerAccountId: sellerAccount.id,
          sellerAccountLast4: bankAccountLast4(sellerAccount),
          buyerAccountId: buyerAccount?.id ?? null,
          buyerAccountLast4: buyerAccount ? bankAccountLast4(buyerAccount) : null,
        },
        requestId: null,
      });
      return this.detailWith(tx, updated.tenantId, updated.id);
    });
  }

  async revise(
    actor: PlatformPrincipal,
    id: string,
    input: OfferReviseDto,
  ): Promise<OfferServiceDetailSource> {
    const canonicalOfferId = canonicalBillingUuid(id);
    const [located] = await this.db
      .select({
        tenantId: schema.commercialOffers.tenantId,
        familyId: schema.commercialOffers.familyId,
      })
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.id, canonicalOfferId))
      .limit(1);
    if (!located) throw new NotFoundException({ code: "offer_not_found" });
    return this.db.transaction(async (tx) => {
      const mutation = await beginPlatformBillingMutation(tx, {
        tenantId: located.tenantId,
        idempotencyKey: input.idempotencyKey,
        operation: "billing.offer.revise",
        targetId: canonicalOfferId,
        payload: { sourceOfferId: canonicalOfferId },
        actorPlatformUserId: actor.userId,
      });
      if (mutation.kind === "committed") {
        const replay = platformCommercialContracts.offers.revise.response.parse(mutation.result);
        return offerServiceDetailSchema.parse({
          ...replay,
          expiresAt: replay.expiresAt ? new Date(replay.expiresAt) : null,
          publishedAt: replay.publishedAt ? new Date(replay.publishedAt) : null,
          paidAt: replay.paidAt ? new Date(replay.paidAt) : null,
          createdAt: new Date(replay.createdAt),
          updatedAt: new Date(replay.updatedAt),
          lines: replay.lines.map((line) => ({ ...line, createdAt: new Date(line.createdAt) })),
        });
      }
      if (mutation.kind === "pending") {
        throw new ConflictException({ code: "billing_mutation_in_progress" });
      }
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id: canonicalOfferId },
      ]);
      const family = await tx
        .select()
        .from(schema.commercialOffers)
        .where(
          and(
            eq(schema.commercialOffers.tenantId, located.tenantId),
            eq(schema.commercialOffers.familyId, located.familyId),
          ),
        )
        .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id))
        .for("update");
      const source = family.find((offer) => offer.id === canonicalOfferId);
      if (!source) throw new NotFoundException({ code: "offer_not_found" });
      const currentGeneration = family.find((offer) => offer.status !== "draft");
      if (!currentGeneration || currentGeneration.id !== source.id) {
        throw new ConflictException({ code: "offer_version_stale" });
      }
      if (source.status !== "published") {
        throw new ConflictException({ code: "offer_not_published" });
      }
      if (family.some((offer) => offer.status === "draft")) {
        throw new ConflictException({ code: "offer_revision_draft_exists" });
      }
      const [decision] = await tx
        .select()
        .from(schema.commercialOfferDecisions)
        .where(
          and(
            eq(schema.commercialOfferDecisions.tenantId, source.tenantId),
            eq(schema.commercialOfferDecisions.offerId, source.id),
          ),
        )
        .orderBy(
          desc(schema.commercialOfferDecisions.createdAt),
          desc(schema.commercialOfferDecisions.id),
        )
        .for("update")
        .limit(1);
      if (decision?.decision !== "changes_requested") {
        throw new ConflictException({ code: "offer_revision_not_requested" });
      }
      const [draft] = await tx
        .insert(schema.commercialOffers)
        .values({
          tenantId: source.tenantId,
          familyId: source.familyId,
          revision: Math.max(...family.map((offer) => offer.revision)) + 1,
          previousRevisionId: source.id,
          status: "draft",
          sellerBankAccountId: source.sellerBankAccountId,
          total: source.total,
          expiresAt: source.expiresAt,
          termsMarkdown: source.termsMarkdown,
          createdByPlatformUserId: actor.userId,
        })
        .returning();
      if (!draft) throw new Error("offer revision insert failed");
      const lines = await tx
        .select()
        .from(schema.commercialOfferLines)
        .where(
          and(
            eq(schema.commercialOfferLines.tenantId, source.tenantId),
            eq(schema.commercialOfferLines.offerId, source.id),
          ),
        )
        .orderBy(asc(schema.commercialOfferLines.position));
      if (lines.length > 0) {
        await tx.insert(schema.commercialOfferLines).values(
          lines.map((line) => ({
            tenantId: source.tenantId,
            offerId: draft.id,
            position: line.position,
            kind: line.kind,
            catalogVersionId: line.catalogVersionId,
            nameRu: line.nameRu,
            nameEn: line.nameEn,
            descriptionRu: line.descriptionRu,
            descriptionEn: line.descriptionEn,
            quantity: line.quantity,
            unit: line.unit,
            catalogUnitPrice: line.catalogUnitPrice,
            agreedUnitPrice: line.agreedUnitPrice,
            vatRate: line.vatRate,
            vatIncluded: line.vatIncluded,
            priceOverrideReason: line.priceOverrideReason,
            activationPolicy: line.activationPolicy,
            lineTotal: line.lineTotal,
          })),
        );
      }
      const result = await this.detailWith(tx, source.tenantId, draft.id);
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "billing.offer.revised",
        outcome: "success",
        tenantId: source.tenantId,
        targetType: "commercial_offer",
        targetId: draft.id,
        reason: null,
        before: { sourceOfferId: source.id, revision: source.revision, status: source.status },
        after: {
          revision: draft.revision,
          status: draft.status,
          previousRevisionId: source.id,
        },
        requestId: null,
      });
      await commitPlatformBillingMutation(tx, mutation.row.id, draft.id, result);
      return result;
    });
  }

  async cancel(_actor: PlatformPrincipal, id: string): Promise<OfferServiceDetailSource> {
    const canonicalOfferId = canonicalBillingUuid(id);
    return this.db.transaction(async (tx) => {
      const [located] = await tx
        .select({
          tenantId: schema.commercialOffers.tenantId,
          familyId: schema.commercialOffers.familyId,
        })
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, canonicalOfferId))
        .limit(1);
      if (!located) throw new ConflictException({ code: "offer_not_published" });
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id: canonicalOfferId },
      ]);
      const family = await lockCommercialOfferFamily(tx, located.tenantId, located.familyId);
      const offer = family.find((candidate) => candidate.id === canonicalOfferId);
      const currentGeneration = family.find((candidate) => candidate.status !== "draft");
      if (!offer || currentGeneration?.id !== offer.id || offer.status !== "published") {
        throw new ConflictException({ code: "offer_not_published" });
      }
      const [cancelled] = await tx
        .update(schema.commercialOffers)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(schema.commercialOffers.id, canonicalOfferId),
            eq(schema.commercialOffers.status, "published"),
          ),
        )
        .returning();
      if (!cancelled) throw new ConflictException({ code: "offer_not_published" });
      return this.detailWith(tx, cancelled.tenantId, cancelled.id);
    });
  }

  async pay(
    actor: PlatformPrincipal,
    id: string,
    key: string,
    input: PaymentDto,
  ): Promise<OfferPaymentResultSource> {
    if (!key.trim()) throw new ConflictException({ code: "idempotency_key_required" });
    const canonicalOfferId = canonicalBillingUuid(id);
    const canonicalKey = canonicalBillingResourceId(key.trim());
    return this.db.transaction(async (tx) => {
      const [located] = await tx
        .select({
          tenantId: schema.commercialOffers.tenantId,
          familyId: schema.commercialOffers.familyId,
        })
        .from(schema.commercialOffers)
        .where(eq(schema.commercialOffers.id, canonicalOfferId))
        .limit(1);
      if (!located) throw new NotFoundException({ code: "offer_not_found" });
      await acquireBillingWorkflowLocks(tx, located.tenantId, [
        { kind: "offer_family", id: located.familyId },
        { kind: "offer", id: canonicalOfferId },
        { kind: "payment_key", id: canonicalKey },
      ]);
      const family = await lockCommercialOfferFamily(tx, located.tenantId, located.familyId);
      const offer = family.find((candidate) => candidate.id === canonicalOfferId);
      if (!offer) throw new NotFoundException({ code: "offer_not_found" });
      const currentGeneration = family.find((candidate) => candidate.status !== "draft");
      const [existing] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.idempotencyKey, canonicalKey))
        .limit(1);
      if (existing) {
        if (
          existing.offerId !== canonicalOfferId ||
          existing.amount !== input.amount ||
          existing.bankReference !== input.bankReference
        )
          throw new ConflictException({ code: "idempotency_key_reused" });
        return { paymentId: existing.id, fulfilments: [] };
      }
      if (!currentGeneration || currentGeneration.id !== offer.id) {
        throw new ConflictException({ code: "offer_version_stale" });
      }
      const [offerPayment] = await tx
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(
          and(eq(schema.payments.tenantId, offer.tenantId), eq(schema.payments.offerId, offer.id)),
        )
        .limit(1);
      if (offerPayment) throw new ConflictException({ code: "offer_already_paid" });
      if (offer.status !== "published" || offer.total !== input.amount)
        throw new ConflictException({ code: "offer_payment_invalid" });
      const [decision] = await tx
        .select()
        .from(schema.commercialOfferDecisions)
        .where(
          and(
            eq(schema.commercialOfferDecisions.tenantId, offer.tenantId),
            eq(schema.commercialOfferDecisions.offerId, offer.id),
          ),
        )
        .orderBy(
          desc(schema.commercialOfferDecisions.createdAt),
          desc(schema.commercialOfferDecisions.id),
        )
        .for("update")
        .limit(1);
      if (decision?.decision !== "accepted") {
        throw new ConflictException({ code: "offer_not_accepted" });
      }
      let payment: typeof schema.payments.$inferSelect | undefined;
      try {
        [payment] = await tx
          .insert(schema.payments)
          .values({
            tenantId: offer.tenantId,
            offerId: offer.id,
            paidAt: new Date(),
            amount: input.amount,
            currency: input.currency,
            bankReference: input.bankReference,
            platformUserId: actor.userId,
            idempotencyKey: canonicalKey,
          })
          .returning();
      } catch (error) {
        const constraint = postgresUniqueConstraint(error);
        if (constraint === "payments_idempotency_key_uq") {
          throw new ConflictException({ code: "idempotency_key_reused" });
        }
        if (constraint === "payments_offer_uq") {
          throw new ConflictException({ code: "offer_already_paid" });
        }
        if (constraint) throw new ConflictException({ code: "offer_payment_conflict" });
        throw error;
      }
      if (!payment) throw new Error("payment insert failed");
      await tx
        .update(schema.commercialOffers)
        .set({ status: "paid", paidAt: payment.paidAt, updatedAt: new Date() })
        .where(
          and(
            eq(schema.commercialOffers.id, offer.id),
            eq(schema.commercialOffers.status, "published"),
          ),
        );
      const lines = await tx
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.offerId, offer.id))
        .orderBy(asc(schema.commercialOfferLines.position));
      const fulfilments: string[] = [];
      let targetSubscriptionId: string | null = null;
      for (const line of lines) {
        if (line.kind === "plan" && line.catalogVersionId) {
          const [current] = await tx
            .select({ endsAt: schema.tenantSubscriptions.endsAt })
            .from(schema.tenantSubscriptions)
            .where(
              and(
                eq(schema.tenantSubscriptions.tenantId, offer.tenantId),
                sql`${schema.tenantSubscriptions.status} in ('pending_activation','trial','active')`,
              ),
            )
            .orderBy(desc(schema.tenantSubscriptions.updatedAt))
            .limit(1);
          const scheduledStart =
            line.activationPolicy === "after_current" &&
            current?.endsAt &&
            current.endsAt > payment.paidAt
              ? current.endsAt
              : payment.paidAt;
          await tx
            .update(schema.tenantSubscriptions)
            .set({ status: "superseded", updatedAt: payment.paidAt })
            .where(
              and(
                eq(schema.tenantSubscriptions.tenantId, offer.tenantId),
                sql`${schema.tenantSubscriptions.status} in ('pending_activation','trial','active')`,
              ),
            );
          const [subscription] = await tx
            .insert(schema.tenantSubscriptions)
            .values({
              tenantId: offer.tenantId,
              planVersionId: line.catalogVersionId,
              status: scheduledStart > payment.paidAt ? "scheduled" : "active",
              startsAt: scheduledStart,
              endsAt: null,
              source: "paid_offer_line",
              sourceOfferLineId: line.id,
              createdByPlatformUserId: actor.userId,
            })
            .returning();
          if (subscription) {
            targetSubscriptionId = subscription.id;
            await tx.insert(schema.offerLineFulfilments).values({
              tenantId: offer.tenantId,
              offerLineId: line.id,
              paymentId: payment.id,
              kind: "subscription",
              tenantSubscriptionId: subscription.id,
              fulfilledAt: payment.paidAt,
            });
            fulfilments.push(subscription.id);
          }
        } else if (line.kind === "addon" && line.catalogVersionId && targetSubscriptionId) {
          const [addon] = await tx
            .insert(schema.subscriptionAddons)
            .values({
              tenantId: offer.tenantId,
              subscriptionId: targetSubscriptionId,
              addonVersionId: line.catalogVersionId,
              quantity: line.quantity,
              startsAt: payment.paidAt,
              endsAt: null,
              status: "active",
              source: "paid_offer_line",
              sourceOfferLineId: line.id,
              createdByPlatformUserId: actor.userId,
            })
            .returning();
          if (addon) {
            await tx.insert(schema.offerLineFulfilments).values({
              tenantId: offer.tenantId,
              offerLineId: line.id,
              paymentId: payment.id,
              kind: "subscription_addon",
              subscriptionAddonId: addon.id,
              fulfilledAt: payment.paidAt,
            });
            fulfilments.push(addon.id);
          }
        }
        if (line.kind === "service") {
          const [service] = await tx
            .insert(schema.orderedServices)
            .values({
              tenantId: offer.tenantId,
              offerLineId: line.id,
              paymentId: payment.id,
              catalogVersionId: line.catalogVersionId,
              catalogKind: "service",
              nameRu: line.nameRu,
              nameEn: line.nameEn,
              descriptionRu: line.descriptionRu,
              descriptionEn: line.descriptionEn,
              quantity: line.quantity,
              unit: line.unit,
              orderedAt: payment.paidAt,
            })
            .returning();
          if (service) {
            await tx.insert(schema.offerLineFulfilments).values({
              tenantId: offer.tenantId,
              offerLineId: line.id,
              paymentId: payment.id,
              kind: "ordered_service",
              orderedServiceId: service.id,
              fulfilledAt: payment.paidAt,
            });
            fulfilments.push(service.id);
          }
        }
      }
      return {
        paymentId: payment.id,
        fulfilments,
        subscriptionId: targetSubscriptionId ?? undefined,
      };
    });
  }

  private async detailWith(
    executor: EntitlementsExecutor,
    tenantId: string,
    id: string,
  ): Promise<OfferServiceDetailSource> {
    const [offer] = await executor
      .select()
      .from(schema.commercialOffers)
      .where(
        and(eq(schema.commercialOffers.tenantId, tenantId), eq(schema.commercialOffers.id, id)),
      )
      .limit(1);
    if (!offer) throw new NotFoundException({ code: "offer_not_found" });
    const lines = await executor
      .select()
      .from(schema.commercialOfferLines)
      .where(
        and(
          eq(schema.commercialOfferLines.tenantId, tenantId),
          eq(schema.commercialOfferLines.offerId, id),
        ),
      )
      .orderBy(asc(schema.commercialOfferLines.position));
    return { ...offer, lines };
  }
}

async function lockCommercialOfferFamily(
  tx: Pick<Db, "select">,
  tenantId: string,
  familyId: string,
) {
  return tx
    .select()
    .from(schema.commercialOffers)
    .where(
      and(
        eq(schema.commercialOffers.tenantId, tenantId),
        eq(schema.commercialOffers.familyId, familyId),
      ),
    )
    .orderBy(desc(schema.commercialOffers.revision), desc(schema.commercialOffers.id))
    .for("update");
}
