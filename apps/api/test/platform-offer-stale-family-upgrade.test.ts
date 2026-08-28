import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const databaseUrl = process.env.DATABASE_URL;
const tenantId = "stale-family-runtime";
const actorId = "stale-family-runtime-actor";
const tenantUserId = "stale-family-runtime-user";
const familyId = "00000000-0000-4000-8000-000000007220";
const staleOfferId = "00000000-0000-4000-8000-000000007221";
const currentOfferId = "00000000-0000-4000-8000-000000007222";

const actor: PlatformPrincipal = {
  userId: actorId,
  role: "accountant",
  capabilities: platformCapabilitiesForRole("accountant"),
  twoFactorReady: true,
};

describe.skipIf(!databaseUrl)("stale commercial family after a real 0070 to 0072 upgrade", () => {
  const databaseName = `markiro_offer_stale_runtime_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const migrationsFolder = join(__dirname, "../../../packages/db/migrations");
  let temporaryRoot = "";
  let created = false;
  let platformOffers: PlatformOffersService;
  let tenantOffers: TenantBillingOffersService;
  let tenantRead: TenantBillingReadService;
  let billing: BillingService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-offer-stale-runtime-"));
    const migrationsThrough0070 = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, migrationsThrough0070, { recursive: true });
    await rm(join(migrationsThrough0070, "0071_tenant_billing_target_cardinality.sql"), {
      force: true,
    });
    await rm(join(migrationsThrough0070, "0072_tenant_billing_stale_family_repair.sql"), {
      force: true,
    });
    await rm(join(migrationsThrough0070, "meta", "0071_snapshot.json"), { force: true });
    await rm(join(migrationsThrough0070, "meta", "0072_snapshot.json"), { force: true });
    const journalPath = join(migrationsThrough0070, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      ({ tag }) =>
        tag !== "0071_tenant_billing_target_cardinality" &&
        tag !== "0072_tenant_billing_stale_family_repair",
    );
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(connection.db, { migrationsFolder: migrationsThrough0070 });

    await connection.db.insert(schema.organization).values({
      id: tenantId,
      name: "Stale family runtime",
      slug: tenantId,
      createdAt: new Date(),
    });
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Stale family actor",
      email: "stale-family-runtime-actor@example.invalid",
      role: actor.role,
      status: "active",
    });
    await connection.db.insert(schema.user).values({
      id: tenantUserId,
      name: "Stale family tenant user",
      email: "stale-family-runtime-user@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.commercialOffers).values([
      {
        id: staleOfferId,
        tenantId,
        familyId,
        revision: 1,
        status: "published",
        number: "KP-0072-RUNTIME-P1",
        total: "100.00",
        publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        publishedByPlatformUserId: actorId,
        createdByPlatformUserId: actorId,
      },
      {
        id: currentOfferId,
        tenantId,
        familyId,
        revision: 2,
        status: "published",
        number: "KP-0072-RUNTIME-P2",
        total: "200.00",
        publishedAt: new Date("2026-08-02T00:00:00.000Z"),
        publishedByPlatformUserId: actorId,
        createdByPlatformUserId: actorId,
      },
    ]);
    await connection.db.insert(schema.commercialOfferDecisions).values([
      {
        tenantId,
        offerId: staleOfferId,
        decision: "changes_requested",
        message: "Replace stale terms",
        actorUserId: tenantUserId,
        idempotencyKey: "00000000-0000-4000-8000-000000007231",
      },
      {
        tenantId,
        offerId: currentOfferId,
        decision: "accepted",
        actorUserId: tenantUserId,
        idempotencyKey: "00000000-0000-4000-8000-000000007232",
      },
    ]);

    await migrate(connection.db, { migrationsFolder });
    const audit = new PlatformAuditService();
    platformOffers = new PlatformOffersService(connection.db, audit);
    tenantOffers = new TenantBillingOffersService(connection.db);
    tenantRead = new TenantBillingReadService(connection.db, {} as never, {} as never);
    billing = new BillingService(connection.db, audit);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    if (created) {
      await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    }
    await maintenance.pool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("exposes the repaired status and rejects every stale money path", async () => {
    const listed = await platformOffers.list(actor, tenantId);
    expect(
      listed
        .filter(({ familyId: candidateFamilyId }) => candidateFamilyId === familyId)
        .sort((left, right) => left.revision - right.revision)
        .map(({ id, status }) => ({ id, status })),
    ).toEqual([
      { id: staleOfferId, status: "superseded" },
      { id: currentOfferId, status: "published" },
    ]);
    await expect(tenantRead.offerDetail(tenantId, staleOfferId)).resolves.toMatchObject({
      id: staleOfferId,
      status: "superseded",
    });
    await expect(
      tenantOffers.accept(tenantId, tenantUserId, staleOfferId, randomUUID()),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(
      platformOffers.pay(actor, staleOfferId, randomUUID(), {
        amount: "100.00",
        currency: "RUB",
        bankReference: `STALE-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(billing.create(actor, invoiceInput(staleOfferId))).rejects.toMatchObject({
      response: { code: "offer_version_stale" },
      status: 409,
    });
    const sourceInvoice = await billing.create(actor, invoiceInput(currentOfferId));
    expect(sourceInvoice).toMatchObject({ sourceOfferId: currentOfferId });
    await expect(
      platformOffers.pay(actor, currentOfferId, randomUUID(), {
        amount: "200.00",
        currency: "RUB",
        bankReference: `CURRENT-${randomUUID()}`,
      }),
    ).resolves.toMatchObject({ paymentId: expect.any(String) });

    const staleEffects = await connection.pool.query<{ payments: string; fulfilments: string }>(`
      SELECT
        (SELECT count(*) FROM payments WHERE offer_id = '${staleOfferId}') AS payments,
        (SELECT count(*) FROM offer_line_fulfilments AS fulfilment
         JOIN commercial_offer_lines AS line ON line.id = fulfilment.offer_line_id
         WHERE line.offer_id = '${staleOfferId}') AS fulfilments
    `);
    expect(staleEffects.rows).toEqual([{ payments: "0", fulfilments: "0" }]);
  }, 30_000);
});

function invoiceInput(sourceOfferId: string) {
  return {
    tenantId,
    sourceOfferId,
    dueDate: null,
    applicationMode: "manual" as const,
    lines: [
      {
        kind: "custom" as const,
        catalogVersionId: null,
        nameRu: "Разовая услуга",
        nameEn: "One-time service",
        quantity: 1,
        unit: "услуга",
        agreedUnitPrice: "200.00",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: null,
      },
    ],
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
