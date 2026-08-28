import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { createDb, schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createOfferSchema, type CreateOfferDto } from "../src/modules/platform-offers/dto";
import type { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { BillingService } from "../src/modules/billing/billing.service";
import { TenantBillingOffersService } from "../src/modules/tenant-billing/tenant-billing-offers.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { PlatformAuditService as RealPlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { createOrganization } from "./support/subscription-fixtures";

const actor: PlatformPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "accountant",
  capabilities: ["billing.write"],
  twoFactorReady: true,
};
const input: CreateOfferDto = {
  tenantId: "21111111-1111-4111-8111-111111111111",
  expiresAt: null,
  lines: [
    {
      kind: "plan",
      catalogVersionId: "31111111-1111-4111-8111-111111111111",
      nameRu: "Базовый",
      nameEn: "Basic",
      quantity: 1,
      unit: "месяц",
      agreedUnitPrice: "120.00",
      vatRateBps: 2000,
      vatIncluded: true,
      priceOverrideReason: null,
      activationPolicy: "immediately",
    },
  ],
};
const inputLine = input.lines[0]!;

function serviceHarness(
  version:
    | { kind: "plan" | "addon" | "service"; status: "published" | "retired"; unitPrice: string }
    | null
    | undefined = {
    kind: "plan",
    status: "published",
    unitPrice: "120.00",
  },
) {
  const insertedValues: unknown[] = [];
  const offer = { id: "41111111-1111-4111-8111-111111111111", tenantId: input.tenantId };
  let selectCount = 0;
  let insertCount = 0;
  const tx = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        const query = {
          from: vi.fn(() => query),
          where: vi.fn(() => query),
          for: vi.fn(async () => (version === null ? [] : [version])),
          limit: vi.fn(async () => [offer]),
          orderBy: vi.fn(async () => []),
        };
        return query;
      }
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => (selectCount === 2 ? [offer] : [])),
        orderBy: vi.fn(async () => []),
      };
      return query;
    }),
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        insertCount += 1;
        if (insertCount === 1) return { returning: vi.fn(async () => [offer]) };
        return Promise.resolve();
      },
    })),
  };
  const db = {
    transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as Db;
  return {
    service: new PlatformOffersService(db, {} as PlatformAuditService),
    insertedValues,
    insert: tx.insert,
  };
}

describe("PlatformOffersService catalog validation", () => {
  it.each([
    [null, "plan", "offer_catalog_version_invalid"],
    [
      { kind: "plan", status: "retired", unitPrice: "120.00" },
      "plan",
      "offer_catalog_version_invalid",
    ],
    [
      { kind: "addon", status: "published", unitPrice: "120.00" },
      "plan",
      "offer_catalog_version_invalid",
    ],
  ] as const)("rejects invalid catalog state %#", async (version, kind, code) => {
    const { service, insert } = serviceHarness(version);
    const failure = await service
      .create(actor, { ...input, lines: [{ ...inputLine, kind }] })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({ code });
    expect(insert).not.toHaveBeenCalled();
  });

  it.each(["plan", "addon"] as const)("rejects an unversioned %s line", async (kind) => {
    const { service, insert } = serviceHarness();
    const failure = await service
      .create(actor, {
        ...input,
        lines: [{ ...inputLine, kind, catalogVersionId: null }],
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({
      code: "offer_catalog_version_invalid",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts an unversioned service line", async () => {
    const { service, insertedValues } = serviceHarness();
    await service.create(actor, {
      ...input,
      lines: [
        {
          ...inputLine,
          kind: "service",
          catalogVersionId: null,
          agreedUnitPrice: "120.00",
          priceOverrideReason: null,
          activationPolicy: null,
        },
      ],
    });
    expect(insertedValues[1]).toEqual([
      expect.objectContaining({ catalogVersionId: null, catalogUnitPrice: null }),
    ]);
  });

  it.each([null, "1.00"])(
    "rejects a client-supplied catalog baseline of %s at the request boundary",
    (catalogUnitPrice) => {
      const candidate = { ...input, lines: [{ ...inputLine, catalogUnitPrice }] };
      expect(createOfferSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it.each([undefined, null, "   "])(
    "rejects an authoritative price override with a missing or blank reason (%s)",
    async (priceOverrideReason) => {
      const { service, insert } = serviceHarness();
      const overrideInput: CreateOfferDto = {
        ...input,
        lines: [{ ...inputLine, agreedUnitPrice: "99.00", priceOverrideReason }],
      };
      const failure = await service.create(actor, overrideInput).catch((error) => error);
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toEqual({
        code: "offer_price_override_reason_required",
      });
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("persists the authoritative catalog baseline and a valid override reason", async () => {
    const { service, insertedValues } = serviceHarness();
    await service.create(actor, {
      ...input,
      lines: [
        {
          ...inputLine,
          agreedUnitPrice: "99.00",
          priceOverrideReason: "  Annual commitment  ",
        },
      ],
    });
    expect(insertedValues[1]).toEqual([
      expect.objectContaining({
        catalogVersionId: inputLine.catalogVersionId,
        catalogUnitPrice: "120.00",
        agreedUnitPrice: "99.00",
        priceOverrideReason: "Annual commitment",
      }),
    ]);
  });
});

describe("platform offer response boundary", () => {
  it("rejects a malformed successful offer list returned by the service", async () => {
    const service = {
      list: async () => [
        {
          id: "41111111-1111-4111-8111-111111111111",
          tenantId: input.tenantId,
          status: "draft",
          total: "120.00",
        },
      ],
    } as unknown as PlatformOffersService;
    const controller = new PlatformOffersController(service, {} as OfferDocumentsService);
    const request = {
      platformPrincipal: actor,
    } as unknown as Parameters<PlatformOffersController["list"]>[0];

    await expect(controller.list(request)).rejects.toThrow();
  });

  it("rejects a malformed document id before the document service", async () => {
    const documents = {
      url: vi.fn(async () => ({
        url: "https://objects.example.invalid/offers/offer.pdf?signature=redacted",
      })),
    } as unknown as OfferDocumentsService;
    const controller = new PlatformOffersController({} as PlatformOffersService, documents);

    const failure = await controller
      .documentsDownload("41111111-1111-4111-8111-111111111111", "not-a-uuid")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(documents.url).not.toHaveBeenCalled();
  });
});

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("platform offer revisions on isolated Postgres", () => {
  const databaseName = `markiro_offer_revisions_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratchUrl.toString());
  const actorId = `offer-revision-${randomUUID()}`;
  const tenantUserId = `offer-revision-tenant-${randomUUID()}`;
  const revisionActor: PlatformPrincipal = {
    userId: actorId,
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  };
  let tenantId = "";
  let publishedOfferId = "";
  let familyId = "";
  let draftOfferId = "";
  let service: PlatformOffersService;
  let billing: BillingService;
  let tenantOffers: TenantBillingOffersService;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    tenantId = await createOrganization(connection.db);
    await connection.db.insert(schema.platformUsers).values({
      id: actorId,
      name: "Offer revision actor",
      email: `${actorId}@example.invalid`,
      role: revisionActor.role,
      status: "active",
    });
    await connection.db.insert(schema.user).values({
      id: tenantUserId,
      name: "Offer revision tenant user",
      email: `${tenantUserId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const confirmedAt = new Date("2026-08-27T10:00:00.000Z");
    await connection.db.insert(schema.operatorBillingProfiles).values({
      revision: 1,
      kind: "legal_entity",
      fullName: "Markiro Operator",
      displayName: "Markiro",
      inn: "7707083893",
      kpp: "773601001",
      ogrn: "1027700132195",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId,
      revision: 1,
      kind: "legal_entity",
      fullName: "Revision Buyer",
      displayName: "Revision Buyer",
      inn: "7710140679",
      kpp: "771001001",
      ogrn: "1027700132196",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt,
      createdByPlatformUserId: actorId,
    });
    await connection.db.insert(schema.operatorBankAccounts).values({
      label: "Default",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Test bank",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actorId,
    });
    familyId = randomUUID();
    const [published] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        familyId,
        revision: 4,
        status: "draft",
        total: "240.00",
        expiresAt: new Date("2026-09-30T21:00:00.000Z"),
        termsMarkdown: "## Immutable terms",
        createdByPlatformUserId: actorId,
      })
      .returning();
    publishedOfferId = published!.id;
    await connection.db.insert(schema.commercialOfferLines).values({
      tenantId,
      offerId: publishedOfferId,
      position: 1,
      kind: "service",
      nameRu: "Настройка",
      nameEn: "Setup",
      descriptionRu: "Снимок строки",
      descriptionEn: "Line snapshot",
      quantity: 2,
      unit: "час",
      catalogUnitPrice: "120.00",
      agreedUnitPrice: "120.00",
      vatRate: "20.00",
      vatIncluded: true,
      lineTotal: "240.00",
    });
    await connection.db
      .update(schema.commercialOffers)
      .set({
        status: "published",
        number: `KP-REVISION-${randomUUID()}`,
        publishedAt: new Date("2026-08-27T12:00:00.000Z"),
        publishedByPlatformUserId: actorId,
      })
      .where(eq(schema.commercialOffers.id, publishedOfferId));
    await connection.db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: publishedOfferId,
      decision: "changes_requested",
      message: "Change the delivery date",
      actorUserId: tenantUserId,
      idempotencyKey: randomUUID(),
    });
    service = new PlatformOffersService(connection.db, new RealPlatformAuditService());
    billing = new BillingService(connection.db, new RealPlatformAuditService());
    tenantOffers = new TenantBillingOffersService(connection.db);
  }, 120_000);

  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenance.pool.end();
  });

  it("serializes revision retries, copies immutable inputs, and leaves the published offer current", async () => {
    const idempotencyKey = randomUUID();
    const [left, right] = await Promise.all([
      service.revise(revisionActor, publishedOfferId, { idempotencyKey }),
      service.revise(revisionActor, publishedOfferId, { idempotencyKey }),
    ]);
    expect(right).toEqual(left);
    expect(left).toMatchObject({
      tenantId,
      familyId,
      previousRevisionId: publishedOfferId,
      revision: 5,
      status: "draft",
      number: null,
      total: "240.00",
      termsMarkdown: "## Immutable terms",
      lines: [
        expect.objectContaining({
          position: 1,
          kind: "service",
          nameRu: "Настройка",
          quantity: 2,
          agreedUnitPrice: "120.00",
          vatIncluded: true,
          lineTotal: "240.00",
        }),
      ],
    });
    draftOfferId = left.id;
    const family = await connection.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.familyId, familyId));
    expect(family).toHaveLength(2);
    expect(family.find((offer) => offer.id === publishedOfferId)).toMatchObject({
      status: "published",
      revision: 4,
    });
    const audits = await connection.db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, left.id));
    expect(audits).toEqual([
      expect.objectContaining({
        actorPlatformUserId: actorId,
        actorRole: "accountant",
        action: "billing.offer.revised",
        outcome: "success",
        tenantId,
        targetType: "commercial_offer",
        before: { sourceOfferId: publishedOfferId, revision: 4, status: "published" },
        after: { revision: 5, status: "draft", previousRevisionId: publishedOfferId },
      }),
    ]);
    await expect(
      service.revise(revisionActor, publishedOfferId, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_revision_draft_exists" }, status: 409 });
  });

  it("supersedes stale terms on publication and only accepts payment/source use of the accepted current revision", async () => {
    const published = await service.publish(revisionActor, draftOfferId);
    expect(published).toMatchObject({ id: draftOfferId, revision: 5, status: "published" });
    const familyAfterPublish = await connection.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.familyId, familyId));
    expect(familyAfterPublish.find((offer) => offer.id === publishedOfferId)).toMatchObject({
      revision: 4,
      status: "superseded",
    });

    await expect(
      service.pay(revisionActor, publishedOfferId, randomUUID(), {
        amount: "240.00",
        currency: "RUB",
        bankReference: `STALE-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(
      billing.create(revisionActor, {
        ...invoiceInput(tenantId),
        sourceOfferId: publishedOfferId,
      }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(
      service.pay(revisionActor, draftOfferId, randomUUID(), {
        amount: "240.00",
        currency: "RUB",
        bankReference: `UNACCEPTED-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ response: { code: "offer_not_accepted" }, status: 409 });

    await connection.db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: draftOfferId,
      decision: "accepted",
      actorUserId: tenantUserId,
      idempotencyKey: randomUUID(),
    });
    const paymentKey = randomUUID();
    const paid = await service.pay(
      revisionActor,
      draftOfferId.toUpperCase(),
      paymentKey.toUpperCase(),
      {
        amount: "240.00",
        currency: "RUB",
        bankReference: `CURRENT-${randomUUID()}`,
      },
    );
    expect(paid.fulfilments).toHaveLength(1);
    const [storedPayment] = await connection.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paid.paymentId));
    expect(storedPayment).toMatchObject({
      offerId: draftOfferId,
      idempotencyKey: paymentKey,
    });
    const staleFulfilments = await connection.db
      .select()
      .from(schema.offerLineFulfilments)
      .where(eq(schema.offerLineFulfilments.tenantId, tenantId));
    expect(staleFulfilments).toHaveLength(1);

    await expect(
      service.revise(revisionActor, publishedOfferId, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(
      service.revise(revisionActor, draftOfferId, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_not_published" }, status: 409 });
    const finalFamily = await connection.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.familyId, familyId));
    expect(finalFamily.map(({ revision }) => revision).sort((left, right) => left - right)).toEqual(
      [4, 5],
    );
  });

  it("does not fall back or reuse a revision after the newer published generation is cancelled", async () => {
    const cancelledFamilyId = randomUUID();
    const [first] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        familyId: cancelledFamilyId,
        revision: 1,
        status: "published",
        number: `KP-CANCELLED-FAMILY-${randomUUID()}`,
        total: "100.00",
        publishedAt: new Date(),
        publishedByPlatformUserId: actorId,
        createdByPlatformUserId: actorId,
      })
      .returning();
    await connection.db.insert(schema.commercialOfferDecisions).values({
      tenantId,
      offerId: first!.id,
      decision: "changes_requested",
      message: "Revise before cancellation",
      actorUserId: tenantUserId,
      idempotencyKey: randomUUID(),
    });
    const secondDraft = await service.revise(revisionActor, first!.id, {
      idempotencyKey: randomUUID(),
    });
    await service.publish(revisionActor, secondDraft.id);
    await service.cancel(revisionActor, secondDraft.id);

    await expect(
      service.revise(revisionActor, first!.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_version_stale" }, status: 409 });
    await expect(
      service.revise(revisionActor, secondDraft.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_not_published" }, status: 409 });
    const family = await connection.db
      .select()
      .from(schema.commercialOffers)
      .where(eq(schema.commercialOffers.familyId, cancelledFamilyId));
    expect(family).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first!.id, revision: 1, status: "superseded" }),
        expect.objectContaining({ id: secondDraft.id, revision: 2, status: "cancelled" }),
      ]),
    );
    expect(family).toHaveLength(2);
  });

  it("rejects revision when the latest published offer has no current changes request", async () => {
    const [other] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        revision: 1,
        status: "published",
        number: `KP-NO-REVISION-${randomUUID()}`,
        publishedAt: new Date(),
        createdByPlatformUserId: actorId,
      })
      .returning();
    await expect(
      service.revise(revisionActor, other!.id, { idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ response: { code: "offer_revision_not_requested" }, status: 409 });
  });

  it("serializes tenant decisions against invoice source validation and platform revision", async () => {
    const [invoiceOffer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `KP-MIXED-INVOICE-${randomUUID()}`,
        total: "100.00",
        publishedAt: new Date(),
        publishedByPlatformUserId: actorId,
        createdByPlatformUserId: actorId,
      })
      .returning();
    const [invoiceOutcome, acceptOutcome] = await Promise.allSettled([
      billing.create(revisionActor, {
        ...invoiceInput(tenantId),
        sourceOfferId: invoiceOffer!.id,
      }),
      tenantOffers.accept(tenantId, tenantUserId, invoiceOffer!.id, randomUUID()),
    ]);
    expect(acceptOutcome).toMatchObject({
      status: "fulfilled",
      value: { offerId: invoiceOffer!.id, decision: "accepted" },
    });
    if (invoiceOutcome.status === "rejected") {
      expect(invoiceOutcome.reason).toMatchObject({
        response: { code: "offer_not_accepted" },
        status: 409,
      });
    } else {
      expect(invoiceOutcome.value).toMatchObject({ sourceOfferId: invoiceOffer!.id });
    }

    const [revisionOffer] = await connection.db
      .insert(schema.commercialOffers)
      .values({
        tenantId,
        familyId: randomUUID(),
        revision: 1,
        status: "published",
        number: `KP-MIXED-REVISION-${randomUUID()}`,
        total: "100.00",
        publishedAt: new Date(),
        publishedByPlatformUserId: actorId,
        createdByPlatformUserId: actorId,
      })
      .returning();
    const [reviseOutcome, changesOutcome] = await Promise.allSettled([
      service.revise(revisionActor, revisionOffer!.id, { idempotencyKey: randomUUID() }),
      tenantOffers.requestChanges(tenantId, tenantUserId, revisionOffer!.id, {
        idempotencyKey: randomUUID(),
        message: "Please revise this offer",
      }),
    ]);
    expect(changesOutcome).toMatchObject({
      status: "fulfilled",
      value: { offerId: revisionOffer!.id, decision: "changes_requested" },
    });
    if (reviseOutcome.status === "rejected") {
      expect(reviseOutcome.reason).toMatchObject({
        response: { code: "offer_revision_not_requested" },
        status: 409,
      });
    } else {
      expect(reviseOutcome.value).toMatchObject({
        previousRevisionId: revisionOffer!.id,
        revision: 2,
        status: "draft",
      });
    }
  }, 15_000);

  it("serializes global offer numbers and payment keys across tenants", async () => {
    const secondTenantId = await createOrganization(connection.db);
    const secondTenantUserId = `offer-global-tenant-${randomUUID()}`;
    await connection.db.insert(schema.user).values({
      id: secondTenantUserId,
      name: "Second offer tenant user",
      email: `${secondTenantUserId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await connection.db.insert(schema.tenantBillingProfiles).values({
      tenantId: secondTenantId,
      revision: 1,
      kind: "legal_entity",
      fullName: "Second Revision Buyer",
      displayName: "Second Buyer",
      inn: "7801002292",
      kpp: "780101001",
      ogrn: "1027800000001",
      addressRaw: "Saint Petersburg",
      legalAddressRaw: "Saint Petersburg",
      isConfirmed: true,
      confirmedByPlatformUserId: actorId,
      confirmedAt: new Date("2026-08-27T10:00:00.000Z"),
      createdByPlatformUserId: actorId,
    });
    const [firstDraft, secondDraft] = await connection.db
      .insert(schema.commercialOffers)
      .values([
        {
          tenantId,
          familyId: randomUUID(),
          revision: 42,
          status: "draft",
          total: "100.00",
          createdByPlatformUserId: actorId,
        },
        {
          tenantId: secondTenantId,
          familyId: randomUUID(),
          revision: 42,
          status: "draft",
          total: "100.00",
          createdByPlatformUserId: actorId,
        },
      ])
      .returning();
    await connection.pool.query(`
      CREATE FUNCTION task6_offer_publish_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.number IS NULL AND NEW.number IS NOT NULL THEN
          PERFORM pg_advisory_xact_lock(72042);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER task6_offer_publish_delay
      BEFORE UPDATE ON commercial_offers
      FOR EACH ROW EXECUTE FUNCTION task6_offer_publish_delay();
    `);
    let published: Awaited<ReturnType<PlatformOffersService["publish"]>>[];
    const barrier = await connection.pool.connect();
    try {
      await barrier.query("select pg_advisory_lock(72042)");
      const pending = Promise.allSettled([
        service.publish(revisionActor, firstDraft!.id),
        service.publish(revisionActor, secondDraft!.id),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await barrier.query("select pg_advisory_unlock(72042)");
      const outcomes = await pending;
      expect(outcomes).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      published = outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
      expect(new Set(published.map(({ number }) => number)).size).toBe(2);
    } finally {
      await barrier.query("select pg_advisory_unlock_all()");
      barrier.release();
      await connection.pool.query(`
        DROP TRIGGER task6_offer_publish_delay ON commercial_offers;
        DROP FUNCTION task6_offer_publish_delay();
      `);
    }
    expect(published).toHaveLength(2);
    await connection.db.insert(schema.commercialOfferDecisions).values([
      {
        tenantId,
        offerId: firstDraft!.id,
        decision: "accepted",
        actorUserId: tenantUserId,
        idempotencyKey: randomUUID(),
      },
      {
        tenantId: secondTenantId,
        offerId: secondDraft!.id,
        decision: "accepted",
        actorUserId: secondTenantUserId,
        idempotencyKey: randomUUID(),
      },
    ]);
    const paymentKey = randomUUID();
    await connection.pool.query(`
      CREATE FUNCTION task6_payment_insert_delay() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
      CREATE TRIGGER task6_payment_insert_delay
      BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION task6_payment_insert_delay();
    `);
    try {
      const outcomes = await Promise.allSettled([
        service.pay(revisionActor, firstDraft!.id, paymentKey, {
          amount: "100.00",
          currency: "RUB",
          bankReference: `GLOBAL-A-${randomUUID()}`,
        }),
        service.pay(revisionActor, secondDraft!.id, paymentKey, {
          amount: "100.00",
          currency: "RUB",
          bankReference: `GLOBAL-B-${randomUUID()}`,
        }),
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find(({ status }) => status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { response: { code: "idempotency_key_reused" }, status: 409 },
      });
    } finally {
      await connection.pool.query(`
        DROP TRIGGER task6_payment_insert_delay ON payments;
        DROP FUNCTION task6_payment_insert_delay();
      `);
    }
  }, 30_000);
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

function invoiceInput(tenantId: string) {
  return {
    tenantId,
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
        agreedUnitPrice: "100.00",
        vatRateBps: null,
        vatIncluded: false,
        activationPolicy: null,
      },
    ],
  };
}
