import { eq, and, inArray } from "drizzle-orm";
import { NationalCatalogLinkRefreshService } from "../src/modules/national-catalog/national-catalog-link-refresh.service";
import type {
  NationalCatalogRequestCoordinator,
  CatalogTransport,
} from "../src/modules/national-catalog/national-catalog-request-coordinator";
import type { NationalCatalogProduct } from "../src/modules/national-catalog/national-catalog.types";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { NationalCatalogLinkService } from "../src/modules/national-catalog/national-catalog-link.service";
import { createManagedSubscription, createOrganization } from "./support/subscription-fixtures";

function localObservationDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname.length <= 1 ||
    url.search !== ""
  )
    throw new Error("Requires a local PostgreSQL test database");
  return url;
}
it("admits disposable CI and named local test URLs without connecting to them", () => {
  // These calls only parse URLs; no connection or database hooks are invoked.
  expect(
    localObservationDatabaseUrl("postgres://markiro:markiro@localhost:5432/markiro").pathname,
  ).toBe("/markiro");
  expect(localObservationDatabaseUrl("postgresql://test@127.0.0.1/catalog_test").pathname).toBe(
    "/catalog_test",
  );
  for (const value of [
    "postgres://test@database.example/markiro",
    "postgres://test@10.0.0.1/markiro",
    "postgres://test@localhost/markiro?host=database.example",
    "https://localhost/markiro",
    "postgres://test@localhost/",
  ])
    expect(() => localObservationDatabaseUrl(value)).toThrow();
});
const databaseUrl = process.env.DATABASE_URL
  ? localObservationDatabaseUrl(process.env.DATABASE_URL)
  : null;
describe.skipIf(!databaseUrl)("confirmed-link observations with local PostgreSQL", () => {
  let connection: ReturnType<typeof createDb> | undefined;
  let db: ReturnType<typeof createDb>["db"];
  let authorization: AuthorizationService;
  let entitlements: EntitlementsService;
  beforeAll(() => {
    if (!databaseUrl) throw new Error("Requires a local PostgreSQL test database");
    connection = createDb(databaseUrl.toString());
    db = connection.db;
    authorization = new AuthorizationService(db);
    entitlements = new EntitlementsService(db, "managed_only");
  });
  let tenantId: string;
  let userId: string;
  let productId: string;
  let linkId: string;
  const fairnessTenants: string[] = [];
  afterEach(async () => {
    if (fairnessTenants.length)
      await db
        .update(schema.nationalCatalogProductLinks)
        .set({ updatedAt: new Date() })
        .where(inArray(schema.nationalCatalogProductLinks.tenantId, fairnessTenants.splice(0)));
  });
  afterAll(async () => connection?.pool.end());
  beforeEach(async () => {
    tenantId = await createOrganization(db);
    userId = randomUUID();
    productId = randomUUID();
    linkId = randomUUID();
    await db.insert(schema.user).values({
      id: userId,
      name: "Refresh actor",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId,
      organizationId: tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await createManagedSubscription(db, { tenantId });
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "sandbox" } });
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: "04601234567893", name: "Local" });
    await db.insert(schema.nationalCatalogProductLinks).values({
      id: linkId,
      tenantId,
      productId,
      environment: "sandbox",
      cardId: "720679",
      boundGtin14: "04601234567893",
      confirmedBy: userId,
      reviewedMeaningfulHash: "a".repeat(64),
      observedMeaningfulHash: "b".repeat(64),
    });
  });
  describe("durable confirmed-link observations", () => {
    it("does not claim supported changes from hash inequality without per-target evidence", async () => {
      const links = new NationalCatalogLinkService(db, authorization, entitlements);
      expect((await links.read(tenantId, productId)).hasChanges).toBe(false);
    });
  });

  it("deduplicates manual refresh without losing its admitted initiator", async () => {
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const service = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => {
          throw new Error("enqueue must not call provider");
        },
      },
      {
        run: async () => {
          throw new Error("enqueue must not call coordinator");
        },
        runExternal: async () => {
          throw new Error("enqueue must not call CDN");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    await service.request({ tenantId, userId }, productId);
    await service.request({ tenantId, userId }, productId);
    const { eq } = await import("drizzle-orm");
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    expect(link?.refreshCheckpoint).toMatchObject({
      actor: { kind: "manual", userId },
      phase: "card",
      attempts: 0,
      enqueuePending: true,
    });
  });

  const GTIN = "04601234567893";
  const projection = (name: string) => ({ version: 1, values: { name }, context: null });
  const source = (name = "Observed"): NationalCatalogProduct => ({
    id: 720679,
    name,
    status: "published",
    detailedStatuses: ["draft", "future-status"],
    identifiers: [{ value: GTIN, type: "gtin", level: null, multiplier: null }],
    categories: [],
    attributes: [],
    images: [],
    imageIssues: [],
    raw: { good_id: 720679 },
  });
  const transport: CatalogTransport = {
    auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
    signal: new AbortController().signal,
  };
  const coordinator: Pick<NationalCatalogRequestCoordinator, "run" | "runExternal"> = {
    run: async (_context, fn) => fn(transport),
    runExternal: async (_context, fn) => fn(transport.signal),
  };
  function worker(fetch = async () => source()) {
    return new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async (auth, ids, options) => {
          expect(ids).toEqual(["720679"]);
          expect(auth).toBe(transport.auth);
          expect(options?.signal).toBe(transport.signal);
          expect(options?.ifNoneMatch).toBeUndefined();
          return {
            status: "ok",
            value: { products: [await fetch()] },
            etag: null,
            contentHash: "c".repeat(64),
            usage: { total: null, method: null },
          };
        },
      },
      coordinator,
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
  }
  async function stored() {
    const [row] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    if (!row) throw new Error("missing link");
    return row;
  }
  async function baseline() {
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({
        reviewedProjection: projection("Reviewed"),
        observedProjection: projection("Reviewed"),
        statusKeys: ["draft"],
        lastSuccessAt: new Date("2026-09-08T09:00:00Z"),
        lastOutcome: "ok",
      })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
  }
  it("observes only the confirmed card and shows live local edits without touching review or product", async () => {
    await baseline();
    const service = worker();
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    const link = await stored();
    expect(link).toMatchObject({
      revision: 1,
      lastOutcome: "ok",
      reviewedProjection: projection("Reviewed"),
      statusKeys: ["published", "draft", "unknown"],
      rawDetailedStatuses: ["draft", "future-status"],
    });
    const reads = new NationalCatalogLinkService(db, authorization, entitlements);
    expect((await reads.read(tenantId, productId)).hasChanges).toBe(true);
    await db
      .update(schema.products)
      .set({ name: "Observed" })
      .where(eq(schema.products.id, productId));
    expect((await reads.read(tenantId, productId)).hasChanges).toBe(false);
    expect(link.reviewedMeaningfulHash).toBe("a".repeat(64));
  });
  it.each([false, true])(
    "rechecks revoked membership after provider success/failure: failure=%s",
    async (failed) => {
      await baseline();
      const before = await stored();
      const service = worker(async () => {
        await db
          .delete(schema.member)
          .where(and(eq(schema.member.userId, userId), eq(schema.member.organizationId, tenantId)));
        if (failed) throw new Error("private provider message");
        return source();
      });
      await service.request({ tenantId, userId }, productId);
      await service.resume(tenantId, linkId);
      await service.resume(tenantId, linkId);
      const link = await stored();
      expect(link).toMatchObject({
        lastOutcome: "error",
        refreshErrorCode: "access_changed",
        statusKeys: ["draft"],
        latestSnapshotId: null,
      });
      expect(link.lastSuccessAt).toEqual(before.lastSuccessAt);
      const audits = await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, tenantId),
            eq(schema.tenantAuditEvents.action, "national_catalog.link.refresh"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: userId,
        targetId: productId,
        targetType: "product",
        outcome: "failure",
        after: {
          linkId,
          phase: "card",
          actorKind: "manual",
          attempts: 1,
          reason: "access_changed",
        },
      });
    },
  );
  it("does not impersonate a former confirmer for periodic work", async () => {
    await baseline();
    await db.delete(schema.member).where(eq(schema.member.userId, userId));
    const service = worker();
    await service.schedule(tenantId, productId);
    await service.resume(tenantId, linkId);
    expect(await stored()).toMatchObject({
      lastOutcome: "ok",
      refreshCheckpoint: { actor: { kind: "system" } },
    });
  });
  it("preserves last good status when the confirmed card loses its bound GTIN", async () => {
    await baseline();
    const before = await stored();
    const service = worker(async () => ({ ...source(), identifiers: [] }));
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    const link = await stored();
    expect(link).toMatchObject({
      refreshErrorCode: "card_lost_gtin",
      lastOutcome: "error",
      statusKeys: ["draft"],
      latestSnapshotId: null,
    });
    expect(link.lastSuccessAt).toEqual(before.lastSuccessAt);
  });
  it("audits exhausted accepted work once before any HTTP admission", async () => {
    const fetch = vi.fn(async () => source());
    const service = worker(fetch);
    await service.request({ tenantId, userId }, productId);
    const cp = (await stored()).refreshCheckpoint;
    if (!cp || typeof cp !== "object") throw new Error("checkpoint");
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({ refreshCheckpoint: { ...cp, attempts: 4 } })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    await service.resume(tenantId, linkId);
    await service.resume(tenantId, linkId);
    expect(fetch).not.toHaveBeenCalled();
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audits.filter((a) => a.action === "national_catalog.link.refresh")).toHaveLength(1);
    expect(await stored()).toMatchObject({ refreshErrorCode: "retry_exhausted" });
  });
  it("cannot write over a review that changes the link revision during HTTP", async () => {
    await baseline();
    const service = worker(async () => {
      await db
        .update(schema.nationalCatalogProductLinks)
        .set({
          revision: 2,
          reviewedProjection: projection("New review"),
          observedProjection: projection("New review"),
          refreshCheckpoint: null,
        })
        .where(eq(schema.nationalCatalogProductLinks.id, linkId));
      return source();
    });
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    expect(await stored()).toMatchObject({
      revision: 2,
      latestSnapshotId: null,
      reviewedProjection: projection("New review"),
      observedProjection: projection("New review"),
      refreshCheckpoint: null,
    });
  });
  it("returns compact CHZ for products with tenant-isolated any-status filtering", async () => {
    const { ProductsService } = await import("../src/modules/products/products.service");
    const products = new ProductsService(db, {} as never, {} as never, {} as never);
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({ statusKeys: ["published", "draft"], rawStatus: "opaque-provider-status" })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    const unlinkedId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: unlinkedId, tenantId, gtin14: "04006381333931", name: "Unlinked" });
    const rows = await products.listProducts(tenantId, {});
    expect(rows.items.find((p) => p.id === productId)?.chz).toMatchObject({
      linkId,
      statusKeys: ["published", "draft"],
    });
    expect(rows.items.find((p) => p.id === unlinkedId)?.chz).toMatchObject({
      linkId: null,
      lastOutcome: "never",
    });
    expect(
      (await products.listProducts(tenantId, { chzStatus: "draft" })).items.map((p) => p.id),
    ).toEqual([productId]);
    expect(
      (await products.listProducts(tenantId, { chzStatus: "published" })).items.map((p) => p.id),
    ).toEqual([productId]);
    expect(
      (await products.listProducts(tenantId, { chzStatus: "unlinked" })).items.map((p) => p.id),
    ).toEqual([unlinkedId]);
    expect(
      (await products.listProducts(await createOrganization(db), { chzStatus: "published" })).items,
    ).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("reviewedProjection");
    expect(JSON.stringify(rows)).not.toContain("sourceHash");
  });
  it.each([
    "same-url-new-bytes",
    "new-url-same-bytes",
    "download-fails",
    "ambiguous",
    "stale-photo",
  ])("observes normalized photo bytes with durable card/photo steps: %s", async (mode) => {
    const sharp = (await import("sharp")).default;
    const { processProductImage } = await import("../src/modules/media/product-image-processor");
    const { photoSelector } =
      await import("../src/modules/national-catalog/national-catalog-photo-selection");
    const oldBytes = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer();
    const newBytes = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "#994433" },
    })
      .png()
      .toBuffer();
    const checksum = (await processProductImage(oldBytes)).checksum;
    const oldImage = {
      sourceId: "good_images:0",
      barcode: GTIN,
      primary: true,
      url: "https://images.example/old",
    };
    const image = {
      ...oldImage,
      sourceId: "good_images:5",
      url: mode === "new-url-same-bytes" ? "https://images.example/new" : oldImage.url,
    };
    const reviewed = { version: 1, values: { name: "Reviewed", photo: checksum }, context: null };
    await baseline();
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({
        reviewedProjection: reviewed,
        observedProjection: reviewed,
        reviewedPhoto: {
          version: 1,
          snapshotId: randomUUID(),
          sourceHash: "d".repeat(64),
          candidateId: randomUUID(),
          selector: photoSelector(oldImage),
          checksum,
          choice: "keep",
        },
      })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    const fetch = vi.fn(async () => ({
      status: "ok" as const,
      value: {
        products: [
          {
            ...source("Reviewed"),
            images:
              mode === "ambiguous" ? [image, { ...image, sourceId: "good_images:7" }] : [image],
          },
        ],
      },
      etag: null,
      contentHash: "e".repeat(64),
      usage: { total: null, method: null },
    }));
    const download = vi.fn(async (url: string, _policy: unknown, deps: unknown) => {
      expect(url).toBe(image.url);
      expect(deps).toEqual({ signal: transport.signal });
      if (mode === "stale-photo")
        await db
          .update(schema.nationalCatalogProductLinks)
          .set({
            revision: 2,
            reviewedProjection: projection("New review"),
            observedProjection: projection("New review"),
            refreshCheckpoint: null,
            statusKeys: ["errors"],
          })
          .where(eq(schema.nationalCatalogProductLinks.id, linkId));
      if (mode === "download-fails") throw new Error("secret source error");
      return mode === "same-url-new-bytes" ? newBytes : oldBytes;
    });
    const service = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      { getFeedProductsByIds: fetch },
      coordinator,
      { enabled: true, photos: { enabled: true, verifiedHosts: ["images.example"] } },
      download,
    );
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    const card = await stored();
    expect(card.lastOutcome).toBe("ok");
    expect(card.latestSnapshotId).not.toBeNull();
    // Reconstruct the worker to prove the durable phase does not rely on process memory.
    const repaired = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      { getFeedProductsByIds: fetch },
      coordinator,
      { enabled: true, photos: { enabled: true, verifiedHosts: ["images.example"] } },
      download,
    );
    await repaired.resume(tenantId, linkId);
    const link = await stored();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(mode === "ambiguous" ? 0 : 1);
    expect(link.latestSnapshotId).toBe(card.latestSnapshotId);
    expect(link.lastSuccessAt).toEqual(card.lastSuccessAt);
    if (mode === "stale-photo") {
      expect(link).toMatchObject({
        revision: 2,
        reviewedProjection: projection("New review"),
        observedProjection: projection("New review"),
        refreshCheckpoint: null,
        statusKeys: ["errors"],
      });
      return;
    }
    expect(link.reviewedProjection).toEqual(reviewed);
    const summary = await new NationalCatalogLinkService(db, authorization, entitlements).read(
      tenantId,
      productId,
    );
    expect(summary.hasChanges).toBe(mode === "same-url-new-bytes");
    if (mode === "download-fails")
      expect(summary).toMatchObject({
        lastOutcome: "error",
        lastErrorCode: "photo_unavailable",
        statusKeys: ["published", "draft", "unknown"],
      });
  });
  it("rotates tenants even when a tenant has many never-attempted confirmed links", async () => {
    fairnessTenants.push(tenantId);
    const { DrizzleNationalCatalogFreshnessRepository } =
      await import("../src/modules/national-catalog/national-catalog-freshness.service");
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({ updatedAt: new Date("1970-01-01T00:00:00Z") })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    const second = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: second, tenantId, gtin14: "04006381333931", name: "Second" });
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId,
      productId: second,
      environment: "sandbox",
      cardId: "second",
      boundGtin14: "04006381333931",
      confirmedBy: userId,
      updatedAt: new Date("1970-01-02T00:00:00Z"),
    });
    const otherTenant = await createOrganization(db),
      otherProduct = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: otherProduct, tenantId: otherTenant, gtin14: GTIN, name: "Other" });
    fairnessTenants.push(otherTenant);
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId: otherTenant,
      productId: otherProduct,
      environment: "sandbox",
      cardId: "other",
      boundGtin14: GTIN,
      confirmedBy: userId,
      updatedAt: new Date("1971-01-01T00:00:00Z"),
    });
    const repository = new DrizzleNationalCatalogFreshnessRepository(db);
    expect(await repository.listDueProducts(1)).toEqual([{ tenantId, productId }]);
    await worker().schedule(tenantId, productId);
    await repository.advanceScheduledAt(tenantId, productId, new Date());
    expect(await repository.listDueProducts(1)).toEqual([
      { tenantId: otherTenant, productId: otherProduct },
    ]);
  });
  it("persists admission attempts through reconstruction and dedupes a deferred manual refresh", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("remote transport failed");
    });
    let service = worker(fetch);
    await service.request({ tenantId, userId }, productId);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await service.resume(tenantId, linkId);
      const link = await stored();
      expect(link.refreshCheckpoint).toMatchObject({
        attempts: attempt,
        enqueuePending: attempt < 4,
      });
      if (attempt < 4) {
        await service.request({ tenantId, userId }, productId);
        expect((await stored()).refreshCheckpoint).toEqual(link.refreshCheckpoint);
        const cp = link.refreshCheckpoint;
        if (!cp || typeof cp !== "object") throw new Error("checkpoint");
        await db
          .update(schema.nationalCatalogProductLinks)
          .set({ refreshCheckpoint: { ...cp, nextRetryAt: "2020-01-01T00:00:00.000Z" } })
          .where(eq(schema.nationalCatalogProductLinks.id, linkId));
        service = worker(fetch);
      }
    }
    await service.resume(tenantId, linkId);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await stored()).toMatchObject({ refreshErrorCode: "retry_exhausted" });
  });
  it("audits revoked eligibility before network once and keeps last good source data", async () => {
    await baseline();
    const fetch = vi.fn(async () => source());
    const service = worker(fetch);
    await service.request({ tenantId, userId }, productId);
    await db.delete(schema.member).where(eq(schema.member.userId, userId));
    await service.resume(tenantId, linkId);
    await service.resume(tenantId, linkId);
    expect(fetch).not.toHaveBeenCalled();
    const events = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "national_catalog.link.refresh"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: userId,
      targetId: productId,
      outcome: "failure",
      after: { phase: "card", attempts: 0, reason: "access_changed" },
    });
    expect(await stored()).toMatchObject({
      statusKeys: ["draft"],
      refreshErrorCode: "access_changed",
    });
  });
  it("rejects stale local GTIN without rebinding the confirmed card", async () => {
    await baseline();
    await db
      .update(schema.products)
      .set({ gtin14: "04006381333931" })
      .where(eq(schema.products.id, productId));
    const fetch = vi.fn(async () => source());
    const service = worker(fetch);
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    expect(fetch).not.toHaveBeenCalled();
    expect(await stored()).toMatchObject({
      cardId: "720679",
      boundGtin14: GTIN,
      refreshErrorCode: "local_gtin_changed",
      statusKeys: ["draft"],
    });
  });
  it("consumes no HTTP attempt when the shared coordinator defers quota admission", async () => {
    const { CatalogRequestError } =
      await import("../src/modules/national-catalog/national-catalog-request-coordinator");
    const service = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => {
          throw new Error("not admitted");
        },
      },
      {
        run: async () => {
          throw new CatalogRequestError("deferred", "quota_wait", new Date(Date.now() + 300_000));
        },
        runExternal: coordinator.runExternal,
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    expect(await stored()).toMatchObject({
      lastAttemptAt: null,
      refreshErrorCode: "quota_wait",
      refreshCheckpoint: { attempts: 0, enqueuePending: true, runId: null },
    });
  });
  it("hides actionable changes for explicit archive and restores them after unarchive without reviewing values", async () => {
    await baseline();
    let archived = true;
    const service = worker(async () => ({
      ...source(),
      status: archived ? "archived" : "published",
      detailedStatuses: [],
    }));
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    const reads = new NationalCatalogLinkService(db, authorization, entitlements);
    expect(await reads.read(tenantId, productId)).toMatchObject({
      statusKeys: ["archived"],
      hasChanges: false,
      lastOutcome: "ok",
    });
    const saved = await stored();
    expect(saved.observedProjection).toEqual(projection("Observed"));
    expect(saved.reviewedProjection).toEqual(projection("Reviewed"));
    expect(saved.lastSuccessAt).not.toBeNull();
    archived = false;
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    expect(await reads.read(tenantId, productId)).toMatchObject({
      statusKeys: ["published"],
      hasChanges: true,
    });
    expect((await stored()).reviewedProjection).toEqual(projection("Reviewed"));
  });
  it("keeps a whole legacy-null review unknown after a successful new source observation", async () => {
    const service = worker();
    await service.request({ tenantId, userId }, productId);
    await service.resume(tenantId, linkId);
    expect(
      await new NationalCatalogLinkService(db, authorization, entitlements).read(
        tenantId,
        productId,
      ),
    ).toMatchObject({ lastOutcome: "ok", hasChanges: false });
    expect(await stored()).toMatchObject({ reviewedProjection: null, observedProjection: null });
  });
});
