import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDb, schema, type Db } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubscriptionStatusJob } from "../src/subscriptions/subscription-status.job";
import {
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("SubscriptionStatusJob", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  let db: Db;

  beforeAll(() => {
    db = connection.db;
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it("materializes due parent and add-on statuses exactly once across retrying workers", async () => {
    const at = new Date("2026-08-10T12:00:00.000Z");
    const tenantId = await createOrganization(db);
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
    const currentId = randomUUID();
    const scheduledId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values([
      {
        id: currentId,
        tenantId,
        planVersionId: currentPlan,
        status: "active",
        startsAt: new Date("2026-07-10T12:00:00.000Z"),
        endsAt: at,
        source: "manual",
      },
      {
        id: scheduledId,
        tenantId,
        planVersionId: scheduledPlan,
        status: "scheduled",
        startsAt: at,
        endsAt: new Date("2026-09-10T12:00:00.000Z"),
        source: "manual",
      },
    ]);
    const addonVersion = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 1 },
    ]);
    const expiredAddonId = randomUUID();
    const activatedAddonId = randomUUID();
    await db.insert(schema.subscriptionAddons).values([
      {
        id: expiredAddonId,
        tenantId,
        subscriptionId: currentId,
        addonVersionId: addonVersion,
        quantity: 1,
        startsAt: new Date("2026-07-10T12:00:00.000Z"),
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
        endsAt: new Date("2026-09-10T12:00:00.000Z"),
        status: "scheduled",
        source: "manual",
      },
    ]);

    const first = new SubscriptionStatusJob(db);
    const second = new SubscriptionStatusJob(db);
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
      .where(inArray(schema.subscriptionAddons.id, [expiredAddonId, activatedAddonId]));
    expect(new Map(addons.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [expiredAddonId, "expired"],
        [activatedAddonId, "active"],
      ]),
    );
    const events = await db
      .select()
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
        expect.objectContaining({
          subscriptionId: currentId,
          eventKind: "plan.expired",
          effectiveAt: at,
          actorPlatformUserId: null,
          reason: "term_ended",
          before: expect.objectContaining({ status: "active" }),
          after: expect.objectContaining({ status: "expired" }),
        }),
        expect.objectContaining({
          subscriptionId: scheduledId,
          eventKind: "plan.activated",
          effectiveAt: at,
          actorPlatformUserId: null,
          reason: "scheduled_start_reached",
          before: expect.objectContaining({ status: "scheduled" }),
          after: expect.objectContaining({ status: "active" }),
        }),
        expect.objectContaining({
          subscriptionId: currentId,
          eventKind: "addon.expired",
          effectiveAt: at,
          reason: "term_ended",
          before: expect.objectContaining({ id: expiredAddonId, status: "active" }),
          after: expect.objectContaining({ id: expiredAddonId, status: "expired" }),
        }),
        expect.objectContaining({
          subscriptionId: scheduledId,
          eventKind: "addon.activated",
          effectiveAt: at,
          reason: "scheduled_start_reached",
          before: expect.objectContaining({ id: activatedAddonId, status: "scheduled" }),
          after: expect.objectContaining({ id: activatedAddonId, status: "active" }),
        }),
      ]),
    );
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
    await new SubscriptionStatusJob(db).run(at);
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

    const job = new SubscriptionStatusJob(db);
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
});
