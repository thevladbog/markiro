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
import { DB } from "../auth/auth.module";
import type { AssignAddonDto, AssignPlanDto } from "../modules/platform-tenants/dto";
import type { PlatformPrincipal } from "../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";

type SubscriptionTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;
type SubscriptionRow = typeof schema.tenantSubscriptions.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_MANUAL_TERM_MS = 10 * 366 * DAY_MS;
const MAX_EFFECTIVE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() private readonly audit?: PlatformAuditService,
  ) {}

  async activatePendingDemo(
    tx: SubscriptionTransaction,
    input: { tenantId: string; activatedAt: Date; sourceUserId: string },
  ): Promise<SubscriptionRow | null> {
    await tx.execute(
      sql`select id from tenant_subscriptions where tenant_id = ${input.tenantId} and status = 'pending_activation' for update`,
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

  async assignPlan(
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignPlanDto,
  ): Promise<SubscriptionRow> {
    assertPlatformAdmin(actor);
    const operationAt = new Date();
    validateEffectiveAt(input.effectiveAt, operationAt);
    return this.db.transaction(async (tx) => {
      await lockTenantTimeline(tx, tenantId);
      await requireTenant(tx, tenantId);
      const candidate = await requirePublishedVersion(tx, input.catalogVersionId, "plan");

      let current = await findCurrentSubscription(tx, tenantId);
      const existingScheduled = await findScheduledSubscription(tx, tenantId);
      if (current?.endsAt && current.endsAt <= operationAt) {
        await tx
          .update(schema.tenantSubscriptions)
          .set({ status: "expired", updatedAt: operationAt })
          .where(
            and(
              eq(schema.tenantSubscriptions.id, current.id),
              eq(schema.tenantSubscriptions.tenantId, tenantId),
            ),
          );
        await tx.insert(schema.subscriptionEvents).values({
          tenantId,
          subscriptionId: current.id,
          eventKind: "plan.expired",
          effectiveAt: current.endsAt,
          actorPlatformUserId: actor.userId,
          source: "platform_manual",
          reason: input.reason,
          before: subscriptionSnapshot(current),
          after: { ...subscriptionSnapshot(current), status: "expired" },
        });
        current = undefined;
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
        startsAt = input.effectiveAt ?? operationAt;
        status = "active";
        if (existingScheduled) {
          await tx
            .update(schema.tenantSubscriptions)
            .set({ status: "cancelled", updatedAt: operationAt })
            .where(
              and(
                eq(schema.tenantSubscriptions.id, existingScheduled.id),
                eq(schema.tenantSubscriptions.tenantId, tenantId),
              ),
            );
          await tx.insert(schema.subscriptionEvents).values({
            tenantId,
            subscriptionId: existingScheduled.id,
            eventKind: "plan.schedule_cancelled",
            effectiveAt: operationAt,
            actorPlatformUserId: actor.userId,
            source: "platform_manual",
            reason: input.reason,
            before: subscriptionSnapshot(existingScheduled),
            after: { ...subscriptionSnapshot(existingScheduled), status: "cancelled" },
          });
        }
        if (current) {
          await tx
            .update(schema.tenantSubscriptions)
            .set({ status: "superseded", updatedAt: operationAt })
            .where(
              and(
                eq(schema.tenantSubscriptions.id, current.id),
                eq(schema.tenantSubscriptions.tenantId, tenantId),
              ),
            );
          await tx.insert(schema.subscriptionEvents).values({
            tenantId,
            subscriptionId: current.id,
            eventKind: "plan.superseded",
            effectiveAt: startsAt,
            actorPlatformUserId: actor.userId,
            source: "platform_manual",
            reason: input.reason,
            before,
            after: { ...before, status: "superseded" },
          });
        }
      }
      validateTerm(startsAt, input.endsAt);

      const [created] = await tx
        .insert(schema.tenantSubscriptions)
        .values({
          tenantId,
          planVersionId: candidate.id,
          status,
          startsAt,
          endsAt: input.endsAt ?? null,
          source: "manual",
          createdByPlatformUserId: actor.userId,
          createdAt: operationAt,
          updatedAt: operationAt,
        })
        .returning();
      if (!created) throw new ConflictException({ code: "subscription_assignment_failed" });
      const after = subscriptionSnapshot(created);
      await tx.insert(schema.subscriptionEvents).values({
        tenantId,
        subscriptionId: created.id,
        eventKind: status === "scheduled" ? "plan.scheduled" : "plan.assigned",
        effectiveAt: startsAt,
        actorPlatformUserId: actor.userId,
        source: "platform_manual",
        reason: input.reason,
        before,
        after,
      });
      await this.requireAudit().record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action:
          status === "scheduled"
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
    });
  }

  async assignAddon(
    actor: PlatformPrincipal,
    tenantId: string,
    input: AssignAddonDto,
  ): Promise<typeof schema.subscriptionAddons.$inferSelect> {
    assertPlatformAdmin(actor);
    const operationAt = new Date();
    validateEffectiveAt(input.effectiveAt, operationAt);
    return this.db.transaction(async (tx) => {
      await lockTenantTimeline(tx, tenantId);
      await requireTenant(tx, tenantId);
      const candidate = await requirePublishedVersion(tx, input.catalogVersionId, "addon");
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

      const target =
        input.activationPolicy === "after_current"
          ? await findScheduledSubscription(tx, tenantId)
          : await findCurrentSubscription(tx, tenantId);
      if (
        !target ||
        (input.activationPolicy === "immediate" &&
          (target.status === "pending_activation" ||
            (target.endsAt !== null && target.endsAt <= operationAt)))
      ) {
        throw new ConflictException({ code: "subscription_compatible_plan_required" });
      }
      const startsAt =
        input.activationPolicy === "after_current"
          ? target.startsAt
          : (input.effectiveAt ?? operationAt);
      if (!startsAt) throw new ConflictException({ code: "subscription_start_required" });
      const endsAt = input.endsAt ?? target.endsAt;
      validateTerm(startsAt, endsAt ?? undefined);
      if (target.endsAt && endsAt && endsAt > target.endsAt) {
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
          status,
          source: "manual",
          createdByPlatformUserId: actor.userId,
          createdAt: operationAt,
          updatedAt: operationAt,
        })
        .returning();
      if (!created) throw new ConflictException({ code: "addon_assignment_failed" });
      const after = addonSnapshot(created);
      await tx.insert(schema.subscriptionEvents).values({
        tenantId,
        subscriptionId: target.id,
        eventKind: status === "scheduled" ? "addon.scheduled" : "addon.activated",
        effectiveAt: startsAt,
        actorPlatformUserId: actor.userId,
        source: "platform_manual",
        reason: input.reason,
        before: null,
        after,
      });
      await this.requireAudit().record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action:
          status === "scheduled"
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
    });
  }

  private requireAudit(): PlatformAuditService {
    if (!this.audit) throw new Error("Platform audit provider is required for direct assignments");
    return this.audit;
  }
}

function assertPlatformAdmin(actor: PlatformPrincipal): void {
  if (actor.role !== "platform_admin") {
    throw new ConflictException({ code: "direct_subscription_assignment_forbidden" });
  }
}

async function lockTenantTimeline(tx: SubscriptionTransaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-subscription:${tenantId}`}, 0))`,
  );
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
  if (!candidate || candidate.kind !== kind || candidate.status !== "published") {
    throw new ConflictException({ code: "published_catalog_version_required" });
  }
  return candidate;
}

async function findCurrentSubscription(
  tx: SubscriptionTransaction,
  tenantId: string,
): Promise<SubscriptionRow | undefined> {
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
  return current;
}

async function findScheduledSubscription(
  tx: SubscriptionTransaction,
  tenantId: string,
): Promise<SubscriptionRow | undefined> {
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
  return scheduled;
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

function subscriptionSnapshot(subscription: SubscriptionRow) {
  return {
    id: subscription.id,
    planVersionId: subscription.planVersionId,
    status: subscription.status,
    startsAt: subscription.startsAt,
    endsAt: subscription.endsAt,
    source: subscription.source,
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
  };
}
