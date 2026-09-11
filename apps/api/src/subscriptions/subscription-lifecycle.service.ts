import { assertCommercialPlanSequence } from "../modules/billing/commercial-line-terms";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { resolveCommercialPeriod, type CommercialPeriod } from "@markiro/domain";
import {
  commercialLineTermsSchema,
  commercialPeriodSchema,
  type CommercialLineTerms,
} from "@markiro/platform-contracts";
import { SubscriptionEntitlementsInvalidException } from "./subscription-errors";
import { EntitlementsService } from "./entitlements.service";
import { DB } from "../auth/auth.module";
import type { AssignAddonDto, AssignPlanDto } from "../modules/platform-tenants/dto";
import type { PlatformPrincipal } from "../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";
import { lockTenantSubscriptionTimeline } from "./subscription-locks";

type SubscriptionTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;
type SubscriptionRow = typeof schema.tenantSubscriptions.$inferSelect;
type EndedSubscriptionRow = SubscriptionRow & { endsAt: Date };
export type PaidLicenseOrigin =
  | { kind: "invoice"; invoiceLineId: string; paymentId: string }
  | { kind: "offer"; offerLineId: string; paymentId: string };
type AssignmentContext = {
  subscriptionSource: "manual" | "paid_invoice_line" | "paid_offer_line";
  sourceOfferLineId?: string;
  paid?: { terms: CommercialLineTerms; operationAt: Date; origin: PaidLicenseOrigin };
  sourceInvoiceLineId: string | null;
  eventSource: "platform_manual" | "paid_invoice_line" | "paid_offer_line";
  auditScope: "platform" | "billing";
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MANUAL_TERM_MS = 10 * 366 * DAY_MS;
const MAX_EFFECTIVE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly audit?: PlatformAuditService,
  ) {}

  /**
   * Global tenant timeline lock order: tenant advisory lock, parent
   * subscription rows by id, then child add-on rows by id.
   */
  async lockTenantTimeline(tx: SubscriptionTransaction, tenantId: string): Promise<void> {
    await lockTenantSubscriptionTimeline(tx, tenantId);
  }

  async activatePendingDemo(
    tx: SubscriptionTransaction,
    input: { tenantId: string; activatedAt: Date; sourceUserId: string },
  ): Promise<SubscriptionRow | null> {
    await this.lockTenantTimeline(tx, input.tenantId);
    await tx.execute(
      sql`select id from tenant_subscriptions where tenant_id = ${input.tenantId} and status = 'pending_activation' order by id for update`,
    );
    const [pending] = await tx
      .select({
        subscription: schema.tenantSubscriptions,
        demoDurationDays: schema.planEntitlements.demoDurationDays,
      })
      .from(schema.tenantSubscriptions)
      .innerJoin(
        schema.planEntitlements,
        eq(schema.planEntitlements.catalogVersionId, schema.tenantSubscriptions.planVersionId),
      )
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, input.tenantId),
          eq(schema.tenantSubscriptions.status, "pending_activation"),
        ),
      )
      .limit(1);
    if (!pending) return null;
    if (pending.demoDurationDays === null || pending.demoDurationDays <= 0) {
      throw new ConflictException({ code: "pending_demo_duration_invalid" });
    }
    const endsAt = new Date(input.activatedAt.getTime() + pending.demoDurationDays * DAY_MS);
    const [activated] = await tx
      .update(schema.tenantSubscriptions)
      .set({
        status: "trial",
        startsAt: input.activatedAt,
        endsAt,
        updatedAt: input.activatedAt,
      })
      .where(
        and(
          eq(schema.tenantSubscriptions.id, pending.subscription.id),
          eq(schema.tenantSubscriptions.tenantId, input.tenantId),
          eq(schema.tenantSubscriptions.status, "pending_activation"),
        ),
      )
      .returning();
    if (!activated) throw new ConflictException({ code: "pending_demo_changed" });
    await tx.insert(schema.subscriptionEvents).values({
      tenantId: input.tenantId,
      subscriptionId: activated.id,
      eventKind: "demo.activated",
      effectiveAt: input.activatedAt,
      actorPlatformUserId: null,
      source: "tenant_owner_activation",
      reason: null,
      before: {
        status: pending.subscription.status,
        startsAt: null,
        endsAt: null,
      },
      after: {
        status: "trial",
        startsAt: input.activatedAt,
        endsAt,
        sourceUserId: input.sourceUserId,
        demoDurationDays: pending.demoDurationDays,
      },
    });
    return activated;
  }

  /** Caller holds the tenant timeline lock and current/scheduled row locks. */
  private async assertPaidPlanSequence(
    tx: SubscriptionTransaction,
    tenantId: string,
    origin: PaidLicenseOrigin,
    policy: string,
    current: SubscriptionRow | undefined,
  ): Promise<void> {
    const conflict = () =>
      new ConflictException({ code: "commercial_plan_sequence_review_required" });
    const invoice = origin.kind === "invoice";
    const sourceId = origin.kind === "invoice" ? origin.invoiceLineId : origin.offerLineId;
    let lines: {
      id: string;
      kind: string;
      commercialTerms: unknown;
      activationPolicy: string | null;
    }[];
    if (origin.kind === "invoice") {
      const [source] = await tx
        .select()
        .from(schema.invoiceLines)
        .where(
          and(eq(schema.invoiceLines.tenantId, tenantId), eq(schema.invoiceLines.id, sourceId)),
        );
      if (!source) throw conflict();
      lines = await tx
        .select()
        .from(schema.invoiceLines)
        .where(
          and(
            eq(schema.invoiceLines.tenantId, tenantId),
            eq(schema.invoiceLines.invoiceId, source.invoiceId),
          ),
        )
        .orderBy(schema.invoiceLines.position);
    } else {
      const [source] = await tx
        .select()
        .from(schema.commercialOfferLines)
        .where(
          and(
            eq(schema.commercialOfferLines.tenantId, tenantId),
            eq(schema.commercialOfferLines.id, sourceId),
          ),
        );
      if (!source) throw conflict();
      lines = await tx
        .select()
        .from(schema.commercialOfferLines)
        .where(
          and(
            eq(schema.commercialOfferLines.tenantId, tenantId),
            eq(schema.commercialOfferLines.offerId, source.offerId),
          ),
        )
        .orderBy(schema.commercialOfferLines.position);
    }
    assertCommercialPlanSequence(lines, true);
    const plans = lines.filter((line) => line.kind === "plan");
    if (plans.length < 2) return;
    const purchased = await tx
      .select()
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          inArray(
            invoice
              ? schema.tenantSubscriptions.sourceInvoiceLineId
              : schema.tenantSubscriptions.sourceOfferLineId,
            plans.map((line) => line.id),
          ),
        ),
      )
      .orderBy(schema.tenantSubscriptions.id)
      .for("update");
    if (policy === "immediate") {
      if (
        purchased.some(
          (row) => (invoice ? row.sourceInvoiceLineId : row.sourceOfferLineId) !== sourceId,
        )
      )
        throw conflict();
    } else {
      const predecessor = purchased.find(
        (row) => (invoice ? row.sourceInvoiceLineId : row.sourceOfferLineId) === plans[0]?.id,
      );
      if (!predecessor || predecessor.id !== current?.id || predecessor.status !== "active")
        throw conflict();
    }
  }

  async assignPlan(
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignPlanDto,
  ): Promise<SubscriptionRow> {
    assertPlatformAdmin(actor);
    return this.db.transaction((tx) =>
      this.assignPlanInTransaction(tx, actor, tenantId, input, {
        subscriptionSource: "manual",
        sourceInvoiceLineId: null,
        eventSource: "platform_manual",
        auditScope: "platform",
      }),
    );
  }

  /** Both payment routes enter here with a frozen sold line and confirmed payment provenance. */
  async applyPaidLicense(
    tx: SubscriptionTransaction,
    actor: PlatformPrincipal,
    tenantId: string,
    input: {
      line: {
        kind: "plan" | "addon";
        catalogVersionId: string;
        quantity: number;
        commercialTerms: unknown;
      };
      origin: PaidLicenseOrigin;
      operationAt: Date;
      reason: string;
    },
  ): Promise<SubscriptionRow | typeof schema.subscriptionAddons.$inferSelect> {
    const parsed = commercialLineTermsSchema.safeParse(input.line.commercialTerms);
    if (!parsed.success || parsed.data.subject !== "software_license") {
      throw new ConflictException({ code: "commercial_terms_review_required" });
    }
    if (input.line.kind === "plan" && input.line.quantity !== 1) {
      throw new BadRequestException({ code: "commercial_plan_quantity_invalid" });
    }
    await this.lockTenantTimeline(tx, tenantId);
    const table =
      input.line.kind === "plan" ? schema.tenantSubscriptions : schema.subscriptionAddons;
    const [previous] = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.tenantId, tenantId),
          input.origin.kind === "invoice"
            ? eq(table.sourceInvoiceLineId, input.origin.invoiceLineId)
            : eq(table.sourceOfferLineId, input.origin.offerLineId),
        ),
      )
      .limit(1);
    if (previous) return previous;
    const context: AssignmentContext = {
      subscriptionSource: input.origin.kind === "invoice" ? "paid_invoice_line" : "paid_offer_line",
      sourceInvoiceLineId: input.origin.kind === "invoice" ? input.origin.invoiceLineId : null,
      ...(input.origin.kind === "offer" ? { sourceOfferLineId: input.origin.offerLineId } : {}),
      eventSource: input.origin.kind === "invoice" ? "paid_invoice_line" : "paid_offer_line",
      auditScope: "billing",
      paid: { terms: parsed.data, operationAt: input.operationAt, origin: input.origin },
    };
    const activationPolicy =
      parsed.data.activationRule === "after_current" ? "after_current" : "immediate";
    const base = {
      catalogVersionId: input.line.catalogVersionId,
      activationPolicy,
      reason: input.reason,
    } as const;
    if (input.line.kind === "plan")
      return this.assignPlanInTransaction(tx, actor, tenantId, base, context);
    const timeline = await lockAndFindTimelineSubscriptions(tx, tenantId);
    const target = activationPolicy === "after_current" ? timeline.scheduled : timeline.current;
    if (!target) throw new ConflictException({ code: "subscription_target_missing" });
    const addon = await this.assignAddonInTransaction(
      tx,
      actor,
      tenantId,
      { ...base, expectedSubscriptionId: target.id, quantity: input.line.quantity },
      context,
    );
    // The existing resolver validates multiplication and combined quotas before committing rights.
    try {
      await new EntitlementsService(this.db, "all").resolve(
        tenantId,
        tx,
        addon.startsAt ?? input.operationAt,
      );
    } catch (error) {
      if (error instanceof SubscriptionEntitlementsInvalidException)
        throw new ConflictException({ code: "subscription_entitlements_invalid" });
      throw error;
    }
    return addon;
  }

  private async assignPlanInTransaction(
    tx: SubscriptionTransaction,
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignPlanDto,
    context: AssignmentContext,
  ): Promise<SubscriptionRow> {
    await this.lockTenantTimeline(tx, tenantId);
    const operationAt = context.paid?.operationAt ?? new Date();
    validateEffectiveAt(input.effectiveAt, operationAt);
    if (input.activationPolicy === "immediate") {
      const startsAt = resolveImmediateStart(input.effectiveAt, operationAt);
      validateTerm(startsAt, input.endsAt);
      validateActiveEnd(input.endsAt, operationAt);
    }
    await requireTenant(tx, tenantId);
    const candidate = await requirePublishedVersion(
      tx,
      input.catalogVersionId,
      "plan",
      Boolean(context.paid),
    );

    const lockedTimeline = await lockAndFindTimelineSubscriptions(tx, tenantId);
    const expiredCurrent = isEndedSubscription(lockedTimeline.current, operationAt)
      ? lockedTimeline.current
      : undefined;
    const current = expiredCurrent ? undefined : lockedTimeline.current;
    const existingScheduled = lockedTimeline.scheduled;
    if (context.paid) {
      await this.assertPaidPlanSequence(
        tx,
        tenantId,
        context.paid.origin,
        input.activationPolicy,
        current,
      );
    }

    if (input.activationPolicy === "after_current" && !current) {
      throw new ConflictException({ code: "subscription_timeline_changed" });
    }

    const before = current ? subscriptionSnapshot(current) : null;
    let startsAt: Date;
    let status: "active" | "scheduled";
    if (input.activationPolicy === "after_current" && current) {
      if (existingScheduled) {
        throw new ConflictException({ code: "subscription_schedule_exists" });
      }
      if (!current.endsAt) {
        throw new ConflictException({ code: "subscription_current_end_required" });
      }
      startsAt = current.endsAt;
      status = "scheduled";
    } else {
      startsAt = resolveImmediateStart(input.effectiveAt, operationAt);
      status = "active";
    }
    const commercialPeriod = context.paid
      ? paidPeriod(
          context.paid.terms,
          startsAt,
          input.activationPolicy === "after_current" ? current?.commercialPeriod : null,
        )
      : null;
    const endsAt = commercialPeriod ? new Date(commercialPeriod.endsAt) : input.endsAt;
    validateTerm(startsAt, endsAt);
    if (status === "active") validateActiveEnd(endsAt, operationAt);

    if (expiredCurrent) {
      const expired = await tx
        .update(schema.tenantSubscriptions)
        .set({ status: "expired", updatedAt: operationAt })
        .where(
          and(
            eq(schema.tenantSubscriptions.id, expiredCurrent.id),
            eq(schema.tenantSubscriptions.tenantId, tenantId),
            eq(schema.tenantSubscriptions.status, expiredCurrent.status),
          ),
        )
        .returning({ id: schema.tenantSubscriptions.id });
      if (expired.length !== 1) {
        throw new ConflictException({ code: "subscription_timeline_changed" });
      }
      await this.retireSubscriptionAddons(
        tx,
        actor,
        expiredCurrent,
        input.reason,
        operationAt,
        context,
      );
      await tx.insert(schema.subscriptionEvents).values({
        tenantId,
        subscriptionId: expiredCurrent.id,
        eventKind: "plan.expired",
        effectiveAt: expiredCurrent.endsAt,
        actorPlatformUserId: actor.userId,
        source: context.eventSource,
        reason: input.reason,
        before: subscriptionSnapshot(expiredCurrent),
        after: { ...subscriptionSnapshot(expiredCurrent), status: "expired" },
      });
    }

    if (status === "active") {
      if (existingScheduled) {
        const cancelled = await tx
          .update(schema.tenantSubscriptions)
          .set({ status: "cancelled", updatedAt: operationAt })
          .where(
            and(
              eq(schema.tenantSubscriptions.id, existingScheduled.id),
              eq(schema.tenantSubscriptions.tenantId, tenantId),
              eq(schema.tenantSubscriptions.status, "scheduled"),
            ),
          )
          .returning({ id: schema.tenantSubscriptions.id });
        if (cancelled.length !== 1) {
          throw new ConflictException({ code: "subscription_timeline_changed" });
        }
        await this.retireSubscriptionAddons(
          tx,
          actor,
          existingScheduled,
          input.reason,
          operationAt,
          context,
        );
        await tx.insert(schema.subscriptionEvents).values({
          tenantId,
          subscriptionId: existingScheduled.id,
          eventKind: "plan.schedule_cancelled",
          effectiveAt: operationAt,
          actorPlatformUserId: actor.userId,
          source: context.eventSource,
          reason: input.reason,
          before: subscriptionSnapshot(existingScheduled),
          after: { ...subscriptionSnapshot(existingScheduled), status: "cancelled" },
        });
      }
      if (current) {
        const superseded = await tx
          .update(schema.tenantSubscriptions)
          .set({ status: "superseded", updatedAt: operationAt })
          .where(
            and(
              eq(schema.tenantSubscriptions.id, current.id),
              eq(schema.tenantSubscriptions.tenantId, tenantId),
              eq(schema.tenantSubscriptions.status, current.status),
            ),
          )
          .returning({ id: schema.tenantSubscriptions.id });
        if (superseded.length !== 1) {
          throw new ConflictException({ code: "subscription_timeline_changed" });
        }
        await this.retireSubscriptionAddons(tx, actor, current, input.reason, operationAt, context);
        await tx.insert(schema.subscriptionEvents).values({
          tenantId,
          subscriptionId: current.id,
          eventKind: "plan.superseded",
          effectiveAt: startsAt,
          actorPlatformUserId: actor.userId,
          source: context.eventSource,
          reason: input.reason,
          before,
          after: { ...before, status: "superseded" },
        });
      }
    }

    const [created] = await tx
      .insert(schema.tenantSubscriptions)
      .values({
        tenantId,
        planVersionId: candidate.id,
        status,
        startsAt,
        endsAt: endsAt ?? null,
        commercialPeriod,
        source: context.subscriptionSource,
        sourceInvoiceLineId: context.sourceInvoiceLineId,
        sourceOfferLineId: context.sourceOfferLineId ?? null,
        createdByPlatformUserId: actor.userId,
        createdAt: operationAt,
        updatedAt: operationAt,
      })
      .returning();
    if (!created) throw new ConflictException({ code: "subscription_assignment_failed" });
    const after = {
      ...subscriptionSnapshot(created),
      ...(context.paid ? { paymentOrigin: context.paid.origin } : {}),
    };
    await tx.insert(schema.subscriptionEvents).values({
      tenantId,
      subscriptionId: created.id,
      eventKind: status === "scheduled" ? "plan.scheduled" : "plan.assigned",
      effectiveAt: startsAt,
      actorPlatformUserId: actor.userId,
      source: context.eventSource,
      reason: input.reason,
      before,
      after,
    });
    await this.requireAudit().record(tx, {
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      action:
        context.auditScope === "billing"
          ? status === "scheduled"
            ? `${paidAuditPrefix(context)}.plan_scheduled`
            : `${paidAuditPrefix(context)}.plan_applied`
          : status === "scheduled"
            ? "platform.tenant.subscription.plan_scheduled"
            : "platform.tenant.subscription.plan_assigned",
      outcome: "success",
      tenantId,
      targetType: "tenant_subscription",
      targetId: created.id,
      reason: input.reason,
      before,
      after,
      requestId: null,
    });
    return created;
  }

  async assignAddon(
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignAddonDto,
  ): Promise<typeof schema.subscriptionAddons.$inferSelect> {
    assertPlatformAdmin(actor);
    return this.db.transaction((tx) =>
      this.assignAddonInTransaction(tx, actor, tenantId, input, {
        subscriptionSource: "manual",
        sourceInvoiceLineId: null,
        eventSource: "platform_manual",
        auditScope: "platform",
      }),
    );
  }

  private async assignAddonInTransaction(
    tx: SubscriptionTransaction,
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignAddonDto,
    context: AssignmentContext,
  ): Promise<typeof schema.subscriptionAddons.$inferSelect> {
    await this.lockTenantTimeline(tx, tenantId);
    const operationAt = context.paid?.operationAt ?? new Date();
    validateEffectiveAt(input.effectiveAt, operationAt);
    await requireTenant(tx, tenantId);
    const candidate = await requirePublishedVersion(
      tx,
      input.catalogVersionId,
      "addon",
      Boolean(context.paid),
    );
    const effects = await tx
      .select()
      .from(schema.addonEntitlements)
      .where(eq(schema.addonEntitlements.catalogVersionId, candidate.id));
    if (
      effects.length === 0 ||
      effects.some(
        (effect) =>
          !(
            (effect.quotaIncrement !== null && effect.quotaIncrement > 0) ||
            (effect.quotaIncrement === null && effect.featureEnabled)
          ),
      )
    ) {
      throw new ConflictException({ code: "addon_entitlements_invalid" });
    }

    const timeline = await lockAndFindTimelineSubscriptions(tx, tenantId);
    const target =
      input.activationPolicy === "after_current" ? timeline.scheduled : timeline.current;
    if (!target || target.id !== input.expectedSubscriptionId) {
      throw new ConflictException({ code: "subscription_addon_timeline_changed" });
    }
    if (
      input.activationPolicy === "immediate" &&
      (target.status === "pending_activation" ||
        target.startsAt === null ||
        target.startsAt > operationAt ||
        (target.endsAt !== null && target.endsAt <= operationAt))
    ) {
      throw new ConflictException({ code: "subscription_compatible_plan_required" });
    }
    const startsAt =
      input.activationPolicy === "after_current"
        ? target.startsAt
        : resolveImmediateStart(input.effectiveAt, operationAt);
    if (!startsAt) throw new ConflictException({ code: "subscription_start_required" });
    if (target.startsAt && startsAt < target.startsAt) {
      throw new BadRequestException({ code: "addon_precedes_subscription_term" });
    }
    const commercialPeriod = context.paid ? paidPeriod(context.paid.terms, startsAt, null) : null;
    const endsAt = commercialPeriod
      ? new Date(commercialPeriod.endsAt)
      : (input.endsAt ?? target.endsAt);
    validateTerm(startsAt, endsAt ?? undefined);
    if (input.activationPolicy === "immediate") {
      validateActiveEnd(endsAt ?? undefined, operationAt);
    }
    if (!context.paid && target.endsAt && endsAt && endsAt > target.endsAt) {
      throw new BadRequestException({ code: "addon_exceeds_subscription_term" });
    }
    const status = input.activationPolicy === "after_current" ? "scheduled" : "active";
    const [created] = await tx
      .insert(schema.subscriptionAddons)
      .values({
        tenantId,
        subscriptionId: target.id,
        addonVersionId: candidate.id,
        quantity: input.quantity,
        startsAt,
        endsAt: endsAt ?? null,
        commercialPeriod,
        status,
        source: context.subscriptionSource,
        sourceInvoiceLineId: context.sourceInvoiceLineId,
        sourceOfferLineId: context.sourceOfferLineId ?? null,
        createdByPlatformUserId: actor.userId,
        createdAt: operationAt,
        updatedAt: operationAt,
      })
      .returning();
    if (!created) throw new ConflictException({ code: "addon_assignment_failed" });
    const after = {
      ...addonSnapshot(created),
      ...(context.paid ? { paymentOrigin: context.paid.origin } : {}),
    };
    await tx.insert(schema.subscriptionEvents).values({
      tenantId,
      subscriptionId: target.id,
      eventKind: status === "scheduled" ? "addon.scheduled" : "addon.activated",
      effectiveAt: startsAt,
      actorPlatformUserId: actor.userId,
      source: context.eventSource,
      reason: input.reason,
      before: null,
      after,
    });
    await this.requireAudit().record(tx, {
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      action:
        context.auditScope === "billing"
          ? status === "scheduled"
            ? `${paidAuditPrefix(context)}.addon_scheduled`
            : `${paidAuditPrefix(context)}.addon_applied`
          : status === "scheduled"
            ? "platform.tenant.subscription.addon_scheduled"
            : "platform.tenant.subscription.addon_assigned",
      outcome: "success",
      tenantId,
      targetType: "subscription_addon",
      targetId: created.id,
      reason: input.reason,
      before: null,
      after,
      requestId: null,
    });
    return created;
  }

  private requireAudit(): PlatformAuditService {
    if (!this.audit) throw new Error("Platform audit provider is required for direct assignments");
    return this.audit;
  }

  private async retireSubscriptionAddons(
    tx: SubscriptionTransaction,
    actor: PlatformPrincipal,
    subscription: SubscriptionRow,
    reason: string,
    operationAt: Date,
    context: AssignmentContext,
  ): Promise<void> {
    await tx.execute(
      sql`select id from subscription_addons where tenant_id = ${subscription.tenantId} and subscription_id = ${subscription.id} and status in ('active', 'scheduled') order by id for update`,
    );
    const addons = await tx
      .select()
      .from(schema.subscriptionAddons)
      .where(
        and(
          eq(schema.subscriptionAddons.tenantId, subscription.tenantId),
          eq(schema.subscriptionAddons.subscriptionId, subscription.id),
          inArray(schema.subscriptionAddons.status, ["active", "scheduled"]),
        ),
      )
      .orderBy(schema.subscriptionAddons.id);
    for (const addon of addons) {
      const nextStatus = addon.endsAt && addon.endsAt <= operationAt ? "expired" : "revoked";
      const before = addonSnapshot(addon);
      const after = { ...before, status: nextStatus };
      const changed = await tx
        .update(schema.subscriptionAddons)
        .set({ status: nextStatus, updatedAt: operationAt })
        .where(
          and(
            eq(schema.subscriptionAddons.id, addon.id),
            eq(schema.subscriptionAddons.tenantId, subscription.tenantId),
            eq(schema.subscriptionAddons.subscriptionId, subscription.id),
            eq(schema.subscriptionAddons.status, addon.status),
          ),
        )
        .returning({ id: schema.subscriptionAddons.id });
      if (changed.length !== 1) {
        throw new ConflictException({ code: "subscription_addon_timeline_changed" });
      }
      const eventKind = nextStatus === "expired" ? "addon.expired" : "addon.revoked";
      await tx.insert(schema.subscriptionEvents).values({
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        eventKind,
        effectiveAt: nextStatus === "expired" ? (addon.endsAt ?? operationAt) : operationAt,
        actorPlatformUserId: actor.userId,
        source: context.eventSource,
        reason,
        before,
        after,
      });
      await this.requireAudit().record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action:
          context.auditScope === "billing"
            ? `${paidAuditPrefix(context)}.${eventKind.replace(".", "_")}`
            : `platform.tenant.subscription.${eventKind.replace(".", "_")}`,
        outcome: "success",
        tenantId: subscription.tenantId,
        targetType: "subscription_addon",
        targetId: addon.id,
        reason,
        before,
        after,
        requestId: null,
      });
    }
  }
}

function assertPlatformAdmin(actor: PlatformPrincipal): void {
  if (actor.role !== "platform_admin") {
    throw new ConflictException({ code: "direct_subscription_assignment_forbidden" });
  }
}

async function requireTenant(tx: SubscriptionTransaction, tenantId: string): Promise<void> {
  const [tenant] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, tenantId))
    .limit(1);
  if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
}

async function requirePublishedVersion(
  tx: SubscriptionTransaction,
  versionId: string,
  kind: "plan" | "addon",
  allowRetired = false,
): Promise<{ id: string }> {
  await tx.execute(sql`select id from catalog_item_versions where id = ${versionId} for key share`);
  const [candidate] = await tx
    .select({
      id: schema.catalogItemVersions.id,
      kind: schema.catalogItemVersions.kind,
      status: schema.catalogItemVersions.status,
    })
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.id, versionId))
    .limit(1);
  if (
    !candidate ||
    candidate.kind !== kind ||
    (candidate.status !== "published" && !(allowRetired && candidate.status === "retired"))
  ) {
    throw new ConflictException({ code: "published_catalog_version_required" });
  }
  return candidate;
}

async function lockAndFindTimelineSubscriptions(
  tx: SubscriptionTransaction,
  tenantId: string,
): Promise<{ current: SubscriptionRow | undefined; scheduled: SubscriptionRow | undefined }> {
  await tx.execute(
    sql`select id from tenant_subscriptions where tenant_id = ${tenantId} and status in ('pending_activation', 'trial', 'active', 'scheduled') order by id for update`,
  );
  const [current] = await tx
    .select()
    .from(schema.tenantSubscriptions)
    .where(
      and(
        eq(schema.tenantSubscriptions.tenantId, tenantId),
        inArray(schema.tenantSubscriptions.status, ["pending_activation", "trial", "active"]),
      ),
    )
    .orderBy(desc(schema.tenantSubscriptions.updatedAt))
    .limit(1);
  const [scheduled] = await tx
    .select()
    .from(schema.tenantSubscriptions)
    .where(
      and(
        eq(schema.tenantSubscriptions.tenantId, tenantId),
        eq(schema.tenantSubscriptions.status, "scheduled"),
      ),
    )
    .limit(1);
  return { current, scheduled };
}

function validateEffectiveAt(effectiveAt: Date | undefined, now: Date): void {
  if (!effectiveAt) return;
  if (
    effectiveAt.getTime() > now.getTime() + MAX_EFFECTIVE_CLOCK_SKEW_MS ||
    effectiveAt.getTime() < now.getTime() - DAY_MS
  ) {
    throw new BadRequestException({ code: "effective_at_out_of_range" });
  }
}

function validateTerm(startsAt: Date, endsAt: Date | undefined): void {
  if (!endsAt) return;
  const duration = endsAt.getTime() - startsAt.getTime();
  if (duration <= 0 || duration > MAX_MANUAL_TERM_MS) {
    throw new BadRequestException({ code: "subscription_term_out_of_range" });
  }
}

function validateActiveEnd(endsAt: Date | undefined, now: Date): void {
  if (endsAt && endsAt <= now) {
    throw new BadRequestException({ code: "subscription_term_already_ended" });
  }
}

function resolveImmediateStart(effectiveAt: Date | undefined, now: Date): Date {
  return effectiveAt && effectiveAt < now ? effectiveAt : now;
}

function isEndedSubscription(
  subscription: SubscriptionRow | undefined,
  now: Date,
): subscription is EndedSubscriptionRow {
  return subscription?.endsAt !== null && subscription?.endsAt !== undefined
    ? subscription.endsAt <= now
    : false;
}

function subscriptionSnapshot(subscription: SubscriptionRow) {
  return {
    id: subscription.id,
    planVersionId: subscription.planVersionId,
    status: subscription.status,
    startsAt: subscription.startsAt,
    endsAt: subscription.endsAt,
    source: subscription.source,
    commercialPeriod: subscription.commercialPeriod,
    sourceOfferLineId: subscription.sourceOfferLineId,
    sourceInvoiceLineId: subscription.sourceInvoiceLineId,
  };
}

function addonSnapshot(addon: typeof schema.subscriptionAddons.$inferSelect) {
  return {
    id: addon.id,
    subscriptionId: addon.subscriptionId,
    addonVersionId: addon.addonVersionId,
    quantity: addon.quantity,
    status: addon.status,
    startsAt: addon.startsAt,
    endsAt: addon.endsAt,
    source: addon.source,
    commercialPeriod: addon.commercialPeriod,
    sourceOfferLineId: addon.sourceOfferLineId,
    sourceInvoiceLineId: addon.sourceInvoiceLineId,
  };
}

function paidPeriod(
  terms: CommercialLineTerms,
  startsAt: Date,
  previous: unknown,
): CommercialPeriod {
  if (!terms.billingPeriod)
    throw new ConflictException({ code: "commercial_terms_review_required" });
  const retained = commercialPeriodSchema.safeParse(previous);
  if (
    retained.success &&
    retained.data.billingPeriod === terms.billingPeriod &&
    new Date(retained.data.endsAt).getTime() === startsAt.getTime()
  ) {
    return resolveCommercialPeriod({
      anchorAt: retained.data.anchorAt,
      billingPeriod: terms.billingPeriod,
      cycle: retained.data.cycle + 1,
    });
  }
  return resolveCommercialPeriod({
    anchorAt: startsAt.toISOString(),
    billingPeriod: terms.billingPeriod,
    cycle: 0,
  });
}

function paidAuditPrefix(context: AssignmentContext): string {
  return context.paid?.origin.kind === "offer" ? "billing.offer" : "billing.invoice";
}
