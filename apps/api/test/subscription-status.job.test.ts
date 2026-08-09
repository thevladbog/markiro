import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DatabaseSubscriptionStatusCandidateSource,
  SubscriptionStatusJob,
} from "../src/subscriptions/subscription-status.job";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import {
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("SubscriptionStatusJob", () => {
  const databaseName = `markiro_subscription_status_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenanceConnection = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;

  beforeAll(async () => {
    await maintenanceConnection.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenanceConnection.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenanceConnection.pool.end();
  });

  function scopedJob(tenantIds: string[]): SubscriptionStatusJob {
    return new SubscriptionStatusJob(db, { dueTenantIds: async () => tenantIds });
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await connection.pool.query<{ waiting: boolean }>(
        `select exists (
          select 1
          from pg_stat_activity
          where application_name = $1 and wait_event_type = 'Lock'
        ) as waiting`,
        [applicationName],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on the database lock`);
  }

  it("materializes due parent and add-on statuses exactly once across retrying workers", async () => {
    const at = new Date("2026-08-10T12:00:00.000Z");
    const tenantId = "70000000-0000-4000-8000-000000000001";
    await createOrganization(db, tenantId);
    const currentPlan = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const scheduledPlan = await createPublishedPlan(db, {
      maxLines: 2,
      maxStations: 2,
      maxKiosks: 2,
      maxCabinetUsers: 2,
    });
    const currentId = "70000000-0000-4000-8000-000000000101";
    const scheduledId = "70000000-0000-4000-8000-000000000102";
    const currentStartsAt = new Date("2026-07-10T12:00:00.000Z");
    const scheduledEndsAt = new Date("2026-09-10T12:00:00.000Z");
    await db.insert(schema.tenantSubscriptions).values([
      {
        id: currentId,
        tenantId,
        planVersionId: currentPlan,
        status: "active",
        startsAt: currentStartsAt,
        endsAt: at,
        source: "manual",
      },
      {
        id: scheduledId,
        tenantId,
        planVersionId: scheduledPlan,
        status: "scheduled",
        startsAt: at,
        endsAt: scheduledEndsAt,
        source: "manual",
      },
    ]);
    const addonVersion = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 1 },
    ]);
    const expiredAddonId = "70000000-0000-4000-8000-000000000201";
    const activatedAddonId = "70000000-0000-4000-8000-000000000202";
    const revokedAddonId = "70000000-0000-4000-8000-000000000203";
    await db.insert(schema.subscriptionAddons).values([
      {
        id: expiredAddonId,
        tenantId,
        subscriptionId: currentId,
        addonVersionId: addonVersion,
        quantity: 1,
        startsAt: currentStartsAt,
        endsAt: at,
        status: "active",
        source: "manual",
      },
      {
        id: activatedAddonId,
        tenantId,
        subscriptionId: scheduledId,
        addonVersionId: addonVersion,
        quantity: 2,
        startsAt: at,
        endsAt: scheduledEndsAt,
        status: "scheduled",
        source: "manual",
      },
      {
        id: revokedAddonId,
        tenantId,
        subscriptionId: currentId,
        addonVersionId: addonVersion,
        quantity: 3,
        startsAt: currentStartsAt,
        endsAt: at,
        status: "revoked",
        source: "manual",
      },
    ]);

    const first = scopedJob([tenantId]);
    const second = scopedJob([tenantId]);
    await Promise.all([first.run(at), second.run(at)]);
    await first.run(at);

    const subscriptions = await db
      .select({ id: schema.tenantSubscriptions.id, status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(inArray(schema.tenantSubscriptions.id, [currentId, scheduledId]));
    expect(new Map(subscriptions.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [currentId, "expired"],
        [scheduledId, "active"],
      ]),
    );
    const addons = await db
      .select({ id: schema.subscriptionAddons.id, status: schema.subscriptionAddons.status })
      .from(schema.subscriptionAddons)
      .where(
        inArray(schema.subscriptionAddons.id, [expiredAddonId, activatedAddonId, revokedAddonId]),
      );
    expect(new Map(addons.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [expiredAddonId, "expired"],
        [activatedAddonId, "active"],
        [revokedAddonId, "revoked"],
      ]),
    );
    const events = await db
      .select({
        id: schema.subscriptionEvents.id,
        tenantId: schema.subscriptionEvents.tenantId,
        subscriptionId: schema.subscriptionEvents.subscriptionId,
        eventKind: schema.subscriptionEvents.eventKind,
        effectiveAt: schema.subscriptionEvents.effectiveAt,
        actorPlatformUserId: schema.subscriptionEvents.actorPlatformUserId,
        source: schema.subscriptionEvents.source,
        reason: schema.subscriptionEvents.reason,
        before: schema.subscriptionEvents.before,
        after: schema.subscriptionEvents.after,
      })
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.tenantId, tenantId),
          eq(schema.subscriptionEvents.source, "subscription_status_job"),
        ),
      )
      .orderBy(schema.subscriptionEvents.eventKind, schema.subscriptionEvents.id);
    expect(events).toEqual([
      {
        id: "1e0ba2c7-e487-5c59-a0d0-44b0d93c61be",
        tenantId,
        subscriptionId: scheduledId,
        eventKind: "addon.activated",
        effectiveAt: at,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason: "scheduled_start_reached",
        before: {
          id: activatedAddonId,
          subscriptionId: scheduledId,
          addonVersionId: addonVersion,
          quantity: 2,
          status: "scheduled",
          startsAt: at.toISOString(),
          endsAt: scheduledEndsAt.toISOString(),
          source: "manual",
        },
        after: {
          id: activatedAddonId,
          subscriptionId: scheduledId,
          addonVersionId: addonVersion,
          quantity: 2,
          status: "active",
          startsAt: at.toISOString(),
          endsAt: scheduledEndsAt.toISOString(),
          source: "manual",
        },
      },
      {
        id: "9d5eb8c5-e5ab-5306-a895-22e89d20df37",
        tenantId,
        subscriptionId: currentId,
        eventKind: "addon.expired",
        effectiveAt: at,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason: "term_ended",
        before: {
          id: expiredAddonId,
          subscriptionId: currentId,
          addonVersionId: addonVersion,
          quantity: 1,
          status: "active",
          startsAt: currentStartsAt.toISOString(),
          endsAt: at.toISOString(),
          source: "manual",
        },
        after: {
          id: expiredAddonId,
          subscriptionId: currentId,
          addonVersionId: addonVersion,
          quantity: 1,
          status: "expired",
          startsAt: currentStartsAt.toISOString(),
          endsAt: at.toISOString(),
          source: "manual",
        },
      },
      {
        id: "48cd17d7-2918-586a-a4d9-3076be06156e",
        tenantId,
        subscriptionId: scheduledId,
        eventKind: "plan.activated",
        effectiveAt: at,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason: "scheduled_start_reached",
        before: {
          id: scheduledId,
          planVersionId: scheduledPlan,
          status: "scheduled",
          startsAt: at.toISOString(),
          endsAt: scheduledEndsAt.toISOString(),
          source: "manual",
        },
        after: {
          id: scheduledId,
          planVersionId: scheduledPlan,
          status: "active",
          startsAt: at.toISOString(),
          endsAt: scheduledEndsAt.toISOString(),
          source: "manual",
        },
      },
      {
        id: "bbb63939-d1f3-5d3d-a3ac-9c89d9af897c",
        tenantId,
        subscriptionId: currentId,
        eventKind: "plan.expired",
        effectiveAt: at,
        actorPlatformUserId: null,
        source: "subscription_status_job",
        reason: "term_ended",
        before: {
          id: currentId,
          planVersionId: currentPlan,
          status: "active",
          startsAt: currentStartsAt.toISOString(),
          endsAt: at.toISOString(),
          source: "manual",
        },
        after: {
          id: currentId,
          planVersionId: currentPlan,
          status: "expired",
          startsAt: currentStartsAt.toISOString(),
          endsAt: at.toISOString(),
          source: "manual",
        },
      },
    ]);
  });

  it("does not overwrite newer terminal lifecycle transitions", async () => {
    const at = new Date("2026-08-10T12:00:00.000Z");
    const tenantId = await createOrganization(db);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const subscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values({
      id: subscriptionId,
      tenantId,
      planVersionId,
      status: "superseded",
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-08-01T00:00:00.000Z"),
      source: "manual",
    });
    await scopedJob([tenantId]).run(at);
    const [stored] = await db
      .select({ status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.id, subscriptionId));
    expect(stored).toEqual({ status: "superseded" });
    await expect(
      db
        .select()
        .from(schema.subscriptionEvents)
        .where(
          and(
            eq(schema.subscriptionEvents.subscriptionId, subscriptionId),
            eq(schema.subscriptionEvents.source, "subscription_status_job"),
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  it("materializes both activation and expiry when an entire scheduled term elapsed", async () => {
    const startsAt = new Date("2026-08-01T12:00:00.000Z");
    const endsAt = new Date("2026-08-05T12:00:00.000Z");
    const at = new Date("2026-08-10T12:00:00.000Z");
    const tenantId = await createOrganization(db);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const subscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values({
      id: subscriptionId,
      tenantId,
      planVersionId,
      status: "scheduled",
      startsAt,
      endsAt,
      source: "manual",
    });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 1 },
    ]);
    const addonId = randomUUID();
    await db.insert(schema.subscriptionAddons).values({
      id: addonId,
      tenantId,
      subscriptionId,
      addonVersionId,
      quantity: 1,
      status: "scheduled",
      startsAt,
      endsAt,
      source: "manual",
    });

    const job = scopedJob([tenantId]);
    await job.run(at);
    await job.run(at);

    await expect(
      db
        .select({ status: schema.tenantSubscriptions.status })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.id, subscriptionId)),
    ).resolves.toEqual([{ status: "expired" }]);
    await expect(
      db
        .select({ status: schema.subscriptionAddons.status })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.id, addonId)),
    ).resolves.toEqual([{ status: "expired" }]);

    const events = await db
      .select({
        eventKind: schema.subscriptionEvents.eventKind,
        effectiveAt: schema.subscriptionEvents.effectiveAt,
      })
      .from(schema.subscriptionEvents)
      .where(
        and(
          eq(schema.subscriptionEvents.tenantId, tenantId),
          eq(schema.subscriptionEvents.source, "subscription_status_job"),
        ),
      );
    expect(events).toHaveLength(4);
    expect(events).toEqual(
      expect.arrayContaining([
        { eventKind: "plan.activated", effectiveAt: startsAt },
        { eventKind: "plan.expired", effectiveAt: endsAt },
        { eventKind: "addon.activated", effectiveAt: startsAt },
        { eventKind: "addon.expired", effectiveAt: endsAt },
      ]),
    );
  });

  it("materializes only injected candidate tenants and leaves an unrelated due sentinel untouched", async () => {
    const at = new Date("1901-02-10T12:00:00.000Z");
    const targetTenantId = randomUUID();
    const sentinelTenantId = randomUUID();
    await createOrganization(db, targetTenantId);
    await createOrganization(db, sentinelTenantId);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const targetSubscriptionId = randomUUID();
    const sentinelSubscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values([
      {
        id: targetSubscriptionId,
        tenantId: targetTenantId,
        planVersionId,
        status: "active",
        startsAt: new Date("1901-01-01T00:00:00.000Z"),
        endsAt: at,
        source: "manual",
      },
      {
        id: sentinelSubscriptionId,
        tenantId: sentinelTenantId,
        planVersionId,
        status: "active",
        startsAt: new Date("1901-01-01T00:00:00.000Z"),
        endsAt: at,
        source: "manual",
      },
    ]);

    await scopedJob([targetTenantId]).run(at);

    const rows = await db
      .select({ id: schema.tenantSubscriptions.id, status: schema.tenantSubscriptions.status })
      .from(schema.tenantSubscriptions)
      .where(
        inArray(schema.tenantSubscriptions.id, [targetSubscriptionId, sentinelSubscriptionId]),
      );
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [targetSubscriptionId, "expired"],
        [sentinelSubscriptionId, "active"],
      ]),
    );
    await expect(
      db
        .select()
        .from(schema.subscriptionEvents)
        .where(eq(schema.subscriptionEvents.tenantId, sentinelTenantId)),
    ).resolves.toEqual([]);
  });

  it("discovers due production candidates read-only without including future tenants", async () => {
    const at = new Date("1800-02-10T12:00:00.000Z");
    const dueTenantId = await createOrganization(db);
    const futureTenantId = await createOrganization(db);
    const planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    await db.insert(schema.tenantSubscriptions).values([
      {
        tenantId: dueTenantId,
        planVersionId,
        status: "active",
        startsAt: new Date("1800-01-01T00:00:00.000Z"),
        endsAt: at,
        source: "manual",
      },
      {
        tenantId: futureTenantId,
        planVersionId,
        status: "active",
        startsAt: new Date("1800-01-01T00:00:00.000Z"),
        endsAt: new Date("1800-03-01T00:00:00.000Z"),
        source: "manual",
      },
    ]);

    await expect(
      new DatabaseSubscriptionStatusCandidateSource(db).dueTenantIds(at),
    ).resolves.toEqual([dueTenantId]);
    await expect(
      db
        .select({
          tenantId: schema.tenantSubscriptions.tenantId,
          status: schema.tenantSubscriptions.status,
        })
        .from(schema.tenantSubscriptions)
        .where(inArray(schema.tenantSubscriptions.tenantId, [dueTenantId, futureTenantId])),
    ).resolves.toEqual(
      expect.arrayContaining([
        { tenantId: dueTenantId, status: "active" },
        { tenantId: futureTenantId, status: "active" },
      ]),
    );
  });

  it("serializes with manual lifecycle work before locking rows and never overwrites it", async () => {
    const at = new Date("1902-02-10T12:00:00.000Z");
    const tenantId = await createOrganization(db);
    const currentPlanVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    const replacementPlanVersionId = await createPublishedPlan(db, {
      maxLines: 2,
      maxStations: 2,
      maxKiosks: 2,
      maxCabinetUsers: 2,
    });
    const currentSubscriptionId = randomUUID();
    const actorId = `status-job-actor-${randomUUID()}`;
    await db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Status job concurrency actor",
      email: `${actorId}@example.invalid`,
      role: "platform_admin",
      status: "active",
      emailVerified: true,
    });
    await db.insert(schema.tenantSubscriptions).values({
      id: currentSubscriptionId,
      tenantId,
      planVersionId: currentPlanVersionId,
      status: "active",
      startsAt: new Date("1902-01-01T00:00:00.000Z"),
      endsAt: at,
      source: "manual",
    });

    const jobApplicationName = `subscription-status-job-${randomUUID()}`;
    const jobUrl = new URL(scratchUrl);
    jobUrl.searchParams.set("application_name", jobApplicationName);
    const jobConnection = createDb(jobUrl.toString());
    const lifecycleApplicationName = `subscription-lifecycle-${randomUUID()}`;
    const lifecycleUrl = new URL(scratchUrl);
    lifecycleUrl.searchParams.set("application_name", lifecycleApplicationName);
    const lifecycleConnection = createDb(lifecycleUrl.toString());
    const job = new SubscriptionStatusJob(jobConnection.db, {
      dueTenantIds: async () => [tenantId],
    });
    const lifecycle = new SubscriptionLifecycleService(
      lifecycleConnection.db,
      new PlatformAuditService(),
    );
    const actor: PlatformPrincipal = {
      userId: actorId,
      role: "platform_admin",
      capabilities: platformCapabilitiesForRole("platform_admin"),
      twoFactorReady: true,
    };
    const blocker = await connection.pool.connect();
    let blockerOpen = false;
    let jobPhase: "waiting" | "settled" | undefined;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `tenant-subscription:${tenantId}`,
      ]);
      const jobAttempt = job.run(at);
      jobPhase = await Promise.race([
        waitForDatabaseLock(jobApplicationName).then(() => "waiting" as const),
        jobAttempt.then(() => "settled" as const),
      ]);
      const lifecycleAttempt = lifecycle.assignPlan(actor, tenantId, {
        catalogVersionId: replacementPlanVersionId,
        activationPolicy: "immediate",
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
        reason: "serialize status materialization with lifecycle",
      });
      await waitForDatabaseLock(lifecycleApplicationName);
      await blocker.query("commit");
      blockerOpen = false;
      await Promise.all([jobAttempt, lifecycleAttempt]);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      blocker.release();
      await jobConnection.pool.end();
      await lifecycleConnection.pool.end();
    }

    expect(jobPhase).toBe("waiting");
    await expect(
      db
        .select({ status: schema.tenantSubscriptions.status })
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.id, currentSubscriptionId)),
    ).resolves.toEqual([{ status: "expired" }]);
    const currentRows = await db
      .select({
        id: schema.tenantSubscriptions.id,
        planVersionId: schema.tenantSubscriptions.planVersionId,
      })
      .from(schema.tenantSubscriptions)
      .where(
        and(
          eq(schema.tenantSubscriptions.tenantId, tenantId),
          eq(schema.tenantSubscriptions.status, "active"),
        ),
      );
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0]?.planVersionId).toBe(replacementPlanVersionId);
    await expect(
      db
        .select({ eventKind: schema.subscriptionEvents.eventKind })
        .from(schema.subscriptionEvents)
        .where(
          and(
            eq(schema.subscriptionEvents.subscriptionId, currentSubscriptionId),
            eq(schema.subscriptionEvents.eventKind, "plan.expired"),
          ),
        ),
    ).resolves.toHaveLength(1);
  });
});
