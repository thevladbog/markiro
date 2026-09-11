import sharp from "sharp";
import { PgBoss, type JobWithMetadata } from "pg-boss";
import { createHash } from "node:crypto";
import { ProductsService } from "../src/modules/products/products.service";
import { MediaAssetsService } from "../src/modules/media/media-assets.service";
import type { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import type { OrgProfileService } from "../src/modules/org-profile/org-profile.service";
import { CatalogRequestError } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import { canonicalImportDecisions } from "../src/modules/national-catalog/national-catalog-import-apply-state";
import { randomUUID } from "node:crypto";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImportApply, type ImportPreview } from "@markiro/platform-contracts";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportRepository } from "../src/modules/national-catalog/national-catalog-import.repository";
import { NationalCatalogRequestCoordinator } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import { buildImportPreview } from "../src/modules/national-catalog/national-catalog-import-preview-builder";
import { NationalCatalogImageService } from "../src/modules/national-catalog/national-catalog-image.service";
import { NationalCatalogImportApplyService } from "../src/modules/national-catalog/national-catalog-import-apply.service";
import type { NationalCatalogProduct } from "../src/modules/national-catalog/national-catalog.types";
import { createManagedSubscription, createOrganization } from "./support/subscription-fixtures";

const GTIN = "04601234567893";
if (!process.env.DATABASE_URL) throw new Error("Apply tests require local PostgreSQL");
describe("private National Catalog images (real PostgreSQL and normalized bytes)", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const db: Db = connection.db;
  let actor: { tenantId: string; userId: string };
  let repository: NationalCatalogImportRepository;
  let sessions: NationalCatalogImportService;

  let sessionId: string;
  let itemId: string;
  let source: NationalCatalogProduct;
  let existingId: string;
  beforeAll(async () => {
    await connection.pool.query("select 1");
  });
  afterAll(async () => {
    await connection.pool.end();
  });
  beforeEach(async () => {
    actor = { tenantId: await createOrganization(db), userId: randomUUID() };
    await db.insert(schema.user).values({
      id: actor.userId,
      name: "Apply actor",
      email: `${actor.userId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: actor.userId,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(schema.integrationChannels).values({
      tenantId: actor.tenantId,
      type: "chestny_znak",
      settings: { environment: "sandbox" },
    });
    await createManagedSubscription(db, { tenantId: actor.tenantId });
    repository = new NationalCatalogImportRepository(db);
    // No provider call belongs to apply. Coordinator is never used by this fixture.
    const coordinator = Object.create(
      NationalCatalogRequestCoordinator.prototype,
    ) as NationalCatalogRequestCoordinator;
    sessions = new NationalCatalogImportService(
      repository,
      { listOwnProducts: vi.fn(), getFeedProducts: vi.fn() },
      coordinator,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      { ownCatalog: true, gtinLookup: true },
    );
    sessionId = (await sessions.start(actor, { mode: "gtins", text: GTIN })).id;
    existingId = randomUUID();
    await db.insert(schema.products).values({
      id: existingId,
      tenantId: actor.tenantId,
      gtin14: GTIN,
      name: "Моё имя",
      boxCapacity: 12,
      palletBoxCapacity: 60,
      unitPrice: "19.20",
      externalRef: "1C-unchanged",
    });
    itemId = randomUUID();
    await db.insert(schema.nationalCatalogImportItems).values({
      id: itemId,
      tenantId: actor.tenantId,
      sessionId,
      gtin14: GTIN,
      cardId: "720679",
      match: "existing",
      productId: existingId,
      selected: true,
      selectable: true,
    });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ loaded: 1, selected: 1 })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    source = {
      id: 720679,
      name: "Из ЧЗ",
      status: "published",
      detailedStatuses: [],
      identifiers: [{ value: GTIN, type: "gtin", level: null, multiplier: null }],
      categories: [],
      attributes: [],
      images: [],
      imageIssues: [],
      raw: { good_id: 720679, good_name: "Из ЧЗ" },
    };
  });
  async function preview(
    manualName?: string,
    optionId?: string,
    preparationActorId = actor.userId,
    enabled = true,
  ) {
    return repository.transaction(async (tx) => {
      const session = await repository.lock(tx, actor.tenantId, sessionId);
      const [item] = await tx
        .select()
        .from(schema.nationalCatalogImportItems)
        .where(
          and(
            eq(schema.nationalCatalogImportItems.tenantId, actor.tenantId),
            eq(schema.nationalCatalogImportItems.id, itemId),
          ),
        );
      if (!item) throw new Error("fixture item");
      return buildImportPreview(
        tx,
        session,
        item,
        source,
        {
          requestId: randomUUID(),
          itemIds: [itemId],
          manualNames: manualName ? [{ itemId, name: manualName }] : [],
          categoryChoices: optionId ? [{ itemId, optionId }] : [],
        },
        { actorId: preparationActorId, enabled },
      );
    });
  }
  it("queues a durable default for the actual preparation actor and keeps GET stored-only", async () => {
    source.images = [
      { sourceId: "good_img", url: "https://images.example/a", barcode: GTIN, primary: true },
    ];
    const p = await preview();
    const [image] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.previewId, p.id));
    expect(image?.preparationActorId).toBe(actor.userId);
    expect(image?.preparationCheckpoint).toMatchObject({
      version: 1,
      attempts: 0,
      enqueuePending: true,
    });
    expect(p.photos[0]?.selectedByDefault).toBe(true);
    expect(NationalCatalogImageService).toBeDefined();
  });
  function runtime(downloadError?: Error) {
    const objects = new Map<string, Buffer>();
    const storage = {
      put: vi.fn(async (key: string, body: Buffer) => {
        objects.set(key, Buffer.from(body));
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        if (!body) throw new Error("missing");
        return { body: Buffer.from(body), contentType: "image/webp" };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
    const media = new MediaAssetsService(db, storage as unknown as ObjectStorageService);
    const products = new ProductsService(
      db,
      {} as OrgProfileService,
      media,
      storage as unknown as ObjectStorageService,
    );
    const download = vi.fn(async () => {
      if (downloadError) throw downloadError;
      return sharp({ create: { width: 80, height: 40, channels: 3, background: "#2463eb" } })
        .png()
        .toBuffer();
    });
    const coordinator: Pick<NationalCatalogRequestCoordinator, "runExternal"> = {
      runExternal: vi.fn(async (_context, work) => work(new AbortController().signal)),
    };
    const service = new NationalCatalogImageService(
      repository,
      sessions,
      coordinator,
      storage,
      products,
      { enabled: true, verifiedHosts: ["images.example"] },
      download,
    );
    return { service, media, products, download, coordinator, storage, objects };
  }
  function photos() {
    source.images = [
      { sourceId: "good_img", url: "https://images.example/default", barcode: GTIN, primary: true },
    ];
  }
  it("prepares the main source photo with an existing local photo and leaves alternatives idle until requested", async () => {
    const rt = runtime();
    const currentAssetId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: currentAssetId,
      ownerTenantId: actor.tenantId,
      objectKey: `test/${currentAssetId}`,
      contentType: "image/webp",
      byteSize: 10,
      checksum: "f".repeat(64),
      width: 10,
      height: 10,
      status: "active",
    });
    await db.insert(schema.productImages).values({
      tenantId: actor.tenantId,
      productId: existingId,
      assetId: currentAssetId,
    });
    source.images = [
      { sourceId: "main", url: "https://images.example/main", barcode: GTIN, primary: true },
      {
        sourceId: "alternative",
        url: "https://images.example/other",
        barcode: GTIN,
        primary: false,
      },
    ];
    const p = await preview();
    const main = p.photos[0];
    const alternative = p.photos[1];
    if (!main || !alternative) throw new Error("Missing photo candidates");
    expect(main).toMatchObject({
      state: "pending",
      selectedByDefault: false,
      automaticWorkPending: true,
    });
    expect(alternative).toMatchObject({
      state: "pending",
      selectedByDefault: false,
      automaticWorkPending: false,
    });
    const rows = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.previewId, p.id));
    expect(
      rows.find((row) => row.candidateId === main.candidateId)?.preparationCheckpoint,
    ).toMatchObject({ enqueuePending: true });
    expect(
      rows.find((row) => row.candidateId === alternative.candidateId)?.preparationCheckpoint,
    ).toBeNull();
    await rt.service.resume(actor.tenantId, sessionId, p.id, main.candidateId);
    expect(await rt.service.prepare(actor, sessionId, p.id, main.candidateId)).toMatchObject({
      state: "ready",
      automaticWorkPending: false,
    });
    expect(await rt.service.prepare(actor, sessionId, p.id, alternative.candidateId)).toMatchObject(
      { state: "pending", automaticWorkPending: true },
    );
    await rt.service.resume(actor.tenantId, sessionId, p.id, alternative.candidateId);
    expect(await rt.service.prepare(actor, sessionId, p.id, alternative.candidateId)).toMatchObject(
      { state: "ready", automaticWorkPending: false },
    );
    const [current] = await db
      .select()
      .from(schema.productImages)
      .where(
        and(
          eq(schema.productImages.tenantId, actor.tenantId),
          eq(schema.productImages.productId, existingId),
        ),
      );
    expect(current?.assetId).toBe(currentAssetId);
  });
  async function prepared(rt: ReturnType<typeof runtime>) {
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId;
    if (!id) throw new Error("missing candidate");
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    return { p, id };
  }
  async function accept(p: ImportPreview, id: string, keep = false) {
    const apply = new NationalCatalogImportApplyService(repository, sessions);
    const body: ImportApply = {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: [],
          linkAction: p.linkAction,
          photo: keep
            ? { kind: "keep", reviewedCandidateId: id }
            : { kind: "candidate", candidateId: id },
        },
      ],
    };
    const result = await apply.start(actor, sessionId, body);
    await apply.resume(actor.tenantId, result.operationId);
    return { apply, result, body };
  }
  it("stages normalized bytes once, previews and applies identical bytes, replays without writes", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const shown = await rt.service.readPreview(actor.tenantId, sessionId, id);
    expect(await sharp(shown.buffer).metadata()).toMatchObject({
      format: "webp",
      width: 80,
      height: 40,
    });
    const checksum = createHash("sha256").update(shown.buffer).digest("hex");
    const { apply, result } = await accept(p, id);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({ product: "applied", image: "pending" });
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({ product: "applied", image: "applied" });
    const [active] = await db
      .select()
      .from(schema.productImages)
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
      .where(eq(schema.productImages.productId, existingId));
    expect(active?.media_assets.checksum).toBe(checksum);
    expect(rt.objects.get(active?.media_assets.objectKey ?? "")).toEqual(shown.buffer);
    expect(rt.download).toHaveBeenCalledTimes(1);
    expect(rt.storage.put).toHaveBeenCalledTimes(1);
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
          eq(schema.tenantAuditEvents.action, "product.image.uploaded"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: actor.userId,
      targetId: existingId,
      outcome: "success",
    });
  });
  it("rejects pending candidate acceptance", async () => {
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    await expect(accept(p, id)).rejects.toThrow("image_not_ready");
  });
  it("rejects deleting asset acceptance", async () => {
    const rt = runtime();
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    const [row] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    await db
      .update(schema.mediaAssets)
      .set({ status: "deleting" })
      .where(eq(schema.mediaAssets.id, row?.stagedAssetId ?? ""));
    await expect(accept(p, id)).rejects.toThrow("prepared_image_changed");
    expect(
      await db
        .select()
        .from(schema.nationalCatalogImportOperations)
        .where(eq(schema.nationalCatalogImportOperations.tenantId, actor.tenantId)),
    ).toHaveLength(0);
  });
  it("uses actual preparation initiator and does not reset a queued step on polling", async () => {
    const other = randomUUID();
    await db
      .insert(schema.user)
      .values({ id: other, name: "Preparer", email: `${other}@example.test`, emailVerified: true });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: other,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    photos();
    const p = await preview(undefined, undefined, other);
    const id = p.photos[0]?.candidateId ?? "";
    const rt = runtime();
    await rt.service.prepare(actor, sessionId, p.id, id);
    const [row] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    expect(row?.preparationActorId).toBe(other);
    expect(row?.preparationCheckpoint).toMatchObject({ attempts: 0 });
    await db.delete(schema.member).where(eq(schema.member.userId, other));
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    expect(rt.download).not.toHaveBeenCalled();
  });
  it("retains a foreign-GTIN warning after explicit preparation and never chooses it by default", async () => {
    source.images = [
      {
        sourceId: "good_images:0",
        url: "https://images.example/foreign",
        barcode: "04006381333931",
        primary: true,
      },
    ];
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    const rt = runtime();
    expect(p.photos[0]).toMatchObject({ selectedByDefault: false, reason: "barcode_mismatch" });
    await rt.service.prepare(actor, sessionId, p.id, id);
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    expect(await rt.service.prepare(actor, sessionId, p.id, id)).toMatchObject({
      state: "ready",
      reason: "barcode_mismatch",
      selectedByDefault: false,
    });
  });
  it("blocks cross-tenant and mismatched preview reads without downloading", async () => {
    const rt = runtime();
    const { id } = await prepared(rt);
    const other = await createOrganization(db);
    await expect(rt.service.readPreview(other, sessionId, id)).rejects.toThrow();
    await expect(rt.service.prepare(actor, sessionId, randomUUID(), id)).rejects.toThrow();
    expect(rt.download).toHaveBeenCalledTimes(1);
  });
  it("does not enqueue default preparation while disabled", async () => {
    photos();
    const p = await preview(undefined, undefined, actor.userId, false);
    const [image] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.previewId, p.id));
    expect(image?.preparationActorId).toBeNull();
    expect(image?.preparationCheckpoint).toBeNull();
  });
  it("rechecks revoked access on failing external response before recording provider failure", async () => {
    const rt = runtime();
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    rt.download.mockImplementationOnce(async () => {
      await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
      throw new CatalogRequestError("retry", "provider_failure", new Date());
    });
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    const [row] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    expect(row).toMatchObject({ state: "failed", errorCode: "image_access_changed" });
    expect(row?.preparationCheckpoint).toMatchObject({ attempts: 1, enqueuePending: false });
  });
  it("keeps durable attempts for admitted retries and no budget for quota deferral", async () => {
    const rt = runtime();
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    vi.mocked(rt.coordinator.runExternal).mockRejectedValueOnce(
      new CatalogRequestError("deferred", "tenant_busy", new Date()),
    );
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    let [row] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    expect(row?.preparationCheckpoint).toMatchObject({ attempts: 0, enqueuePending: true });
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    [row] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    expect(row).toMatchObject({ state: "ready" });
    expect(row?.preparationCheckpoint).toMatchObject({ attempts: 1, enqueuePending: false });
  });
  it("retains accepted bytes and original descriptor beyond TTL and applies with provider flags removed", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    const future = new Date(Date.now() + 48 * 3600_000);
    expect(await rt.service.releaseExpired(future)).toBeGreaterThanOrEqual(0);
    const [previewRow] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    expect(previewRow?.payloadPurgedAt).toBeNull();
    expect(previewRow?.previousPhoto).toBeNull();
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    await db
      .delete(schema.integrationChannels)
      .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "expired" })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect((await apply.read(actor.tenantId, sessionId, result.operationId)).items[0]?.image).toBe(
      "applied",
    );
    expect(rt.download).toHaveBeenCalledTimes(1);
  });
  it("keeps product success on photo conflict, including equal-checksum local replacement, and retry preserves decision", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    const [candidate] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    const replacement = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: replacement,
      ownerTenantId: actor.tenantId,
      objectKey: `tenants/${actor.tenantId}/replacement.webp`,
      contentType: "image/webp",
      checksum: candidate?.checksum ?? "",
      byteSize: candidate?.byteSize ?? 1,
      width: candidate?.width ?? 1,
      height: candidate?.height ?? 1,
      status: "active",
    });
    await db
      .insert(schema.productImages)
      .values({ tenantId: actor.tenantId, productId: existingId, assetId: replacement });
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    const first = (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0];
    expect(first).toMatchObject({
      product: "applied",
      image: "failed",
      imageReason: "product_image_changed",
    });
    const [before] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await apply.retry(actor, sessionId, result.operationId, [p.id]);
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    const [after] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(after?.decision).toEqual(before?.decision);
    expect(after?.appliedEvidence).toEqual(before?.appliedEvidence);
    expect(after).toMatchObject({
      productResult: "applied",
      imageResult: "failed",
      imageErrorCode: "product_image_changed",
    });
  });
  it("records keep-after-view baseline with a durable source selector and preserves old keep digest", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result, body } = await accept(p, id, true);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({ product: "applied", image: "none" });
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    expect(link?.reviewedPhoto).toMatchObject({
      choice: "keep",
      candidateId: id,
      selector: { sourceId: "good_img", barcode: GTIN, primary: true },
    });
    expect(link?.observedMeaningfulHash).toBe(link?.reviewedMeaningfulHash);
    const old: ImportApply = {
      ...body,
      decisions: body.decisions.map((d) => ({ ...d, photo: { kind: "keep" } })),
    };
    expect(canonicalImportDecisions(old).decisions[0]?.photo).toEqual({ kind: "keep" });
    expect(canonicalImportDecisions(old).hash).not.toBe(canonicalImportDecisions(body).hash);
    await expect(apply.start(actor, sessionId, old)).rejects.toThrow("import_request_mismatch");
    const shown = await rt.service.readPreview(actor.tenantId, sessionId, id);
    expect(JSON.stringify(link?.reviewedPhoto)).toContain(
      createHash("sha256").update(shown.buffer).digest("hex"),
    );
  });
  it("does not let old photo completion overwrite a newer review", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { result } = await accept(p, id);
    const newer = { marker: "newer source remains" };
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({
        reviewedPhoto: newer,
        reviewedMeaningfulHash: "b".repeat(64),
        observedMeaningfulHash: "c".repeat(64),
      })
      .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    expect(link).toMatchObject({
      reviewedPhoto: newer,
      reviewedMeaningfulHash: "b".repeat(64),
      observedMeaningfulHash: "c".repeat(64),
    });
  });
  it("reselects pending observed photos after a different explicit review and never reuses the old selector checksum", async () => {
    const rt = runtime();
    const first = await prepared(rt);
    await accept(first.p, first.id, true);
    source.images.push({
      sourceId: "alternative",
      url: "https://images.example/alternative",
      barcode: GTIN,
      primary: false,
    });
    const p = await preview();
    const alternative = p.photos[1]!;
    await rt.service.prepare(actor, sessionId, p.id, alternative.candidateId);
    await rt.service.resume(actor.tenantId, sessionId, p.id, alternative.candidateId);
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const { readRefreshCheckpoint } =
      await import("../src/modules/national-catalog/national-catalog-refresh-state");
    const linkQuery = () =>
      db
        .select()
        .from(schema.nationalCatalogProductLinks)
        .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    const download = vi.fn(async (_url: string) =>
      sharp({ create: { width: 20, height: 10, channels: 3, background: "#aa0000" } })
        .png()
        .toBuffer(),
    );
    const worker = new NationalCatalogLinkRefreshService(
      db,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      {
        getFeedProductsByIds: async () => ({
          status: "ok",
          value: { products: [source] },
          contentHash: "e".repeat(64),
          etag: null,
          usage: { total: null, method: null },
        }),
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async (_context, fn) => fn(new AbortController().signal),
      },
      { enabled: true, photos: { enabled: true, verifiedHosts: ["images.example"] } },
      download,
    );
    await worker.request(actor, existingId);
    const [initial] = await linkQuery();
    await worker.resume(actor.tenantId, initial!.id);
    const [observed] = await linkQuery();
    const before = readRefreshCheckpoint(observed!.refreshCheckpoint)!;
    expect(before.phase).toBe("photo");
    const result = await accept(p, alternative.candidateId, true);
    expect(
      (await result.apply.read(actor.tenantId, sessionId, result.result.operationId)).items[0]
        ?.product,
    ).toBe("applied");
    const [reviewed] = await linkQuery();
    const after = readRefreshCheckpoint(reviewed!.refreshCheckpoint)!;
    expect(reviewed!.latestSnapshotId).toBe(observed!.latestSnapshotId);
    expect(reviewed!.observedProjection).not.toHaveProperty("values.photo");
    expect(after).toMatchObject({
      phase: "photo",
      revision: reviewed!.revision,
      actor: before.actor,
      attempts: 0,
      nextRetryAt: before.nextRetryAt,
      photo: { snapshotId: before.photo!.snapshotId, sourceHash: before.photo!.sourceHash },
    });
    expect(after.stepId).not.toBe(before.stepId);
    expect(after.photo!.selector.urlHash).not.toBe(before.photo!.selector.urlHash);
    await worker.resume(actor.tenantId, initial!.id);
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0]?.[0]).toBe("https://images.example/alternative");
    const [finished] = await linkQuery();
    expect(finished!.observedProjection).toHaveProperty("values.photo");
    expect(readRefreshCheckpoint(finished!.refreshCheckpoint)?.enqueuePending).toBe(false);
  });
  it.each([false, true])(
    "public cancellation stops a committed product photo and releases temporary payload (finished after TTL=%s)",
    async (finishedAfterTtl) => {
      const rt = runtime();
      const { p, id } = await prepared(rt);
      const { apply, result } = await accept(p, id);
      const query = () =>
        db
          .select()
          .from(schema.nationalCatalogImportOperationItems)
          .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
      const [before] = await query();
      if (finishedAfterTtl) {
        {
          rt.storage.get.mockRejectedValueOnce(Error("controlled storage failure"));
          await rt.service.apply(actor.tenantId, result.operationId, p.id);
          await db
            .update(schema.nationalCatalogImportOperationItems)
            .set({ imageAttempts: 4, nextImageAttemptAt: null })
            .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
          await rt.service.apply(actor.tenantId, result.operationId, p.id);
        }
        expect((await apply.read(actor.tenantId, sessionId, result.operationId)).state).toBe(
          "finished",
        );
        await db
          .update(schema.nationalCatalogImportSessions)
          .set({
            startedAt: new Date(Date.now() - 86_400_001),
            expiresAt: new Date(Date.now() - 1000),
          })
          .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
        await db
          .delete(schema.integrationChannels)
          .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
      }
      await sessions.cancel(actor, sessionId);
      expect((await apply.read(actor.tenantId, sessionId, result.operationId)).state).toBe(
        "cancelled",
      );
      await rt.service.apply(actor.tenantId, result.operationId, p.id);
      const [after] = await query();
      expect(after).toMatchObject({
        productResult: "applied",
        imageResult: "failed",
        imageRetryEligible: false,
        nextImageAttemptAt: null,
      });
      expect(after?.decision).toEqual(before?.decision);
      expect(after?.appliedEvidence).toEqual(before?.appliedEvidence);
      expect(
        await db
          .select()
          .from(schema.productImages)
          .where(eq(schema.productImages.productId, existingId)),
      ).toHaveLength(0);
      await db
        .update(schema.nationalCatalogImportPreviews)
        .set({ expiresAt: new Date(0) })
        .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
      await rt.service.releaseExpired(new Date(), 1);
      const [stored] = await db
        .select()
        .from(schema.nationalCatalogImportPreviews)
        .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
      expect(stored?.payloadPurgedAt).not.toBeNull();
      expect((await query())[0]?.appliedEvidence).toEqual(before?.appliedEvidence);
    },
  );
  it("terminal core conflict removes impossible photo retention without a fixture eligibility update", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const apply = new NationalCatalogImportApplyService(repository, sessions);
    const result = await apply.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: [],
          linkAction: p.linkAction,
          photo: { kind: "candidate", candidateId: id },
        },
      ],
    });
    await db
      .update(schema.products)
      .set({ name: "Changed after preview" })
      .where(eq(schema.products.id, existingId));
    await apply.resume(actor.tenantId, result.operationId);
    const [receipt] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(receipt).toMatchObject({
      productResult: "conflict",
      errorCode: "product_changed",
      imageRetryEligible: false,
    });
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    await rt.service.releaseExpired(new Date(), 1);
    const [stored] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    expect(stored?.payloadPurgedAt).not.toBeNull();
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0]?.product,
    ).toBe("conflict");
  });
  it("protects live and accepted failed assets from storage deletion and deliberately releases expired unaccepted ones", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const [candidate] = await db
      .select()
      .from(schema.nationalCatalogImportImages)
      .where(eq(schema.nationalCatalogImportImages.candidateId, id));
    const old = new Date(Date.now() - 3600_000);
    await db
      .update(schema.mediaAssets)
      .set({ updatedAt: old })
      .where(eq(schema.mediaAssets.id, candidate?.stagedAssetId ?? ""));
    await rt.media.reconcile(new Date());
    expect(rt.objects.size).toBe(1);
    const { result } = await accept(p, id);
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ imageResult: "failed", imageErrorCode: "storage_failure" })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    await rt.service.releaseExpired(new Date());
    await rt.media.cleanupDeletingTenantAsset(actor.tenantId, candidate?.stagedAssetId ?? "");
    expect(rt.objects.size).toBe(1);
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ imageRetryEligible: false })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await rt.service.releaseExpired(new Date());
    await rt.media.reconcile(new Date());
    expect(rt.objects.size).toBe(0);
  });
  it("rejects corrupted cached bytes without undoing product or downloading again", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    for (const key of rt.objects.keys()) rt.objects.set(key, Buffer.from("tampered"));
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({
      product: "applied",
      image: "failed",
      imageReason: "prepared_image_bytes_changed",
    });
    expect(rt.download).toHaveBeenCalledTimes(1);
    const failures = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
          eq(schema.tenantAuditEvents.action, "national_catalog.image.failed"),
        ),
      );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      actorUserId: actor.userId,
      outcome: "failure",
      targetType: "product",
      targetId: existingId,
      after: {
        operationId: result.operationId,
        previewId: p.id,
        reason: "prepared_image_bytes_changed",
        result: "failed",
      },
    });
  });
  it("rolls back a crash after swap and resumes only the image from cached bytes", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    const original = rt.products.applyPreparedImage.bind(rt.products);
    const swap = vi
      .spyOn(rt.products, "applyPreparedImage")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("crash after swap before receipt commit");
      });
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect(
      await db
        .select()
        .from(schema.productImages)
        .where(eq(schema.productImages.productId, existingId)),
    ).toHaveLength(0);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({
      product: "applied",
      image: "failed",
      imageReason: "image_infrastructure_failure",
    });
    await apply.resume(actor.tenantId, result.operationId);
    const [scheduled] = await db
      .select()
      .from(schema.nationalCatalogImportOperations)
      .where(eq(schema.nationalCatalogImportOperations.id, result.operationId));
    expect(scheduled).toMatchObject({ state: "running", enqueuePending: true });
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ nextImageAttemptAt: new Date() })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect((await apply.read(actor.tenantId, sessionId, result.operationId)).items[0]?.image).toBe(
      "applied",
    );
    expect(swap).toHaveBeenCalledTimes(2);
    expect(rt.download).toHaveBeenCalledTimes(1);
  });
  it("redelivers a committed image receipt across two real local PgBoss worker instances", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    const queueSchema = `nc_test_${randomUUID().replaceAll("-", "")}`;
    const queueUrl = process.env.DATABASE_URL;
    if (!queueUrl) throw new Error("Queue test requires PostgreSQL");
    const options = {
      connectionString: queueUrl,
      schema: queueSchema,
      supervise: false,
      schedule: false,
    };
    const first = new PgBoss(options);
    const second = new PgBoss(options);
    const errors: Error[] = [];
    first.on("error", (error) => errors.push(error));
    second.on("error", (error) => errors.push(error));
    const deliveries: { id: string; retryCount: number }[] = [];
    const queue = "accepted-image";
    try {
      await first.start();
      await first.createQueue(queue, { retryLimit: 2, retryDelay: 2 });
      const jobId = await first.send(queue, { operationId: result.operationId, previewId: p.id });
      expect(jobId).toBeTypeOf("string");
      if (!jobId) throw new Error("Queue did not retain the accepted job");
      await first.work(
        queue,
        { includeMetadata: true, pollingIntervalSeconds: 0.5 },
        async (jobs: JobWithMetadata<{ operationId: string; previewId: string }>[]) => {
          for (const job of jobs) {
            deliveries.push({ id: job.id, retryCount: job.retryCount });
            await rt.service.apply(actor.tenantId, job.data.operationId, job.data.previewId);
            throw new Error("synthetic lost acknowledgement after committed receipt");
          }
        },
      );
      await expect
        .poll(async () => (await first.getJobById(queue, jobId))?.state, {
          timeout: 8000,
          interval: 20,
        })
        .toBe("retry");
      await first.stop({ graceful: true, timeout: 2000 });
      const receipt = await apply.read(actor.tenantId, sessionId, result.operationId);
      expect(receipt.items[0]).toMatchObject({ product: "applied", image: "applied" });
      const before = await db
        .select()
        .from(schema.nationalCatalogImportOperationItems)
        .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
      const auditBefore = await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, actor.tenantId));
      expect(auditBefore.length).toBeGreaterThan(0);
      await second.start();
      await second.work(
        queue,
        { includeMetadata: true, pollingIntervalSeconds: 0.5 },
        async (jobs: JobWithMetadata<{ operationId: string; previewId: string }>[]) => {
          for (const job of jobs) {
            deliveries.push({ id: job.id, retryCount: job.retryCount });
            await rt.service.apply(actor.tenantId, job.data.operationId, job.data.previewId);
          }
        },
      );
      await expect
        .poll(async () => (await second.getJobById(queue, jobId))?.state, {
          timeout: 8000,
          interval: 20,
        })
        .toBe("completed");
      expect(deliveries).toEqual([
        { id: jobId, retryCount: 0 },
        { id: jobId, retryCount: 1 },
      ]);
      expect(await apply.read(actor.tenantId, sessionId, result.operationId)).toEqual(receipt);
      expect(
        await db
          .select()
          .from(schema.nationalCatalogImportOperationItems)
          .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId)),
      ).toEqual(before);
      expect(
        await db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, actor.tenantId)),
      ).toEqual(auditBefore);
      expect(
        await db
          .select()
          .from(schema.productImages)
          .where(eq(schema.productImages.productId, existingId)),
      ).toHaveLength(1);
      expect(rt.download).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    } finally {
      const stopped = await Promise.allSettled([
        first.stop({ graceful: false }),
        second.stop({ graceful: false }),
      ]);
      // Generated identifier owned only by this test; no shared job schema is removed.
      await connection.pool.query(`DROP SCHEMA IF EXISTS "${queueSchema}" CASCADE`);
      expect(stopped.every((value) => value.status === "fulfilled")).toBe(true);
    }
  }, 25000);

  it("an asset attacher winning the row lock prevents GC's later storage call", async () => {
    const rt = runtime();
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    const assetId = randomUUID();
    const key = `tenants/${actor.tenantId}/race.webp`;
    await db.insert(schema.mediaAssets).values({
      id: assetId,
      ownerTenantId: actor.tenantId,
      objectKey: key,
      contentType: "image/webp",
      checksum: "a".repeat(64),
      byteSize: 10,
      width: 1,
      height: 1,
      status: "staging",
      updatedAt: new Date(Date.now() - 3600_000),
    });
    const client = await connection.pool.connect();
    await client.query("BEGIN");
    let collecting: Promise<number> | undefined;
    try {
      await client.query("SELECT id FROM media_assets WHERE id=$1 FOR UPDATE", [assetId]);
      const blocker = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const blockerPid = blocker.rows[0]?.pid;
      expect(blockerPid).toBeTypeOf("number");
      collecting = rt.media.reconcile(new Date(), 10000);
      // This client holds exactly the target asset row. Wait until the actual
      // collector claim is blocked by it, rather than merely starting a promise.
      await expect
        .poll(
          async () => {
            const waiting = await connection.pool.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname=current_database() AND wait_event_type='Lock'
             AND query LIKE '%media_assets%' AND query LIKE '%for update%'
             AND $1 = ANY(pg_blocking_pids(pid))`,
              [blockerPid],
            );
            return waiting.rows[0]?.count;
          },
          { timeout: 5000, interval: 10 },
        )
        .toBe(1);
      expect(rt.storage.delete).not.toHaveBeenCalledWith(key);
      await client.query(
        "UPDATE national_catalog_import_images SET staged_asset_id=$1,state='ready',checksum=$2,byte_size=10,width=1,height=1 WHERE candidate_id=$3",
        [assetId, "a".repeat(64), id],
      );
      await client.query("COMMIT");
      await collecting;
      expect(rt.storage.delete).not.toHaveBeenCalledWith(key);
      expect(
        await db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)),
      ).toHaveLength(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await collecting;
    }
  });
  it("a committed GC claim prevents activation before object deletion, without holding a DB lock over storage", async () => {
    const rt = runtime();
    const image = await import("../src/modules/media/product-image-processor").then(async (m) =>
      m.processProductImage(
        await sharp({ create: { width: 20, height: 10, channels: 3, background: "#2463eb" } })
          .png()
          .toBuffer(),
      ),
    );
    const assetId = randomUUID();
    const key = `tenants/${actor.tenantId}/claimed.webp`;
    await db.insert(schema.mediaAssets).values({
      id: assetId,
      ownerTenantId: actor.tenantId,
      objectKey: key,
      contentType: image.contentType,
      checksum: image.checksum,
      byteSize: image.byteSize,
      width: image.width,
      height: image.height,
      status: "deleting",
    });
    rt.objects.set(key, image.buffer);
    rt.storage.delete.mockImplementationOnce(async (objectKey) => {
      // A separate transaction can acquire the row lock while storage is in progress.
      await expect(
        db.transaction((tx) =>
          rt.products.applyPreparedImage(
            tx,
            actor.tenantId,
            actor.userId,
            existingId,
            image,
            null,
            assetId,
          ),
        ),
      ).rejects.toThrow("prepared_image_changed");
      rt.objects.delete(objectKey);
    });
    await rt.media.cleanupDeletingTenantAsset(actor.tenantId, assetId);
    expect(rt.storage.delete).toHaveBeenCalledWith(key);
    expect(rt.objects.has(key)).toBe(false);
    expect(
      await db
        .select()
        .from(schema.productImages)
        .where(eq(schema.productImages.productId, existingId)),
    ).toHaveLength(0);
  });

  it("does not call bytes reviewed if they become ready only after keep acceptance", async () => {
    const rt = runtime();
    photos();
    const p = await preview();
    const id = p.photos[0]?.candidateId ?? "";
    const apply = new NationalCatalogImportApplyService(repository, sessions);
    const result = await apply.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: [],
          linkAction: p.linkAction,
          photo: { kind: "keep" },
        },
      ],
    });
    await rt.service.resume(actor.tenantId, sessionId, p.id, id);
    await apply.resume(actor.tenantId, result.operationId);
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    expect(link?.reviewedPhoto).toBeNull();
  });

  // The PostgreSQL-only API job has no MinIO. The infrastructure job runs this
  // same file with LOCAL_INFRA_SMOKE=1 and an initialized private bucket.
  it.skipIf(process.env.LOCAL_INFRA_SMOKE !== "1")(
    "serves the same normalized bytes from private local MinIO before and after activation",
    async () => {
      const { loadEnv } = await import("../src/env");
      const { ObjectStorageService } =
        await import("../src/modules/storage/object-storage.service");
      const env = loadEnv();
      if (!["localhost", "127.0.0.1"].includes(new URL(env.S3_ENDPOINT).hostname))
        throw new Error("Local MinIO only");
      const storage = new ObjectStorageService(env);
      const rt = runtime();
      const service = new NationalCatalogImageService(
        repository,
        sessions,
        rt.coordinator,
        storage,
        rt.products,
        { enabled: true, verifiedHosts: ["images.example"] },
        rt.download,
      );
      let assetId: string | null = null;
      let objectKey: string | null = null;
      try {
        const { p, id } = await prepared({ ...rt, service });
        const shown = await service.readPreview(actor.tenantId, sessionId, id);
        const { result } = await accept(p, id);
        await service.apply(actor.tenantId, result.operationId, p.id);
        const [active] = await db
          .select()
          .from(schema.productImages)
          .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
          .where(eq(schema.productImages.productId, existingId));
        if (!active) throw new Error("Expected active private asset");
        assetId = active.media_assets.id;
        objectKey = active.media_assets.objectKey;
        expect((await storage.get(objectKey)).body).toEqual(shown.buffer);
        expect(active.media_assets.checksum).toBe(
          createHash("sha256").update(shown.buffer).digest("hex"),
        );
      } finally {
        if (assetId && objectKey) {
          await db
            .delete(schema.productImages)
            .where(eq(schema.productImages.productId, existingId));
          await db
            .update(schema.nationalCatalogImportImages)
            .set({ stagedAssetId: null, state: "released" })
            .where(eq(schema.nationalCatalogImportImages.stagedAssetId, assetId));
          await storage.delete(objectKey);
          await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
        }
        storage.onModuleDestroy();
      }
    },
  );
  it.each([
    { scenario: "pre-read revocation", reason: "image_access_changed", attempts: 0 },
    { scenario: "exhausted-attempt recovery", reason: "image_attempts_exhausted", attempts: 4 },
  ])(
    "audits terminal $scenario once with the current operation actor",
    async ({ reason, attempts }) => {
      const rt = runtime();
      const { p, id } = await prepared(rt);
      const { apply, result } = await accept(p, id);
      const currentActorId = randomUUID();
      await db.insert(schema.user).values({
        id: currentActorId,
        name: "Current operation actor",
        email: `${currentActorId}@example.test`,
        emailVerified: true,
      });
      await db.insert(schema.member).values({
        id: randomUUID(),
        userId: currentActorId,
        organizationId: actor.tenantId,
        role: "owner",
        createdAt: new Date(),
      });
      await db
        .update(schema.nationalCatalogImportOperations)
        .set({ actorId: currentActorId })
        .where(
          and(
            eq(schema.nationalCatalogImportOperations.tenantId, actor.tenantId),
            eq(schema.nationalCatalogImportOperations.id, result.operationId),
          ),
        );
      const receipts = schema.nationalCatalogImportOperationItems;
      const receiptScope = and(
        eq(receipts.tenantId, actor.tenantId),
        eq(receipts.operationId, result.operationId),
        eq(receipts.previewId, p.id),
      );
      if (attempts === 4) {
        // Recovery after the fourth worker died with its persisted claim still pending.
        await db
          .update(receipts)
          .set({
            imageAttempts: attempts,
            nextImageAttemptAt: new Date(Date.now() - 1_000),
          })
          .where(receiptScope);
      } else {
        await db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.organizationId, actor.tenantId),
              eq(schema.member.userId, currentActorId),
            ),
          );
      }
      const [before] = await db.select().from(receipts).where(receiptScope);
      if (!before?.acceptedImageId) throw new Error("Expected accepted image receipt");
      for (let replay = 0; replay < 2; replay++) {
        await rt.service.apply(actor.tenantId, result.operationId, p.id);
        expect(
          (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
        ).toMatchObject({ product: "applied", image: "failed", imageReason: reason });
        const [after] = await db.select().from(receipts).where(receiptScope);
        expect(after).toMatchObject({
          imageAttempts: attempts,
          nextImageAttemptAt: null,
          decision: before.decision,
          appliedEvidence: before.appliedEvidence,
        });
        const audits = await db
          .select()
          .from(schema.tenantAuditEvents)
          .where(
            and(
              eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
              eq(schema.tenantAuditEvents.action, "national_catalog.image.failed"),
            ),
          );
        expect(audits).toEqual([
          expect.objectContaining({
            organizationId: actor.tenantId,
            actorUserId: currentActorId,
            action: "national_catalog.image.failed",
            outcome: "failure",
            targetType: "product",
            targetId: existingId,
            before: null,
            after: {
              operationId: result.operationId,
              previewId: p.id,
              acceptedImageId: before.acceptedImageId,
              reason,
              result: "failed",
            },
          }),
        ]);
      }
      expect(rt.storage.get).not.toHaveBeenCalled();
      expect(rt.download).toHaveBeenCalledTimes(1);
      expect(
        await db
          .select()
          .from(schema.productImages)
          .where(eq(schema.productImages.productId, existingId)),
      ).toHaveLength(0);
    },
  );

  it("rechecks write access after cached storage returns before activation", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    const { apply, result } = await accept(p, id);
    const get = rt.storage.get.getMockImplementation();
    if (!get) throw new Error("storage fixture");
    rt.storage.get.mockImplementationOnce(async (key) => {
      await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
      return get(key);
    });
    await rt.service.apply(actor.tenantId, result.operationId, p.id);
    expect(
      (await apply.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({ product: "applied", image: "failed", imageReason: "image_access_changed" });
    expect(
      await db
        .select()
        .from(schema.productImages)
        .where(eq(schema.productImages.productId, existingId)),
    ).toHaveLength(0);
  });

  it("does not starve purgeable previews behind a full batch of retained accepted previews", async () => {
    const rt = runtime();
    const { p, id } = await prepared(rt);
    await accept(p, id);
    const purgeable = await preview();
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ expiresAt: new Date("2000-01-02T00:00:00Z") })
      .where(eq(schema.nationalCatalogImportPreviews.id, purgeable.id));
    // Earlier failed runs may leave their own older fixtures; bounded oldest-first passes
    // must still reach this row and never spin on retained previews.
    for (let batch = 0; batch < 10; batch++) {
      await rt.service.releaseExpired(new Date(), 1);
      const [current] = await db
        .select()
        .from(schema.nationalCatalogImportPreviews)
        .where(eq(schema.nationalCatalogImportPreviews.id, purgeable.id));
      if (current?.payloadPurgedAt) break;
    }
    const [released] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, purgeable.id));
    const [retained] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    expect(released?.payloadPurgedAt).not.toBeNull();
    expect(retained?.payloadPurgedAt).toBeNull();
    expect(retained?.diff).not.toBeNull();
  });
});
