import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
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

  it("counts only fixed-clock actionable tenant rows across calendar boundaries", async () => {
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
      tenantId,
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
      tenantId,
      familyId,
      revision: 2,
      status: "published",
      number: `KP-${currentOfferId}`,
      total: "10.00",
      publishedAt: fixedNow,
      createdByPlatformUserId: platformUserId,
      publishedByPlatformUserId: platformUserId,
    });
    const supersededFamilyId = randomUUID();
    await db.insert(schema.commercialOffers).values([
      {
        id: randomUUID(),
        tenantId,
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
        tenantId,
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
        tenantId,
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
      tenantId: foreignTenantId,
      number: `REQ-${randomUUID()}`,
      type: "other",
      status: "clarification_required",
      description: "Foreign",
      responsibleSide: "tenant",
      idempotencyKey: randomUUID(),
      createdByUserId: `${tenantId}:owner`,
    });

    await expect(service.attention(tenantId)).resolves.toEqual({ count: 4 });
    await db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: currentOfferId,
      decision: "changes_requested",
      message: "Revise",
      actorUserId: `${tenantId}:owner`,
      idempotencyKey: randomUUID(),
    });
    await expect(service.attention(tenantId)).resolves.toEqual({ count: 3 });
  });
});
