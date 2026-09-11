import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import request from "supertest";
import { PlatformAuthGuard } from "../src/platform-auth/platform-auth.guard";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { listenOnLoopback } from "./support/listen-loopback";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";
import { tenantOfferDetailSchema } from "../src/modules/tenant-billing/dto";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { OfferPreviewService } from "../src/modules/platform-offers/offer-preview.service";
import { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import { OfferWorkspaceService } from "../src/modules/platform-offers/offer-workspace.service";
import { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { noopTenantBillingNotifications } from "./support/tenant-billing-notifications";
import { createOrganization } from "./support/subscription-fixtures";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("offer previews and immutable variants on isolated Postgres", () => {
  const databaseName = `markiro_offer_preview_${randomUUID().replaceAll("-", "_")}`;
  const scratch = new URL(databaseUrl ?? "postgres://invalid");
  scratch.pathname = `/${databaseName}`;
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const connection = createDb(scratch.toString());
  const db = connection.db;
  const actor: PlatformPrincipal = {
    userId: randomUUID(),
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  };
  const audit = new PlatformAuditService();
  const notifications = noopTenantBillingNotifications();
  const enqueue = vi.spyOn(notifications, "enqueueInTransaction");
  const offers = new PlatformOffersService(db, audit, notifications);
  const preview = new OfferPreviewService(db);
  const workspace = new OfferWorkspaceService(db);
  const objects = new Map<string, Buffer>();
  let failPdf = false;
  const put = vi.fn(async (key: string, body: Buffer, contentType: string) => {
    if (failPdf && contentType === "application/pdf") throw new Error("test_pdf_failure");
    objects.set(key, Buffer.from(body));
  });
  const storage = {
    ensureBucket: vi.fn(async () => undefined),
    put,
    presignRead: vi.fn(async (key: string) => `https://example.invalid/${key}`),
  } as unknown as ObjectStorageService;
  const documents = new OfferDocumentsService(db, storage, audit);
  const tenantRead = new TenantBillingReadService(db, storage, new EntitlementsService(db, "all"));
  let tenantId: string;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    tenantId = await createOrganization(db);
    await db.insert(schema.platformUsers).values({
      id: actor.userId,
      name: "Preview actor",
      email: `${actor.userId}@example.invalid`,
      role: actor.role,
      status: "active",
      twoFactorEnabled: true,
    });
    await db.insert(schema.platformTwoFactors).values({
      id: randomUUID(),
      userId: actor.userId,
      secret: "fixture",
      backupCodes: "fixture",
    });
    const party = {
      revision: 1,
      kind: "legal_entity" as const,
      fullName: "Saved seller",
      displayName: "Seller",
      inn: "234106228141",
      kpp: "773601001",
      ogrn: "1027700132195",
      addressRaw: "Moscow",
      legalAddressRaw: "Moscow",
      isConfirmed: true,
      confirmedByPlatformUserId: actor.userId,
      confirmedAt: new Date("2026-09-01T00:00:00Z"),
      createdByPlatformUserId: actor.userId,
    };
    await db.insert(schema.operatorBillingProfiles).values(party);
    await db
      .insert(schema.tenantBillingProfiles)
      .values({ ...party, tenantId, fullName: "Saved buyer", inn: "7710140679" });
    await db.insert(schema.operatorBankAccounts).values({
      label: "Default",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "Test bank",
      correspondentAccount: "30101810400000000225",
      isDefault: true,
      createdByPlatformUserId: actor.userId,
    });
  });
  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });
  async function draft() {
    const offer = await offers.create(actor, {
      tenantId,
      expiresAt: null,
      termsMarkdown: "## Saved terms\n\n<script>alert(1)</script>",
      lines: [
        {
          kind: "service",
          catalogVersionId: null,
          nameRu: "Actual <line>",
          nameEn: "Line",
          quantity: 1,
          unit: "шт",
          agreedUnitPrice: "100.00",
          vatRateBps: 2000,
          vatIncluded: false,
          priceOverrideReason: null,
          activationPolicy: null,
        },
      ],
    });
    await db
      .update(schema.commercialOffers)
      .set({ revision: 5 })
      .where(eq(schema.commercialOffers.id, offer.id));
    return offer.id;
  }

  it("previews actual saved input without issuing anything and refuses changed inputs before publication", async () => {
    const id = await draft();
    const notificationsBefore = enqueue.mock.calls.length;
    const first = await preview.preview(actor, id);
    expect(first.html).toContain("Черновик. Не выпущен");
    expect(first.html).toContain("Actual &lt;line&gt;");
    expect(first.html).toContain("Saved terms");
    expect(first.html).toContain("Saved buyer");
    expect(first.html).not.toContain("<script>");
    expect(first.html).not.toContain("01.01.1970");
    expect(first.html).not.toContain("data-barcode-value");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await preview.preview(actor, id)).fingerprint).toBe(first.fingerprint);
    await db
      .update(schema.commercialOffers)
      .set({ updatedAt: new Date("2026-09-10T23:59:00Z") })
      .where(eq(schema.commercialOffers.id, id));
    await db
      .update(schema.commercialOfferLines)
      .set({ createdAt: new Date("2026-09-10T23:59:00Z") })
      .where(eq(schema.commercialOfferLines.offerId, id));
    expect((await preview.preview(actor, id)).fingerprint).toBe(first.fingerprint);
    expect(await offers.detail(actor, id)).toMatchObject({
      status: "draft",
      number: null,
      publishedAt: null,
    });
    expect(
      await db
        .select()
        .from(schema.commercialOfferPrintSnapshots)
        .where(eq(schema.commercialOfferPrintSnapshots.offerId, id)),
    ).toEqual([]);
    expect(await documents.list(id)).toEqual([]);
    expect(objects.size).toBe(0);
    expect(enqueue.mock.calls.length).toBe(notificationsBefore);
    await db
      .update(schema.tenantBillingProfiles)
      .set({ fullName: "Changed buyer" })
      .where(eq(schema.tenantBillingProfiles.tenantId, tenantId));
    await expect(offers.publish(actor, id, first.fingerprint)).rejects.toMatchObject({
      response: { code: "offer_preview_changed" },
      status: 409,
    });
    expect(await offers.detail(actor, id)).toMatchObject({ status: "draft", number: null });
    const fresh = await preview.preview(actor, id);
    await offers.publish(actor, id, fresh.fingerprint);
    const [snapshot] = await db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    expect(snapshot).toMatchObject({
      subtotal: "100.00",
      vatTotal: "20.00",
      total: "120.00",
      revision: 5,
    });
    expect(snapshot?.linesSnapshot).toMatchObject([{ lineTotal: "120.00" }]);
  });

  it("reports missing requisites and denies read without capability", async () => {
    const id = await draft();
    await expect(preview.preview({ ...actor, capabilities: [] }, id)).rejects.toMatchObject({
      status: 403,
    });
    await db
      .update(schema.tenantBillingProfiles)
      .set({ isConfirmed: false, confirmedAt: null, confirmedByPlatformUserId: null })
      .where(eq(schema.tenantBillingProfiles.tenantId, tenantId));
    await expect(preview.preview(actor, id)).rejects.toMatchObject({
      response: { code: "billing_profile_unconfirmed" },
    });
    await db
      .update(schema.tenantBillingProfiles)
      .set({ isConfirmed: true, confirmedAt: new Date(), confirmedByPlatformUserId: actor.userId })
      .where(eq(schema.tenantBillingProfiles.tenantId, tenantId));
  });

  it("coexists at revision 5, retries only failed PDF, serializes concurrent attempts, and retains ready bytes", async () => {
    const id = await draft();
    await offers.publish(actor, id);
    const offerBefore = await offers.detail(actor, id);
    const snapshotsBefore = await db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    const clean = await documents.render(id);
    const notificationsBefore = enqueue.mock.calls.length;
    expect(clean.revision).toBe(5);
    expect(clean.documents.map((item) => item.printVariant)).toEqual(["clean", "clean"]);
    const cleanObjects = new Map(objects);
    // The frozen seller authorizes images even after current billing data changes.
    await db.update(schema.operatorBillingProfiles).set({ inn: "7707083893" });
    failPdf = true;
    const signed = await documents.render(id, "signed", actor);
    expect(signed.documents.find((item) => item.format === "html")).toMatchObject({
      printVariant: "signed",
      status: "ready",
    });
    expect(signed.documents.find((item) => item.format === "pdf")).toMatchObject({
      status: "failed",
    });
    const signedHtml = signed.documents.find((item) => item.format === "html")!;
    const callsBefore = put.mock.calls.length;
    failPdf = false;
    const retries = await Promise.all([
      documents.render(id, "signed", actor),
      documents.render(id, "signed", actor),
    ]);
    expect(put.mock.calls.length - callsBefore).toBe(1);
    expect(retries[0]).toEqual(retries[1]);
    expect(retries[0]?.documents.find((item) => item.format === "html")).toEqual(signedHtml);
    for (const [key, bytes] of cleanObjects) expect(objects.get(key)).toEqual(bytes);
    const rows = await db
      .select()
      .from(schema.commercialOfferDocuments)
      .where(eq(schema.commercialOfferDocuments.offerId, id));
    expect(rows).toHaveLength(4);
    expect(
      tenantOfferDetailSchema.parse(await tenantRead.offerDetail(tenantId, id)).documents,
    ).toHaveLength(4);
    expect((await tenantRead.downloadOfferDocument(tenantId, id, signedHtml.id)).url).toContain(
      "/r5/signed/",
    );
    await expect(
      tenantRead.downloadOfferDocument(randomUUID(), id, signedHtml.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(await offers.detail(actor, id)).toEqual(offerBefore);
    expect(
      await db
        .select()
        .from(schema.commercialOfferPrintSnapshots)
        .where(eq(schema.commercialOfferPrintSnapshots.offerId, id)),
    ).toEqual(snapshotsBefore);
    await expect(documents.url(randomUUID(), signedHtml.id)).rejects.toMatchObject({
      response: { code: "offer_document_not_ready" },
    });
    for (const row of rows)
      expect(createHash("sha256").update(objects.get(row.objectKey!)!).digest("hex")).toBe(
        row.sha256,
      );
    expect(
      (await workspace.workspace(actor, id)).documents.filter(
        (item) => item.printVariant === "signed",
      ),
    ).toHaveLength(2);
    const events = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.targetId, id));
    expect(events.filter((event) => event.action === "billing.offer.documents.rendered")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorPlatformUserId: actor.userId,
          actorRole: actor.role,
          tenantId,
          targetType: "commercial_offer",
          targetId: id,
          outcome: "failure",
          after: {
            revision: 5,
            printVariant: "signed",
            documents: [
              { format: "html", status: "ready" },
              { format: "pdf", status: "failed" },
            ],
          },
        }),
      ]),
    );
    expect(events.filter((event) => event.action === "billing.offer.published")).toHaveLength(1);
    const successfulRenders = events.filter(
      (event) => event.action === "billing.offer.documents.rendered" && event.outcome === "success",
    );
    expect(successfulRenders).toHaveLength(2);
    for (const event of successfulRenders)
      expect(event).toMatchObject({
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        tenantId,
        targetType: "commercial_offer",
        targetId: id,
        after: {
          revision: 5,
          printVariant: "signed",
          documents: [
            { format: "html", status: "ready" },
            { format: "pdf", status: "ready" },
          ],
        },
      });
    expect(enqueue.mock.calls.length).toBe(notificationsBefore);
    await db.update(schema.operatorBillingProfiles).set({ inn: "234106228141" });
  });

  it.each([
    { status: "published", offset: -1, allowed: false },
    { status: "published", offset: 0, allowed: false },
    { status: "published", offset: 1, allowed: true },
    { status: "published", offset: null, allowed: true },
    { status: "paid", offset: -1, allowed: true },
    { status: "paid", offset: null, allowed: true },
  ] as const)(
    "checks signed generation at $status deadline offset $offset",
    async ({ status, offset, allowed }) => {
      const id = await draft();
      const now = new Date("2030-09-11T12:00:00.000Z");
      await db
        .update(schema.commercialOffers)
        .set({
          expiresAt: offset === null ? null : new Date(now.getTime() + offset),
        })
        .where(eq(schema.commercialOffers.id, id));
      await offers.publish(actor, id);
      if (status === "paid")
        await db
          .update(schema.commercialOffers)
          .set({ status })
          .where(eq(schema.commercialOffers.id, id));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        if (allowed) {
          const result = await documents.render(id, "signed", actor);
          expect(result.documents).toHaveLength(2);
          expect(result.documents.every((document) => document.status === "ready")).toBe(true);
        } else {
          const uploadsBefore = put.mock.calls.length;
          await expect(documents.render(id, "signed", actor)).rejects.toMatchObject({
            status: 409,
            response: { code: "offer_signed_variant_not_allowed" },
          });
          expect(await documents.list(id)).toEqual([]);
          expect(put.mock.calls.length).toBe(uploadsBefore);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps ready signed files readable after the published deadline elapses", async () => {
    const id = await draft();
    const deadline = new Date("2030-09-11T12:00:00.000Z");
    await db
      .update(schema.commercialOffers)
      .set({ expiresAt: deadline })
      .where(eq(schema.commercialOffers.id, id));
    await offers.publish(actor, id);
    const signed = await documents.render(id, "signed", actor);
    const rowsBefore = await documents.list(id);
    const snapshotsBefore = await db
      .select()
      .from(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    const uploadsBefore = put.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(deadline.getTime() + 1));
    try {
      for (const document of signed.documents) {
        expect((await documents.url(id, document.id)).url).toContain("/signed/");
        expect((await tenantRead.downloadOfferDocument(tenantId, id, document.id)).url).toContain(
          "/signed/",
        );
      }
      expect(await documents.list(id)).toEqual(rowsBefore);
      expect((await workspace.workspace(actor, id)).documents).toHaveLength(2);
      expect(put.mock.calls.length).toBe(uploadsBefore);
      expect(
        await db
          .select()
          .from(schema.commercialOfferPrintSnapshots)
          .where(eq(schema.commercialOfferPrintSnapshots.offerId, id)),
      ).toEqual(snapshotsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["draft", "cancelled", "expired", "superseded"] as const)(
    "denies signed generation for %s",
    async (status) => {
      const id = await draft();
      if (status !== "draft") await offers.publish(actor, id);
      await db
        .update(schema.commercialOffers)
        .set({ status })
        .where(eq(schema.commercialOffers.id, id));
      expect((await workspace.workspace(actor, id)).actions.addSignedVariant).toBe(false);
      await expect(documents.render(id, "signed", actor)).rejects.toMatchObject({ status: 409 });
    },
  );

  it("allows paid offers but denies missing snapshot, unauthorized frozen seller and missing write capability", async () => {
    const id = await draft();
    await offers.publish(actor, id);
    await db
      .update(schema.commercialOffers)
      .set({ status: "paid" })
      .where(eq(schema.commercialOffers.id, id));
    expect((await workspace.workspace(actor, id)).actions.addSignedVariant).toBe(true);
    await expect(
      documents.render(id, "signed", { ...actor, capabilities: ["billing.read"] }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await documents.render(id, "signed", actor)).documents.every(
        (item) => item.status === "ready",
      ),
    ).toBe(true);
    await db
      .update(schema.commercialOfferPrintSnapshots)
      .set({ sellerSnapshot: { inn: "7707083893" } })
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    expect((await workspace.workspace(actor, id)).actions.addSignedVariant).toBe(false);
    await expect(documents.render(id, "signed", actor)).rejects.toMatchObject({
      response: { code: "signed_print_seller_not_authorized" },
    });
    await db
      .update(schema.commercialOfferPrintSnapshots)
      .set({ sellerSnapshot: { taxId: "234106228141", legalName: "Legacy seller" } })
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    const legacy = await workspace.workspace(actor, id);
    expect(legacy.parties.seller).toBeNull();
    expect(legacy.actions.addSignedVariant).toBe(true);
    expect(
      (await documents.render(id, "signed", actor)).documents.every(
        (item) => item.status === "ready",
      ),
    ).toBe(true);
    await db
      .delete(schema.commercialOfferPrintSnapshots)
      .where(eq(schema.commercialOfferPrintSnapshots.offerId, id));
    expect((await workspace.workspace(actor, id)).actions.addSignedVariant).toBe(false);
    await expect(documents.render(id, "signed", actor)).rejects.toMatchObject({
      response: { code: "offer_print_snapshot_not_found" },
    });
  });

  it("serves no-store preview, denies unauthorized platform requests and accepts legacy empty publication/render bodies", async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformOffersController],
      providers: [
        { provide: PlatformOffersService, useValue: offers },
        { provide: OfferPreviewService, useValue: preview },
        { provide: OfferDocumentsService, useValue: documents },
        { provide: OfferWorkspaceService, useValue: workspace },
      ],
    }).compile();
    const app = module.createNestApplication();
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "fixture=platform" ? { user: { id: actor.userId } } : null,
      },
    };
    app.useGlobalGuards(new PlatformAuthGuard(new Reflector(), auth as never, db, audit));
    await app.init();
    await listenOnLoopback(app);
    try {
      const id = await draft();
      await request(app.getHttpServer()).get(`/platform/offers/${id}/preview`).expect(401);
      const response = await request(app.getHttpServer())
        .get(`/platform/offers/${id}/preview`)
        .set("Cookie", "fixture=platform")
        .expect(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).toMatchObject({
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        html: expect.stringContaining("Черновик. Не выпущен"),
      });
      await request(app.getHttpServer())
        .post(`/platform/offers/${id}/publish`)
        .set("Cookie", "fixture=platform")
        .send({ previewFingerprint: "not-a-hash" })
        .expect(400);
      await request(app.getHttpServer())
        .post(`/platform/offers/${id}/publish`)
        .set("Cookie", "fixture=platform")
        .expect(200);
      const clean = await request(app.getHttpServer())
        .post(`/platform/offers/${id}/documents`)
        .set("Cookie", "fixture=platform")
        .expect(201);
      expect(clean.body.documents).toHaveLength(2);
      expect(
        clean.body.documents.every(
          (item: { printVariant: string }) => item.printVariant === "clean",
        ),
      ).toBe(true);
      await db
        .update(schema.platformUsers)
        .set({ role: "support" })
        .where(eq(schema.platformUsers.id, actor.userId));
      await request(app.getHttpServer())
        .get(`/platform/offers/${id}/preview`)
        .set("Cookie", "fixture=platform")
        .expect(403);
      await request(app.getHttpServer())
        .post(`/platform/offers/${id}/documents`)
        .set("Cookie", "fixture=platform")
        .send({ printVariant: "signed" })
        .expect(403);
    } finally {
      await db
        .update(schema.platformUsers)
        .set({ role: actor.role })
        .where(eq(schema.platformUsers.id, actor.userId));
      await app.close();
    }
  });
});
