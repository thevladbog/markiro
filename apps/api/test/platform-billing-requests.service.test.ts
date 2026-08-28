import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb, schema, type Db } from "@markiro/db";
import type { CreateInvoiceDto } from "@markiro/platform-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import { PlatformBillingRequestsService } from "../src/modules/platform-billing-requests/platform-billing-requests.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";

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
    requests = new PlatformBillingRequestsService(connection.db, audit);
    billing = new BillingService(connection.db, audit);
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
    },
  );

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
