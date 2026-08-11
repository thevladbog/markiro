import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import type { SubscriptionTransaction } from "./entitlements.types";
import { lockTenantSubscriptionTimeline } from "./subscription-locks";

export const MATERIALIZE_SUBSCRIPTION_STATUSES_QUEUE = "materialize-subscription-statuses";
export const MATERIALIZE_SUBSCRIPTION_STATUSES_CRON = "* * * * *";

interface MaterializeResult {
  subscriptionsActivated: number;
  subscriptionsExpired: number;
  addonsActivated: number;
  addonsExpired: number;
}

export interface SubscriptionStatusCandidateSource {
  dueTenantIds(at: Date): Promise<string[]>;
}

export const SUBSCRIPTION_STATUS_CANDIDATE_SOURCE = Symbol("SUBSCRIPTION_STATUS_CANDIDATE_SOURCE");

@Injectable()
export class DatabaseSubscriptionStatusCandidateSource implements SubscriptionStatusCandidateSource {
  constructor(@Inject(DB) private readonly db: Db) {}

  async dueTenantIds(at: Date): Promise<string[]> {
    const candidates = await this.db.execute<{ tenantId: string }>(sql`
      select tenant_id as "tenantId"
      from tenant_subscriptions
      where (status in ('trial', 'active') and ends_at is not null and ends_at <= ${at})
         or (status = 'scheduled' and starts_at is not null and starts_at <= ${at})
      union
      select tenant_id as "tenantId"
      from subscription_addons
      where (status = 'active' and ends_at is not null and ends_at <= ${at})
         or (status = 'scheduled' and starts_at is not null and starts_at <= ${at})
      order by "tenantId"
    `);
    return candidates.rows.map((candidate) => candidate.tenantId);
  }
}

@Injectable()
export class SubscriptionStatusJob {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SUBSCRIPTION_STATUS_CANDIDATE_SOURCE)
    private readonly candidates: SubscriptionStatusCandidateSource,
  ) {}

  async run(at = new Date()): Promise<MaterializeResult> {
    const result: MaterializeResult = {
      subscriptionsActivated: 0,
      subscriptionsExpired: 0,
      addonsActivated: 0,
      addonsExpired: 0,
    };
    const tenantIds = [...new Set(await this.candidates.dueTenantIds(at))].sort();
    for (const tenantId of tenantIds) {
      const tenantResult = await this.db.transaction(async (tx) => {
        const current: MaterializeResult = {
          subscriptionsActivated: 0,
          subscriptionsExpired: 0,
          addonsActivated: 0,
          addonsExpired: 0,
        };

        await lockTenantSubscriptionTimeline(tx, tenantId);

        await tx.execute(sql`
        select id
        from tenant_subscriptions
        where tenant_id = ${tenantId}
        order by id
        for update
      `);
        const dueSubscriptions = await tx
          .select()
          .from(schema.tenantSubscriptions)
          .where(
            sql`${schema.tenantSubscriptions.tenantId} = ${tenantId} and ((${schema.tenantSubscriptions.status} in ('trial', 'active') and ${schema.tenantSubscriptions.endsAt} is not null and ${schema.tenantSubscriptions.endsAt} <= ${at})
            or (${schema.tenantSubscriptions.status} = 'scheduled' and ${schema.tenantSubscriptions.startsAt} is not null and ${schema.tenantSubscriptions.startsAt} <= ${at}))`,
          )
          .orderBy(asc(schema.tenantSubscriptions.startsAt), asc(schema.tenantSubscriptions.id));

        // Expire old current rows before activating successors, preserving the
        // one-current partial unique index at an exact term boundary.
        for (const row of dueSubscriptions.filter(
          (candidate) =>
            candidate.status !== "scheduled" && candidate.endsAt !== null && candidate.endsAt <= at,
        )) {
          if (await this.transitionSubscription(tx, row, "expired", row.endsAt!, "term_ended")) {
            current.subscriptionsExpired += 1;
          }
        }
        for (const row of dueSubscriptions.filter(
          (candidate) => candidate.status === "scheduled",
        )) {
          if (row.startsAt === null) continue;
          const activated = await this.transitionSubscription(
            tx,
            row,
            "active",
            row.startsAt,
            "scheduled_start_reached",
          );
          if (!activated) continue;
          current.subscriptionsActivated += 1;
          if (
            row.endsAt !== null &&
            row.endsAt <= at &&
            (await this.transitionSubscription(
              tx,
              { ...row, status: "active" },
              "expired",
              row.endsAt,
              "term_ended",
            ))
          ) {
            current.subscriptionsExpired += 1;
          }
        }

        await tx.execute(sql`
        select id
        from subscription_addons
        where tenant_id = ${tenantId}
        order by id
        for update
      `);
        const dueAddons = await tx
          .select()
          .from(schema.subscriptionAddons)
          .where(
            sql`${schema.subscriptionAddons.tenantId} = ${tenantId} and ((${schema.subscriptionAddons.status} = 'active' and ${schema.subscriptionAddons.endsAt} is not null and ${schema.subscriptionAddons.endsAt} <= ${at})
            or (${schema.subscriptionAddons.status} = 'scheduled' and ${schema.subscriptionAddons.startsAt} is not null and ${schema.subscriptionAddons.startsAt} <= ${at}))`,
          )
          .orderBy(asc(schema.subscriptionAddons.startsAt), asc(schema.subscriptionAddons.id));
        for (const row of dueAddons) {
          if (row.status === "active" && row.endsAt !== null && row.endsAt <= at) {
            if (await this.transitionAddon(tx, row, "expired", row.endsAt, "term_ended")) {
              current.addonsExpired += 1;
            }
          } else if (row.status === "scheduled" && row.startsAt !== null) {
            const activated = await this.transitionAddon(
              tx,
              row,
              "active",
              row.startsAt,
              "scheduled_start_reached",
            );
            if (!activated) continue;
            current.addonsActivated += 1;
            if (
              row.endsAt !== null &&
              row.endsAt <= at &&
              (await this.transitionAddon(
                tx,
                { ...row, status: "active" },
                "expired",
                row.endsAt,
                "term_ended",
              ))
            ) {
              current.addonsExpired += 1;
            }
          }
        }
        return current;
      });
      result.subscriptionsActivated += tenantResult.subscriptionsActivated;
      result.subscriptionsExpired += tenantResult.subscriptionsExpired;
      result.addonsActivated += tenantResult.addonsActivated;
      result.addonsExpired += tenantResult.addonsExpired;
    }
    return result;
  }

  private async transitionSubscription(
    tx: SubscriptionTransaction,
    row: typeof schema.tenantSubscriptions.$inferSelect,
    nextStatus: "active" | "expired",
    effectiveAt: Date,
    reason: "scheduled_start_reached" | "term_ended",
  ): Promise<boolean> {
    const changed = await tx
      .update(schema.tenantSubscriptions)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(
        and(
          eq(schema.tenantSubscriptions.id, row.id),
          eq(schema.tenantSubscriptions.tenantId, row.tenantId),
          eq(schema.tenantSubscriptions.status, row.status),
        ),
      )
      .returning({ id: schema.tenantSubscriptions.id });
    if (changed.length !== 1) return false;
    const before = subscriptionSnapshot(row);
    const after = { ...before, status: nextStatus };
    const eventKind = nextStatus === "active" ? "plan.activated" : "plan.expired";
    await tx
      .insert(schema.subscriptionEvents)
      .values({
        id: deterministicEventId("subscription", row.id, eventKind, effectiveAt),
        tenantId: row.tenantId,
        subscriptionId: row.id,
        eventKind,
        effectiveAt,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason,
        before,
        after,
      })
      .onConflictDoNothing({ target: schema.subscriptionEvents.id });
    return true;
  }

  private async transitionAddon(
    tx: SubscriptionTransaction,
    row: typeof schema.subscriptionAddons.$inferSelect,
    nextStatus: "active" | "expired",
    effectiveAt: Date,
    reason: "scheduled_start_reached" | "term_ended",
  ): Promise<boolean> {
    const changed = await tx
      .update(schema.subscriptionAddons)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(
        and(
          eq(schema.subscriptionAddons.id, row.id),
          eq(schema.subscriptionAddons.tenantId, row.tenantId),
          eq(schema.subscriptionAddons.subscriptionId, row.subscriptionId),
          eq(schema.subscriptionAddons.status, row.status),
        ),
      )
      .returning({ id: schema.subscriptionAddons.id });
    if (changed.length !== 1) return false;
    const before = addonSnapshot(row);
    const after = { ...before, status: nextStatus };
    const eventKind = nextStatus === "active" ? "addon.activated" : "addon.expired";
    await tx
      .insert(schema.subscriptionEvents)
      .values({
        id: deterministicEventId("addon", row.id, eventKind, effectiveAt),
        tenantId: row.tenantId,
        subscriptionId: row.subscriptionId,
        eventKind,
        effectiveAt,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason,
        before,
        after,
      })
      .onConflictDoNothing({ target: schema.subscriptionEvents.id });
    return true;
  }
}

function deterministicEventId(
  entity: "subscription" | "addon",
  id: string,
  eventKind: string,
  effectiveAt: Date,
): string {
  const hex = createHash("sha256")
    .update(`subscription-status:${entity}:${id}:${eventKind}:${effectiveAt.toISOString()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function subscriptionSnapshot(row: typeof schema.tenantSubscriptions.$inferSelect) {
  return {
    id: row.id,
    planVersionId: row.planVersionId,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    source: row.source,
  };
}

function addonSnapshot(row: typeof schema.subscriptionAddons.$inferSelect) {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    addonVersionId: row.addonVersionId,
    quantity: row.quantity,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    source: row.source,
  };
}
