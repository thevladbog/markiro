import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  platformCatalogV3Contracts,
  platformCapabilitiesForRole,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { BillingService } from "../src/modules/billing/billing.service";
import { PlatformBillingRequestsService } from "../src/modules/platform-billing-requests/platform-billing-requests.service";
import { SubscriptionLifecycleService } from "../src/subscriptions/subscription-lifecycle.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";
import { createManagedSubscription, createPublishedAddon } from "./support/subscription-fixtures";
import { createTestTenantBillingNotifications } from "./support/tenant-billing-notifications";
import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";

const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
const db = connection.db;
const audit = new PlatformAuditService();
const catalog = new PlatformCatalogService(db, audit);
const notifications = createTestTenantBillingNotifications(db);
const offers = new PlatformOffersService(db, audit, notifications);
const billing = new BillingService(db, audit, notifications);
const requests = new PlatformBillingRequestsService(db, audit, notifications);
const lifecycle = new SubscriptionLifecycleService(db, audit);
const principal: PlatformPrincipal = {
  userId: randomUUID(),
  role: "platform_admin",
  capabilities: platformCapabilitiesForRole.platform_admin,
  twoFactorReady: true,
};
afterAll(() => connection.pool.end());
describe.skipIf(!process.env.DATABASE_URL)("Commercial V3 transaction boundaries", () => {
  beforeAll(async () => {
    await db.insert(schema.platformUsers).values({
      id: principal.userId,
      name: "P1 tester",
      email: `${principal.userId}@example.invalid`,
      role: "platform_admin",
      status: "active",
    });
  });
  async function policy(approved = true, valid = true) {
    const payload = { testOnly: true, noProductionApproval: true };
    const [row] = await db
      .insert(schema.entitlementLifecyclePolicies)
      .values({
        policyKey: `test-${randomUUID()}`,
        version: 1,
        payload,
        payloadHash: valid ? entitlementDigest(payload) : "0".repeat(64),
        status: approved ? "approved" : "draft",
        createdByPlatformUserId: principal.userId,
        ...(approved
          ? {
              approvedAt: new Date(),
              approvedByPlatformUserId: principal.userId,
              decisionReference: "TEST-FIXTURE-ONLY",
            }
          : {}),
      })
      .returning();
    if (!row) throw new Error("Missing policy");
    return row;
  }
  it("binds V3 publication to exact policy identity/version/hash and refuses unapproved or corrupt policies", async () => {
    await new BillingProfilesService(db, audit).setOperator(principal, {
      kind: "self_employed",
      fullName: "Test",
      displayName: "Test",
      inn: "123456789012",
      legalAddressRaw: "Москва",
      actualAddress: { sameAsLegal: true },
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
      taxPolicy: { kind: "without_vat", regime: "npd" },
    });
    for (const [approved, valid] of [
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const p = await policy(approved, valid);
      const code = `v3-${randomUUID()}`;
      const version = await catalog.createVersion(
        principal,
        code,
        {
          nameRu: "Тариф",
          nameEn: "Plan",
          documentNameRu: "Право",
          documentNameEn: "License",
          subject: "software_license",
          unit: "month",
          billingMode: "recurring",
          billingPeriod: "month",
          unitPrice: "1000.00",
          vatRateBps: null,
          vatIncluded: false,
          lifecyclePolicyId: p.id,
          plan: {
            maxLines: 1,
            maxStations: 1,
            maxKiosks: 1,
            maxCabinetUsers: 1,
            labelEditorEnabled: true,
            publicApiEnabled: false,
            palletsEnabled: false,
            demoDurationDays: null,
            chzIntegrationEnabled: true,
            inventoryEnabled: false,
            commerceMlEnabled: false,
            handheldEnabled: false,
          },
        },
        3,
      );
      const review = platformCatalogV3Contracts.reviewVersion.response.parse(
        await catalog.review(principal, code, version.id, 3),
      );
      expect(review.identity).toMatchObject({
        lifecyclePolicyId: p.id,
        lifecyclePolicyVersion: p.version,
        lifecyclePolicyHash: p.payloadHash,
      });
      const identity = platformCatalogV3Contracts.publishVersion.body.parse(review.identity);
      await expect(
        catalog.publish(
          principal,
          code,
          version.id,
          { ...identity, lifecyclePolicyHash: "f".repeat(64) },
          3,
        ),
      ).rejects.toMatchObject({ response: { code: "commercial_review_stale" } });
      await expect(catalog.publish(principal, code, version.id, identity, 2)).rejects.toMatchObject(
        { response: { code: "client_update_required" } },
      );
      if (!approved || !valid) {
        expect(review.errors).toContainEqual({
          code: "lifecycle_policy_not_approved",
          path: "lifecyclePolicyId",
        });
        await expect(
          catalog.publish(principal, code, version.id, identity, 3),
        ).rejects.toMatchObject({ response: { code: "commercial_review_invalid" } });
        expect((await catalog.getVersion(principal, code, version.id)).status).toBe("draft");
        if (!approved) {
          const changed = { testOnly: true, revision: 2 };
          await db
            .update(schema.entitlementLifecyclePolicies)
            .set({ payload: changed, payloadHash: entitlementDigest(changed) })
            .where(eq(schema.entitlementLifecyclePolicies.id, p.id));
          await expect(
            catalog.publish(principal, code, version.id, identity, 3),
          ).rejects.toMatchObject({ response: { code: "commercial_review_stale" } });
        }
        expect(
          await db
            .select()
            .from(schema.platformAuditEvents)
            .where(eq(schema.platformAuditEvents.targetId, version.id)),
        ).toEqual([]);
      } else {
        expect(review.errors).toEqual([]);
        expect((await catalog.publish(principal, code, version.id, identity, 3)).status).toBe(
          "published",
        );
        expect((await catalog.editorContext(principal, 3)).lifecyclePolicies).toContainEqual({
          id: p.id,
          policyKey: p.policyKey,
          version: p.version,
        });
        expect(await catalog.editorContext(principal, 2)).not.toHaveProperty("lifecyclePolicies");
      }
    }
  });
  it.each([1, 2] as const)(
    "retains saved P1 offer continuation and exact revise replay for client %i",
    async (clientVersion) => {
      const { tenantId } = await createManagedSubscription(db);
      const catalogVersionId = await createPublishedAddon(db, [{ entitlementKey: "inventory" }]);
      const userId = randomUUID();
      await db
        .insert(schema.user)
        .values({ id: userId, name: "Buyer", email: `${userId}@example.invalid` });
      const line = {
        kind: "addon" as const,
        catalogVersionId,
        nameRu: "Учёт",
        nameEn: "Inventory",
        quantity: 1,
        unit: "month",
        agreedUnitPrice: "100.00",
        vatRateBps: null,
        vatIncluded: false,
      };
      async function savedOffer(decision: "accepted" | "changes_requested") {
        const offer = await offers.create(principal, { tenantId, lines: [line] }, 3);
        await db
          .update(schema.commercialOfferLines)
          .set({
            commercialTerms: {
              version: 1,
              subject: "software_license",
              documentNameRu: line.nameRu,
              documentNameEn: line.nameEn,
              sellerPolicyRevision: 1,
              billingPeriod: "month",
              billingTimezone: "Europe/Moscow",
              activationRule: "on_application",
            },
          })
          .where(eq(schema.commercialOfferLines.offerId, offer.id));
        await db
          .update(schema.commercialOffers)
          .set({
            status: "published",
            number: `KP-${randomUUID()}`,
            publishedAt: new Date(),
            publishedByPlatformUserId: principal.userId,
          })
          .where(eq(schema.commercialOffers.id, offer.id));
        await db.insert(schema.commercialOfferDecisions).values({
          tenantId,
          offerId: offer.id,
          decision,
          message: decision === "changes_requested" ? "Fixture revision" : null,
          actorUserId: userId,
          idempotencyKey: randomUUID(),
        });
        return offer.id;
      }
      const reviseId = await savedOffer("changes_requested");
      const reviseInput = { idempotencyKey: randomUUID() };
      await expect(
        offers.revise(principal, reviseId, reviseInput, clientVersion),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      const revision = await offers.revise(principal, reviseId, reviseInput, 3);
      expect(await offers.revise(principal, reviseId, reviseInput, clientVersion)).toEqual(
        revision,
      );
      const sourceOfferId = await savedOffer("accepted");
      const before = await db
        .select()
        .from(schema.commercialOfferLines)
        .where(eq(schema.commercialOfferLines.offerId, sourceOfferId));
      const request = {
        tenantId,
        sourceOfferId,
        idempotencyKey: randomUUID(),
        applicationMode: "manual" as const,
        lines: [line],
      };
      const invoice = await billing.create(principal, request, clientVersion);
      expect(invoice.sourceOfferId).toBe(sourceOfferId);
      expect(await billing.create(principal, request, clientVersion)).toMatchObject({
        id: invoice.id,
      });
      expect(
        await db
          .select()
          .from(schema.commercialOfferLines)
          .where(eq(schema.commercialOfferLines.offerId, sourceOfferId)),
      ).toEqual(before);
      await expect(
        billing.create(
          principal,
          { ...request, idempotencyKey: randomUUID(), lines: [{ ...line, quantity: 2 }] },
          clientVersion,
        ),
      ).rejects.toThrow();
    },
  );

  it.each([1, 2] as const)(
    "refuses version %i ID-only P1 selections before persistent side effects",
    async (clientVersion) => {
      const { tenantId, subscriptionId } = await createManagedSubscription(db);
      const catalogVersionId = await createPublishedAddon(db, [
        { entitlementKey: "chzIntegration" },
      ]);
      const line = {
        kind: "addon" as const,
        catalogVersionId,
        nameRu: "ЧЗ",
        nameEn: "CHZ",
        quantity: 1,
        unit: "month",
        agreedUnitPrice: "100.00",
        vatRateBps: 2000,
        vatIncluded: true,
      };
      await expect(
        lifecycle.assignAddon(
          principal,
          tenantId,
          {
            catalogVersionId,
            expectedSubscriptionId: subscriptionId,
            activationPolicy: "immediate",
            quantity: 1,
            reason: "Test",
          },
          clientVersion,
        ),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      await expect(
        offers.create(principal, { tenantId, lines: [line] }, clientVersion),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      const invoiceInput = { tenantId, applicationMode: "manual" as const, lines: [line] };
      await expect(billing.create(principal, invoiceInput, clientVersion)).rejects.toMatchObject({
        response: { code: "client_update_required" },
      });
      const userId = randomUUID();
      await db
        .insert(schema.user)
        .values({ id: userId, name: "Buyer", email: `${userId}@example.invalid` });
      const [request] = await db
        .insert(schema.tenantBillingRequests)
        .values({
          tenantId,
          number: randomUUID(),
          type: "other",
          description: "Test",
          idempotencyKey: randomUUID(),
          createdByUserId: userId,
        })
        .returning();
      if (!request) throw new Error("Missing request");
      await expect(
        requests.createOffer(
          principal,
          request.id,
          { lines: [line], idempotencyKey: randomUUID() },
          clientVersion,
        ),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      await expect(
        billing.create(
          principal,
          { ...invoiceInput, sourceRequestId: request.id, idempotencyKey: randomUUID() },
          clientVersion,
        ),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      expect(
        await db
          .select()
          .from(schema.subscriptionAddons)
          .where(eq(schema.subscriptionAddons.subscriptionId, subscriptionId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.commercialOffers)
          .where(eq(schema.commercialOffers.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await db.select().from(schema.invoices).where(eq(schema.invoices.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.platformAuditEvents)
          .where(eq(schema.platformAuditEvents.tenantId, tenantId)),
      ).toEqual([]);
      const assigned = await lifecycle.assignAddon(
        principal,
        tenantId,
        {
          catalogVersionId,
          expectedSubscriptionId: subscriptionId,
          activationPolicy: "immediate",
          quantity: 1,
          reason: "Test V3",
        },
        3,
      );
      expect(assigned.addonVersionId).toBe(catalogVersionId);
      const created = await offers.create(principal, { tenantId, lines: [line] }, 3);
      await expect(
        offers.publish(principal, created.id, undefined, clientVersion),
      ).rejects.toMatchObject({ response: { code: "client_update_required" } });
      expect((await offers.detail(principal, created.id)).status).toBe("draft");
      expect((await billing.create(principal, invoiceInput, 3)).id).toEqual(expect.any(String));
    },
  );
});
