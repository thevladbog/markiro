import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import { acquireBillingWorkflowLocks } from "../src/modules/billing-workflow-locks";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe("tenant offer decision idempotency lock protocol", () => {
  it("uses the tenant two-int namespace before a collision-injected workflow lock", async () => {
    const dialect = new PgDialect();
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    const offerId = "10000000-0000-4000-8000-000000000042";
    const idempotencyKey = "00000000-0000-4000-8000-000000000042";
    const decisionId = "20000000-0000-4000-8000-000000000042";
    let selectCount = 0;
    const tx = {
      execute: vi.fn(async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        rendered.push(query);
        return query.sql.includes("from unnest") ? { rows: [{ identity: "42" }] } : { rows: [] };
      }),
      select: vi.fn(() => {
        selectCount += 1;
        return resolvedQuery(
          selectCount === 1
            ? [{ familyId: "30000000-0000-4000-8000-000000000042" }]
            : selectCount === 2
              ? [{ offerId, decision: "accepted", message: null, decisionId }]
              : [
                  {
                    id: decisionId,
                    offerId,
                    decision: "accepted",
                    message: null,
                    createdAt: new Date("2026-08-28T00:00:00.000Z"),
                  },
                ],
        );
      }),
    };
    const db = {
      transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
    } as unknown as Db;

    await expect(
      new TenantBillingOffersService(db).accept("tenant-a", "user-a", offerId, idempotencyKey),
    ).resolves.toMatchObject({ id: decisionId, offerId, decision: "accepted" });
    await acquireBillingWorkflowLocks(tx as unknown as Db, "tenant-a", [
      { kind: "offer", id: offerId },
    ]);

    expect(rendered).toHaveLength(3);
    expect(rendered[0]).toMatchObject({
      sql: "select pg_advisory_xact_lock($1::integer, hashtext($2))",
      params: [0x42494c54, `tenant-offer-idempotency:tenant-a:${idempotencyKey}`],
    });
    expect(rendered[1]).toMatchObject({ sql: expect.stringContaining("from unnest") });
    expect(rendered[2]).toMatchObject({
      sql: "select pg_advisory_xact_lock($1::bigint)",
      params: ["42"],
    });
  });
});

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
    const [request] = await db
      .insert(schema.tenantBillingRequests)
      .values({
        tenantId: tenantA,
        number: `BR-${randomUUID()}`,
        type: "other",
        description: "Concurrent linked offer",
        idempotencyKey: randomUUID(),
        createdByUserId: userA,
      })
      .returning();
    await db.insert(schema.tenantBillingRequestLinks).values({
      tenantId: tenantA,
      requestId: request!.id,
      offerId,
    });
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const results = await Promise.all([
      service.accept(tenantA, userA, offerId, firstKey),
      service.accept(tenantA, userB, offerId, secondKey),
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
    const aliases = await db
      .select()
      .from(schema.commercialOfferDecisionIdempotency)
      .where(eq(schema.commercialOfferDecisionIdempotency.tenantId, tenantA));
    const offerAliases = aliases.filter((alias) => alias.offerId === offerId);
    expect(offerAliases).toHaveLength(2);
    expect(new Set(offerAliases.map((alias) => alias.decisionId))).toEqual(
      new Set([results[0].id]),
    );
    await expect(service.accept(tenantA, userB, offerId, secondKey)).resolves.toEqual(results[1]);
    await expect(
      service.requestChanges(tenantA, userB, offerId, {
        idempotencyKey: secondKey,
        message: "Different payload",
      }),
    ).rejects.toMatchObject({
      response: { code: "idempotency_key_reused" },
      status: 409,
    });
    const events = await db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.tenantId, tenantA),
          eq(schema.tenantBillingRequestEvents.requestId, request!.id),
          eq(schema.tenantBillingRequestEvents.kind, "offer_accepted"),
        ),
      );
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantA),
          eq(schema.tenantAuditEvents.targetId, offerId),
          eq(schema.tenantAuditEvents.action, "billing.offer.accepted"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("globally serializes one tenant idempotency key across different offer families", async () => {
    const firstOfferId = await offer();
    const secondOfferId = await offer();
    const key = randomUUID();
    const settled = await Promise.allSettled([
      service.accept(tenantA, userA, firstOfferId, key),
      service.accept(tenantA, userB, secondOfferId, key),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.accept>>> =>
        result.status === "fulfilled",
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      response: { code: "idempotency_key_reused" },
      status: 409,
    });

    const winner = fulfilled[0]!.value;
    await expect(service.accept(tenantA, userA, winner.offerId, key)).resolves.toEqual(winner);
    const loserId = winner.offerId === firstOfferId ? secondOfferId : firstOfferId;
    await expect(service.accept(tenantA, userA, loserId, key)).rejects.toMatchObject({
      response: { code: "idempotency_key_reused" },
      status: 409,
    });
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

function resolvedQuery<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => promise),
  };
  return query;
}
