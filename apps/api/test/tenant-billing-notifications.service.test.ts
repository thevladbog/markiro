import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { renderEmail, type RenderedEmail } from "@markiro/email";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { MailJobsService, type MailPgPool } from "../src/modules/mail/mail-jobs.service";
import {
  TENANT_BILLING_ORGANIZATION_NAME_MAX,
  TENANT_BILLING_RECIPIENT_NAME_MAX,
  TENANT_BILLING_SUBJECT_NAME_MAX,
  tenantBillingNotificationPayloadSchema,
} from "../src/modules/mail/tenant-billing-notification-payload";
import { TenantBillingNotificationsService } from "../src/modules/tenant-billing/tenant-billing-notifications.service";

const ready = Boolean(process.env.DATABASE_URL);
const fixedNow = new Date("2026-08-28T21:30:00.000Z"); // 29 August in Europe/Moscow.

describe.skipIf(!ready)("tenant billing notifications isolated Postgres integration", () => {
  const databaseName = `markiro_billing_notifications_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  const crypto = new MailCryptoService(Buffer.alloc(32, 0x62));

  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantId: string;
  let foreignTenantId: string;
  let service: TenantBillingNotificationsService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    tenantId = `billing-notifications-${randomUUID()}`;
    foreignTenantId = `billing-notifications-${randomUUID()}`;
    await db.insert(schema.organization).values([
      {
        id: tenantId,
        name: "Завод & Ко",
        slug: `billing-notifications-${randomUUID()}`,
        createdAt: fixedNow,
      },
      {
        id: foreignTenantId,
        name: "Чужой завод",
        slug: `billing-notifications-${randomUUID()}`,
        createdAt: fixedNow,
      },
    ]);
    const users = [
      { id: "owner", name: "Owner", email: "Owner@example.test", role: "owner" },
      { id: "same-email", name: "Duplicate", email: "owner@example.test", role: "admin" },
      { id: "admin", name: "Admin", email: "admin@example.test", role: "member, admin" },
      { id: "manager", name: "Manager", email: "manager@example.test", role: "manager" },
      { id: "member", name: "Member", email: "member@example.test", role: "member" },
      { id: "invalid", name: "Invalid", email: "not-an-email", role: "admin" },
    ];
    await db.insert(schema.user).values(
      users.map((user) => ({
        id: `${tenantId}:${user.id}`,
        name: user.name,
        email: user.email,
        emailVerified: true,
        createdAt: fixedNow,
        updatedAt: fixedNow,
      })),
    );
    await db.insert(schema.member).values([
      ...users.map((user) => ({
        id: randomUUID(),
        organizationId: tenantId,
        userId: `${tenantId}:${user.id}`,
        role: user.role,
        createdAt: fixedNow,
      })),
      {
        id: randomUUID(),
        organizationId: tenantId,
        userId: `${tenantId}:owner`,
        role: "admin",
        createdAt: fixedNow,
      },
    ]);
    service = new TenantBillingNotificationsService(
      db,
      new MailDeliveryService(crypto),
      "https://cabinet.markiro.test",
      () => new Date(fixedNow),
    );
  });

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  it("enqueues one encrypted delivery per current owner/admin recipient and replays durably", async () => {
    const input = {
      tenantId,
      eventKind: "clarification_required" as const,
      entityId: randomUUID(),
      revision: 1,
      subjectName: "Заявка №42",
    };
    await db.transaction((tx) => service.enqueueInTransaction(tx, input));
    await db.transaction((tx) => service.enqueueInTransaction(tx, input));

    const deliveries = await db
      .select()
      .from(schema.emailDeliveries)
      .where(
        eq(schema.emailDeliveries.sourceId, `billing:clarification_required:${input.entityId}:1`),
      );
    expect(deliveries.map((row) => row.recipient).sort()).toEqual([
      "admin@example.test",
      "owner@example.test",
    ]);
    expect(deliveries.every((row) => row.kind === "tenant-billing-notification")).toBe(true);
    expect(deliveries.every((row) => row.encryptedPayload instanceof Buffer)).toBe(true);
    expect(
      deliveries.map((row) =>
        crypto.decrypt(row.id, {
          encryptedPayload: row.encryptedPayload!,
          payloadNonce: row.payloadNonce!,
          payloadTag: row.payloadTag!,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionUrl: `https://cabinet.markiro.test/billing/requests/${input.entityId}`,
          organizationName: "Завод & Ко",
          eventKind: "clarification_required",
        }),
      ]),
    );
    const outbox = await db.select().from(schema.emailOutbox);
    expect(outbox).toHaveLength(2);
  });

  it("keeps event and deliveries atomic and concurrent replays unique", async () => {
    const rolledBackEntity = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await service.enqueueInTransaction(tx, {
          tenantId,
          eventKind: "offer_published",
          entityId: rolledBackEntity,
          revision: 2,
          subjectName: "КП-42",
        });
        throw new Error("authoritative event rejected");
      }),
    ).rejects.toThrow("authoritative event rejected");
    expect(
      await db
        .select()
        .from(schema.emailDeliveries)
        .where(
          eq(schema.emailDeliveries.sourceId, `billing:offer_published:${rolledBackEntity}:2`),
        ),
    ).toEqual([]);

    const concurrentEntity = randomUUID();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        db.transaction((tx) =>
          service.enqueueInTransaction(tx, {
            tenantId,
            eventKind: "offer_published",
            entityId: concurrentEntity,
            revision: 3,
            subjectName: "КП-43",
          }),
        ),
      ),
    );
    const deliveries = await db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.sourceId, `billing:offer_published:${concurrentEntity}:3`));
    expect(deliveries.map((row) => row.recipient).sort()).toEqual([
      "admin@example.test",
      "owner@example.test",
    ]);
  });

  it("normalizes maximum upstream names before encryption so the worker can render them", async () => {
    const longTenantId = `billing-notifications-${randomUUID()}`;
    const ownerId = `${longTenantId}:owner`;
    const platformUserId = `platform-${randomUUID()}`;
    const actId = randomUUID();
    await db.insert(schema.organization).values({
      id: longTenantId,
      name: `  ${"Завод🏭".repeat(60)}  `,
      slug: `billing-notifications-${randomUUID()}`,
      createdAt: fixedNow,
    });
    await db.insert(schema.user).values({
      id: ownerId,
      name: `  ${"Владелец🙂".repeat(30)}  `,
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: longTenantId,
      userId: ownerId,
      role: "owner",
      createdAt: fixedNow,
    });
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Platform",
      email: `${platformUserId}@example.test`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.billingActs).values({
      id: actId,
      tenantId: longTenantId,
      number: "АКТ🙂".repeat(60),
      status: "issued",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-28",
      createdByPlatformUserId: platformUserId,
      issuedByPlatformUserId: platformUserId,
      issuedAt: fixedNow,
    });
    await db.insert(schema.billingActDocuments).values({
      id: randomUUID(),
      tenantId: longTenantId,
      actId,
      revision: 1,
      objectKey: `billing/acts/${actId}.pdf`,
      contentType: "application/pdf",
      sha256: "a".repeat(64),
      byteSize: 10,
      state: "ready",
      uploadedByPlatformUserId: platformUserId,
      readyAt: fixedNow,
    });
    const longService = new TenantBillingNotificationsService(
      db,
      new MailDeliveryService(crypto),
      "https://cabinet.markiro.test",
      () => new Date(fixedNow),
    );
    const [deliveryId] = await db.transaction((tx) =>
      longService.enqueueInTransaction(tx, {
        tenantId: longTenantId,
        eventKind: "act_ready",
        entityId: actId,
        revision: 1,
        subjectName: "АКТ🙂".repeat(60),
      }),
    );
    const [queuedDelivery] = await db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, deliveryId!));
    const payload = tenantBillingNotificationPayloadSchema.parse(
      crypto.decrypt(queuedDelivery!.id, {
        encryptedPayload: queuedDelivery!.encryptedPayload!,
        payloadNonce: queuedDelivery!.payloadNonce!,
        payloadTag: queuedDelivery!.payloadTag!,
      }),
    );
    expect(Array.from(payload.recipientName)).toHaveLength(TENANT_BILLING_RECIPIENT_NAME_MAX);
    expect(Array.from(payload.organizationName)).toHaveLength(TENANT_BILLING_ORGANIZATION_NAME_MAX);
    expect(Array.from(payload.subjectName)).toHaveLength(TENANT_BILLING_SUBJECT_NAME_MAX);
    expect(
      `${payload.recipientName}${payload.organizationName}${payload.subjectName}`,
    ).not.toContain("\uFFFD");
    await expect(renderEmail(payload)).resolves.toMatchObject({
      subject: expect.any(String),
      html: expect.stringContaining("https://cabinet.markiro.test/billing/documents"),
      text: expect.any(String),
    });
    const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
    const jobs = new MailJobsService(
      connection.pool as unknown as MailPgPool,
      crypto,
      transport,
      undefined,
      undefined,
      () => new Date(fixedNow),
    );

    await jobs.processDelivery(deliveryId!);

    const [delivery] = await db
      .select({ status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, deliveryId!));
    expect(delivery?.status).toBe("sent");
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe action URL before any durable delivery or outbox row", async () => {
    const entityId = randomUUID();
    const unsafe = new TenantBillingNotificationsService(
      db,
      new MailDeliveryService(crypto),
      `https://${"a".repeat(2_100)}.example.test`,
      () => new Date(fixedNow),
    );

    await expect(
      db.transaction((tx) =>
        unsafe.enqueueInTransaction(tx, {
          tenantId,
          eventKind: "offer_published",
          entityId,
          revision: 1,
          subjectName: "КП-URL",
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db
        .select()
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.sourceId, `billing:offer_published:${entityId}:1`)),
    ).resolves.toEqual([]);
  });

  it("cancels billing deliveries whose authoritative action becomes stale before send", async () => {
    const platformUserId = `platform-${randomUUID()}`;
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Worker state actor",
      email: `${platformUserId}@example.test`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
    const jobs = new MailJobsService(
      connection.pool as unknown as MailPgPool,
      crypto,
      transport,
      undefined,
      undefined,
      () => new Date(fixedNow),
    );
    const queued: Array<{ id: string; staleKind: string }> = [];
    const enqueueOne = async (input: Parameters<typeof service.enqueueInTransaction>[1]) => {
      const ids = await db.transaction((tx) => service.enqueueInTransaction(tx, input));
      return ids[0]!;
    };

    for (const nextStatus of ["under_review", "cancelled"] as const) {
      const requestId = randomUUID();
      const eventId = randomUUID();
      await db.insert(schema.tenantBillingRequests).values({
        id: requestId,
        tenantId,
        number: `REQ-${randomUUID()}`,
        type: "other",
        status: "clarification_required",
        description: "Clarify",
        responsibleSide: "tenant",
        idempotencyKey: randomUUID(),
        createdByUserId: `${tenantId}:owner`,
      });
      await db.insert(schema.tenantBillingRequestEvents).values({
        id: eventId,
        tenantId,
        requestId,
        kind: "status_changed",
        fromStatus: "under_review",
        toStatus: "clarification_required",
        actorKind: "platform_user",
        actorPlatformUserId: platformUserId,
        idempotencyKey: randomUUID(),
      });
      const id = await enqueueOne({
        tenantId,
        eventKind: "clarification_required",
        entityId: requestId,
        revision: eventId,
        subjectName: `REQ-${requestId}`,
      });
      await db
        .update(schema.tenantBillingRequests)
        .set({
          status: nextStatus,
          responsibleSide: nextStatus === "cancelled" ? "none" : "markiro",
        })
        .where(eq(schema.tenantBillingRequests.id, requestId));
      queued.push({ id, staleKind: nextStatus === "cancelled" ? "cancelled" : "replied" });
    }

    for (const staleKind of ["decided", "superseded"] as const) {
      const offerId = randomUUID();
      await db.insert(schema.commercialOffers).values({
        id: offerId,
        tenantId,
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `KP-${randomUUID()}`,
        total: "10.00",
        publishedAt: fixedNow,
        createdByPlatformUserId: platformUserId,
        publishedByPlatformUserId: platformUserId,
      });
      const id = await enqueueOne({
        tenantId,
        eventKind: "offer_published",
        entityId: offerId,
        revision: 1,
        subjectName: `KP-${offerId}`,
      });
      if (staleKind === "decided") {
        await db.insert(schema.commercialOfferDecisions).values({
          tenantId,
          offerId,
          decision: "accepted",
          actorUserId: `${tenantId}:owner`,
          idempotencyKey: randomUUID(),
        });
      } else {
        await db
          .update(schema.commercialOffers)
          .set({ status: "superseded" })
          .where(eq(schema.commercialOffers.id, offerId));
      }
      queued.push({ id, staleKind });
    }

    for (const staleKind of ["paid", "plus8"] as const) {
      const invoiceId = randomUUID();
      await db.insert(schema.invoices).values({
        id: invoiceId,
        tenantId,
        number: `INV-${randomUUID()}`,
        status: "issued",
        issueDate: fixedNow,
        dueDate: new Date("2026-08-30T00:00:00.000Z"),
        sellerSnapshot: { legalName: "Markiro" },
        buyerSnapshot: { legalName: "Factory" },
        subtotal: "10.00",
        vatTotal: "0.00",
        total: "10.00",
        createdByPlatformUserId: platformUserId,
      });
      const id = await enqueueOne({
        tenantId,
        eventKind: "invoice_due_soon",
        entityId: invoiceId,
        revision: 1,
        subjectName: `INV-${invoiceId}`,
      });
      await db
        .update(schema.invoices)
        .set(
          staleKind === "paid"
            ? { status: "paid" }
            : { dueDate: new Date("2026-09-06T00:00:00.000Z") },
        )
        .where(eq(schema.invoices.id, invoiceId));
      queued.push({ id, staleKind });
    }

    const actId = randomUUID();
    await db.insert(schema.billingActs).values({
      id: actId,
      tenantId,
      number: `ACT-${randomUUID()}`,
      status: "issued",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-28",
      createdByPlatformUserId: platformUserId,
      issuedByPlatformUserId: platformUserId,
      issuedAt: fixedNow,
    });
    const actDocumentId = randomUUID();
    await db.insert(schema.billingActDocuments).values({
      id: actDocumentId,
      tenantId,
      actId,
      revision: 1,
      objectKey: `billing/acts/${actId}.pdf`,
      contentType: "application/pdf",
      sha256: "b".repeat(64),
      byteSize: 10,
      state: "ready",
      uploadedByPlatformUserId: platformUserId,
      readyAt: fixedNow,
    });
    const staleActDelivery = await enqueueOne({
      tenantId,
      eventKind: "act_ready",
      entityId: actId,
      revision: 1,
      subjectName: `ACT-${actId}`,
    });
    await db
      .update(schema.billingActDocuments)
      .set({ state: "pending", readyAt: null })
      .where(eq(schema.billingActDocuments.id, actDocumentId));
    queued.push({ id: staleActDelivery, staleKind: "act invalid" });

    const liveRequestId = randomUUID();
    const liveEventId = randomUUID();
    await db.insert(schema.tenantBillingRequests).values({
      id: liveRequestId,
      tenantId,
      number: `REQ-${randomUUID()}`,
      type: "other",
      status: "clarification_required",
      description: "Still live",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });
    await db.insert(schema.tenantBillingRequestEvents).values({
      id: liveEventId,
      tenantId,
      requestId: liveRequestId,
      kind: "status_changed",
      fromStatus: "under_review",
      toStatus: "clarification_required",
      actorKind: "platform_user",
      actorPlatformUserId: platformUserId,
      idempotencyKey: randomUUID(),
    });
    const liveId = await enqueueOne({
      tenantId,
      eventKind: "clarification_required",
      entityId: liveRequestId,
      revision: liveEventId,
      subjectName: `REQ-${liveRequestId}`,
    });

    for (const item of queued) {
      await jobs.processDelivery(item.id);
      const [delivery] = await db
        .select({ status: schema.emailDeliveries.status })
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.id, item.id));
      expect(delivery?.status, item.staleKind).toBe("canceled");
    }
    await jobs.processDelivery(liveId);
    const [liveDelivery] = await db
      .select({ status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, liveId));
    expect(liveDelivery?.status).toBe("sent");
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("sends only the latest clarification status transition after a reply and re-entry", async () => {
    const platformUserId = `platform-${randomUUID()}`;
    const requestId = randomUUID();
    const tiedAt = new Date("2026-08-28T18:00:00.000Z");
    const firstClarificationId = "11111111-1111-4111-8111-111111111111";
    const replyId = "22222222-2222-4222-8222-222222222222";
    const latestClarificationId = "33333333-3333-4333-8333-333333333333";
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Clarification cycle actor",
      email: `${platformUserId}@example.test`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.tenantBillingRequests).values({
      id: requestId,
      tenantId,
      number: `REQ-CYCLE-${randomUUID()}`,
      type: "other",
      status: "clarification_required",
      description: "Clarification cycle",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });
    await db.insert(schema.tenantBillingRequestEvents).values({
      id: firstClarificationId,
      tenantId,
      requestId,
      kind: "status_changed",
      fromStatus: "under_review",
      toStatus: "clarification_required",
      actorKind: "platform_user",
      actorPlatformUserId: platformUserId,
      idempotencyKey: randomUUID(),
      createdAt: tiedAt,
    });
    const firstDeliveryIds = await db.transaction((tx) =>
      service.enqueueInTransaction(tx, {
        tenantId,
        eventKind: "clarification_required",
        entityId: requestId,
        revision: firstClarificationId,
        subjectName: "REQ cycle A",
      }),
    );
    await db.insert(schema.tenantBillingRequestEvents).values([
      {
        id: replyId,
        tenantId,
        requestId,
        kind: "status_changed",
        fromStatus: "clarification_required",
        toStatus: "under_review",
        actorKind: "platform_user",
        actorPlatformUserId: platformUserId,
        idempotencyKey: randomUUID(),
        createdAt: tiedAt,
      },
      {
        id: latestClarificationId,
        tenantId,
        requestId,
        kind: "status_changed",
        fromStatus: "under_review",
        toStatus: "clarification_required",
        actorKind: "platform_user",
        actorPlatformUserId: platformUserId,
        idempotencyKey: randomUUID(),
        createdAt: tiedAt,
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        tenantId,
        requestId,
        kind: "platform_comment",
        message: "A later non-status event must not replace the status transition",
        actorKind: "platform_user",
        actorPlatformUserId: platformUserId,
        idempotencyKey: randomUUID(),
        createdAt: tiedAt,
      },
    ]);
    const latestDeliveryIds = await db.transaction((tx) =>
      service.enqueueInTransaction(tx, {
        tenantId,
        eventKind: "clarification_required",
        entityId: requestId,
        revision: latestClarificationId,
        subjectName: "REQ cycle B",
      }),
    );
    const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
    const jobs = new MailJobsService(connection.pool as unknown as MailPgPool, crypto, transport);

    for (const deliveryId of [...firstDeliveryIds, ...latestDeliveryIds]) {
      await jobs.processDelivery(deliveryId);
    }
    const cycleDeliveries = await db
      .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.tenantId, tenantId));
    expect(
      cycleDeliveries.filter(({ id }) => firstDeliveryIds.includes(id)).map(({ status }) => status),
    ).toEqual(["canceled", "canceled"]);
    expect(
      cycleDeliveries
        .filter(({ id }) => latestDeliveryIds.includes(id))
        .map(({ status }) => status),
    ).toEqual(["sent", "sent"]);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it("keeps combining and astral glyphs intact through encrypted worker rendering", async () => {
    const platformUserId = `platform-${randomUUID()}`;
    const requestId = randomUUID();
    const eventId = randomUUID();
    const boundarySubject = `${"a".repeat(118)}e\u0301🙂tail`;
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Unicode boundary actor",
      email: `${platformUserId}@example.test`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.tenantBillingRequests).values({
      id: requestId,
      tenantId,
      number: `REQ-UNICODE-${randomUUID()}`,
      type: "other",
      status: "clarification_required",
      description: "Unicode boundary",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });
    await db.insert(schema.tenantBillingRequestEvents).values({
      id: eventId,
      tenantId,
      requestId,
      kind: "status_changed",
      fromStatus: "under_review",
      toStatus: "clarification_required",
      actorKind: "platform_user",
      actorPlatformUserId: platformUserId,
      idempotencyKey: randomUUID(),
    });
    const [deliveryId] = await db.transaction((tx) =>
      service.enqueueInTransaction(tx, {
        tenantId,
        eventKind: "clarification_required",
        entityId: requestId,
        revision: eventId,
        subjectName: boundarySubject,
      }),
    );
    const [queuedDelivery] = await db
      .select()
      .from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.id, deliveryId!));
    expect(
      tenantBillingNotificationPayloadSchema.parse(
        crypto.decrypt(queuedDelivery!.id, {
          encryptedPayload: queuedDelivery!.encryptedPayload!,
          payloadNonce: queuedDelivery!.payloadNonce!,
          payloadTag: queuedDelivery!.payloadTag!,
        }),
      ).subjectName,
    ).toBe(boundarySubject);
    const transport = { verify: vi.fn(async () => true), send: vi.fn(async () => undefined) };
    const jobs = new MailJobsService(connection.pool as unknown as MailPgPool, crypto, transport);

    await jobs.processDelivery(deliveryId!);

    const rendered = (
      transport.send.mock.calls as unknown as Array<[RenderedEmail, string]>
    )[0]?.[0];
    if (!rendered) throw new Error("worker did not render the billing notification");
    const expectedBoundary = `${"a".repeat(118)}e\u0301🙂`;
    for (const value of [rendered.subject, rendered.html, rendered.text]) {
      expect(value).toContain(expectedBoundary);
      expect(value).not.toContain("tail");
      expect(value).not.toContain("\uFFFD");
      expect(hasUnpairedSurrogate(value)).toBe(false);
    }
  });

  it("counts only fixed-clock actionable tenant rows across calendar boundaries", async () => {
    const attentionTenantId = `billing-attention-${randomUUID()}`;
    const attentionForeignTenantId = `billing-attention-${randomUUID()}`;
    await db.insert(schema.organization).values([
      {
        id: attentionTenantId,
        name: "Attention tenant",
        slug: attentionTenantId,
        createdAt: fixedNow,
      },
      {
        id: attentionForeignTenantId,
        name: "Foreign attention tenant",
        slug: attentionForeignTenantId,
        createdAt: fixedNow,
      },
    ]);
    const platformUserId = `platform-${randomUUID()}`;
    await db.insert(schema.platformUsers).values({
      id: platformUserId,
      name: "Platform",
      email: `${platformUserId}@example.test`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    const requestId = randomUUID();
    await db.insert(schema.tenantBillingRequests).values({
      id: requestId,
      tenantId: attentionTenantId,
      number: `REQ-${requestId}`,
      type: "other",
      status: "clarification_required",
      description: "Clarify",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });
    const familyId = randomUUID();
    const currentOfferId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: currentOfferId,
      tenantId: attentionTenantId,
      familyId,
      revision: 2,
      status: "published",
      number: `KP-${currentOfferId}`,
      total: "10.00",
      publishedAt: fixedNow,
      createdByPlatformUserId: platformUserId,
      publishedByPlatformUserId: platformUserId,
    });
    await db.insert(schema.commercialOffers).values({
      id: randomUUID(),
      tenantId: attentionTenantId,
      familyId,
      revision: 3,
      status: "draft",
      number: null,
      total: "10.00",
      previousRevisionId: currentOfferId,
      createdByPlatformUserId: platformUserId,
    });
    const supersededFamilyId = randomUUID();
    await db.insert(schema.commercialOffers).values([
      {
        id: randomUUID(),
        tenantId: attentionTenantId,
        familyId: supersededFamilyId,
        revision: 1,
        status: "published",
        number: `KP-${randomUUID()}`,
        total: "10.00",
        publishedAt: fixedNow,
        createdByPlatformUserId: platformUserId,
        publishedByPlatformUserId: platformUserId,
      },
      {
        id: randomUUID(),
        tenantId: attentionTenantId,
        familyId: supersededFamilyId,
        revision: 2,
        status: "superseded",
        number: `KP-${randomUUID()}`,
        total: "10.00",
        createdByPlatformUserId: platformUserId,
      },
    ]);
    const invoiceRows = [
      ["past", "2026-08-28T12:00:00.000Z", "issued"],
      ["today", "2026-08-29T20:59:59.000Z", "issued"],
      ["plus7", "2026-09-05T00:00:00.000Z", "partially_paid"],
      ["plus8", "2026-09-06T00:00:00.000Z", "issued"],
      ["paid", "2026-08-30T00:00:00.000Z", "paid"],
    ] as const;
    await db.insert(schema.invoices).values(
      invoiceRows.map(([label, dueDate, status]) => ({
        id: randomUUID(),
        tenantId: attentionTenantId,
        number: `${label}-${randomUUID()}`,
        status,
        issueDate: fixedNow,
        dueDate: new Date(dueDate),
        sellerSnapshot: { legalName: "Markiro" },
        buyerSnapshot: { legalName: "Factory" },
        subtotal: "10.00",
        vatTotal: "0.00",
        total: "10.00",
        createdByPlatformUserId: platformUserId,
      })),
    );
    await db.insert(schema.tenantBillingRequests).values({
      id: randomUUID(),
      tenantId: attentionForeignTenantId,
      number: `REQ-${randomUUID()}`,
      type: "other",
      status: "clarification_required",
      description: "Foreign",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });

    await expect(service.attention(attentionTenantId)).resolves.toEqual({ count: 4 });
    await db.insert(schema.commercialOfferDecisions).values({
      tenantId: attentionTenantId,
      offerId: currentOfferId,
      decision: "changes_requested",
      message: "Revise",
      actorUserId: `${tenantId}:owner`,
      idempotencyKey: randomUUID(),
    });
    await expect(service.attention(attentionTenantId)).resolves.toEqual({ count: 3 });
  });
});

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}
