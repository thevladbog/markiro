import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";
import { createOrganization } from "./support/subscription-fixtures";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant billing read service isolated Postgres integration", () => {
  const databaseName = `markiro_tenant_billing_read_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantA: string;
  let tenantB: string;
  let actorId: string;
  let foreignInvoiceId: string;
  let foreignOfferId: string;
  let service: TenantBillingReadService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    actorId = `billing-read-${randomUUID()}`;
    await db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Billing read test",
      email: `${actorId}@example.invalid`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    tenantA = await createOrganization(db);
    tenantB = await createOrganization(db);
    const timestamp = new Date("2026-08-20T12:00:00.000Z");
    const invoices = Array.from({ length: 105 }, (_, index) => ({
      id: randomUUID(),
      tenantId: tenantA,
      number: `A-${index}`,
      status: "issued" as const,
      issueDate: timestamp,
      dueDate: new Date("2026-08-01T00:00:00.000Z"),
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: "A" },
      subtotal: "1.00",
      vatTotal: "0.00",
      total: "1.00",
      createdByPlatformUserId: actorId,
      issuedByPlatformUserId: actorId,
      issuedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    foreignInvoiceId = randomUUID();
    await db.insert(schema.invoices).values([
      ...invoices,
      {
        id: foreignInvoiceId,
        tenantId: tenantB,
        number: "B-foreign",
        status: "issued",
        issueDate: timestamp,
        dueDate: timestamp,
        sellerSnapshot: { name: "Markiro" },
        buyerSnapshot: { name: "B" },
        subtotal: "1.00",
        vatTotal: "0.00",
        total: "1.00",
        createdByPlatformUserId: actorId,
        issuedByPlatformUserId: actorId,
        issuedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    const offerDocuments = Array.from({ length: 105 }, (_, index) => {
      const offerId = randomUUID();
      const documentId = randomUUID();
      return { offerId, documentId, index };
    });
    await db.insert(schema.commercialOffers).values(
      offerDocuments.map(({ offerId, index }) => ({
        id: offerId,
        tenantId: tenantA,
        familyId: randomUUID(),
        revision: 1,
        status: "published" as const,
        number: `O-${index}`,
        total: "1.00",
        createdByPlatformUserId: actorId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    );
    foreignOfferId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: foreignOfferId,
      tenantId: tenantB,
      familyId: randomUUID(),
      revision: 1,
      status: "published",
      number: "B-offer",
      total: "1.00",
      createdByPlatformUserId: actorId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(schema.commercialOfferDocuments).values(
      offerDocuments.map(({ offerId, documentId }) => ({
        id: documentId,
        tenantId: tenantA,
        offerId,
        revision: 1,
        format: "pdf",
        status: "ready",
        objectKey: `tenants/${tenantA}/offers/${offerId}/r1.pdf`,
        contentType: "application/pdf",
        sha256: "a".repeat(64),
        byteSize: 1,
        rendererVersion: "test",
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    );
    const acts = Array.from({ length: 105 }, (_, index) => ({
      actId: randomUUID(),
      documentId: randomUUID(),
      index,
    }));
    await db.insert(schema.billingActs).values(
      acts.map(({ actId, index }) => ({
        id: actId,
        tenantId: tenantA,
        number: `ACT-${index}`,
        status: "draft" as const,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actorId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
    );
    await db.insert(schema.billingActDocuments).values(
      acts.map(({ actId, documentId }) => ({
        id: documentId,
        tenantId: tenantA,
        actId,
        revision: 1,
        objectKey: `tenant-billing/${tenantA}/acts/${actId}/${documentId}.pdf`,
        contentType: "application/pdf",
        sha256: "b".repeat(64),
        byteSize: 1,
        uploadedByPlatformUserId: actorId,
        createdAt: timestamp,
      })),
    );
    service = new TenantBillingReadService(
      db,
      { presignRead: async () => "https://private.example.test/read" } as never,
      {} as never,
    );
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  it("paginates tied overdue invoices beyond 100 and excludes a foreign invoice", async () => {
    const page = await service.listInvoices(tenantA, { status: "overdue", offset: 100, limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.items.map((item) => item.status)).toEqual([
      "overdue",
      "overdue",
      "overdue",
      "overdue",
      "overdue",
    ]);
    expect(page.items.map((item) => item.id)).toEqual(
      [...page.items.map((item) => item.id)].sort().reverse(),
    );
    await expect(service.invoiceDetail(tenantA, foreignInvoiceId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.offerDetail(tenantA, foreignOfferId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("returns deterministic mixed offer/act pages from one database union", async () => {
    const first = await service.listDocuments(tenantA, { offset: 99, limit: 10 });
    const second = await service.listDocuments(tenantA, { offset: 109, limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(20);
    expect([...first.items, ...second.items].map((item) => item.createdAt)).toEqual(
      Array(20).fill("2026-08-20T12:00:00.000Z"),
    );
  });
});
