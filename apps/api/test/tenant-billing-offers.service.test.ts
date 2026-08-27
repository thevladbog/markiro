import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant billing offer decisions isolated Postgres service", () => {
  const databaseName = `markiro_tenant_billing_offers_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let platformUserId: string;
  let service: TenantBillingOffersService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    tenantA = await createOrganization(db);
    tenantB = await createOrganization(db);
    userA = `offer-admin-a-${randomUUID()}`;
    userB = `offer-admin-b-${randomUUID()}`;
    platformUserId = `offer-platform-${randomUUID()}`;
    await db.insert(schema.user).values(
      [userA, userB].map((id) => ({
        id,
        name: id,
        email: `${id}@example.invalid`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    );
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Offer operator",
      email: `${platformUserId}@example.invalid`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    service = new TenantBillingOffersService(db);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  async function offer(
    input: {
      tenantId?: string;
      familyId?: string;
      revision?: number;
      status?: "draft" | "published";
      expiresAt?: Date;
    } = {},
  ) {
    const id = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id,
      tenantId: input.tenantId ?? tenantA,
      familyId: input.familyId ?? randomUUID(),
      revision: input.revision ?? 1,
      status: input.status ?? "published",
      number: `TASK5-${id}`,
      total: "100.00",
      expiresAt: input.expiresAt,
      publishedAt: input.status === "draft" ? null : new Date("2026-08-27T00:00:00.000Z"),
      createdByPlatformUserId: platformUserId,
    });
    return id;
  }

  it("accepts only the latest published non-expired family revision while drafts do not supersede", async () => {
    const familyId = randomUUID();
    const oldRevisionId = await offer({ familyId, revision: 1 });
    const currentId = await offer({ familyId, revision: 2 });
    await offer({ familyId, revision: 3, status: "draft" });

    await expect(service.accept(tenantA, userA, oldRevisionId, randomUUID())).rejects.toMatchObject(
      { response: { code: "offer_version_stale" }, status: 409 },
    );
    await expect(service.accept(tenantA, userA, currentId, randomUUID())).resolves.toMatchObject({
      offerId: currentId,
      decision: "accepted",
    });
    await expect(service.accept(tenantB, userA, currentId, randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });

  it("serializes two administrators accepting one offer into one accepted decision", async () => {
    const offerId = await offer();
    const results = await Promise.all([
      service.accept(tenantA, userA, offerId, randomUUID()),
      service.accept(tenantA, userB, offerId, randomUUID()),
    ]);
    expect(results[0].id).toBe(results[1].id);
    const decisions = await db
      .select()
      .from(schema.commercialOfferDecisions)
      .where(
        and(
          eq(schema.commercialOfferDecisions.tenantId, tenantA),
          eq(schema.commercialOfferDecisions.offerId, offerId),
        ),
      );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("accepted");
  });

  it("writes a linked request event and exact audit atomically without mutating the offer", async () => {
    const offerId = await offer();
    const [request] = await db
      .insert(schema.tenantBillingRequests)
      .values({
        tenantId: tenantA,
        number: `BR-${randomUUID()}`,
        type: "other",
        description: "Linked offer",
        idempotencyKey: randomUUID(),
        createdByUserId: userA,
      })
      .returning();
    await db.insert(schema.tenantBillingRequestLinks).values({
      tenantId: tenantA,
      requestId: request!.id,
      offerId,
    });
    const before = await db
      .select()
      .from(schema.commercialOffers)
      .where(
        and(eq(schema.commercialOffers.tenantId, tenantA), eq(schema.commercialOffers.id, offerId)),
      );
    const result = await service.requestChanges(tenantA, userA, offerId, {
      message: "  Please change capacity  ",
      idempotencyKey: randomUUID(),
    });
    expect(result).toMatchObject({
      decision: "changes_requested",
      message: "Please change capacity",
    });
    const after = await db
      .select()
      .from(schema.commercialOffers)
      .where(
        and(eq(schema.commercialOffers.tenantId, tenantA), eq(schema.commercialOffers.id, offerId)),
      );
    expect(after).toEqual(before);
    const [event] = await db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.tenantId, tenantA),
          eq(schema.tenantBillingRequestEvents.requestId, request!.id),
        ),
      );
    expect(event).toMatchObject({
      kind: "offer_changes_requested",
      actorUserId: userA,
      metadata: { offerId },
    });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantA),
          eq(schema.tenantAuditEvents.targetId, offerId),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: userA,
      action: "billing.offer.changes_requested",
      outcome: "success",
      targetType: "commercial_offer",
      before: null,
      after: { decision: "changes_requested", requestId: request!.id },
    });
  });

  it("rejects expired offers and reused idempotency keys with a different payload", async () => {
    const expiredId = await offer({ expiresAt: new Date("2020-01-01T00:00:00.000Z") });
    await expect(service.accept(tenantA, userA, expiredId, randomUUID())).rejects.toMatchObject({
      response: { code: "offer_expired" },
      status: 409,
    });

    const offerId = await offer();
    const key = randomUUID();
    await service.requestChanges(tenantA, userA, offerId, {
      message: "First payload",
      idempotencyKey: key,
    });
    await expect(service.accept(tenantA, userA, offerId, key)).rejects.toMatchObject({
      response: { code: "idempotency_key_reused" },
      status: 409,
    });
  });

  it("replays the same tenant key and payload across administrators", async () => {
    const offerId = await offer();
    const key = randomUUID();
    const first = await service.accept(tenantA, userA, offerId, key);
    const replay = await service.accept(tenantA, userB, offerId, key);
    expect(replay).toEqual(first);
  });
});
