import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadEnv } from "../src/env";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { tenantOfferDetailSchema } from "../src/modules/tenant-billing/dto";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import {
  createOrganization,
  createPublishedAddon,
  createPublishedPlan,
} from "./support/subscription-fixtures";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

const fixedNow = new Date("2026-08-27T12:00:00.000Z");
const tiedTimestamp = new Date("2026-08-20T12:00:00.000Z");
const olderDocumentTimestamp = new Date("2026-08-19T12:00:00.000Z");

type ExpectedDocument = {
  id: string;
  type: "offer" | "act";
  createdAt: string;
};

class FixedClockTenantBillingReadService extends TenantBillingReadService {
  constructor(
    db: Db,
    storage: ObjectStorageService,
    entitlements: EntitlementsService,
    private readonly fixedClock: Date,
  ) {
    super(db, storage, entitlements);
  }

  protected now(): Date {
    return new Date(this.fixedClock);
  }
}

function documentKey(document: ExpectedDocument): string {
  return `${document.createdAt}|${document.id}|${document.type}`;
}

function compareDocuments(left: ExpectedDocument, right: ExpectedDocument): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.id.localeCompare(left.id) ||
    left.type.localeCompare(right.type)
  );
}

function daysFromNow(days: number): Date {
  const value = new Date(fixedNow);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("tenant billing read service isolated Postgres integration", () => {
  const databaseName = `markiro_tenant_billing_read_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  const signingBoundary = vi.fn(async () => "https://private.example.test/read");
  const storage = new ObjectStorageService(
    loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgres://user:pass@localhost/db",
      BETTER_AUTH_SECRET: "insecure-test-placeholder",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "insecure-test-pairing-pepper",
    } as NodeJS.ProcessEnv),
    { send: vi.fn() } as never,
    signingBoundary,
  );

  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let tenantA: string;
  let tenantB: string;
  let attentionTenant: string;
  let actorId: string;
  let cabinetUserId: string;
  let service: TenantBillingReadService;

  const overdueInvoiceIds: string[] = [];
  const expectedDocuments: ExpectedDocument[] = [];
  let sharedDocumentId: string;
  let foreignInvoiceId: string;
  let foreignInvoiceDocumentId: string;
  let foreignOfferId: string;
  let foreignOfferDocumentId: string;
  let foreignActId: string;
  let foreignActDocumentId: string;
  let poisonedInvoiceId: string;
  let poisonedInvoiceDocumentId: string;
  let poisonedOfferId: string;
  let poisonedOfferDocumentId: string;
  let poisonedActId: string;
  let poisonedActDocumentId: string;

  let clarificationRequestId: string;
  let actionableAttentionOfferId: string;
  const attentionBoundaryInvoiceIds: Record<"yesterday" | "today" | "plus7" | "plus8", string> = {
    yesterday: "",
    today: "",
    plus7: "",
    plus8: "",
  };

  const subscriptionCases: Record<
    "expired" | "current" | "future" | "effectiveReplacement",
    { tenantId: string; subscriptionId: string; planVersionId: string }
  > = {
    expired: { tenantId: "", subscriptionId: "", planVersionId: "" },
    current: { tenantId: "", subscriptionId: "", planVersionId: "" },
    future: { tenantId: "", subscriptionId: "", planVersionId: "" },
    effectiveReplacement: { tenantId: "", subscriptionId: "", planVersionId: "" },
  };
  let addonTenantId: string;
  let addonSubscriptionId: string;
  const addonIds: Record<"beforeStart" | "atStart" | "beforeEnd" | "atEnd" | "afterEnd", string> = {
    beforeStart: "",
    atStart: "",
    beforeEnd: "",
    atEnd: "",
    afterEnd: "",
  };

  const offerCases: Record<
    "laterDraft" | "laterPublished" | "accepted" | "changesRequested" | "expired",
    { tenantId: string; expectedOfferId: string | null }
  > = {
    laterDraft: { tenantId: "", expectedOfferId: null },
    laterPublished: { tenantId: "", expectedOfferId: null },
    accepted: { tenantId: "", expectedOfferId: null },
    changesRequested: { tenantId: "", expectedOfferId: null },
    expired: { tenantId: "", expectedOfferId: null },
  };
  const offerDetailCases: Record<
    | "currentUndecided"
    | "accepted"
    | "changesRequested"
    | "expired"
    | "supersededPrior"
    | "currentFamily",
    { tenantId: string; offerId: string }
  > = {
    currentUndecided: { tenantId: "", offerId: "" },
    accepted: { tenantId: "", offerId: "" },
    changesRequested: { tenantId: "", offerId: "" },
    expired: { tenantId: "", offerId: "" },
    supersededPrior: { tenantId: "", offerId: "" },
    currentFamily: { tenantId: "", offerId: "" },
  };

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString());
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    actorId = `billing-read-${randomUUID()}`;
    cabinetUserId = `billing-reader-${randomUUID()}`;
    await db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Billing read test",
      email: `${actorId}@example.invalid`,
      role: "platform_admin",
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.user).values({
      id: cabinetUserId,
      name: "Billing reader",
      email: `${cabinetUserId}@example.invalid`,
      emailVerified: true,
      createdAt: fixedNow,
      updatedAt: fixedNow,
    });

    tenantA = await createOrganization(db);
    tenantB = await createOrganization(db);
    attentionTenant = await createOrganization(db);

    const overdueInvoices = Array.from({ length: 105 }, (_, index) => {
      const id = randomUUID();
      overdueInvoiceIds.push(id);
      return {
        id,
        tenantId: tenantA,
        number: `READ-A-${index}-${id}`,
        status: "issued" as const,
        issueDate: tiedTimestamp,
        dueDate: new Date("2026-08-01T00:00:00.000Z"),
        sellerSnapshot: { name: "Markiro" },
        buyerSnapshot: { name: "A" },
        subtotal: "1.00",
        vatTotal: "0.00",
        total: "1.00",
        createdByPlatformUserId: actorId,
        issuedByPlatformUserId: actorId,
        issuedAt: tiedTimestamp,
        createdAt: tiedTimestamp,
        updatedAt: tiedTimestamp,
      };
    });
    foreignInvoiceId = randomUUID();
    poisonedInvoiceId = randomUUID();
    await db.insert(schema.invoices).values([
      ...overdueInvoices,
      {
        id: foreignInvoiceId,
        tenantId: tenantB,
        number: `READ-B-FOREIGN-${foreignInvoiceId}`,
        status: "draft",
        subtotal: "1.00",
        vatTotal: "0.00",
        total: "1.00",
        createdByPlatformUserId: actorId,
        createdAt: tiedTimestamp,
        updatedAt: tiedTimestamp,
      },
      {
        id: poisonedInvoiceId,
        tenantId: tenantA,
        number: `READ-A-POISON-${poisonedInvoiceId}`,
        status: "draft",
        subtotal: "1.00",
        vatTotal: "0.00",
        total: "1.00",
        createdByPlatformUserId: actorId,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
    ]);
    foreignInvoiceDocumentId = randomUUID();
    poisonedInvoiceDocumentId = randomUUID();
    await db.insert(schema.invoiceDocuments).values([
      {
        id: foreignInvoiceDocumentId,
        tenantId: tenantB,
        invoiceId: foreignInvoiceId,
        revision: 1,
        format: "pdf",
        status: "ready",
        objectKey: `tenants/${tenantB}/invoices/${foreignInvoiceId}/r1.pdf`,
        contentType: "application/pdf",
        sha256: "f".repeat(64),
        byteSize: 1,
        rendererVersion: "test",
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
      {
        id: poisonedInvoiceDocumentId,
        tenantId: tenantA,
        invoiceId: poisonedInvoiceId,
        revision: 1,
        format: "pdf",
        status: "ready",
        objectKey: `tenants/${tenantB}/invoices/${poisonedInvoiceId}/r1.pdf`,
        contentType: "application/pdf",
        sha256: "e".repeat(64),
        byteSize: 1,
        rendererVersion: "test",
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
    ]);

    sharedDocumentId = randomUUID();
    const offerDocuments = Array.from({ length: 105 }, (_, index) => ({
      offerId: randomUUID(),
      documentId: index === 0 ? sharedDocumentId : randomUUID(),
      index,
    }));
    await db.insert(schema.commercialOffers).values(
      offerDocuments.map(({ offerId, index }) => ({
        id: offerId,
        tenantId: tenantA,
        familyId: randomUUID(),
        revision: 1,
        status: "published" as const,
        number: `READ-O-${index}-${offerId}`,
        total: "1.00",
        publishedAt: tiedTimestamp,
        createdByPlatformUserId: actorId,
        createdAt: tiedTimestamp,
        updatedAt: tiedTimestamp,
      })),
    );
    await db.insert(schema.commercialOfferDocuments).values(
      offerDocuments.map(({ offerId, documentId }) => {
        expectedDocuments.push({
          id: documentId,
          type: "offer",
          createdAt: tiedTimestamp.toISOString(),
        });
        return {
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
          createdAt: tiedTimestamp,
          updatedAt: tiedTimestamp,
        };
      }),
    );

    const acts = Array.from({ length: 105 }, (_, index) => ({
      actId: randomUUID(),
      documentId: index === 0 ? sharedDocumentId : randomUUID(),
      index,
    }));
    await db.insert(schema.billingActs).values(
      acts.map(({ actId, index }) => ({
        id: actId,
        tenantId: tenantA,
        number: `READ-ACT-${index}-${actId}`,
        status: "draft" as const,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actorId,
        createdAt: tiedTimestamp,
        updatedAt: tiedTimestamp,
      })),
    );
    await db.insert(schema.billingActDocuments).values(
      acts.map(({ actId, documentId }) => {
        expectedDocuments.push({
          id: documentId,
          type: "act",
          createdAt: tiedTimestamp.toISOString(),
        });
        return {
          id: documentId,
          tenantId: tenantA,
          actId,
          revision: 1,
          objectKey: `tenant-billing/${tenantA}/acts/${actId}/${documentId}.pdf`,
          contentType: "application/pdf",
          sha256: "b".repeat(64),
          byteSize: 1,
          state: "ready" as const,
          uploadedByPlatformUserId: actorId,
          readyAt: tiedTimestamp,
          createdAt: tiedTimestamp,
          updatedAt: tiedTimestamp,
        };
      }),
    );

    foreignOfferId = randomUUID();
    foreignOfferDocumentId = randomUUID();
    poisonedOfferId = randomUUID();
    poisonedOfferDocumentId = randomUUID();
    await db.insert(schema.commercialOffers).values([
      {
        id: foreignOfferId,
        tenantId: tenantB,
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `READ-B-OFFER-${foreignOfferId}`,
        total: "1.00",
        publishedAt: olderDocumentTimestamp,
        createdByPlatformUserId: actorId,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
      {
        id: poisonedOfferId,
        tenantId: tenantA,
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `READ-A-POISON-OFFER-${poisonedOfferId}`,
        total: "1.00",
        publishedAt: olderDocumentTimestamp,
        createdByPlatformUserId: actorId,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
    ]);
    await db.insert(schema.commercialOfferDocuments).values([
      {
        id: foreignOfferDocumentId,
        tenantId: tenantB,
        offerId: foreignOfferId,
        revision: 1,
        format: "pdf",
        status: "ready",
        objectKey: `tenants/${tenantB}/offers/${foreignOfferId}/r1.pdf`,
        contentType: "application/pdf",
        sha256: "c".repeat(64),
        byteSize: 1,
        rendererVersion: "test",
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
      {
        id: poisonedOfferDocumentId,
        tenantId: tenantA,
        offerId: poisonedOfferId,
        revision: 1,
        format: "pdf",
        status: "ready",
        objectKey: `tenants/${tenantB}/offers/${poisonedOfferId}/r1.pdf`,
        contentType: "application/pdf",
        sha256: "d".repeat(64),
        byteSize: 1,
        rendererVersion: "test",
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
    ]);
    expectedDocuments.push({
      id: poisonedOfferDocumentId,
      type: "offer",
      createdAt: olderDocumentTimestamp.toISOString(),
    });

    foreignActId = randomUUID();
    foreignActDocumentId = randomUUID();
    poisonedActId = randomUUID();
    poisonedActDocumentId = randomUUID();
    await db.insert(schema.billingActs).values([
      {
        id: foreignActId,
        tenantId: tenantB,
        number: `READ-B-ACT-${foreignActId}`,
        status: "draft",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actorId,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
      {
        id: poisonedActId,
        tenantId: tenantA,
        number: `READ-A-POISON-ACT-${poisonedActId}`,
        status: "draft",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actorId,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
    ]);
    await db.insert(schema.billingActDocuments).values([
      {
        id: foreignActDocumentId,
        tenantId: tenantB,
        actId: foreignActId,
        revision: 1,
        objectKey: `tenant-billing/${tenantB}/acts/${foreignActId}/${foreignActDocumentId}.pdf`,
        contentType: "application/pdf",
        sha256: "1".repeat(64),
        byteSize: 1,
        state: "ready",
        uploadedByPlatformUserId: actorId,
        readyAt: olderDocumentTimestamp,
        createdAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
      },
      {
        id: poisonedActDocumentId,
        tenantId: tenantA,
        actId: poisonedActId,
        revision: 1,
        objectKey: `tenant-billing/${tenantA}/acts/${poisonedActId}/${randomUUID()}.pdf`,
        contentType: "application/pdf",
        sha256: "2".repeat(64),
        byteSize: 1,
        state: "ready",
        uploadedByPlatformUserId: actorId,
        readyAt: olderDocumentTimestamp,
        updatedAt: olderDocumentTimestamp,
        createdAt: olderDocumentTimestamp,
      },
    ]);
    expectedDocuments.push({
      id: poisonedActDocumentId,
      type: "act",
      createdAt: olderDocumentTimestamp.toISOString(),
    });
    expectedDocuments.sort(compareDocuments);

    const completedRequests = Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      tenantId: attentionTenant,
      number: `READ-COMPLETED-${index}-${randomUUID()}`,
      type: "other" as const,
      status: "completed" as const,
      description: "Completed billing request",
      responsibleSide: "none" as const,
      idempotencyKey: randomUUID(),
      createdByUserId: cabinetUserId,
      createdAt: new Date(fixedNow.getTime() - index * 60_000),
      updatedAt: new Date(fixedNow.getTime() - index * 60_000),
    }));
    clarificationRequestId = randomUUID();
    await db.insert(schema.tenantBillingRequests).values([
      ...completedRequests,
      {
        id: clarificationRequestId,
        tenantId: attentionTenant,
        number: `READ-CLARIFICATION-${clarificationRequestId}`,
        type: "capacity_change",
        status: "clarification_required",
        description: "Clarification needed",
        responsibleSide: "tenant",
        idempotencyKey: randomUUID(),
        createdByUserId: cabinetUserId,
        createdAt: daysFromNow(-10),
        updatedAt: daysFromNow(-10),
      },
    ]);
    await db.insert(schema.tenantBillingRequestEvents).values([
      {
        tenantId: attentionTenant,
        requestId: clarificationRequestId,
        kind: "created",
        actorKind: "system",
        idempotencyKey: randomUUID(),
        createdAt: daysFromNow(-10),
      },
      {
        tenantId: attentionTenant,
        requestId: clarificationRequestId,
        kind: "platform_comment",
        actorKind: "system",
        message: "Second related event must not duplicate attention",
        idempotencyKey: randomUUID(),
        createdAt: daysFromNow(-9),
      },
    ]);

    actionableAttentionOfferId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: actionableAttentionOfferId,
      tenantId: attentionTenant,
      familyId: randomUUID(),
      revision: 1,
      status: "published",
      number: `READ-ATTENTION-OFFER-${actionableAttentionOfferId}`,
      total: "10.00",
      expiresAt: daysFromNow(1),
      publishedAt: daysFromNow(-1),
      createdByPlatformUserId: actorId,
      createdAt: daysFromNow(-1),
      updatedAt: daysFromNow(-1),
    });

    const recentPaidInvoices = Array.from({ length: 25 }, (_, index) => ({
      id: randomUUID(),
      tenantId: attentionTenant,
      number: `READ-RECENT-PAID-${index}-${randomUUID()}`,
      status: "paid" as const,
      issueDate: daysFromNow(-2),
      dueDate: daysFromNow(-1),
      sellerSnapshot: { name: "Markiro" },
      buyerSnapshot: { name: "Attention" },
      subtotal: "1.00",
      vatTotal: "0.00",
      total: "1.00",
      createdByPlatformUserId: actorId,
      issuedByPlatformUserId: actorId,
      issuedAt: daysFromNow(-2),
      paidAt: daysFromNow(-1),
      createdAt: new Date(fixedNow.getTime() - index * 1_000),
      updatedAt: new Date(fixedNow.getTime() - index * 1_000),
    }));
    const boundaryInvoices = (
      [
        ["yesterday", -1],
        ["today", 0],
        ["plus7", 7],
        ["plus8", 8],
      ] as const
    ).map(([label, days]) => {
      const id = randomUUID();
      attentionBoundaryInvoiceIds[label] = id;
      return {
        id,
        tenantId: attentionTenant,
        number: `READ-BOUNDARY-${label}-${id}`,
        status: "issued" as const,
        issueDate: daysFromNow(-20),
        dueDate: daysFromNow(days),
        sellerSnapshot: { name: "Markiro" },
        buyerSnapshot: { name: "Attention" },
        subtotal: "1.00",
        vatTotal: "0.00",
        total: "1.00",
        createdByPlatformUserId: actorId,
        issuedByPlatformUserId: actorId,
        issuedAt: daysFromNow(-20),
        createdAt: daysFromNow(-20),
        updatedAt: daysFromNow(-20),
      };
    });
    await db.insert(schema.invoices).values([...recentPaidInvoices, ...boundaryInvoices]);
    await db.insert(schema.tenantBillingRequestLinks).values([
      {
        tenantId: attentionTenant,
        requestId: clarificationRequestId,
        offerId: actionableAttentionOfferId,
      },
      {
        tenantId: attentionTenant,
        requestId: clarificationRequestId,
        invoiceId: attentionBoundaryInvoiceIds.today,
      },
      {
        tenantId: attentionTenant,
        requestId: clarificationRequestId,
        invoiceId: recentPaidInvoices[0]!.id,
      },
    ]);

    const sharedPlanVersionId = await createPublishedPlan(db, {
      maxLines: 10,
      maxStations: 2,
      maxKiosks: 3,
      maxCabinetUsers: 4,
      labelEditorEnabled: true,
    });
    for (const [name, status, startsAt, endsAt] of [
      ["expired", "active", daysFromNow(-30), new Date(fixedNow.getTime() - 1)],
      ["current", "active", daysFromNow(-5), daysFromNow(5)],
      ["future", "scheduled", daysFromNow(1), daysFromNow(31)],
      ["effectiveReplacement", "scheduled", fixedNow, daysFromNow(30)],
    ] as const) {
      const tenantId = await createOrganization(db);
      const subscriptionId = randomUUID();
      await db.insert(schema.tenantSubscriptions).values({
        id: subscriptionId,
        tenantId,
        planVersionId: sharedPlanVersionId,
        status,
        startsAt,
        endsAt,
        source: "manual",
        createdAt: daysFromNow(-40),
        updatedAt: daysFromNow(-40),
      });
      subscriptionCases[name] = { tenantId, subscriptionId, planVersionId: sharedPlanVersionId };
    }

    addonTenantId = await createOrganization(db);
    addonSubscriptionId = randomUUID();
    await db.insert(schema.tenantSubscriptions).values({
      id: addonSubscriptionId,
      tenantId: addonTenantId,
      planVersionId: sharedPlanVersionId,
      status: "active",
      startsAt: daysFromNow(-30),
      endsAt: daysFromNow(30),
      source: "manual",
    });
    const addonVersionId = await createPublishedAddon(db, [
      { entitlementKey: "lines", increment: 1 },
    ]);
    for (const [name, status, startsAt, endsAt] of [
      ["beforeStart", "scheduled", new Date(fixedNow.getTime() + 1), daysFromNow(10)],
      ["atStart", "scheduled", fixedNow, daysFromNow(10)],
      ["beforeEnd", "active", daysFromNow(-10), new Date(fixedNow.getTime() + 1)],
      ["atEnd", "active", daysFromNow(-10), fixedNow],
      ["afterEnd", "active", daysFromNow(-10), new Date(fixedNow.getTime() - 1)],
    ] as const) {
      const id = randomUUID();
      addonIds[name] = id;
      await db.insert(schema.subscriptionAddons).values({
        id,
        tenantId: addonTenantId,
        subscriptionId: addonSubscriptionId,
        addonVersionId,
        quantity: 1,
        startsAt,
        endsAt,
        status,
        source: "manual",
      });
    }

    const offerTenantIds = {
      laterDraft: await createOrganization(db),
      laterPublished: await createOrganization(db),
      accepted: await createOrganization(db),
      changesRequested: await createOrganization(db),
      expired: await createOrganization(db),
    };
    const laterDraftFamilyId = randomUUID();
    const laterDraftPublishedId = randomUUID();
    const laterDraftId = randomUUID();
    await db.insert(schema.commercialOffers).values([
      {
        id: laterDraftPublishedId,
        tenantId: offerTenantIds.laterDraft,
        familyId: laterDraftFamilyId,
        revision: 1,
        status: "published",
        number: `READ-LATER-DRAFT-PUBLISHED-${laterDraftPublishedId}`,
        total: "1.00",
        publishedAt: daysFromNow(-2),
        createdByPlatformUserId: actorId,
        createdAt: daysFromNow(-2),
        updatedAt: daysFromNow(-2),
      },
      {
        id: laterDraftId,
        tenantId: offerTenantIds.laterDraft,
        familyId: laterDraftFamilyId,
        revision: 2,
        previousRevisionId: laterDraftPublishedId,
        status: "draft",
        number: `READ-LATER-DRAFT-${laterDraftId}`,
        total: "2.00",
        createdByPlatformUserId: actorId,
        createdAt: daysFromNow(-1),
        updatedAt: daysFromNow(-1),
      },
    ]);
    offerCases.laterDraft = {
      tenantId: offerTenantIds.laterDraft,
      expectedOfferId: laterDraftPublishedId,
    };
    offerDetailCases.currentUndecided = {
      tenantId: offerTenantIds.laterDraft,
      offerId: laterDraftPublishedId,
    };

    const laterPublishedFamilyId = randomUUID();
    const earlierPublishedId = randomUUID();
    const laterPublishedId = randomUUID();
    await db.insert(schema.commercialOffers).values([
      {
        id: earlierPublishedId,
        tenantId: offerTenantIds.laterPublished,
        familyId: laterPublishedFamilyId,
        revision: 1,
        status: "published",
        number: `READ-EARLIER-PUBLISHED-${earlierPublishedId}`,
        total: "1.00",
        publishedAt: daysFromNow(-2),
        createdByPlatformUserId: actorId,
        createdAt: daysFromNow(-2),
        updatedAt: daysFromNow(-2),
      },
      {
        id: laterPublishedId,
        tenantId: offerTenantIds.laterPublished,
        familyId: laterPublishedFamilyId,
        revision: 2,
        previousRevisionId: earlierPublishedId,
        status: "published",
        number: `READ-LATER-PUBLISHED-${laterPublishedId}`,
        total: "2.00",
        publishedAt: daysFromNow(-1),
        createdByPlatformUserId: actorId,
        createdAt: daysFromNow(-1),
        updatedAt: daysFromNow(-1),
      },
    ]);
    offerCases.laterPublished = {
      tenantId: offerTenantIds.laterPublished,
      expectedOfferId: laterPublishedId,
    };
    offerDetailCases.supersededPrior = {
      tenantId: offerTenantIds.laterPublished,
      offerId: earlierPublishedId,
    };
    offerDetailCases.currentFamily = {
      tenantId: offerTenantIds.laterPublished,
      offerId: laterPublishedId,
    };

    for (const [name, decision] of [
      ["accepted", "accepted"],
      ["changesRequested", "changes_requested"],
    ] as const) {
      const offerId = randomUUID();
      await db.insert(schema.commercialOffers).values({
        id: offerId,
        tenantId: offerTenantIds[name],
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `READ-${name}-${offerId}`,
        total: "1.00",
        publishedAt: daysFromNow(-1),
        createdByPlatformUserId: actorId,
        createdAt: daysFromNow(-1),
        updatedAt: daysFromNow(-1),
      });
      await db.insert(schema.commercialOfferDecisions).values({
        tenantId: offerTenantIds[name],
        offerId,
        decision,
        ...(decision === "changes_requested" ? { message: "Please revise" } : {}),
        actorUserId: cabinetUserId,
        idempotencyKey: randomUUID(),
        createdAt: fixedNow,
      });
      offerCases[name] = { tenantId: offerTenantIds[name], expectedOfferId: null };
      offerDetailCases[name] = { tenantId: offerTenantIds[name], offerId };
    }

    const expiredOfferId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: expiredOfferId,
      tenantId: offerTenantIds.expired,
      familyId: randomUUID(),
      revision: 1,
      status: "published",
      number: `READ-EXPIRED-${expiredOfferId}`,
      total: "1.00",
      expiresAt: fixedNow,
      publishedAt: daysFromNow(-2),
      createdByPlatformUserId: actorId,
      createdAt: daysFromNow(-2),
      updatedAt: daysFromNow(-2),
    });
    offerCases.expired = { tenantId: offerTenantIds.expired, expectedOfferId: null };
    offerDetailCases.expired = { tenantId: offerTenantIds.expired, offerId: expiredOfferId };

    const entitlements = new EntitlementsService(db, "all");
    service = new FixedClockTenantBillingReadService(db, storage, entitlements, fixedNow);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  it("returns exact adjacent tied invoice pages beyond 100 without omissions or tenant leakage", async () => {
    const expectedIds = [...overdueInvoiceIds].sort((left, right) => right.localeCompare(left));
    const first = await service.listInvoices(tenantA, {
      status: "overdue",
      offset: 95,
      limit: 5,
    });
    const second = await service.listInvoices(tenantA, {
      status: "overdue",
      offset: 100,
      limit: 5,
    });

    expect(first.items.map((item) => item.id)).toEqual(expectedIds.slice(95, 100));
    expect(second.items.map((item) => item.id)).toEqual(expectedIds.slice(100, 105));
    expect([...first.items, ...second.items].map((item) => item.status)).toEqual(
      Array(10).fill("overdue"),
    );
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(10);
    expect([...first.items, ...second.items].map((item) => item.id)).not.toContain(
      foreignInvoiceId,
    );
  });

  it("orders mixed documents exactly and applies exact type/from/to filters in PostgreSQL", async () => {
    const first = await service.listDocuments(tenantA, { offset: 99, limit: 10 });
    const second = await service.listDocuments(tenantA, { offset: 109, limit: 10 });
    const actualAdjacent = [...first.items, ...second.items].map((item) =>
      documentKey({ id: item.id, type: item.type, createdAt: item.createdAt }),
    );
    expect(actualAdjacent).toEqual(expectedDocuments.slice(99, 119).map(documentKey));
    expect(new Set(actualAdjacent).size).toBe(actualAdjacent.length);

    const sharedPairOffset = expectedDocuments.findIndex(
      (document) => document.id === sharedDocumentId,
    );
    const sharedPair = await service.listDocuments(tenantA, {
      offset: sharedPairOffset,
      limit: 2,
    });
    expect(
      sharedPair.items.map((item) => ({
        id: item.id,
        type: item.type,
        createdAt: item.createdAt,
      })),
    ).toEqual([
      { id: sharedDocumentId, type: "act", createdAt: tiedTimestamp.toISOString() },
      { id: sharedDocumentId, type: "offer", createdAt: tiedTimestamp.toISOString() },
    ]);

    const offersOnly = await service.listDocuments(tenantA, {
      type: "offer",
      offset: 0,
      limit: 100,
    });
    expect(offersOnly.items.map((item) => item.type)).toEqual(Array(100).fill("offer"));
    expect(offersOnly.items.map((item) => item.id)).toEqual(
      expectedDocuments
        .filter((document) => document.type === "offer")
        .slice(0, 100)
        .map((document) => document.id),
    );

    const onOrAfter = await service.listDocuments(tenantA, {
      from: "2026-08-20",
      offset: 0,
      limit: 100,
    });
    expect(onOrAfter.items.map((item) => item.id)).toEqual(
      expectedDocuments
        .filter((document) => document.createdAt >= "2026-08-20T00:00:00.000Z")
        .slice(0, 100)
        .map((document) => document.id),
    );

    const onOrBefore = await service.listDocuments(tenantA, {
      to: "2026-08-19",
      offset: 0,
      limit: 100,
    });
    expect(
      onOrBefore.items.map((item) =>
        documentKey({ id: item.id, type: item.type, createdAt: item.createdAt }),
      ),
    ).toEqual(
      expectedDocuments
        .filter((document) => document.createdAt <= "2026-08-19T23:59:59.999Z")
        .map(documentKey),
    );
  });

  it("returns 404 for every persisted foreign detail/download and rejects poisoned keys before signing", async () => {
    signingBoundary.mockClear();
    await expect(service.invoiceDetail(tenantA, foreignInvoiceId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.offerDetail(tenantA, foreignOfferId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.downloadInvoiceDocument(tenantA, foreignInvoiceId, foreignInvoiceDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.downloadOfferDocument(tenantA, foreignOfferId, foreignOfferDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.downloadActDocument(tenantA, foreignActId, foreignActDocumentId),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      service.downloadInvoiceDocument(tenantA, poisonedInvoiceId, poisonedInvoiceDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.downloadOfferDocument(tenantA, poisonedOfferId, poisonedOfferDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.downloadActDocument(tenantA, poisonedActId, poisonedActDocumentId),
    ).rejects.toMatchObject({ status: 404 });
    expect(signingBoundary).not.toHaveBeenCalled();
  });

  it("counts full-set typed attention targets once while keeping recent operations bounded", async () => {
    const overview = await service.overview(attentionTenant);

    // Attention is deduplicated by typed entity target: request, current offer revision,
    // and invoice. Related events and links never create additional targets.
    expect(overview.attentionCount).toBe(4);
    expect(overview.activeRequest).toEqual({
      id: clarificationRequestId,
      number: expect.stringContaining("READ-CLARIFICATION-"),
      status: "clarification_required",
    });
    expect(overview.actionableOffer).toMatchObject({ id: actionableAttentionOfferId });
    expect(overview.recentOperations).toHaveLength(20);
    expect(overview.recentOperations.map((operation) => operation.id)).not.toEqual(
      expect.arrayContaining([
        attentionBoundaryInvoiceIds.yesterday,
        attentionBoundaryInvoiceIds.today,
        attentionBoundaryInvoiceIds.plus7,
        attentionBoundaryInvoiceIds.plus8,
      ]),
    );

    const boundaryIds = Object.values(attentionBoundaryInvoiceIds);
    await db
      .update(schema.invoices)
      .set({ status: "cancelled" })
      .where(inArray(schema.invoices.id, boundaryIds));
    for (const [label, expectedAttentionCount] of [
      ["yesterday", 2],
      ["today", 3],
      ["plus7", 3],
      ["plus8", 2],
    ] as const) {
      const invoiceId = attentionBoundaryInvoiceIds[label];
      await db
        .update(schema.invoices)
        .set({ status: "issued" })
        .where(eq(schema.invoices.id, invoiceId));
      expect((await service.overview(attentionTenant)).attentionCount, label).toBe(
        expectedAttentionCount,
      );
      await db
        .update(schema.invoices)
        .set({ status: "cancelled" })
        .where(eq(schema.invoices.id, invoiceId));
    }
    await db
      .update(schema.invoices)
      .set({ status: "issued" })
      .where(inArray(schema.invoices.id, boundaryIds));
  });

  it("projects expired, current, future, and already-effective subscriptions at one clock", async () => {
    const expired = await service.subscription(subscriptionCases.expired.tenantId);
    expect(expired).toMatchObject({
      access: "read_only",
      subscription: {
        id: subscriptionCases.expired.subscriptionId,
        planVersionId: subscriptionCases.expired.planVersionId,
        status: "expired",
        endsAt: "2026-08-27T11:59:59.999Z",
        billingPeriod: "month",
        price: "1000.00",
      },
      scheduledSubscription: null,
    });

    const current = await service.subscription(subscriptionCases.current.tenantId);
    expect(current).toMatchObject({
      access: "managed",
      subscription: {
        id: subscriptionCases.current.subscriptionId,
        status: "active",
        startsAt: "2026-08-22T12:00:00.000Z",
        endsAt: "2026-09-01T12:00:00.000Z",
      },
      scheduledSubscription: null,
      limits: { lines: 10, stations: 2, kiosks: 3, cabinetUsers: 4 },
    });

    const future = await service.subscription(subscriptionCases.future.tenantId);
    expect(future).toMatchObject({
      access: "read_only",
      subscription: null,
      scheduledSubscription: {
        id: subscriptionCases.future.subscriptionId,
        status: "scheduled",
        startsAt: "2026-08-28T12:00:00.000Z",
      },
    });

    const replacement = await service.subscription(subscriptionCases.effectiveReplacement.tenantId);
    expect(replacement).toMatchObject({
      access: "managed",
      subscription: {
        id: subscriptionCases.effectiveReplacement.subscriptionId,
        status: "active",
        startsAt: "2026-08-27T12:00:00.000Z",
      },
      scheduledSubscription: null,
      limits: { lines: 10 },
    });
  });

  it("aligns add-on presentation and entitlements at start/end boundaries", async () => {
    const billing = await service.subscription(addonTenantId);
    const statuses = Object.fromEntries(billing.addons.map((addon) => [addon.id, addon.status]));

    expect(billing.subscription).toMatchObject({ id: addonSubscriptionId, status: "active" });
    expect(billing.limits.lines).toBe(12);
    expect(billing.limitPresentation.lines).toEqual({
      used: 0,
      assigned: 12,
      remaining: 12,
      state: "normal",
    });
    expect(statuses).toEqual({
      [addonIds.beforeStart]: "scheduled",
      [addonIds.atStart]: "active",
      [addonIds.beforeEnd]: "active",
      [addonIds.atEnd]: "expired",
      [addonIds.afterEnd]: "expired",
    });
  });

  it("selects only current published undecided and unexpired offer revisions", async () => {
    for (const [name, offerCase] of Object.entries(offerCases)) {
      const overview = await service.overview(offerCase.tenantId);
      expect(overview.actionableOffer?.id ?? null, name).toBe(offerCase.expectedOfferId);
      expect(overview.attentionCount, name).toBe(offerCase.expectedOfferId ? 1 : 0);
    }
  });

  it("projects server-owned offer currency, decisions, expiry, and family authority from real rows", async () => {
    const currentUndecided = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.currentUndecided.tenantId,
        offerDetailCases.currentUndecided.offerId,
      ),
    );
    expect(currentUndecided).toMatchObject({
      id: offerDetailCases.currentUndecided.offerId,
      status: "published",
      isCurrent: true,
      actionable: true,
      latestDecision: null,
    });

    const accepted = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.accepted.tenantId,
        offerDetailCases.accepted.offerId,
      ),
    );
    expect(accepted).toMatchObject({
      id: offerDetailCases.accepted.offerId,
      status: "published",
      isCurrent: true,
      actionable: false,
      latestDecision: {
        decision: "accepted",
        message: null,
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });

    const changesRequested = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.changesRequested.tenantId,
        offerDetailCases.changesRequested.offerId,
      ),
    );
    expect(changesRequested).toMatchObject({
      id: offerDetailCases.changesRequested.offerId,
      status: "published",
      isCurrent: true,
      actionable: false,
      latestDecision: {
        decision: "changes_requested",
        message: "Please revise",
        createdAt: "2026-08-27T12:00:00.000Z",
      },
    });

    const expired = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.expired.tenantId,
        offerDetailCases.expired.offerId,
      ),
    );
    expect(expired).toMatchObject({
      id: offerDetailCases.expired.offerId,
      status: "expired",
      expiresAt: "2026-08-27T12:00:00.000Z",
      isCurrent: true,
      actionable: false,
      latestDecision: null,
    });

    const supersededPrior = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.supersededPrior.tenantId,
        offerDetailCases.supersededPrior.offerId,
      ),
    );
    expect(supersededPrior).toMatchObject({
      id: offerDetailCases.supersededPrior.offerId,
      status: "superseded",
      isCurrent: false,
      actionable: false,
      latestDecision: null,
    });

    const currentFamily = tenantOfferDetailSchema.parse(
      await service.offerDetail(
        offerDetailCases.currentFamily.tenantId,
        offerDetailCases.currentFamily.offerId,
      ),
    );
    expect(currentFamily).toMatchObject({
      id: offerDetailCases.currentFamily.offerId,
      status: "published",
      isCurrent: true,
      actionable: true,
      latestDecision: null,
    });
  });
});
