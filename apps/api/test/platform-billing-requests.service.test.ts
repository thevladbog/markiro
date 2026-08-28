import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDb, schema, type Db } from "@markiro/db";
import type { CreateInvoiceDto } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import { PlatformBillingRequestsService } from "../src/modules/platform-billing-requests/platform-billing-requests.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";
import {
  createTestTenantBillingNotifications,
  failingTenantBillingNotifications,
} from "./support/tenant-billing-notifications";

const databaseUrl = process.env.DATABASE_URL;
type RequestStatus = typeof schema.tenantBillingRequests.$inferSelect.status;
const targetStatuses = [
  "under_review",
  "clarification_required",
  "offer_prepared",
  "awaiting_payment",
  "in_progress",
  "completed",
  "cancelled",
] as const;
const allowedTransitions = [
  ["new", "under_review", "markiro"],
  ["new", "cancelled", "none"],
  ["under_review", "clarification_required", "tenant"],
  ["under_review", "offer_prepared", "tenant"],
  ["under_review", "in_progress", "markiro"],
  ["under_review", "cancelled", "none"],
  ["clarification_required", "under_review", "markiro"],
  ["clarification_required", "cancelled", "none"],
  ["offer_prepared", "under_review", "markiro"],
  ["offer_prepared", "awaiting_payment", "tenant"],
  ["offer_prepared", "cancelled", "none"],
  ["awaiting_payment", "in_progress", "markiro"],
  ["awaiting_payment", "cancelled", "none"],
  ["in_progress", "completed", "none"],
  ["in_progress", "cancelled", "none"],
] as const satisfies ReadonlyArray<
  readonly [RequestStatus, (typeof targetStatuses)[number], string]
>;
const allowedTransitionKeys = new Set(
  allowedTransitions.map(([fromStatus, toStatus]) => `${fromStatus}:${toStatus}`),
);
const forbiddenTransitions = (
  [
    "new",
    "under_review",
    "clarification_required",
    "offer_prepared",
    "awaiting_payment",
    "in_progress",
    "completed",
    "cancelled",
  ] as const
).flatMap((fromStatus) =>
  targetStatuses
    .filter((toStatus) => !allowedTransitionKeys.has(`${fromStatus}:${toStatus}`))
    .map((toStatus) => [fromStatus, toStatus] as const),
);

describe.skipIf(!databaseUrl)("platform billing requests on isolated Postgres", () => {
  const databaseName = `markiro_platform_billing_requests_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const audit = new PlatformAuditService();
  const actorId = `platform-billing-${randomUUID()}`;
  const actor: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: platformCapabilitiesForRole("accountant"),
    twoFactorReady: true,
  };
  let tenantA = "";
  let tenantB = "";
  let tenantUser = "";
  let requests: PlatformBillingRequestsService;
  let billing: BillingService;
  let offers: PlatformOffersService;
  let tenantOffers: TenantBillingOffersService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    tenantA = await createOrganization(connection.db);
    tenantB = await createOrganization(connection.db);
    tenantUser = `platform-billing-tenant-${randomUUID()}`;
    await connection.db.insert(schema.user).values({
      id: tenantUser,
      name: "Billing tenant user",
      email: `${tenantUser}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantA,
      userId: tenantUser,
      role: "owner",
      createdAt: new Date(),
    });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Platform billing actor",
      email: `${actorId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
    await connection.db.insert(schema.operatorBillingProfiles).values({
      ...profileValues(actorId, 1, "ООО Маркиро", "7707083893", "773601001", "1027700132195"),
    });
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId: tenantA,
      ...profileValues(actorId, 1, "ООО Покупатель", "7812014560", "781201001", "1027800000000"),
    });
    await connection.db.insert(schema.operatorBankAccounts).values({
      label: "Основной счёт",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    const notifications = createTestTenantBillingNotifications(connection.db);
    requests = new PlatformBillingRequestsService(connection.db, audit, notifications);
    billing = new BillingService(connection.db, audit, notifications);
    offers = new PlatformOffersService(connection.db, audit, notifications);
    tenantOffers = new TenantBillingOffersService(connection.db);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("serializes payload-sensitive comment retries and records the exact platform actor atomically", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const idempotencyKey = randomUUID();
    const input = { message: "  Check the bank details  ", idempotencyKey };

    const [left, right] = await Promise.all([
      requests.comment(actor, request.id, input),
      requests.comment(actor, request.id, input),
    ]);

    expect(right).toEqual(left);
    expect(left).toMatchObject({
      tenantId: tenantA,
      requestId: request.id,
      kind: "platform_comment",
      actorKind: "platform_user",
      actorUserId: null,
      actorPlatformUserId: actorId,
      message: "Check the bank details",
    });
    const events = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.idempotencyKey, idempotencyKey));
    const audits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, request.id),
          eq(schema.platformAuditEvents.action, "billing.request.commented"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({
        actorPlatformUserId: actorId,
        actorRole: "accountant",
        action: "billing.request.commented",
        outcome: "success",
        tenantId: tenantA,
        targetType: "tenant_billing_request",
        targetId: request.id,
        before: { status: "under_review" },
        after: { status: "under_review", eventId: left.id },
      }),
    ]);
    await expect(
      requests.comment(actor, request.id, { message: "Different", idempotencyKey }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
  });

  it("preserves case in UUID-shaped semantic text while canonicalizing actual IDs", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const idempotencyKey = randomUUID();
    const uppercaseMessage = "A1111111-1111-4111-8111-111111111111";
    const first = await requests.comment(actor, request.id.toUpperCase(), {
      message: uppercaseMessage,
      idempotencyKey: idempotencyKey.toUpperCase(),
    });
    expect(first).toMatchObject({ requestId: request.id, message: uppercaseMessage });

    await expect(
      requests.comment(actor, request.id, {
        message: uppercaseMessage.toLowerCase(),
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
  });

  it.each(allowedTransitions)(
    "moves %s to %s with responsibleSide=%s",
    async (fromStatus, toStatus, expectedSide) => {
      const request = await insertRequest(connection.db, tenantA, tenantUser, fromStatus);
      const beforeSide = responsibleSide(fromStatus);
      const message = `Transition ${fromStatus} to ${toStatus}`;
      const event = await requests.changeStatus(actor, request.id, {
        status: toStatus,
        message,
        idempotencyKey: randomUUID(),
      });
      const [updated] = await connection.db
        .select()
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.id, request.id));
      expect(updated).toMatchObject({ status: toStatus, responsibleSide: expectedSide });
      expect(event).toMatchObject({
        kind: "status_changed",
        fromStatus,
        toStatus,
        actorPlatformUserId: actorId,
        message,
      });
      const audits = await connection.db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.targetId, request.id),
            eq(schema.platformAuditEvents.action, "billing.request.status_changed"),
          ),
        );
      expect(audits).toEqual([
        expect.objectContaining({
          actorPlatformUserId: actorId,
          actorRole: "accountant",
          outcome: "success",
          tenantId: tenantA,
          targetType: "tenant_billing_request",
          reason: message,
          before: { status: fromStatus, responsibleSide: beforeSide },
          after: { status: toStatus, responsibleSide: expectedSide, eventId: event.id },
        }),
      ]);
      if (toStatus === "clarification_required") {
        const deliveries = await connection.db
          .select()
          .from(schema.emailDeliveries)
          .where(
            eq(
              schema.emailDeliveries.sourceId,
              `billing:clarification_required:${request.id}:${event.id}`,
            ),
          );
        expect(deliveries).toEqual([
          expect.objectContaining({
            tenantId: tenantA,
            recipient: `${tenantUser}@example.invalid`,
            kind: "tenant-billing-notification",
            status: "queued",
          }),
        ]);
        await expect(
          connection.db
            .select()
            .from(schema.emailOutbox)
            .where(eq(schema.emailOutbox.deliveryId, deliveries[0]!.id)),
        ).resolves.toHaveLength(1);
      }
    },
  );

  it("rolls back a clarification transition when its mandatory notification cannot enqueue", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const idempotencyKey = randomUUID();
    const failed = new PlatformBillingRequestsService(
      connection.db,
      audit,
      failingTenantBillingNotifications(new Error("notification enqueue failed")),
    );

    await expect(
      failed.changeStatus(actor, request.id, {
        status: "clarification_required",
        message: "Need tenant details",
        idempotencyKey,
      }),
    ).rejects.toThrow("notification enqueue failed");
    await expect(
      connection.db
        .select({ status: schema.tenantBillingRequests.status })
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.id, request.id)),
    ).resolves.toEqual([{ status: "under_review" }]);
    await expect(
      connection.db
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(eq(schema.tenantBillingRequestEvents.idempotencyKey, idempotencyKey)),
    ).resolves.toEqual([]);
  });

  it("returns the authoritative next transitions in list and detail", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");

    const list = await requests.list(actor, { tenantId: tenantA, status: "under_review" });
    expect(list.truncated).toBe(false);
    expect(list.items.find((item) => item.id === request.id)?.allowedTransitions).toEqual([
      "clarification_required",
      "offer_prepared",
      "in_progress",
      "cancelled",
    ]);
    await expect(requests.detail(actor, request.id)).resolves.toMatchObject({
      allowedTransitions: ["clarification_required", "offer_prepared", "in_progress", "cancelled"],
    });
  });

  it("bounds the registry before loading one tenant-safe latest event per returned request", async () => {
    const registryTenant = await createOrganization(connection.db);
    const requestIds: string[] = Array.from({ length: 101 }, () => randomUUID());
    await connection.db.insert(schema.tenantBillingRequests).values(
      requestIds.map((id, index) => ({
        id,
        tenantId: registryTenant,
        number: `BR-REGISTRY-${index}`,
        type: "other" as const,
        status: "new" as const,
        description: "Registry cardinality fixture",
        responsibleSide: "markiro" as const,
        idempotencyKey: randomUUID(),
        createdByUserId: tenantUser,
        createdAt: new Date(`2026-08-28T08:${String(index % 60).padStart(2, "0")}:00.000Z`),
        updatedAt: new Date(1_800_000_000_000 + index * 1_000),
      })),
    );
    const latestRequestIds = requestIds.slice(-2);
    const tiedAt = new Date("2030-08-28T08:00:00.000Z");
    const latestIds = [
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    ];
    for (const [requestIndex, requestId] of latestRequestIds.entries()) {
      if (!requestId) throw new Error("registry request fixture missing");
      const latestId = latestIds[requestIndex];
      if (!latestId) throw new Error("registry latest-event fixture missing");
      await connection.db.insert(schema.tenantBillingRequestEvents).values([
        ...Array.from({ length: 20 }, (_, eventIndex) => ({
          tenantId: registryTenant,
          requestId,
          kind: "created" as const,
          actorKind: "system" as const,
          message: `history-${requestIndex}-${eventIndex}`,
          idempotencyKey: randomUUID(),
          createdAt: new Date(1_700_000_000_000 + eventIndex * 1_000),
        })),
        {
          id:
            requestIndex === 0
              ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
              : "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
          tenantId: registryTenant,
          requestId,
          kind: "platform_comment" as const,
          actorKind: "platform_user" as const,
          actorPlatformUserId: actorId,
          message: "same-time-lower-id",
          idempotencyKey: randomUUID(),
          createdAt: tiedAt,
        },
        {
          id: latestId,
          tenantId: registryTenant,
          requestId,
          kind: "platform_comment" as const,
          actorKind: "platform_user" as const,
          actorPlatformUserId: actorId,
          message: `latest-${requestIndex}`,
          idempotencyKey: randomUUID(),
          createdAt: tiedAt,
        },
      ]);
    }
    const foreign = await insertRequest(connection.db, tenantB, tenantUser, "new");
    await connection.db.insert(schema.tenantBillingRequestEvents).values({
      tenantId: tenantB,
      requestId: foreign.id,
      kind: "platform_comment",
      actorKind: "platform_user",
      actorPlatformUserId: actorId,
      message: "foreign-latest",
      idempotencyKey: randomUUID(),
      createdAt: new Date("2031-08-28T08:00:00.000Z"),
    });
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const observedDb: Db = drizzle(connection.pool, {
      logger: {
        logQuery(query, params) {
          queries.push({ query, params });
        },
      },
    });
    const observedRequests = new PlatformBillingRequestsService(
      observedDb,
      audit,
      createTestTenantBillingNotifications(observedDb),
    );

    const result = await observedRequests.list(actor, { tenantId: registryTenant });

    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(
      result.items
        .filter((item) => latestRequestIds.includes(item.id))
        .map((item) => item.latestEvent?.id)
        .sort(),
    ).toEqual([...latestIds].sort());
    expect(result.items.some((item) => item.latestEvent?.message === "foreign-latest")).toBe(false);
    const eventQueries = queries.filter((entry) =>
      entry.query.includes('from "tenant_billing_request_events"'),
    );
    expect(eventQueries).toHaveLength(1);
    const eventQuery = eventQueries[0];
    if (!eventQuery) throw new Error("registry event query was not observed");
    const loaded = await connection.pool.query<Record<string, unknown>, unknown[]>(
      eventQuery.query,
      eventQuery.params,
    );
    expect(loaded.rows).toHaveLength(2);
    expect(loaded.rows.every((row) => row.tenant_id === registryTenant)).toBe(true);

    const oldestRequestId = requestIds[0];
    if (!oldestRequestId) throw new Error("registry oldest fixture missing");
    await connection.db
      .delete(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, oldestRequestId));
    const completeResult = await requests.list(actor, { tenantId: registryTenant });
    expect(completeResult.items).toHaveLength(100);
    expect(completeResult.truncated).toBe(false);
  });

  it("projects linked-offer revision and invoice actions from authoritative offer state", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const [offer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        revision: 1,
        status: "published",
        number: `KP-ACTION-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    await requests.link(actor, request.id, {
      type: "offer",
      targetId: offer!.id,
      idempotencyKey: randomUUID(),
    });
    await connection.db.insert(schema.commercialOfferDecisions).values({
      tenantId: tenantA,
      offerId: offer!.id,
      decision: "changes_requested",
      message: "Revise the period",
      actorUserId: tenantUser,
      idempotencyKey: randomUUID(),
    });

    await expect(requests.detail(actor, request.id)).resolves.toMatchObject({
      offerAction: {
        offerId: offer!.id,
        currentOfferId: offer!.id,
        latestDecision: "changes_requested",
        canRevise: true,
        canCreateInvoice: false,
      },
    });
  });

  it("follows the current family revision and its current tenant decision", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const [original] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        revision: 1,
        status: "published",
        number: `KP-LIFECYCLE-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    if (!original) throw new Error("lifecycle offer fixture insert failed");
    await requests.link(actor, request.id, {
      type: "offer",
      targetId: original.id,
      idempotencyKey: randomUUID(),
    });
    await tenantOffers.requestChanges(tenantA, tenantUser, original.id, {
      message: "Please update",
      idempotencyKey: randomUUID(),
    });
    const revision = await offers.revise(actor, original.id, { idempotencyKey: randomUUID() });
    await offers.publish(actor, revision.id);
    await tenantOffers.accept(tenantA, tenantUser, revision.id, randomUUID());

    await expect(requests.detail(actor, request.id)).resolves.toMatchObject({
      offerAction: {
        offerId: revision.id,
        currentOfferId: revision.id,
        latestDecision: "accepted",
        canRevise: false,
        canCreateInvoice: true,
      },
    });
  });

  it("creates and links one tenant-authoritative draft atomically on exact replay", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const input = requestOfferInput(randomUUID());

    const [left, right] = await Promise.all([
      requests.createOffer(actor, request.id, input),
      requests.createOffer(actor, request.id, input),
    ]);

    expect(right).toEqual(left);
    expect(left).toMatchObject({
      requestId: request.id,
      tenantId: tenantA,
      link: { requestId: request.id, tenantId: tenantA, type: "offer" },
    });
    expect(left.link.targetId).toBe(left.offerId);
    const [offer] = await connection.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.id, left.offerId));
    expect(offer).toMatchObject({ tenantId: tenantA, status: "draft" });
    expect(
      await connection.db
        .select()
        .from(schema.tenantBillingRequestLinks)
        .where(eq(schema.tenantBillingRequestLinks.offerId, left.offerId)),
    ).toHaveLength(1);
    const events = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.idempotencyKey, input.idempotencyKey));
    expect(events).toEqual([
      expect.objectContaining({
        tenantId: tenantA,
        requestId: request.id,
        kind: "offer_linked",
        actorKind: "platform_user",
        actorPlatformUserId: actorId,
        metadata: { type: "offer", targetId: left.offerId, linkId: left.link.id },
      }),
    ]);
    const audits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, request.id),
          eq(schema.platformAuditEvents.action, "billing.request.offer_created"),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        actorPlatformUserId: actorId,
        actorRole: "accountant",
        outcome: "success",
        tenantId: tenantA,
        targetType: "tenant_billing_request",
        targetId: request.id,
        before: { status: "under_review" },
        after: { offerId: left.offerId, linkId: left.link.id, eventId: events[0]?.id },
      }),
    ]);
  });

  it("rolls back the request-bound offer when a link event conflicts", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const idempotencyKey = randomUUID();
    await connection.db.insert(schema.tenantBillingRequestEvents).values({
      tenantId: tenantA,
      requestId: request.id,
      kind: "platform_comment",
      actorKind: "platform_user",
      actorPlatformUserId: actorId,
      message: "occupy event key",
      idempotencyKey,
    });
    const before = await connection.db
      .select({ id: schema.commercialOffers.id })
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.tenantId, tenantA));

    await expect(
      requests.createOffer(actor, request.id, requestOfferInput(idempotencyKey)),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });

    const after = await connection.db
      .select({ id: schema.commercialOffers.id })
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.tenantId, tenantA));
    expect(after).toEqual(before);
  });

  it.each(forbiddenTransitions)(
    "rejects forbidden %s to %s without state, event, or audit changes",
    async (fromStatus, toStatus) => {
      const request = await insertRequest(connection.db, tenantA, tenantUser, fromStatus);
      const beforeEvents = await countRequestEvents(connection.db, request.id);
      const beforeAudits = await countRequestAudits(connection.db, request.id);

      await expect(
        requests.changeStatus(actor, request.id, {
          status: toStatus,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        response: { code: "billing_request_transition_invalid" },
        status: 409,
      });
      expect(await countRequestEvents(connection.db, request.id)).toBe(beforeEvents);
      expect(await countRequestAudits(connection.db, request.id)).toBe(beforeAudits);
      const [unchanged] = await connection.db
        .select()
        .from(schema.tenantBillingRequests)
        .where(eq(schema.tenantBillingRequests.id, request.id));
      expect(unchanged).toMatchObject({
        status: fromStatus,
        responsibleSide: responsibleSide(fromStatus),
      });
    },
  );

  it("tenant-scopes every linked entity and returns one typed link on an exact replay", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const [foreignOffer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantB,
        revision: 1,
        status: "published",
        number: `KP-FOREIGN-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    await expect(
      requests.link(actor, request.id, {
        type: "offer",
        targetId: foreignOffer!.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: "offer_not_found" }, status: 404 });

    const [offer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        revision: 1,
        status: "published",
        number: `KP-LINK-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    const idempotencyKey = randomUUID();
    const input = { type: "offer" as const, targetId: offer!.id, idempotencyKey };
    const first = await requests.link(actor, request.id, input);
    const replay = await requests.link(actor, request.id, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      tenantId: tenantA,
      requestId: request.id,
      type: "offer",
      targetId: offer!.id,
    });
    const linkedEvents = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.idempotencyKey, idempotencyKey));
    expect(linkedEvents).toHaveLength(1);
    expect(linkedEvents[0]).toMatchObject({ kind: "offer_linked", actorPlatformUserId: actorId });
  });

  it("serializes different-request claims for the same target into one link and one exact conflict", async () => {
    const firstRequest = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const secondRequest = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const [offer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        revision: 1,
        status: "draft",
        createdByPlatformUserId: actorId,
      })
      .returning();
    const outcomes = await Promise.allSettled([
      requests.link(actor, firstRequest.id, {
        type: "offer",
        targetId: offer!.id,
        idempotencyKey: randomUUID(),
      }),
      requests.link(actor, secondRequest.id, {
        type: "offer",
        targetId: offer!.id,
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { response: { code: "billing_target_already_linked" }, status: 409 },
    });
    const links = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.offerId, offer!.id));
    expect(links).toHaveLength(1);
    const events = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.kind, "offer_linked"));
    expect(events.filter(({ requestId }) => links[0]?.requestId === requestId)).toHaveLength(1);
  });

  it("treats upper/lower UUID aliases as one mutation key, entity, fingerprint, and stored link", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "under_review");
    const [firstOffer, secondOffer] = await connection.db
      .insert(schema.commercialOffers)
      .values([
        { tenantId: tenantA, revision: 1, status: "draft", createdByPlatformUserId: actorId },
        { tenantId: tenantA, revision: 1, status: "draft", createdByPlatformUserId: actorId },
      ])
      .returning();
    const idempotencyKey = randomUUID();
    const [left, right] = await Promise.all([
      requests.link(actor, request.id.toUpperCase(), {
        type: "offer",
        targetId: firstOffer!.id.toUpperCase(),
        idempotencyKey: idempotencyKey.toUpperCase(),
      }),
      requests.link(actor, request.id, {
        type: "offer",
        targetId: firstOffer!.id,
        idempotencyKey,
      }),
    ]);
    expect(right).toEqual(left);
    expect(left).toMatchObject({
      requestId: request.id,
      targetId: firstOffer!.id,
    });
    await expect(
      requests.link(actor, request.id, {
        type: "offer",
        targetId: secondOffer!.id,
        idempotencyKey,
      }),
    ).rejects.toMatchObject({ response: { code: "idempotency_key_reused" }, status: 409 });
    const stored = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.id, left.id));
    expect(stored).toEqual([
      expect.objectContaining({ requestId: request.id, offerId: firstOffer!.id }),
    ]);
  });

  it("creates an invoice only from the current accepted published offer and links its source request", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const familyId = randomUUID();
    const [published] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        familyId,
        revision: 1,
        status: "published",
        number: `KP-SOURCE-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    await connection.db.insert(schema.commercialOfferDecisions).values({
      tenantId: tenantA,
      offerId: published!.id,
      decision: "accepted",
      actorUserId: tenantUser,
      idempotencyKey: randomUUID(),
    });
    const [laterDraft] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId: tenantA,
        familyId,
        revision: 2,
        previousRevisionId: published!.id,
        status: "draft",
        createdByPlatformUserId: actorId,
      })
      .returning();

    const invoice = await billing.create(actor, {
      ...invoiceInput(tenantA),
      dueDate: "2026-08-30",
      sourceOfferId: published!.id,
      sourceRequestId: request.id,
    });
    expect(invoice).toMatchObject({ sourceOfferId: published!.id, sourceRequestId: request.id });
    const links = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.invoiceId, invoice.id));
    expect(links).toEqual([
      expect.objectContaining({ tenantId: tenantA, requestId: request.id, invoiceId: invoice.id }),
    ]);
    const issued = await billing.issue(actor, invoice.id);
    expect(issued).toMatchObject({
      status: "issued",
      sourceOfferId: published!.id,
      sourceRequestId: request.id,
    });
    const invoiceDeliveries = await connection.db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, `billing:invoice_due_soon:${invoice.id}:1`));
    expect(invoiceDeliveries).toEqual([
      expect.objectContaining({
        tenantId: tenantA,
        recipient: `${tenantUser}@example.invalid`,
        kind: "tenant-billing-notification",
        status: "queued",
      }),
    ]);
    await expect(
      connection.db
        .select()
        .from(schema.emailOutbox)
        .where(eq(schema.emailOutbox.deliveryId, invoiceDeliveries[0]!.id)),
    ).resolves.toHaveLength(1);
    const [awaitingPayment] = await connection.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, request.id));
    expect(awaitingPayment).toMatchObject({
      status: "awaiting_payment",
      responsibleSide: "tenant",
    });
    const issueEvents = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.requestId, request.id));
    expect(issueEvents.map((event) => event.kind)).toEqual(["invoice_linked", "status_changed"]);
    expect(issueEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "invoice_linked",
          actorKind: "platform_user",
          actorPlatformUserId: actorId,
          metadata: { invoiceId: invoice.id, linkId: links[0]!.id },
        }),
        expect.objectContaining({
          kind: "status_changed",
          fromStatus: "offer_prepared",
          toStatus: "awaiting_payment",
          actorPlatformUserId: actorId,
          metadata: { invoiceId: invoice.id },
        }),
      ]),
    );
    const linkAudits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(
        and(
          eq(schema.platformAuditEvents.targetId, request.id),
          eq(schema.platformAuditEvents.action, "billing.request.invoice_linked"),
        ),
      );
    expect(linkAudits).toHaveLength(1);

    await expect(
      billing.create(actor, {
        ...invoiceInput(tenantA),
        sourceOfferId: published!.id,
        sourceRequestId: (await insertRequest(connection.db, tenantB, tenantUser, "new")).id,
      }),
    ).rejects.toMatchObject({
      response: { code: "billing_source_tenant_mismatch" },
      status: 409,
    });

    const [newPublished] = await connection.db
      .update(schema.commercialOffers)
      .set({
        status: "published",
        number: `KP-SOURCE-NEW-${randomUUID()}`,
        publishedAt: new Date(),
        publishedByPlatformUserId: actorId,
      })
      .where(eq(schema.commercialOffers.id, laterDraft!.id))
      .returning();
    expect(newPublished).toBeDefined();
    await expect(
      billing.create(actor, { ...invoiceInput(tenantA), sourceOfferId: published!.id }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
  });

  it("rolls invoice issue state and linked events back when notification enqueue fails", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const invoice = await billing.create(actor, {
      ...invoiceInput(tenantA),
      dueDate: "2026-08-30",
      sourceRequestId: request.id,
    });
    const eventsBeforeIssue = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(eq(schema.tenantBillingRequestEvents.requestId, request.id));
    const failed = new BillingService(
      connection.db,
      audit,
      failingTenantBillingNotifications(new Error("notification enqueue failed")),
    );

    await expect(failed.issue(actor, invoice.id)).rejects.toThrow("notification enqueue failed");
    await expect(
      connection.db
        .select({ status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoice.id)),
    ).resolves.toEqual([{ status: "draft" }]);
    await expect(
      connection.db
        .select()
        .from(schema.tenantBillingRequestEvents)
        .where(eq(schema.tenantBillingRequestEvents.requestId, request.id)),
    ).resolves.toEqual(eventsBeforeIssue);
    await expect(
      connection.db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.sourceId, `billing:invoice_due_soon:${invoice.id}:1`)),
    ).resolves.toEqual([]);
  });

  it("serializes the global invoice number allocator across tenants", async () => {
    await connection.pool.query(`
      CREATE FUNCTION task6_invoice_insert_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
      CREATE TRIGGER task6_invoice_insert_delay
      BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION task6_invoice_insert_delay();
    `);
    try {
      const outcomes = await Promise.allSettled([
        billing.create(actor, invoiceInput(tenantA)),
        billing.create(actor, invoiceInput(tenantB)),
      ]);
      expect(outcomes).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      if (outcomes[0]?.status !== "fulfilled" || outcomes[1]?.status !== "fulfilled") {
        throw new Error("invoice allocation did not complete for both tenants");
      }
      expect(outcomes[0].value.number).not.toBe(outcomes[1].value.number);
    } finally {
      await connection.pool.query(`
        DROP TRIGGER task6_invoice_insert_delay ON invoices;
        DROP FUNCTION task6_invoice_insert_delay();
      `);
    }
  });

  it("allocates after arbitrary-length numeric suffixes and ignores malformed invoice numbers", async () => {
    const fixtureNumbers = [
      "INV-9223372036854775808",
      "INV-00009223372036854775809",
      "INV-999999999999999999999999999999x",
      "MANUAL-999999999999999999999999999999999999",
      "INV-9223372036854775810",
      "INV-999999999999999999999999999999",
      "INV-1000000000000000000000000000000",
    ];
    await connection.db.insert(schema.invoices).values(
      fixtureNumbers.slice(0, 4).map((number) => ({
        tenantId: tenantA,
        number,
        createdByPlatformUserId: actorId,
      })),
    );

    try {
      await expect(billing.create(actor, invoiceInput(tenantA))).resolves.toMatchObject({
        number: "INV-9223372036854775810",
      });

      await connection.db.insert(schema.invoices).values({
        tenantId: tenantB,
        number: "INV-999999999999999999999999999999",
        createdByPlatformUserId: actorId,
      });
      await expect(billing.create(actor, invoiceInput(tenantB))).resolves.toMatchObject({
        number: "INV-1000000000000000000000000000000",
      });
    } finally {
      await connection.pool.query(
        `DELETE FROM invoice_lines
         WHERE invoice_id IN (SELECT id FROM invoices WHERE number = ANY($1::text[]))`,
        [fixtureNumbers],
      );
      await connection.pool.query(`DELETE FROM invoices WHERE number = ANY($1::text[])`, [
        fixtureNumbers,
      ]);
    }
  });

  it("does not relabel an unrelated invoice unique violation as a number conflict", async () => {
    await connection.pool.query(`
      CREATE FUNCTION task6_invoice_unrelated_unique() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          CONSTRAINT = 'invoices_tenant_id_uq',
          MESSAGE = 'synthetic unrelated invoice unique violation';
      END $$;
      CREATE TRIGGER task6_invoice_unrelated_unique
      BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION task6_invoice_unrelated_unique();
    `);
    try {
      const failure = await billing
        .create(actor, invoiceInput(tenantA))
        .catch((error: unknown) => error);
      expect(failure).not.toMatchObject({ response: { code: "invoice_number_conflict" } });
      expect(postgresConstraint(failure)).toBe("invoices_tenant_id_uq");
    } finally {
      await connection.pool.query(`
        DROP TRIGGER task6_invoice_unrelated_unique ON invoices;
        DROP FUNCTION task6_invoice_unrelated_unique();
      `);
    }
  });

  it("maps the exact invoice number unique constraint to the domain conflict", async () => {
    await connection.pool.query(`
      CREATE FUNCTION task6_invoice_number_unique() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          CONSTRAINT = 'invoices_number_uq',
          MESSAGE = 'synthetic invoice number unique violation';
      END $$;
      CREATE TRIGGER task6_invoice_number_unique
      BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION task6_invoice_number_unique();
    `);
    try {
      await expect(billing.create(actor, invoiceInput(tenantA))).rejects.toMatchObject({
        response: { code: "invoice_number_conflict" },
        status: 409,
      });
    } finally {
      await connection.pool.query(`
        DROP TRIGGER task6_invoice_number_unique ON invoices;
        DROP FUNCTION task6_invoice_number_unique();
      `);
    }
  });

  it("serializes explicit invoice linking against issue without a deadlock or duplicate history", async () => {
    const request = await insertRequest(connection.db, tenantA, tenantUser, "offer_prepared");
    const invoice = await billing.create(actor, invoiceInput(tenantA));
    const [linkOutcome, issueOutcome] = await Promise.allSettled([
      requests.link(actor, request.id, {
        type: "invoice",
        targetId: invoice.id,
        idempotencyKey: randomUUID(),
      }),
      billing.issue(actor, invoice.id),
    ]);

    expect(linkOutcome).toMatchObject({ status: "fulfilled" });
    expect(issueOutcome).toMatchObject({ status: "fulfilled", value: { status: "issued" } });
    const links = await connection.db
      .select()
      .from(schema.tenantBillingRequestLinks)
      .where(eq(schema.tenantBillingRequestLinks.invoiceId, invoice.id));
    expect(links).toHaveLength(1);
    const linkEvents = await connection.db
      .select()
      .from(schema.tenantBillingRequestEvents)
      .where(
        and(
          eq(schema.tenantBillingRequestEvents.requestId, request.id),
          eq(schema.tenantBillingRequestEvents.kind, "invoice_linked"),
        ),
      );
    expect(linkEvents).toHaveLength(1);
    const [storedRequest] = await connection.db
      .select()
      .from(schema.tenantBillingRequests)
      .where(eq(schema.tenantBillingRequests.id, request.id));
    expect(["offer_prepared", "awaiting_payment"]).toContain(storedRequest!.status);
  });
});

function invoiceInput(tenantId: string): CreateInvoiceDto {
  return {
    tenantId,
    dueDate: null,
    applicationMode: "manual",
    lines: [
      {
        kind: "custom",
        catalogVersionId: null,
        nameRu: "Разовая услуга",
        nameEn: "One-time service",
        quantity: 1,
        unit: "услуга",
        agreedUnitPrice: "100.00",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: null,
      },
    ],
  };
}

function requestOfferInput(idempotencyKey: string) {
  return {
    idempotencyKey,
    expiresAt: "2026-09-30",
    lines: [
      {
        kind: "service" as const,
        catalogVersionId: null,
        nameRu: "Настройка",
        nameEn: "Setup",
        descriptionRu: null,
        descriptionEn: null,
        quantity: 1,
        unit: "service",
        agreedUnitPrice: "1000.00",
        vatRateBps: 2000,
        vatIncluded: true,
        activationPolicy: null,
      },
    ],
  };
}

function profileValues(
  actorId: string,
  revision: number,
  fullName: string,
  inn: string,
  kpp: string,
  ogrn: string,
) {
  return {
    revision,
    kind: "legal_entity" as const,
    fullName,
    displayName: fullName,
    inn,
    kpp,
    ogrn,
    addressRaw: "Москва",
    legalAddressRaw: "Москва",
    actualSameAsLegal: true,
    postalSameAsLegal: true,
    isConfirmed: true,
    confirmedByPlatformUserId: actorId,
    confirmedAt: new Date(),
    createdByPlatformUserId: actorId,
  };
}

async function insertRequest(
  db: Db,
  tenantId: string,
  userId: string,
  status: typeof schema.tenantBillingRequests.$inferInsert.status,
) {
  const [request] = await db
    .insert(schema.tenantBillingRequests)
    .values({
      tenantId,
      number: `BR-${randomUUID()}`,
      type: "other",
      status,
      description: "Platform workflow fixture",
      responsibleSide: responsibleSide(status ?? "new"),
      idempotencyKey: randomUUID(),
      createdByUserId: userId,
    })
    .returning();
  return request!;
}

function responsibleSide(
  status: NonNullable<typeof schema.tenantBillingRequests.$inferInsert.status>,
) {
  if (["clarification_required", "offer_prepared", "awaiting_payment"].includes(status)) {
    return "tenant" as const;
  }
  if (["completed", "cancelled"].includes(status)) return "none" as const;
  return "markiro" as const;
}

function postgresConstraint(error: unknown): string | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const code = Reflect.get(current, "code");
    const constraint = Reflect.get(current, "constraint");
    if (code === "23505" && typeof constraint === "string") return constraint;
    current = Reflect.get(current, "cause");
  }
  return null;
}

async function countRequestEvents(db: Db, requestId: string) {
  const rows = await db
    .select({ id: schema.tenantBillingRequestEvents.id })
    .from(schema.tenantBillingRequestEvents)
    .where(eq(schema.tenantBillingRequestEvents.requestId, requestId));
  return rows.length;
}

async function countRequestAudits(db: Db, requestId: string) {
  const rows = await db
    .select({ id: schema.platformAuditEvents.id })
    .from(schema.platformAuditEvents)
    .where(eq(schema.platformAuditEvents.targetId, requestId));
  return rows.length;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
