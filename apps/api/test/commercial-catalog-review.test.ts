import { PlatformTenantsService } from "../src/modules/platform-tenants/platform-tenants.service";
import { TenantProvisioningService } from "../src/modules/platform-tenants/tenant-provisioning.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { MailDeliveryService } from "../src/modules/mail/mail-delivery.service";
import { MailCryptoService } from "../src/modules/mail/mail-crypto.service";
import { createOrganization, createPublishedPlan } from "./support/subscription-fixtures";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import {
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "../src/platform-auth/platform-access-policy";

const ready = Boolean(process.env.DATABASE_URL);
describe.skipIf(!ready)("commercial catalog publication review", () => {
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const databaseName = `markiro_review_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  const connection = createDb(scratchUrl.toString());
  const db = connection.db;
  const audit = new PlatformAuditService();
  const catalog = new PlatformCatalogService(db, audit);
  const profiles = new BillingProfilesService(db, audit);
  const actor: PlatformPrincipal = {
    userId: randomUUID(),
    role: "platform_admin",
    capabilities: platformCapabilitiesForRole("platform_admin"),
    twoFactorReady: true,
  };
  const seller = {
    kind: "self_employed" as const,
    fullName: "Продавец",
    displayName: "Продавец",
    inn: "123456789012",
    legalAddressRaw: "Москва",
    actualAddress: { sameAsLegal: true as const },
    postalAddress: { sameAsLegal: true as const },
    contact: { name: null, email: null, phone: null },
    taxPolicy: { kind: "without_vat" as const, regime: "npd" as const },
  };
  const plan = {
    nameRu: "Тариф",
    nameEn: "Plan",
    documentNameRu: "Право использования",
    documentNameEn: "License",
    subject: "software_license" as const,
    unit: "forged",
    billingMode: "recurring" as const,
    billingPeriod: "year" as const,
    unitPrice: "1200.00",
    vatRateBps: null,
    vatIncluded: false,
    plan: {
      maxLines: 0,
      maxStations: 1,
      maxKiosks: null,
      maxCabinetUsers: 1,
      labelEditorEnabled: false,
      publicApiEnabled: false,
      palletsEnabled: false,
      demoDurationDays: null,
    },
  };
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Review",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
    });
  });
  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.pool.end();
  });
  async function draft(overrides = {}) {
    const code = `review-${randomUUID()}`;
    const version = await catalog.createVersion(actor, code, { ...plan, ...overrides });
    return { code, version };
  }
  async function noPublication(id: string) {
    const [row] = await db
      .select()
      .from(schema.catalogItemVersions)
      .where(eq(schema.catalogItemVersions.id, id));
    expect(row?.status).toBe("draft");
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(
          and(
            eq(schema.platformAuditEvents.targetId, id),
            eq(schema.platformAuditEvents.action, "catalog.version.published"),
          ),
        ),
    ).toEqual([]);
  }
  it("rejects legacy assignment of zero quotas before subscription or audit mutation", async () => {
    const tenantId = await createOrganization(db);
    const catalogVersionId = await createPublishedPlan(db, {
      maxLines: 0,
      maxStations: 1,
      maxKiosks: null,
      maxCabinetUsers: 1,
    });
    const tenants = new PlatformTenantsService(
      db,
      new TenantProvisioningService(
        db,
        new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x6e))),
        audit,
        "https://cabinet.example.invalid",
      ),
      new SubscriptionLifecycleService(db, audit),
    );
    const input = {
      catalogVersionId,
      activationPolicy: "immediate" as const,
      reason: "Zero quota test",
    };
    await expect(tenants.assignPlan(actor, tenantId, input, true)).rejects.toMatchObject({
      response: { code: "client_update_required" },
    });
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, tenantId)),
    ).toEqual([]);
    await expect(tenants.assignPlan(actor, tenantId, input, false)).resolves.toMatchObject({
      tenantId,
      planVersionId: catalogVersionId,
      status: "active",
    });
  });

  it("refuses a legacy draft assignment even when publication commits after its pre-read", async () => {
    await profiles.setOperator(actor, seller);
    const tenantId = await createOrganization(db);
    const { code, version } = await draft();
    const tenants = new PlatformTenantsService(
      db,
      new TenantProvisioningService(
        db,
        new MailDeliveryService(new MailCryptoService(Buffer.alloc(32, 0x6e))),
        audit,
        "https://cabinet.example.invalid",
      ),
      new SubscriptionLifecycleService(db, audit),
    );
    const draftRead = deferredSignal();
    const resumeAssignment = deferredSignal();
    // Pause only this instance after its real DB read, retaining the captured draft row.
    // Production code and lifecycle writes remain unchanged and run against PostgreSQL.
    const readVersion = tenants["requireCatalogVersion"].bind(tenants);
    tenants["requireCatalogVersion"] = async (versionId) => {
      const captured = await readVersion(versionId);
      expect(captured.status).toBe("draft");
      draftRead.resolve();
      await resumeAssignment.promise;
      return captured;
    };
    const outcome = tenants
      .assignPlan(
        actor,
        tenantId,
        {
          catalogVersionId: version.id,
          activationPolicy: "immediate",
          reason: "Concurrent publication regression",
        },
        true,
      )
      .then(
        (value) => ({ kind: "success" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
    try {
      await draftRead.promise;
      const review = await catalog.review(actor, code, version.id);
      const published = await catalog.publish(actor, code, version.id, review.identity);
      expect(published.status).toBe("published");
      expect(published.plan?.maxLines).toBe(0);
    } finally {
      resumeAssignment.resolve();
    }
    expect(await outcome).toMatchObject({
      kind: "error",
      error: { response: { code: "published_catalog_version_required" } },
    });
    expect(
      await db
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.platformAuditEvents)
        .where(eq(schema.platformAuditEvents.tenantId, tenantId)),
    ).toEqual([]);
  });

  it("stores explicit seller-only policy and derives the license unit from its real period", async () => {
    const profile = await profiles.setOperator(actor, seller);
    expect(profile.taxPolicy).toEqual(seller.taxPolicy);
    const { version } = await draft();
    expect(version.unit).toBe("year");
    expect(version.documentNameRu).toBe(plan.documentNameRu);
    expect(version.plan?.maxLines).toBe(0);
  });
  it("refuses forged VAT and missing Russian document names without publication/audit", async () => {
    await profiles.setOperator(actor, seller);
    for (const overrides of [{ vatRateBps: 0 }, { documentNameRu: null }]) {
      const { code, version } = await draft(overrides);
      const review = await catalog.review(actor, code, version.id);
      expect(review.errors.length).toBeGreaterThan(0);
      await expect(catalog.publish(actor, code, version.id, review.identity)).rejects.toMatchObject(
        { response: { code: "commercial_review_invalid" } },
      );
      await noPublication(version.id);
    }
  });
  it("rejects a changed seller policy or draft after review, including rapid saves", async () => {
    await profiles.setOperator(actor, seller);
    const { code, version } = await draft();
    const first = await catalog.review(actor, code, version.id);
    await profiles.setOperator(actor, seller);
    await expect(catalog.publish(actor, code, version.id, first.identity)).rejects.toMatchObject({
      response: { code: "commercial_review_stale" },
    });
    await db
      .update(schema.catalogItemVersions)
      .set({ updatedAt: new Date("2099-01-01T00:00:00.000Z") })
      .where(eq(schema.catalogItemVersions.id, version.id));
    const second = await catalog.review(actor, code, version.id);
    await catalog.updateVersion(actor, code, version.id, { nameRu: "Изменён" });
    const third = await catalog.review(actor, code, version.id);
    expect(new Date(third.identity.draftUpdatedAt).getTime()).toBeGreaterThan(
      new Date(second.identity.draftUpdatedAt).getTime(),
    );
    await expect(catalog.publish(actor, code, version.id, second.identity)).rejects.toMatchObject({
      response: { code: "commercial_review_stale" },
    });
    await noPublication(version.id);
    const published = await catalog.publish(actor, code, version.id, third.identity);
    expect(published.status).toBe("published");
    expect(published.sellerPolicyRevision).toBe(third.identity.sellerPolicyRevision);
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, version.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      tenantId: null,
      action: "catalog.version.published",
      targetType: "catalog_version",
      outcome: "success",
      before: { status: "draft" },
      after: {
        status: "published",
        catalogItemId: version.catalogItemId,
        version: version.version,
      },
    });
    await expect(
      catalog.updateVersion(actor, code, version.id, { unitPrice: "1.00" }),
    ).rejects.toMatchObject({ response: { code: "catalog_version_immutable" } });
  });
  it("requires explicit seller configuration and reviewed publication", async () => {
    await profiles.setOperator(actor, { ...seller, taxPolicy: null });
    const { code, version } = await draft();
    const review = await catalog.review(actor, code, version.id);
    expect(review.errors).toContainEqual({
      code: "seller_tax_policy_unconfigured",
      path: "sellerPolicyRevision",
    });
    await expect(catalog.publish(actor, code, version.id)).rejects.toMatchObject({
      response: { code: "client_update_required" },
    });
    await noPublication(version.id);
  });
});

function deferredSignal() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (release === undefined) throw new Error("Signal was not initialized");
      release();
    },
  };
}
