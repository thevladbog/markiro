import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  platformCapabilitiesForRole,
  platformCatalogV3Contracts,
  type CatalogVersionCreateV3,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import { BillingService } from "../src/modules/billing/billing.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";
import { createTestTenantBillingNotifications } from "./support/tenant-billing-notifications";

describe.skipIf(!process.env.DATABASE_URL)("catalog sales without lifecycle policies", () => {
  const databaseName = `catalog_sales_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${databaseName}`;
  const connection = createDb(url.toString());
  const db = connection.db;
  const audit = new PlatformAuditService();
  const catalog = new PlatformCatalogService(db, audit);
  const notifications = createTestTenantBillingNotifications(db);
  const offers = new PlatformOffersService(db, audit, notifications);
  const buyerOffers = new TenantBillingOffersService(db);
  const billing = new BillingService(db, audit, notifications);
  const actor: PlatformPrincipal = {
    userId: randomUUID(),
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole.platform_admin,
    twoFactorReady: true,
  };
  const buyerId = randomUUID();
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Sales test",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
      twoFactorEnabled: true,
    });
    await db
      .insert(schema.user)
      .values({ id: buyerId, name: "Buyer", email: `${buyerId}@example.invalid` });
    await db.insert(schema.operatorBillingProfiles).values({
      revision: 1,
      kind: "self_employed",
      fullName: "Seller",
      displayName: "Seller",
      inn: "123456789012",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      taxPolicy: { kind: "without_vat", regime: "npd" },
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date(),
      createdByPlatformUserId: actor.userId,
    });
    await db.insert(schema.operatorBankAccounts).values({
      label: "Default",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Test bank",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actor.userId,
    });
  }, 120_000);
  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.pool.end();
  });

  it.each([
    { kind: "plan", period: "month", moduleAddon: false },
    { kind: "plan", period: "year", moduleAddon: false },
    { kind: "addon", period: "month", moduleAddon: false },
    { kind: "addon", period: "year", moduleAddon: true },
    { kind: "service", period: null, moduleAddon: false },
  ] as const)(
    "publishes $kind/$period, accepts its offer and issues both invoice paths",
    async ({ kind, period, moduleAddon }) => {
      const tenantId = await createOrganization(db);
      await db.insert(schema.tenantBillingProfiles).values({
        tenantId,
        revision: 1,
        kind: "self_employed",
        fullName: "Buyer",
        displayName: "Buyer",
        inn: "123456789012",
        addressRaw: "Moscow",
        legalAddressRaw: "Moscow",
        isConfirmed: true,
        confirmedByPlatformUserId: actor.userId,
        confirmedAt: new Date(),
        createdByPlatformUserId: actor.userId,
      });
      const code = `sales-${randomUUID()}`;
      const common = {
        nameRu: "Позиция",
        nameEn: "Item",
        documentNameRu: kind === "service" ? "Услуга внедрения" : "Право использования Markiro",
        documentNameEn: kind === "service" ? "Implementation service" : "Markiro license",
        unit: period ?? "project",
        unitPrice: "1200.00",
        vatRateBps: null,
        vatIncluded: false,
        lifecyclePolicyId: null,
      };
      const input: CatalogVersionCreateV3 =
        kind === "service"
          ? {
              ...common,
              subject: "service",
              billingMode: "one_time",
              billingPeriod: null,
              service: {},
            }
          : kind === "addon"
            ? {
                ...common,
                subject: "software_license",
                billingMode: "recurring",
                billingPeriod: period,
                addon: {
                  effects: moduleAddon
                    ? [{ key: "chzIntegration", featureEnabled: true }]
                    : [{ key: "stations", quotaIncrement: 1 }],
                },
              }
            : {
                ...common,
                subject: "software_license",
                billingMode: "recurring",
                billingPeriod: period,
                plan: {
                  maxLines: 1,
                  maxStations: 2,
                  maxKiosks: 0,
                  maxCabinetUsers: null,
                  labelEditorEnabled: true,
                  publicApiEnabled: false,
                  palletsEnabled: false,
                  chzIntegrationEnabled: false,
                  inventoryEnabled: true,
                  commerceMlEnabled: false,
                  handheldEnabled: true,
                  demoDurationDays: null,
                },
              };
      const draft = await catalog.createVersion(actor, code, input, 3);
      const review = platformCatalogV3Contracts.reviewVersion.response.parse(
        await catalog.review(actor, code, draft.id, 3),
      );
      expect(review.errors).toEqual([]);
      const identity = platformCatalogV3Contracts.publishVersion.body.parse(review.identity);
      expect(identity).toMatchObject({
        lifecyclePolicyId: null,
        lifecyclePolicyVersion: null,
        lifecyclePolicyHash: null,
      });
      const published = platformCatalogV3Contracts.publishVersion.response.parse(
        await catalog.publish(actor, code, draft.id, identity, 3),
      );
      expect(published).toMatchObject({
        status: "published",
        kind,
        lifecyclePolicyId: null,
        billingPeriod: period,
        unitPrice: "1200.00",
      });
      const publicationAudit = await db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.targetId, draft.id),
            eq(schema.platformAuditEvents.action, "catalog.version.published"),
          ),
        );
      expect(publicationAudit).toHaveLength(1);
      expect(publicationAudit[0]).toMatchObject({
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        tenantId: null,
        targetType: "catalog_version",
        targetId: draft.id,
        outcome: "success",
        before: { status: "draft" },
        after: { status: "published", catalogItemId: published.catalogItemId, version: 1 },
      });

      const line = {
        kind,
        catalogVersionId: draft.id,
        nameRu: common.nameRu,
        nameEn: common.nameEn,
        quantity: 1,
        unit: common.unit,
        agreedUnitPrice: "1200.00",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: kind === "service" ? null : ("immediately" as const),
      };
      const offer = await offers.create(actor, { tenantId, lines: [line] }, 3);
      expect((await offers.publish(actor, offer.id, undefined, 3)).status).toBe("published");
      await buyerOffers.accept(tenantId, buyerId, offer.id, randomUUID());
      const invoiceInput = {
        tenantId,
        applicationMode: "manual" as const,
        lines: [{ ...line, activationPolicy: kind === "service" ? null : ("immediate" as const) }],
      };
      const direct = await billing.create(actor, invoiceInput, 3);
      const fromOffer = await billing.create(
        actor,
        {
          ...invoiceInput,
          sourceOfferId: offer.id,
          idempotencyKey: randomUUID(),
          lines: invoiceInput.lines.map((entry) => ({
            ...entry,
            nameRu: common.documentNameRu,
            nameEn: common.documentNameEn,
          })),
        },
        3,
      );
      expect(fromOffer.sourceOfferId).toBe(offer.id);
      for (const invoice of [direct, fromOffer]) {
        expect((await billing.issue(actor, invoice.id)).status).toBe("issued");
        const lines = await db
          .select()
          .from(schema.invoiceLines)
          .where(eq(schema.invoiceLines.invoiceId, invoice.id));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          tenantId,
          catalogVersionId: draft.id,
          kind,
          agreedUnitPrice: "1200.00",
          lineTotal: "1200.00",
          commercialTerms: { documentNameRu: common.documentNameRu, billingPeriod: period },
        });
      }
      expect(await db.select().from(schema.entitlementLifecyclePolicies)).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.tenantSubscriptions)
          .where(eq(schema.tenantSubscriptions.tenantId, tenantId)),
      ).toEqual([]);
    },
  );
});
