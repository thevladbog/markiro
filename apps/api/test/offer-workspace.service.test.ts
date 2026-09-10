import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { createDb, schema } from "@markiro/db";
import { SIGNED_PRINT_SELLER_TAX_ID } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

import { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import { OfferWorkspaceService } from "../src/modules/platform-offers/offer-workspace.service";
import { OfferPreviewService } from "../src/modules/platform-offers/offer-preview.service";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { listenOnLoopback } from "./support/listen-loopback";

const databaseUrl = process.env.DATABASE_URL;
const actorId = `offer-workspace-${randomUUID()}`;
const tenantId = `offer-workspace-tenant-${randomUUID()}`;

describe.skipIf(!databaseUrl)("offer registry and workspace on isolated Postgres", () => {
  const databaseName = `markiro_offer_workspace_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const tenantUserId = `offer-workspace-tenant-${randomUUID()}`;
  const tenantWithoutProfileId = `offer-registry-missing-${randomUUID()}`;
  const writer: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  };
  const reader: PlatformPrincipal = {
    userId: actorId,
    role: "support",
    capabilities: ["billing.read"],
    twoFactorReady: true,
  };
  const sameCreatedAt = new Date("2026-09-10T10:00:00.000Z");
  const nextCreatedAt = new Date("2026-09-10T10:00:00.001Z");
  const pageOfferIds = Array.from({ length: 26 }, () => randomUUID());
  const familyId = randomUUID();
  const staleOfferId = randomUUID();
  const acceptedOfferId = randomUUID();
  const requestedOfferId = randomUUID();
  const draftOfferId = randomUUID();
  const sellerAccountId = randomUUID();
  const requestId = randomUUID();
  let service: OfferWorkspaceService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    await connection.db.insert(schema.organization).values([
      { id: tenantId, name: "North Factory", slug: "north-factory", createdAt: new Date() },
      {
        id: tenantWithoutProfileId,
        name: "No Profile Factory",
        slug: "no-profile",
        createdAt: new Date(),
      },
    ]);
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Offer workspace actor",
      email: `${actorId}@example.invalid`,
      role: "accountant",
      status: "active",
      twoFactorEnabled: true,
    });
    await connection.db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: actorId,
      secret: "fixture",
      backupCodes: "fixture",
      verified: true,
    });
    await connection.db.insert(schema.user).values({
      id: tenantUserId,
      name: "Offer workspace tenant user",
      email: `${tenantUserId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.operatorBillingProfiles).values(
      profileValues({
        revision: 2,
        fullName: "Current Seller LLC",
        displayName: "Current Seller",
        inn: SIGNED_PRINT_SELLER_TAX_ID,
        createdByPlatformUserId: actorId,
      }),
    );
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      ...profileValues({
        revision: 2,
        fullName: "Current Buyer LLC",
        displayName: "Current Buyer",
        inn: "7701234567",
        createdByPlatformUserId: actorId,
      }),
    });
    await connection.db.insert(schema.operatorBankAccounts).values({
      id: sellerAccountId,
      label: "Current settlement",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Current Bank",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
      status: "active",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.commercialOffers).values(
      pageOfferIds.map((id, index) => ({
        id,
        tenantId: tenantWithoutProfileId,
        familyId: randomUUID(),
        revision: 1,
        status: "draft" as const,
        total: `${index + 1}.00`,
        createdByPlatformUserId: actorId,
        createdAt: sameCreatedAt,
        updatedAt: sameCreatedAt,
      })),
    );
    await connection.db.insert(schema.commercialOfferLines).values({
      tenantId: tenantWithoutProfileId,
      offerId: pageOfferIds[0]!,
      position: 1,
      kind: "service",
      nameRu: "%_ O'Reilly Настройка",
      nameEn: "Literal wildcard setup",
      quantity: 1,
      unit: "услуга",
      agreedUnitPrice: "1.00",
      vatRate: null,
      vatIncluded: false,
      lineTotal: "1.00",
    });
    await connection.db
      .insert(schema.commercialOffers)
      .values(offerValues(staleOfferId, familyId, 1, "draft"));
    await connection.db
      .insert(schema.commercialOfferLines)
      .values(lineValues(staleOfferId, 1, "Frozen legacy line"));
    await connection.db
      .update(schema.commercialOffers)
      .set({
        status: "superseded",
        number: "KP-FROZEN-1",
        publishedAt: new Date("2026-09-01T10:00:00.000Z"),
        publishedByPlatformUserId: actorId,
      })
      .where(eq(schema.commercialOffers.id, staleOfferId));
    await connection.db
      .insert(schema.commercialOffers)
      .values(offerValues(acceptedOfferId, familyId, 2, "draft"));
    await connection.db
      .insert(schema.commercialOfferLines)
      .values([
        lineValues(acceptedOfferId, 1, "Stored registry needle"),
        lineValues(acceptedOfferId, 2, "Support"),
        lineValues(acceptedOfferId, 3, "Integration"),
        lineValues(acceptedOfferId, 4, "Fourth hidden summary line"),
      ]);
    await connection.db
      .update(schema.commercialOffers)
      .set({
        status: "published",
        number: "KP-NEEDLE-2",
        publishedAt: new Date("2026-09-02T10:00:00.000Z"),
        publishedByPlatformUserId: actorId,
      })
      .where(eq(schema.commercialOffers.id, acceptedOfferId));
    await connection.db
      .insert(schema.commercialOffers)
      .values(offerValues(requestedOfferId, randomUUID(), 1, "draft"));
    await connection.db
      .insert(schema.commercialOfferLines)
      .values(lineValues(requestedOfferId, 1, "Requested change"));
    await connection.db
      .update(schema.commercialOffers)
      .set({
        status: "published",
        number: "KP-REQUESTED",
        publishedAt: new Date("2026-09-03T10:00:00.000Z"),
        publishedByPlatformUserId: actorId,
      })
      .where(eq(schema.commercialOffers.id, requestedOfferId));
    await connection.db
      .insert(schema.commercialOffers)
      .values(offerValues(draftOfferId, randomUUID(), 1, "draft"));
    await connection.db
      .insert(schema.commercialOfferLines)
      .values(lineValues(draftOfferId, 1, "Draft current parties"));
    await connection.db
      .insert(schema.commercialOfferPrintSnapshots)
      .values([
        snapshotValues(staleOfferId, 1, "KP-FROZEN-1", "Frozen Buyer v1"),
        snapshotValues(acceptedOfferId, 2, "KP-NEEDLE-2", "Frozen Buyer v2"),
        snapshotValues(requestedOfferId, 1, "KP-REQUESTED", "Frozen Requested Buyer"),
      ]);
    await connection.db.insert(schema.tenantBillingRequests).values({
      id: requestId,
      tenantId,
      number: "REQ-WORKSPACE-1",
      type: "renewal",
      status: "offer_prepared",
      description: "Renew the subscription",
      idempotencyKey: randomUUID(),
      createdByUserId: tenantUserId,
    });
    await connection.db.insert(schema.tenantBillingRequestLinks).values({
      tenantId,
      requestId,
      offerId: staleOfferId,
    });
    await connection.db.insert(schema.commercialOfferDecisions).values([
      {
        tenantId,
        offerId: acceptedOfferId,
        decision: "accepted",
        message: null,
        actorUserId: tenantUserId,
        idempotencyKey: randomUUID(),
        createdAt: new Date("2026-09-04T10:00:00.000Z"),
      },
      {
        tenantId,
        offerId: requestedOfferId,
        decision: "changes_requested",
        message: "Change the scope",
        actorUserId: tenantUserId,
        idempotencyKey: randomUUID(),
        createdAt: new Date("2026-09-05T10:00:00.000Z"),
      },
    ]);
    await connection.db.insert(schema.commercialOfferDocuments).values({
      tenantId,
      offerId: acceptedOfferId,
      revision: 2,
      format: "html",
      status: "pending",
      rendererVersion: "billing-print-v2",
    });
    service = new OfferWorkspaceService(connection.db);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("keeps missing profiles, projects stored lines, escapes search literals, and pages stably", async () => {
    const expectedIds = [...pageOfferIds].sort().reverse();
    const first = await service.registry(writer, {
      tenantId: tenantWithoutProfileId,
      page: 1,
      limit: 25,
    });
    const second = await service.registry(writer, {
      tenantId: tenantWithoutProfileId,
      page: 2,
      limit: 25,
    });

    expect(first.total).toBe(26);
    expect(first.items.map(({ id }) => id)).toEqual(expectedIds.slice(0, 25));
    expect(second.items.map(({ id }) => id)).toEqual(expectedIds.slice(25));
    expect(first.items.every((item) => item.buyerLegalName === null)).toBe(true);

    const literal = await service.registry(writer, { search: "%_ O'Reilly", page: 1, limit: 25 });
    expect(literal.items).toEqual([
      expect.objectContaining({
        id: pageOfferIds[0],
        tenantName: "No Profile Factory",
        buyerTaxId: null,
        lineSummary: ["%_ O'Reilly Настройка"],
        lineCount: 1,
      }),
    ]);
    await expect(
      service.registry(writer, { search: "KP-NEEDLE", page: 1, limit: 25 }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(
      service.registry(writer, { search: "North Factory", page: 1, limit: 25 }),
    ).resolves.toMatchObject({ total: 4 });
    await expect(
      service.registry(writer, { search: "7701234567", page: 1, limit: 25 }),
    ).resolves.toMatchObject({ total: 4 });
    await expect(
      service.registry(writer, { search: "Stored registry needle", page: 1, limit: 25 }),
    ).resolves.toMatchObject({ total: 1 });

    await expect(
      service.registry(writer, {
        tenantId: tenantWithoutProfileId,
        createdFrom: sameCreatedAt.toISOString(),
        createdTo: nextCreatedAt.toISOString(),
        page: 1,
        limit: 25,
      }),
    ).resolves.toMatchObject({ total: 26 });
    await expect(
      service.registry(writer, {
        tenantId: tenantWithoutProfileId,
        createdTo: sameCreatedAt.toISOString(),
        page: 1,
        limit: 25,
      }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it("uses frozen issued parties and accounts and derives actions from family, decision, and capability", async () => {
    const accepted = await service.workspace(writer, acceptedOfferId);
    expect(accepted.parties).toMatchObject({
      seller: { fullName: "Frozen Seller LLC", inn: SIGNED_PRINT_SELLER_TAX_ID },
      buyer: { fullName: "Frozen Buyer v2", inn: "7801234567" },
      sellerBankAccount: { label: "Frozen settlement", bankName: "Frozen Bank" },
      buyerBankAccount: null,
    });
    expect(accepted.revisions.map(({ id }) => id)).toEqual([acceptedOfferId, staleOfferId]);
    expect(accepted.decision).toMatchObject({ decision: "accepted", message: null });
    expect(accepted.documents).toEqual([
      expect.objectContaining({ revision: 2, format: "html", status: "pending" }),
    ]);
    expect(accepted.request).toEqual({
      id: requestId,
      number: "REQ-WORKSPACE-1",
      status: "offer_prepared",
    });
    expect(accepted.actions).toEqual({
      publish: false,
      cancel: true,
      revise: false,
      pay: true,
      createInvoice: true,
      addSignedVariant: true,
    });
    expect((await service.workspace(reader, acceptedOfferId)).actions).toEqual({
      publish: false,
      cancel: false,
      revise: false,
      pay: false,
      createInvoice: false,
      addSignedVariant: false,
    });
    expect((await service.workspace(writer, staleOfferId)).actions).toEqual({
      publish: false,
      cancel: false,
      revise: false,
      pay: false,
      createInvoice: false,
      addSignedVariant: false,
    });
    expect((await service.workspace(writer, requestedOfferId)).actions).toEqual({
      publish: false,
      cancel: true,
      revise: true,
      pay: false,
      createInvoice: false,
      addSignedVariant: true,
    });
  });

  it.each([
    { status: "published", offset: -1, allowed: false },
    { status: "published", offset: 0, allowed: false },
    { status: "published", offset: 1, allowed: true },
    { status: "published", offset: null, allowed: true },
    { status: "paid", offset: -1, allowed: true },
    { status: "paid", offset: null, allowed: true },
  ] as const)(
    "projects signed eligibility at $status deadline offset $offset",
    async ({ status, offset, allowed }) => {
      const now = new Date("2026-09-11T12:00:00.000Z");
      const id = randomUUID();
      await connection.db.insert(schema.commercialOffers).values({
        ...offerValues(id, randomUUID(), 1, "draft"),
        expiresAt: offset === null ? null : new Date(now.getTime() + offset),
      });
      await connection.db
        .update(schema.commercialOffers)
        .set({ status })
        .where(eq(schema.commercialOffers.id, id));
      await connection.db
        .insert(schema.commercialOfferPrintSnapshots)
        .values(snapshotValues(id, 1, "KP-DEADLINE", "Deadline buyer"));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        const result = await service.workspace(writer, id);
        expect(result.actions.addSignedVariant).toBe(allowed);
        expect(result.actions.pay).toBe(false);
        expect(result.actions.createInvoice).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("uses current authoritative profiles and accounts only for a draft", async () => {
    const draft = await service.workspace(writer, draftOfferId);
    expect(draft.parties).toMatchObject({
      seller: { fullName: "Current Seller LLC" },
      buyer: { fullName: "Current Buyer LLC" },
      sellerBankAccount: { id: sellerAccountId, bankName: "Current Bank" },
      buyerBankAccount: null,
    });
    expect(draft.actions).toEqual({
      publish: true,
      cancel: false,
      revise: false,
      pay: false,
      createInvoice: false,
      addSignedVariant: false,
    });
    expect((await service.workspace(writer, pageOfferIds[0]!)).actions.publish).toBe(false);
  });

  it("returns 403 through the actual platform guard when billing.read is absent", async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformOffersController],
      providers: [
        { provide: OfferWorkspaceService, useValue: service },
        { provide: PlatformOffersService, useValue: {} },
        { provide: OfferDocumentsService, useValue: {} },
        { provide: OfferPreviewService, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication();
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "fixture=platform" ? { user: { id: actorId } } : null,
      },
    };
    app.useGlobalGuards(
      new PlatformAuthGuard(
        new Reflector(),
        auth as never,
        connection.db,
        new PlatformAuditService(),
      ),
    );
    await app.init();
    await listenOnLoopback(app);
    try {
      await connection.db
        .update(schema.platformUsers)
        .set({ role: "support" })
        .where(eq(schema.platformUsers.id, actorId));
      await request(app.getHttpServer())
        .get("/platform/offers/registry")
        .set("Cookie", "fixture=platform")
        .expect(403);
      await connection.db
        .update(schema.platformUsers)
        .set({ role: "accountant" })
        .where(eq(schema.platformUsers.id, actorId));
      await request(app.getHttpServer())
        .get("/platform/offers/registry")
        .set("Cookie", "fixture=platform")
        .expect(200);
    } finally {
      await connection.db
        .update(schema.platformUsers)
        .set({ role: "accountant" })
        .where(eq(schema.platformUsers.id, actorId));
      await app.close();
    }
  });
});

function profileValues(input: {
  revision: number;
  fullName: string;
  displayName: string;
  inn: string;
  createdByPlatformUserId: string;
}) {
  return {
    ...input,
    kind: "legal_entity" as const,
    kpp: "770101001",
    ogrn: "1027700132195",
    addressRaw: "Moscow",
    legalAddressRaw: "Moscow",
    actualSameAsLegal: true,
    postalSameAsLegal: true,
    contact: { name: "Billing", email: "billing@example.invalid", phone: "+70000000000" },
    isCurrent: true,
    isConfirmed: true,
    confirmedByPlatformUserId: input.createdByPlatformUserId,
    confirmedAt: new Date("2026-09-01T08:00:00.000Z"),
  };
}

function offerValues(
  id: string,
  familyId: string,
  revision: number,
  status: "draft" | "published" | "superseded",
  published: { number: string; publishedAt: Date } | undefined = undefined,
) {
  return {
    id,
    tenantId,
    familyId,
    revision,
    status,
    number: published?.number ?? null,
    total: "120.00",
    publishedAt: published?.publishedAt ?? null,
    publishedByPlatformUserId: published ? actorId : null,
    createdByPlatformUserId: actorId,
    createdAt: published?.publishedAt ?? new Date("2026-09-06T10:00:00.000Z"),
    updatedAt: published?.publishedAt ?? new Date("2026-09-06T10:00:00.000Z"),
  };
}

function lineValues(offerId: string, position: number, nameRu: string) {
  return {
    tenantId,
    offerId,
    position,
    kind: "service" as const,
    nameRu,
    nameEn: nameRu,
    quantity: 1,
    unit: "услуга",
    agreedUnitPrice: "120.00",
    vatRate: null,
    vatIncluded: false,
    lineTotal: "120.00",
  };
}

function snapshotValues(offerId: string, revision: number, number: string, buyerName: string) {
  return {
    tenantId,
    offerId,
    revision,
    number,
    publishedAt: new Date("2026-09-02T10:00:00.000Z"),
    expiresAt: null,
    sellerSnapshot: snapshotParty("Frozen Seller LLC", SIGNED_PRINT_SELLER_TAX_ID),
    buyerSnapshot: snapshotParty(buyerName, "7801234567"),
    sellerBankAccountSnapshot: {
      id: randomUUID(),
      label: "Frozen settlement",
      settlementAccount: "40702810900000000002",
      bic: "044525225",
      bankName: "Frozen Bank",
      correspondentAccount: "30101810400000000225",
      currency: "RUB",
    },
    buyerBankAccountSnapshot: null,
    linesSnapshot: [],
    subtotal: "120.00",
    vatTotal: "0.00",
    total: "120.00",
    termsMarkdown: null,
    termsHtml: null,
  };
}

function snapshotParty(fullName: string, inn: string) {
  return {
    kind: "legal_entity",
    fullName,
    displayName: fullName,
    inn,
    kpp: "770101001",
    ogrn: "1027700132195",
    ogrnip: null,
    legalAddressRaw: "Moscow",
    legalAddress: null,
    actualSameAsLegal: true,
    actualAddressRaw: null,
    actualAddress: null,
    postalSameAsLegal: true,
    postalAddressRaw: null,
    postalAddress: null,
    contact: { name: "Billing", email: "billing@example.invalid", phone: "+70000000000" },
    revision: 1,
    confirmedAt: "2026-09-01T08:00:00.000Z",
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
