import { HttpException } from "@nestjs/common";
import { createDb, schema } from "@markiro/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import {
  createManagedSubscription,
  createOrganization,
  createPublishedAddon,
} from "./support/subscription-fixtures";
import {
  auditRows,
  createTenantWithoutCabinet,
  platformActor,
} from "./support/standalone-license-fixture";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const lifecycle = new SubscriptionLifecycleService(db, new PlatformAuditService());
afterAll(() => connection.pool.end());

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof HttpException)) throw new Error("expected an HttpException");
  return { status: error.getStatus(), body: error.getResponse() };
}

async function seedAddons(tenantId: string, subscriptionId: string, versionId: string, n: number) {
  await db.insert(schema.subscriptionAddons).values(
    Array.from({ length: n }, () => ({
      tenantId,
      subscriptionId,
      addonVersionId: versionId,
      quantity: 1,
      startsAt: new Date(Date.now() - 60_000),
      status: "active" as const,
      source: "manual" as const,
    })),
  );
}

const assign = (
  admin: Awaited<ReturnType<typeof platformActor>>,
  tenantId: string,
  subscriptionId: string,
  catalogVersionId: string,
) =>
  lifecycle.assignAddon(admin, tenantId, {
    catalogVersionId,
    expectedSubscriptionId: subscriptionId,
    activationPolicy: "immediate",
    quantity: 1,
    reason: "Test",
  });

describe.skipIf(!process.env.DATABASE_URL)(
  "the issuance journal's 65 references bound the add-ons of a tenant without a cabinet",
  () => {
    it("accepts the 64th add-on and refuses the 65th with a precise code, writing nothing", async () => {
      const admin = await platformActor(db);
      const tenantId = await createTenantWithoutCabinet(db);
      const { subscriptionId } = await createManagedSubscription(db, {
        tenantId,
        endsAt: null,
      });
      const versionId = await createPublishedAddon(
        db,
        [{ entitlementKey: "lines", increment: 1 }],
        {
          offlineAvailable: true,
        },
      );
      await seedAddons(tenantId, subscriptionId, versionId, 63);
      const sixtyFourth = await assign(admin, tenantId, subscriptionId, versionId);
      expect(sixtyFourth.status).toBe("active");

      expect(await refusal(assign(admin, tenantId, subscriptionId, versionId))).toEqual({
        status: 409,
        body: { code: "standalone_assignment_limit_reached" },
      });
      const rows = await db
        .select({ id: schema.subscriptionAddons.id })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, tenantId));
      expect(rows).toHaveLength(64);
      const refused = (await auditRows(db, tenantId)).filter(
        (entry) => entry.action === "platform.tenant.subscription.addon_assigned",
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        actorPlatformUserId: admin.userId,
        tenantId,
        targetType: "subscription_addon",
        targetId: sixtyFourth.id,
        outcome: "success",
      });
    });

    it("frees a place when an add-on is no longer live", async () => {
      const admin = await platformActor(db);
      const tenantId = await createTenantWithoutCabinet(db);
      const { subscriptionId } = await createManagedSubscription(db, { tenantId, endsAt: null });
      const versionId = await createPublishedAddon(
        db,
        [{ entitlementKey: "lines", increment: 1 }],
        {
          offlineAvailable: true,
        },
      );
      await seedAddons(tenantId, subscriptionId, versionId, 64);
      const [one] = await db
        .select({ id: schema.subscriptionAddons.id })
        .from(schema.subscriptionAddons)
        .where(eq(schema.subscriptionAddons.tenantId, tenantId))
        .limit(1);
      await db
        .update(schema.subscriptionAddons)
        .set({ status: "expired" })
        .where(
          and(
            eq(schema.subscriptionAddons.tenantId, tenantId),
            inArray(schema.subscriptionAddons.id, [one!.id]),
          ),
        );
      expect((await assign(admin, tenantId, subscriptionId, versionId)).status).toBe("active");
    });

    it("does not count an add-on past its end that the status job has not settled", async () => {
      const admin = await platformActor(db);
      const tenantId = await createTenantWithoutCabinet(db);
      const { subscriptionId } = await createManagedSubscription(db, { tenantId, endsAt: null });
      const versionId = await createPublishedAddon(
        db,
        [{ entitlementKey: "lines", increment: 1 }],
        { offlineAvailable: true },
      );
      await seedAddons(tenantId, subscriptionId, versionId, 63);
      await db.insert(schema.subscriptionAddons).values({
        tenantId,
        subscriptionId,
        addonVersionId: versionId,
        quantity: 1,
        startsAt: new Date(Date.now() - 2 * 86_400_000),
        endsAt: new Date(Date.now() - 60_000),
        status: "active",
        source: "manual",
      });
      // 63 live + 1 ended-unsettled: the 64th live add-on fits, the 65th does not.
      expect((await assign(admin, tenantId, subscriptionId, versionId)).status).toBe("active");
      expect(await refusal(assign(admin, tenantId, subscriptionId, versionId))).toEqual({
        status: 409,
        body: { code: "standalone_assignment_limit_reached" },
      });
    });

    it("counts a scheduled add-on that has not started: issuance can still name it later", async () => {
      const admin = await platformActor(db);
      const tenantId = await createTenantWithoutCabinet(db);
      const { subscriptionId } = await createManagedSubscription(db, { tenantId, endsAt: null });
      const versionId = await createPublishedAddon(
        db,
        [{ entitlementKey: "lines", increment: 1 }],
        { offlineAvailable: true },
      );
      await db.insert(schema.subscriptionAddons).values(
        Array.from({ length: 64 }, () => ({
          tenantId,
          subscriptionId,
          addonVersionId: versionId,
          quantity: 1,
          startsAt: new Date(Date.now() + 86_400_000),
          status: "scheduled" as const,
          source: "manual" as const,
        })),
      );
      expect((await refusal(assign(admin, tenantId, subscriptionId, versionId))).status).toBe(409);
    });

    it("does not limit a tenant with a cabinet: its file names no assignments", async () => {
      const admin = await platformActor(db);
      const tenantId = await createOrganization(db);
      const { subscriptionId } = await createManagedSubscription(db, { tenantId, endsAt: null });
      const versionId = await createPublishedAddon(db, [{ entitlementKey: "lines", increment: 1 }]);
      await seedAddons(tenantId, subscriptionId, versionId, 64);
      expect((await assign(admin, tenantId, subscriptionId, versionId)).status).toBe("active");
    });
  },
);
