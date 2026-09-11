import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  reportCommercialP0Impact,
  runReportCommercialP0ImpactCli,
} from "../src/cli/report-commercial-p0-impact";
import { createOrganization } from "./support/subscription-fixtures";

describe.skipIf(!process.env.DATABASE_URL)("commercial P0 read-only impact report", () => {
  const name = `commercial_report_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  let connection: ReturnType<typeof createDb>;
  let fixtureUrl: string;
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    fixtureUrl = url.toString();
    connection = createDb(fixtureUrl);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
  }, 120_000);
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${name}"`);
    await maintenance.pool.end();
  });
  it("reports exact safe identifiers without inferring terms, repairing rows or exposing billing data", async () => {
    const db = connection.db;
    expect(
      Object.values((await reportCommercialP0Impact(db)).categories).every(
        (category) => category.count === 0 && category.ids.length === 0,
      ),
    ).toBe(true);
    const versionId = randomUUID(),
      itemId = randomUUID();
    await db.insert(schema.catalogItems).values({
      id: itemId,
      code: itemId,
      kind: "plan",
      nameRu: "PRIVATE PLAN",
      nameEn: "PRIVATE PLAN",
    });
    await db.insert(schema.catalogItemVersions).values({
      id: versionId,
      catalogItemId: itemId,
      kind: "plan",
      version: 1,
      nameRu: "PRIVATE PLAN",
      nameEn: "PRIVATE PLAN",
      unit: "год",
      billingMode: "recurring",
      billingPeriod: "month",
      unitPrice: "1000.00",
      vatIncluded: false,
    });
    await db.insert(schema.planEntitlements).values({
      catalogVersionId: versionId,
      maxLines: 0,
      maxStations: 1,
      maxKiosks: null,
      maxCabinetUsers: 2,
    });
    await db
      .update(schema.catalogItemVersions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(schema.catalogItemVersions.id, versionId));
    const actorId = randomUUID();
    await db.insert(schema.platformUsers).values({
      id: actorId,
      name: "PRIVATE ACTOR",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
    });
    const tenantId = await createOrganization(db);
    const subscriptionId = randomUUID();
    const [seller] = await db
      .insert(schema.operatorBillingProfiles)
      .values({
        revision: 1,
        kind: "self_employed",
        fullName: "PRIVATE SELLER",
        displayName: "PRIVATE NAME",
        inn: "123456789012",
        addressRaw: "PRIVATE ADDRESS",
        legalAddressRaw: "PRIVATE ADDRESS",
        createdByPlatformUserId: actorId,
      })
      .returning({ id: schema.operatorBillingProfiles.id });
    const offerId = randomUUID(),
      snapshotId = randomUUID(),
      offerLineId = randomUUID();
    await db
      .insert(schema.commercialOffers)
      .values({ id: offerId, tenantId, revision: 1, status: "draft", total: "120.00" });
    await db.insert(schema.commercialOfferLines).values({
      id: offerLineId,
      tenantId,
      offerId,
      position: 1,
      kind: "plan",
      catalogVersionId: versionId,
      nameRu: "PRIVATE LICENSE",
      nameEn: "PRIVATE LICENSE",
      quantity: 1,
      unit: "год",
      agreedUnitPrice: "100.00",
      vatRate: "20.00",
      vatIncluded: false,
      lineTotal: "100.00",
      activationPolicy: "immediately",
    });
    await db.insert(schema.tenantSubscriptions).values({
      id: subscriptionId,
      tenantId,
      planVersionId: versionId,
      status: "active",
      source: "paid_offer_line",
      sourceOfferLineId: offerLineId,
      startsAt: new Date(),
      endsAt: null,
    });
    const frozen = {
      sellerSnapshot: { secret: "PRIVATE BANK ACCOUNT" },
      buyerSnapshot: { name: "PRIVATE BUYER" },
      linesSnapshot: [{ lineTotal: "100.00", vatRate: "20.00", vatIncluded: false }],
    };
    await db.insert(schema.commercialOfferPrintSnapshots).values({
      id: snapshotId,
      tenantId,
      offerId,
      revision: 1,
      number: "PRIVATE DOCUMENT",
      publishedAt: new Date(),
      ...frozen,
      subtotal: "120.00",
      vatTotal: "0.00",
      total: "120.00",
    });
    const before = await db.select().from(schema.commercialOfferPrintSnapshots);
    const report = await reportCommercialP0Impact(db);
    expect(report.categories).toEqual({
      annualUnitMonthlyPeriod: { count: 1, ids: [versionId] },
      missingDocumentNameRu: { count: 1, ids: [versionId] },
      missingDocumentNameEn: { count: 1, ids: [versionId] },
      missingCatalogReview: { count: 1, ids: [versionId] },
      missingSellerPolicy: { count: 1, ids: [seller!.id] },
      nullEndedPaidSubscriptions: { count: 1, ids: [subscriptionId] },
      legacyLicenseOfferLines: { count: 1, ids: [offerLineId] },
      legacyLicenseInvoiceLines: { count: 0, ids: [] },
      legacyUnrepresentablePlans: { count: 1, ids: [versionId] },
      frozenOfferAmountMismatch: { count: 1, ids: [snapshotId] },
      frozenOfferTaxReview: { count: 1, ids: [snapshotId] },
    });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE|123456789012|120\.00|100\.00/);
    expect(await db.select().from(schema.commercialOfferPrintSnapshots)).toEqual(before);
    expect((await db.select().from(schema.catalogItemVersions))[0]).toMatchObject({
      unit: "год",
      billingPeriod: "month",
      documentNameRu: null,
    });
    expect((await db.select().from(schema.tenantSubscriptions))[0]?.endsAt).toBeNull();
    expect(await reportCommercialP0Impact(db)).toEqual(report);
    let output = "",
      errors = "";
    expect(
      await runReportCommercialP0ImpactCli({
        argv: [],
        env: { ...process.env, DATABASE_URL: fixtureUrl },
        stdout: {
          write: (value) => {
            output += value;
          },
        },
        stderr: {
          write: (value) => {
            errors += value;
          },
        },
      }),
    ).toBe(0);
    expect(errors).toBe("");
    expect(JSON.parse(output)).toEqual(report);
    await db.insert(schema.commercialOfferPrintSnapshots).values({
      tenantId,
      offerId,
      revision: 2,
      number: "PRIVATE INCOMPLETE",
      publishedAt: new Date(),
      sellerSnapshot: {},
      buyerSnapshot: {},
      linesSnapshot: [{ lineTotal: "100.00" }, {}],
      subtotal: "120.00",
      vatTotal: "0.00",
      total: "120.00",
    });
    expect((await reportCommercialP0Impact(db)).categories.frozenOfferAmountMismatch).toEqual({
      count: 1,
      ids: [snapshotId],
    });
  });
  it("enforces a read-only transaction even when a database read invokes a writing function", async () => {
    // A view with a write attempt proves the transaction boundary in PostgreSQL itself.
    await connection.db.execute(
      sql`create function commercial_report_write_probe() returns boolean language plpgsql as $$ begin insert into organization(id, name, slug, created_at) values ('probe','probe','probe',now()); return true; end $$`,
    );
    await connection.db.execute(
      sql`alter table plan_entitlements rename to plan_entitlements_original`,
    );
    try {
      await connection.db.execute(
        sql`create view plan_entitlements as select * from plan_entitlements_original where commercial_report_write_probe()`,
      );
      await expect(reportCommercialP0Impact(connection.db)).rejects.toMatchObject({
        cause: { code: "25006" },
      });
    } finally {
      await connection.db.execute(sql`drop view if exists plan_entitlements`);
      await connection.db.execute(
        sql`alter table plan_entitlements_original rename to plan_entitlements`,
      );
      await connection.db.execute(sql`drop function commercial_report_write_probe()`);
    }
    expect(
      await connection.db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, "probe")),
    ).toEqual([]);
  });
});

it("uses a sanitized CLI failure envelope without emitting invalid environment values", async () => {
  let output = "",
    error = "";
  expect(
    await runReportCommercialP0ImpactCli({
      argv: ["--repair"],
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: {
        write: (text) => {
          error += text;
        },
      },
    }),
  ).toBe(1);
  expect(output).toBe("");
  expect(error).toBe(
    "Commercial P0 impact report failed; verify arguments, schema and database access.\n",
  );
});
