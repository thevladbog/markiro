import { HttpException } from "@nestjs/common";
import { sourceEnvelopeSchema } from "../src/modules/national-catalog/national-catalog-import-apply-state";
import { randomUUID } from "node:crypto";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  importResultSchema,
  type ImportApply,
  type ImportPreview,
} from "@markiro/platform-contracts";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportRepository } from "../src/modules/national-catalog/national-catalog-import.repository";
import { NationalCatalogRequestCoordinator } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import { buildImportPreview } from "../src/modules/national-catalog/national-catalog-import-preview-builder";
import type { NationalCatalogImportApplyService } from "../src/modules/national-catalog/national-catalog-import-apply.service";
import type { NationalCatalogProduct } from "../src/modules/national-catalog/national-catalog.types";
import { createManagedSubscription, createOrganization } from "./support/subscription-fixtures";

const GTIN = "04601234567893";
if (!process.env.DATABASE_URL) throw new Error("Apply tests require local PostgreSQL");
describe("atomic National Catalog product application (real PostgreSQL services)", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const db: Db = connection.db;
  let actor: { tenantId: string; userId: string };
  let repository: NationalCatalogImportRepository;
  let sessions: NationalCatalogImportService;
  let service: NationalCatalogImportApplyService;
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
      palletCapacity: 60,
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
  async function preview(manualName?: string, optionId?: string, groupCodes?: number[]) {
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
        undefined,
        new Date(),
        groupCodes
          ? [
              {
                id: 30064,
                active: true,
                gismtCodes: groupCodes,
              },
            ]
          : [],
      );
    });
  }
  function decision(p: ImportPreview, accept = false): ImportApply {
    return {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: accept ? p.fields.filter((f) => f.applicable).map((f) => f.id) : [],
          linkAction: p.linkAction,
          photo: { kind: "keep" },
        },
      ],
    };
  }
  async function init() {
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    service = new NationalCatalogImportApplyService(repository, sessions);
  }
  async function apply(body: ImportApply) {
    // Task9 requires reviewed ready metadata BEFORE acceptance; these remain metadata-only fixtures.
    for (const d of body.decisions) {
      if (d.photo.kind !== "candidate") continue;
      const [candidate] = await db
        .select()
        .from(schema.nationalCatalogImportImages)
        .where(eq(schema.nationalCatalogImportImages.candidateId, d.photo.candidateId));
      if (!candidate || candidate.state !== "pending") continue;
      const assetId = randomUUID();
      await db.insert(schema.mediaAssets).values({
        id: assetId,
        ownerTenantId: actor.tenantId,
        objectKey: `test/${assetId}`,
        contentType: "image/webp",
        byteSize: 10,
        checksum: "a".repeat(64),
        width: 1,
        height: 1,
      });
      await db
        .update(schema.nationalCatalogImportImages)
        .set({
          state: "ready",
          stagedAssetId: assetId,
          checksum: "a".repeat(64),
          byteSize: 10,
          width: 1,
          height: 1,
        })
        .where(eq(schema.nationalCatalogImportImages.id, candidate.id));
    }
    await init();
    const started = await service.start(actor, sessionId, body);
    await service.resume(actor.tenantId, started.operationId);
    return service.read(actor.tenantId, sessionId, started.operationId);
  }
  async function product() {
    const [p] = await db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, actor.tenantId), eq(schema.products.id, existingId)));
    return p;
  }
  async function links() {
    return db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(
        and(
          eq(schema.nationalCatalogProductLinks.tenantId, actor.tenantId),
          eq(schema.nationalCatalogProductLinks.productId, existingId),
        ),
      )
      .orderBy(schema.nationalCatalogProductLinks.confirmedAt);
  }

  async function category(numeric?: {
    sourceUnit: string | null;
    allowedUnits: readonly string[];
  }) {
    const id = randomUUID();
    const categoryId = String(parseInt(id.slice(0, 8), 16));
    const scopeKey = `apply-${id}`;
    await db.insert(schema.nationalCatalogSchemaVersions).values({
      id,
      scopeKey,
      categoryId,
      categoryName: "Категория",
      selectors: {},
      contentHash: "e".repeat(64),
      definition: {
        formatVersion: 2,
        categoryId,
        scopeKey,
        attributes: [
          {
            id: "20",
            label: numeric ? "Объём" : "Цвет",
            valueType: numeric ? "decimal" : "string",
            multiplicity: "one",
            unit: numeric
              ? { canonical: numeric.allowedUnits[0]!, allowed: [...numeric.allowedUnits] }
              : null,
            requirementRules: [],
            presetMode: "none",
            presets: [],
          },
        ],
      },
      status: "active",
      fetchedAt: new Date(),
      validatedAt: new Date(),
      activatedAt: new Date(),
    });
    await db.insert(schema.nationalCatalogCategoryGroupMappings).values({
      chzProductGroupCode: 23,
      schemaVersionId: id,
      categoryId,
      state: "exact",
      reviewedBy: actor.userId,
      reviewedAt: new Date(),
    });
    source.categories = [{ id: Number(categoryId), name: "Категория" }];
    source.attributes = [
      {
        id: 20,
        name: numeric ? "Объём" : "Цвет",
        value: numeric ? "500" : "Синий",
        valueId: null,
        attributeValueId: null,
        valueType: numeric?.sourceUnit ?? null,
        groupId: null,
        groupName: null,
        locationId: null,
        level: null,
        gtin: null,
        multiplier: null,
      },
    ];
    const initial = await preview();
    const option = initial.categoryOptions[0];
    if (!option) throw new Error("category option expected");
    return { id, preview: await preview(undefined, option.optionId) };
  }
  it.each(["preview_expired", "environment_mismatch"] as const)(
    "returns the specific rejected preview for %s without admitting or mutating evidence",
    async (reason) => {
      const p = await preview();
      const table = schema.nationalCatalogImportPreviews;
      const [stored] = await db.select().from(table).where(eq(table.id, p.id));
      if (!stored) throw Error("missing preview");
      await db
        .update(table)
        .set(
          reason === "preview_expired"
            ? { expiresAt: new Date(Date.now() - 1000) }
            : {
                source: { ...sourceEnvelopeSchema.parse(stored.source), environment: "production" },
              },
        )
        .where(eq(table.id, p.id));
      const before = await db.select().from(table).where(eq(table.id, p.id));
      const productBefore = await product();
      await init();
      try {
        await service.start(actor, sessionId, decision(p));
        throw Error("expected conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        if (!(error instanceof HttpException)) throw error;
        expect(error.getStatus()).toBe(409);
        expect(error.getResponse()).toEqual({
          statusCode: 409,
          error: "Conflict",
          message: reason,
          previewIds: [p.id],
        });
      }
      expect(await db.select().from(table).where(eq(table.id, p.id))).toEqual(before);
      expect(await product()).toEqual(productBefore);
      expect(
        await db
          .select()
          .from(schema.nationalCatalogImportOperations)
          .where(eq(schema.nationalCatalogImportOperations.tenantId, actor.tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.nationalCatalogImportOperationItems)
          .where(eq(schema.nationalCatalogImportOperationItems.tenantId, actor.tenantId)),
      ).toEqual([]);
    },
  );
  it("confirms link-only, preserves exact name/operational fields, and writes exact actor/link audit", async () => {
    const before = await product();
    const p = await preview();
    const result = await apply(decision(p));
    expect(result.items[0]).toMatchObject({
      productId: existingId,
      product: "applied",
      image: "none",
      productReason: null,
      imageReason: null,
    });
    expect(importResultSchema.safeParse(result).success).toBe(true);
    expect(await product()).toEqual(before);
    const [link] = await links();
    expect(link).toMatchObject({
      tenantId: actor.tenantId,
      productId: existingId,
      cardId: "720679",
      environment: "sandbox",
      boundGtin14: GTIN,
      confirmedBy: actor.userId,
      closedAt: null,
    });
    expect(link?.reviewedSnapshotId).toBe(link?.latestSnapshotId);
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
          eq(schema.tenantAuditEvents.targetId, existingId),
          eq(schema.tenantAuditEvents.action, "national_catalog.link.confirmed"),
        ),
      );
    expect(audit).toMatchObject({
      organizationId: actor.tenantId,
      actorUserId: actor.userId,
      action: "national_catalog.link.confirmed",
      outcome: "success",
      targetType: "product",
      targetId: existingId,
      after: {
        cardId: "720679",
        boundGtin14: GTIN,
        acceptedEntryIds: [],
        sourceRef: `national-catalog-snapshot:${link?.reviewedSnapshotId}`,
      },
    });
  });
  it("persists exact manual name provenance, immutable decisions and snapshot without fake mapping IDs", async () => {
    const p = await preview("Ручное имя");
    const body = decision(p, true);
    const result = await apply(body);
    expect(result.items[0]?.product).toBe("applied");
    expect((await product())?.name).toBe("Ручное имя");
    const [receipt] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(receipt?.decision).toMatchObject({
      previewId: p.id,
      acceptedEntryIds: body.decisions[0]?.acceptedEntryIds,
      acceptedEntries: [
        { target: "name", source: "manual", currentValue: "Моё имя", proposedValue: "Ручное имя" },
      ],
    });
    const proposals = await db
      .select()
      .from(schema.productRegulatoryProposals)
      .where(eq(schema.productRegulatoryProposals.productId, existingId));
    expect(proposals).toEqual([]);
  });
  it("replays accepted results after expiry and rejects changed canonical decisions", async () => {
    const body = decision(await preview(), true);
    const result = await apply(body);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "expired" })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    expect(await service.start(actor, sessionId, body)).toEqual(result);
    await service.resume(actor.tenantId, result.operationId);
    expect(await service.read(actor.tenantId, sessionId, result.operationId)).toEqual(result);
    await expect(
      service.start(actor, sessionId, {
        ...body,
        decisions: body.decisions.map((d) => ({ ...d, acceptedEntryIds: [] })),
      }),
    ).rejects.toThrow("import_request_mismatch");
    expect(await links()).toHaveLength(1);
  });
  it("records product conflict without changing name/link on concurrent old-value change", async () => {
    const body = decision(await preview(), true);
    await db
      .update(schema.products)
      .set({ printName: "Concurrent" })
      .where(eq(schema.products.id, existingId));
    const result = await apply(body);
    expect(result.items[0]).toMatchObject({
      product: "conflict",
      productReason: "product_changed",
      imageReason: null,
    });
    expect((await product())?.name).toBe("Моё имя");
    expect(await links()).toEqual([]);
  });
  it("requires an accepted valid name to create and preserves new-product draft behavior", async () => {
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: null, match: "new" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await db.delete(schema.products).where(eq(schema.products.id, existingId));
    const p = await preview();
    await init();
    await expect(service.start(actor, sessionId, decision(p))).rejects.toThrow("name_required");
    const result = await apply(decision(p, true));
    const id = result.items[0]?.productId;
    if (!id) throw new Error("expected created product");
    const [created] = await db.select().from(schema.products).where(eq(schema.products.id, id));
    expect(created).toMatchObject({
      tenantId: actor.tenantId,
      name: "Из ЧЗ",
      gtin14: GTIN,
      status: "draft",
      boxCapacity: null,
      palletCapacity: null,
      unitPrice: null,
      externalRef: null,
    });
  });
  it("creates a new product with the accepted ChZ group and retains its source evidence", async () => {
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: null, match: "new" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await db.delete(schema.products).where(eq(schema.products.id, existingId));
    source.categories = [{ id: 30064, name: "Категория" }];
    const p = await preview(undefined, undefined, [23]);
    const result = await apply(decision(p, true));
    expect(result.items[0]?.product).toBe("applied");
    const productId = result.items[0]!.productId!;
    const [created] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(created).toMatchObject({ chzProductGroupCode: 23, status: "draft" });
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
          eq(schema.tenantAuditEvents.targetId, productId),
          eq(schema.tenantAuditEvents.action, "national_catalog.link.confirmed"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: actor.userId,
      targetType: "product",
      outcome: "success",
      after: {
        acceptedEntries: expect.arrayContaining([
          expect.objectContaining({
            target: "product_group",
            currentValue: null,
            proposedValue: 23,
          }),
        ]),
      },
    });
  });
  it("only fills an existing empty group after explicit acceptance and recalculates readiness", async () => {
    source.categories = [{ id: 30064, name: "Категория" }];
    const p = await preview(undefined, undefined, [23]);
    const group = p.fields.find((field) => field.labelKey === "chz_product_group_code");
    expect(group).toMatchObject({ applicable: true, selectedByDefault: false });
    const body = decision(p);
    body.decisions[0]!.acceptedEntryIds = [group!.id];
    const result = await apply(body);
    expect(result.items[0]?.product).toBe("applied");
    expect(await product()).toMatchObject({
      chzProductGroupCode: 23,
      status: "active",
      name: "Моё имя",
    });
    await service.resume(actor.tenantId, result.operationId);
    expect(await service.read(actor.tenantId, sessionId, result.operationId)).toEqual(result);
    expect(await links()).toHaveLength(1);
  });
  it("preserves an existing different product group during import", async () => {
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 7 })
      .where(eq(schema.products.id, existingId));
    source.categories = [{ id: 30064, name: "Категория" }];
    const p = await preview(undefined, undefined, [23]);
    expect(p.fields.find((field) => field.labelKey === "chz_product_group_code")).toMatchObject({
      applicable: false,
      selectedByDefault: false,
      reason: "product_group_change_separate",
    });
    await apply(decision(p, true));
    expect(await product()).toMatchObject({ chzProductGroupCode: 7 });
  });
  it("does not save a declined product group when creating a product", async () => {
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: null, match: "new" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await db.delete(schema.products).where(eq(schema.products.id, existingId));
    source.categories = [{ id: 30064, name: "Категория" }];
    const p = await preview(undefined, undefined, [23]);
    const body = decision(p, true);
    const group = p.fields.find((field) => field.labelKey === "chz_product_group_code");
    body.decisions[0]!.acceptedEntryIds = body.decisions[0]!.acceptedEntryIds.filter(
      (id) => id !== group?.id,
    );
    const result = await apply(body);
    expect(result.items[0]?.product).toBe("applied");
    const [created] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, result.items[0]!.productId!));
    expect(created?.chzProductGroupCode).toBeNull();
  });
  it("turns concurrent GTIN creation into a conflict rather than an update", async () => {
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: null, match: "new" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await db.delete(schema.products).where(eq(schema.products.id, existingId));
    const p = await preview();
    await db
      .insert(schema.products)
      .values({ id: existingId, tenantId: actor.tenantId, gtin14: GTIN, name: "Concurrent" });
    const result = await apply(decision(p, true));
    expect(result.items[0]).toMatchObject({ product: "conflict", productReason: "gtin_conflict" });
    expect((await product())?.name).toBe("Concurrent");
  });
  it("requires explicit replacement and closes old identity with actual actor", async () => {
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId: actor.tenantId,
      productId: existingId,
      cardId: "different",
      environment: "production",
      boundGtin14: GTIN,
      confirmedBy: actor.userId,
    });
    const p = await preview();
    expect(p.linkAction).toBe("replace");
    await init();
    const invalid = decision(p);
    invalid.decisions[0]!.linkAction = "keep";
    await expect(service.start(actor, sessionId, invalid)).rejects.toThrow("link_action_mismatch");
    expect((await apply(decision(p))).items[0]?.product).toBe("applied");
    expect(await links()).toEqual([
      expect.objectContaining({
        cardId: "different",
        closedBy: actor.userId,
        closedReason: "replaced",
      }),
      expect.objectContaining({ cardId: "720679", closedAt: null }),
    ]);
  });
  it("rechecks revoked actor on background apply and denies foreign operation/session IDs", async () => {
    await init();
    const body = decision(await preview());
    const started = await service.start(actor, sessionId, body);
    await db
      .update(schema.member)
      .set({ role: "viewer" })
      .where(eq(schema.member.userId, actor.userId));
    await service.resume(actor.tenantId, started.operationId);
    expect(
      (await service.read(actor.tenantId, sessionId, started.operationId)).items[0],
    ).toMatchObject({ product: "failed", productReason: "permission_denied" });
    expect(await links()).toEqual([]);
    const foreign = await createOrganization(db);
    await expect(service.read(foreign, sessionId, started.operationId)).rejects.toThrow(
      "import_session_not_found",
    );
    await expect(service.read(actor.tenantId, randomUUID(), started.operationId)).rejects.toThrow(
      "import_session_not_found",
    );
    await expect(service.read(actor.tenantId, sessionId, randomUUID())).rejects.toThrow(
      "import_operation_not_found",
    );
  });
  it("reads exact link detail and removes only link history with exact current actor", async () => {
    await apply(decision(await preview()));
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const linkService = new NationalCatalogLinkService(
      db,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
    );
    const before = await product();
    const detail = await linkService.readDetail(actor.tenantId, existingId);
    expect(detail.link).toMatchObject({
      cardId: "720679",
      environment: "sandbox",
      boundGtin14: GTIN,
    });
    expect(detail.link).not.toHaveProperty("confirmedBy");
    await expect(
      linkService.remove(actor, existingId, { action: "remove", expectedRevision: 99 }),
    ).rejects.toThrow("link_changed");
    expect(
      (await linkService.remove(actor, existingId, { action: "remove", expectedRevision: 1 }))
        .linkId,
    ).toBeNull();
    expect(await product()).toEqual(before);
    expect((await links())[0]).toMatchObject({ closedBy: actor.userId, closedReason: "removed" });
  });
  it("atomically changes GTIN only with explicit current revision detach and actual actor", async () => {
    await apply(decision(await preview()));
    const { ProductsService } = await import("../src/modules/products/products.service");
    const products = new ProductsService(db, {} as never, {} as never, {} as never);
    await expect(
      products.updateProduct(actor.tenantId, existingId, { gtin: "14601234567890" }),
    ).rejects.toMatchObject({ response: { code: "CHZ_LINK_REQUIRES_DETACH" } });
    const change = {
      gtin: "14601234567890",
      chzLinkChange: { action: "detach" as const, expectedRevision: 1 },
    };
    await expect(products.updateProduct(actor.tenantId, existingId, change)).rejects.toThrow(
      "detach_actor_required",
    );
    await expect(
      products.updateProduct(
        actor.tenantId,
        existingId,
        { ...change, chzLinkChange: { action: "detach", expectedRevision: 99 } },
        actor.userId,
      ),
    ).rejects.toThrow("link_changed");
    expect((await product())?.gtin14).toBe(GTIN);
    await products.updateProduct(actor.tenantId, existingId, change, actor.userId);
    expect((await product())?.gtin14).toBe("14601234567890");
    expect((await links())[0]).toMatchObject({
      closedBy: actor.userId,
      closedReason: "gtin_changed",
    });
  });
  it("applies initial category and attributes with actual NC snapshot provenance and existing operational readiness", async () => {
    const c = await category();
    const result = await apply(decision(c.preview, true));
    expect(result.items[0]).toMatchObject({ product: "applied", productReason: null });
    expect(await product()).toMatchObject({
      chzProductGroupCode: 23,
      status: "active",
      boxCapacity: 12,
      palletCapacity: 60,
      unitPrice: "19.20",
      externalRef: "1C-unchanged",
    });
    const [binding] = await db
      .select()
      .from(schema.productRegulatoryProfiles)
      .where(eq(schema.productRegulatoryProfiles.productId, existingId));
    const [attribute] = await db
      .select()
      .from(schema.productRegulatoryAttributeValues)
      .where(eq(schema.productRegulatoryAttributeValues.productId, existingId));
    const [link] = await links();
    expect(binding).toMatchObject({
      revision: 2,
      source: "national_catalog",
      confirmedBy: actor.userId,
      schemaVersionId: c.id,
    });
    expect(attribute).toMatchObject({
      source: "national_catalog",
      sourceRef: `national-catalog-snapshot:${link?.reviewedSnapshotId}`,
      appliedBy: actor.userId,
      value: { type: "string", value: "Синий" },
    });
    const [receipt] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(receipt?.appliedEvidence).toMatchObject({
      version: 1,
      snapshotId: link?.reviewedSnapshotId,
      sourceRef: `national-catalog-snapshot:${link?.reviewedSnapshotId}`,
    });
  });
  it("imports the exact supported provider unit and retains it in the reviewed baseline", async () => {
    const c = await category({ sourceUnit: "мл", allowedUnits: ["л", "мл"] });
    const result = await apply(decision(c.preview, true));
    expect(result.items[0]).toMatchObject({ product: "applied", productReason: null });
    const [attribute] = await db
      .select()
      .from(schema.productRegulatoryAttributeValues)
      .where(eq(schema.productRegulatoryAttributeValues.productId, existingId));
    const [link] = await links();
    expect(attribute?.value).toEqual({ type: "decimal", value: "500", unit: "мл" });
    expect(link?.reviewedProjection).toMatchObject({
      values: {
        [`attribute:${c.id}:20`]: { type: "decimal", value: "500", unit: "мл" },
      },
    });
  });

  it.each([null, "кг"])(
    "does not import an absent or unsupported provider unit %j",
    async (unit) => {
      const c = await category({ sourceUnit: unit, allowedUnits: ["л", "мл"] });
      expect(c.preview.fields).toContainEqual(
        expect.objectContaining({ label: "Объём", applicable: false }),
      );
      expect(c.preview.fields).not.toContainEqual(
        expect.objectContaining({ label: "Объём", applicable: true }),
      );
    },
  );
  async function existingAttribute() {
    const c = await category();
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 23 })
      .where(eq(schema.products.id, existingId));
    await db.insert(schema.productRegulatoryProfiles).values({
      tenantId: actor.tenantId,
      productId: existingId,
      schemaVersionId: c.id,
      categoryId: String(source.categories[0]!.id),
      categoryName: "Категория",
      source: "manual",
      confirmedBy: actor.userId,
      confirmedAt: new Date(),
    });
    await db.insert(schema.productRegulatoryAttributeValues).values({
      tenantId: actor.tenantId,
      productId: existingId,
      schemaVersionId: c.id,
      attributeId: "20",
      value: { type: "string", value: "Красный" },
      source: "manual",
      appliedBy: actor.userId,
    });
    return c;
  }
  async function attributes() {
    return db
      .select()
      .from(schema.productRegulatoryAttributeValues)
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, actor.tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, existingId),
        ),
      );
  }
  it("confirms link-only with existing local attributes without changing their provenance", async () => {
    await existingAttribute();
    const before = await attributes();
    const result = await apply(decision(await preview()));
    expect(result.items[0]).toMatchObject({ product: "applied", productReason: null });
    expect(await attributes()).toEqual(before);
    expect((await links())[0]).toMatchObject({ confirmedBy: actor.userId, cardId: "720679" });
  });
  it("replaces an existing local attribute with exact typed before/after and snapshot provenance", async () => {
    const c = await existingAttribute();
    const before = (await attributes())[0]!;
    const p = await preview();
    const result = await apply(decision(p, true));
    expect(result.items[0]).toMatchObject({ product: "applied", productReason: null });
    const rows = await attributes();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === before.id)).toMatchObject({
      value: before.value,
      source: "manual",
      appliedBy: actor.userId,
      supersededAt: expect.any(Date),
    });
    const active = rows.find((row) => row.supersededAt === null);
    const [link] = await links();
    expect(active).toMatchObject({
      tenantId: actor.tenantId,
      productId: existingId,
      schemaVersionId: c.id,
      attributeId: "20",
      value: { type: "string", value: "Синий" },
      source: "national_catalog",
      sourceRef: `national-catalog-snapshot:${link?.reviewedSnapshotId}`,
      appliedBy: actor.userId,
    });
    const [receipt] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(receipt?.appliedEvidence).toMatchObject({
      appliedBy: actor.userId,
      snapshotId: link?.reviewedSnapshotId,
      acceptedEntries: expect.arrayContaining([
        expect.objectContaining({
          target: "mapped",
          entry: expect.objectContaining({
            currentValue: before.value,
            proposedValue: { type: "string", value: "Синий" },
          }),
        }),
      ]),
    });
  });
  it("rejects changed local attributes after preview without mutating product or provenance", async () => {
    await existingAttribute();
    const p = await preview();
    const [original] = await attributes();
    if (!original) throw new Error("attribute fixture missing");
    await db
      .update(schema.productRegulatoryAttributeValues)
      .set({ value: { type: "string", value: "Зелёный" } })
      .where(eq(schema.productRegulatoryAttributeValues.id, original.id));
    const before = await product();
    const rows = await attributes();
    const result = await apply(decision(p, true));
    expect(result.items[0]).toMatchObject({
      product: "conflict",
      productReason: "attributes_changed",
    });
    expect(await attributes()).toEqual(rows);
    expect(await product()).toEqual(before);
    expect(await links()).toEqual([]);
  });
  it("fails malformed stored local attribute values without applying even link-only", async () => {
    await existingAttribute();
    const p = await preview();
    const [stored] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    const { previousValuesSchema } =
      await import("../src/modules/national-catalog/national-catalog-import-apply-state");
    const previous = previousValuesSchema.parse(stored?.previousValues);
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({
        previousValues: {
          ...previous,
          attributes: previous.attributes.map((row) => ({
            ...row,
            value: { type: "string", value: 123 },
          })),
        },
      })
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    const before = await attributes();
    const result = await apply(decision(p));
    expect(result.items[0]).toMatchObject({
      product: "failed",
      productReason: "infrastructure_failure",
    });
    expect(await attributes()).toEqual(before);
    expect(await links()).toEqual([]);
  });
  it("applies a fresh comparison after initial category and attributes import", async () => {
    const c = await category();
    expect((await apply(decision(c.preview, true))).items[0]?.product).toBe("applied");
    const before = await attributes();
    const linkBefore = (await links())[0]!;
    const fresh = await preview();
    expect(fresh.linkAction).toBe("keep");
    const result = await apply(decision(fresh));
    expect(result.items[0]).toMatchObject({ product: "applied", productReason: null });
    expect(await attributes()).toEqual(before);
    expect((await links())[0]).toMatchObject({
      id: linkBefore.id,
      revision: linkBefore.revision + 1,
    });
  });
  it("rolls back product, initial category, snapshot, link and audit when the attribute proposal sees stale profile", async () => {
    const c = await category();
    const before = await product();
    const suffix = randomUUID().replaceAll("-", "");
    const trigger = `nc_test_stale_${suffix}`;
    await connection.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id = '${existingId}'::uuid THEN NEW.revision := 2; END IF; RETURN NEW; END $$`,
    );
    await connection.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON product_regulatory_profiles FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      const result = await apply(decision(c.preview, true));
      expect(result.items[0]).toMatchObject({
        product: "conflict",
        productReason: "profile_changed",
      });
      expect(await product()).toEqual(before);
      for (const table of [
        schema.productRegulatoryProfiles,
        schema.productRegulatoryProposals,
        schema.nationalCatalogCardSnapshots,
        schema.nationalCatalogProductLinks,
      ])
        expect(await db.select().from(table).where(eq(table.productId, existingId))).toEqual([]);
      const audits = await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.targetId, existingId));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "national_catalog.import.item_failed",
        actorUserId: actor.userId,
        outcome: "failure",
        after: { result: "conflict", reason: "profile_changed" },
      });
    } finally {
      await connection.pool.query(`DROP TRIGGER ${trigger} ON product_regulatory_profiles`);
      await connection.pool.query(`DROP FUNCTION ${trigger}()`);
    }
  });
  it("detects schema and link drift before applying accepted fields", async () => {
    const c = await category();
    await db
      .update(schema.nationalCatalogSchemaVersions)
      .set({ status: "observed" })
      .where(eq(schema.nationalCatalogSchemaVersions.id, c.id));
    expect((await apply(decision(c.preview, true))).items[0]).toMatchObject({
      product: "conflict",
      productReason: "schema_changed",
    });
    const p = await preview();
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId: actor.tenantId,
      productId: existingId,
      cardId: "720679",
      environment: "sandbox",
      boundGtin14: GTIN,
      confirmedBy: actor.userId,
    });
    expect((await apply(decision(p))).items[0]).toMatchObject({
      product: "conflict",
      productReason: "link_changed",
    });
  });
  it("pins photo identity while preserving product success and evidence after independent image failure", async () => {
    source.images = [
      { sourceId: "photo", url: "https://images.example.test/photo", barcode: GTIN, primary: true },
    ];
    const p = await preview("Manual");
    const body = decision(p, true);
    const candidate = p.photos[0];
    if (!candidate) throw new Error("photo missing");
    body.decisions[0]!.photo = { kind: "candidate", candidateId: candidate.candidateId };
    const result = await apply(body);
    expect(result.items[0]).toMatchObject({ product: "applied", image: "pending" });
    const [before] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(before?.appliedEvidence).toMatchObject({
      version: 1,
      acceptedEntries: [expect.objectContaining({ source: "manual", proposedValue: "Manual" })],
    });
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ imageResult: "failed", imageErrorCode: "image_conflict" })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await service.resume(actor.tenantId, result.operationId);
    expect(
      (await service.read(actor.tenantId, sessionId, result.operationId)).items[0],
    ).toMatchObject({
      product: "applied",
      image: "failed",
      productReason: null,
      imageReason: "image_conflict",
      reason: "image_conflict",
    });
    const [after] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(after?.appliedEvidence).toEqual(before?.appliedEvidence);
    expect(after?.decision).toEqual(before?.decision);
    expect((await product())?.name).toBe("Manual");
  });

  it("retries only retained failed photos after expiry with the actual retrier and keeps the original acceptance actor", async () => {
    source.images = [
      { sourceId: "photo", url: "https://images.example.test/photo", barcode: GTIN, primary: true },
    ];
    const p = await preview();
    const body = decision(p);
    const photo = p.photos[0];
    if (!photo) throw new Error("photo missing");
    body.decisions[0]!.photo = { kind: "candidate", candidateId: photo.candidateId };
    const result = await apply(body);
    await expect(service.retry(actor, sessionId, result.operationId, [p.id])).rejects.toThrow(
      "operation_running",
    );
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ imageResult: "failed", imageErrorCode: "image_conflict" })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "expired" })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await db
      .delete(schema.integrationChannels)
      .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
    const assetId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: assetId,
      ownerTenantId: actor.tenantId,
      objectKey: `test/${assetId}`,
      contentType: "image/webp",
      byteSize: 10,
      checksum: "a".repeat(64),
      width: 1,
      height: 1,
    });
    await db
      .update(schema.nationalCatalogImportImages)
      .set({
        state: "ready",
        stagedAssetId: assetId,
        checksum: "a".repeat(64),
        byteSize: 10,
        width: 1,
        height: 1,
      })
      .where(eq(schema.nationalCatalogImportImages.previewId, p.id));
    const retrier = { tenantId: actor.tenantId, userId: randomUUID() };
    await db.insert(schema.user).values({
      id: retrier.userId,
      name: "Retrier",
      email: `${retrier.userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: actor.tenantId,
      userId: retrier.userId,
      role: "owner",
      createdAt: new Date(),
    });
    const retried = await service.retry(retrier, sessionId, result.operationId, [p.id]);
    expect(retried.items[0]).toMatchObject({
      product: "applied",
      image: "pending",
      productReason: null,
      imageReason: null,
    });
    const [receipt] = await db
      .select()
      .from(schema.nationalCatalogImportOperationItems)
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    expect(receipt?.decision).toMatchObject({ acceptedBy: actor.userId });
    expect(receipt?.appliedEvidence).toMatchObject({ appliedBy: actor.userId });
    const [op] = await db
      .select()
      .from(schema.nationalCatalogImportOperations)
      .where(eq(schema.nationalCatalogImportOperations.id, result.operationId));
    expect(op?.actorId).toBe(retrier.userId);
  });
  it("serializes two accepted operations for an absent GTIN into one creation and one conflict", async () => {
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: null, match: "new" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await db.delete(schema.products).where(eq(schema.products.id, existingId));
    const p = await preview();
    await init();
    const a = await service.start(actor, sessionId, decision(p, true));
    const b = await service.start(actor, sessionId, decision(p, true));
    await Promise.all([
      service.resume(actor.tenantId, a.operationId),
      service.resume(actor.tenantId, b.operationId),
    ]);
    const results = await Promise.all([
      service.read(actor.tenantId, sessionId, a.operationId),
      service.read(actor.tenantId, sessionId, b.operationId),
    ]);
    expect(results.map((r) => r.items[0]?.product).sort()).toEqual(["applied", "conflict"]);
  });
  it("does not classify unrelated unique constraints as GTIN conflict and supports explicit retry after the automatic budget", async () => {
    source.images = [
      {
        sourceId: "dependent",
        url: "https://images.example.test/dependent",
        barcode: GTIN,
        primary: true,
      },
    ];
    const p = await preview();
    const trigger = `nc_test_unique_${randomUUID().replaceAll("-", "")}`;
    await connection.pool.query(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${existingId}'::uuid THEN RAISE EXCEPTION 'fixture' USING ERRCODE='23505', CONSTRAINT='unrelated_constraint'; END IF; RETURN NEW; END $$`,
    );
    await connection.pool.query(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    let operationId: string;
    try {
      const body = decision(p, true);
      const photo = p.photos[0];
      if (!photo) throw new Error("dependent photo missing");
      body.decisions[0]!.photo = { kind: "candidate", candidateId: photo.candidateId };
      const result = await apply(body);
      operationId = result.operationId;
      expect(result.items[0]).toMatchObject({
        product: "failed",
        productReason: "infrastructure_failure",
      });
      expect(await links()).toEqual([]);
    } finally {
      await connection.pool.query(`DROP TRIGGER ${trigger} ON products`);
      await connection.pool.query(`DROP FUNCTION ${trigger}()`);
    }
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ attempts: 4, nextAttemptAt: null })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, operationId));
    await service.retry(actor, sessionId, operationId, [p.id]);
    await service.resume(actor.tenantId, operationId);
    expect((await service.read(actor.tenantId, sessionId, operationId)).items[0]?.product).toBe(
      "applied",
    );
  });
  it("denies revoked subscription on background mutation while preserving stored receipt reads", async () => {
    await init();
    const op = await service.start(actor, sessionId, decision(await preview()));
    await db
      .update(schema.tenantSubscriptions)
      .set({ status: "expired", endsAt: new Date(Date.now() - 1000) })
      .where(eq(schema.tenantSubscriptions.tenantId, actor.tenantId));
    await service.resume(actor.tenantId, op.operationId);
    expect((await service.read(actor.tenantId, sessionId, op.operationId)).items[0]).toMatchObject({
      product: "failed",
    });
    expect(await links()).toEqual([]);
  });

  it("denies cached photo retry after link replacement and after business-write revocation", async () => {
    source.images = [
      { sourceId: "photo", url: "https://images.example.test/photo", barcode: GTIN, primary: true },
    ];
    const p = await preview();
    const body = decision(p);
    const photo = p.photos[0];
    if (!photo) throw new Error("photo missing");
    body.decisions[0]!.photo = { kind: "candidate", candidateId: photo.candidateId };
    const result = await apply(body);
    await db
      .update(schema.nationalCatalogImportOperationItems)
      .set({ imageResult: "failed" })
      .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, actor.userId));
    await expect(service.retry(actor, sessionId, result.operationId, [p.id])).rejects.toThrow(
      "permission_denied",
    );
    await db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.userId, actor.userId));
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({ cardId: "different", revision: 2 })
      .where(eq(schema.nationalCatalogProductLinks.productId, existingId));
    await expect(service.retry(actor, sessionId, result.operationId, [p.id])).rejects.toThrow(
      "image_binding_changed",
    );
  });

  it("rejects duplicate target products and foreign preview/photo/link identities", async () => {
    const p = await preview();
    const other = await preview();
    await init();
    await expect(
      service.start(actor, sessionId, {
        requestId: randomUUID(),
        decisions: [...decision(p).decisions, ...decision(other).decisions],
      }),
    ).rejects.toThrow("duplicate_target");
    const invalid = decision(p);
    invalid.decisions[0]!.previewId = randomUUID();
    await expect(service.start(actor, sessionId, invalid)).rejects.toThrow(
      "import_preview_not_found",
    );
    const photo = decision(p);
    photo.decisions[0]!.photo = { kind: "candidate", candidateId: randomUUID() };
    await expect(service.start(actor, sessionId, photo)).rejects.toThrow("image_candidate_invalid");
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const linkService = new NationalCatalogLinkService(
      db,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
    );
    await expect(linkService.readDetail(await createOrganization(db), existingId)).rejects.toThrow(
      "product_not_found",
    );
  });
  it("retains cancellation committed before the summary acquires the session lock", async () => {
    await init();
    const op = await service.start(actor, sessionId, decision(await preview(), true));
    const lock = repository.lock.bind(repository);
    let locks = 0;
    const cancelledAt = new Date();
    const intercepted = vi
      .spyOn(repository, "lock")
      .mockImplementation(async (tx, tenantId, id) => {
        locks += 1;
        if (locks === 2) {
          await db.transaction(async (cancelTx) => {
            await lock(cancelTx, tenantId, id);
            await cancelTx
              .update(schema.nationalCatalogImportOperations)
              .set({ state: "cancelled", cancelledAt, enqueuePending: false })
              .where(
                and(
                  eq(schema.nationalCatalogImportOperations.tenantId, tenantId),
                  eq(schema.nationalCatalogImportOperations.id, op.operationId),
                ),
              );
          });
        }
        return lock(tx, tenantId, id);
      });
    try {
      await service.resume(actor.tenantId, op.operationId);
      expect(locks).toBe(2);
      expect((await service.read(actor.tenantId, sessionId, op.operationId)).state).toBe(
        "cancelled",
      );
      await service.resume(actor.tenantId, op.operationId);
      expect((await service.read(actor.tenantId, sessionId, op.operationId)).state).toBe(
        "cancelled",
      );
      const [stored] = await db
        .select()
        .from(schema.nationalCatalogImportOperations)
        .where(
          and(
            eq(schema.nationalCatalogImportOperations.tenantId, actor.tenantId),
            eq(schema.nationalCatalogImportOperations.id, op.operationId),
          ),
        );
      expect(stored?.cancelledAt).toEqual(cancelledAt);
      expect(stored?.enqueuePending).toBe(false);
    } finally {
      intercepted.mockRestore();
    }
  });
  it("public session cancellation durably stops accepted core work and redelivery", async () => {
    await init();
    const op = await service.start(actor, sessionId, decision(await preview(), true));
    await sessions.cancel(actor, sessionId);
    const cancelled = await service.read(actor.tenantId, sessionId, op.operationId);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.items[0]?.product).toBe("cancelled");
    await service.resume(actor.tenantId, op.operationId);
    expect(await service.read(actor.tenantId, sessionId, op.operationId)).toEqual(cancelled);
    expect(await links()).toEqual([]);
    expect((await product())?.name).toBe("Моё имя");
  });
  it("never resumes an explicitly cancelled accepted operation", async () => {
    await init();
    const op = await service.start(actor, sessionId, decision(await preview(), true));
    await db
      .update(schema.nationalCatalogImportOperations)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(eq(schema.nationalCatalogImportOperations.id, op.operationId));
    await service.resume(actor.tenantId, op.operationId);
    expect(await links()).toEqual([]);
    expect((await product())?.name).toBe("Моё имя");
    await expect(
      service.retry(actor, sessionId, op.operationId, [
        (await service.read(actor.tenantId, sessionId, op.operationId)).items[0]!.previewId,
      ]),
    ).rejects.toThrow("import_operation_cancelled");
  });
  it("retains rejected/unchanged target review after preview GC and compares live compatible attributes", async () => {
    const c = await existingAttribute();
    await apply(decision(await preview()));
    const link = (await links())[0];
    if (!link) throw new Error("link");
    expect(link.reviewedProjection).toMatchObject({
      version: 1,
      values: { name: "Из ЧЗ", [`attribute:${c.id}:20`]: { type: "string", value: "Синий" } },
    });
    await db
      .update(schema.nationalCatalogImportPreviews)
      .set({ source: null, diff: null, previousValues: null, payloadPurgedAt: new Date() })
      .where(eq(schema.nationalCatalogImportPreviews.sessionId, sessionId));
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const authorization = new AuthorizationService(db),
      entitlements = new EntitlementsService(db, "managed_only");
    const worker = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => ({
          status: "ok",
          value: { products: [source] },
          etag: null,
          contentHash: "f".repeat(64),
          usage: { total: null, method: null },
        }),
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw new Error("no photo request");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    const read = () =>
      new NationalCatalogLinkService(db, authorization, entitlements).read(
        actor.tenantId,
        existingId,
      );
    const refresh = async () => {
      await worker.request(actor, existingId);
      await worker.resume(actor.tenantId, link.id);
    };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    const unchangedLink = (await links())[0];
    expect(unchangedLink?.observedMeaningfulHash).toBe(unchangedLink?.reviewedMeaningfulHash);
    // Name was rejected and still differs. The only changed target now equals local red.
    source = { ...source, attributes: source.attributes.map((a) => ({ ...a, value: "Красный" })) };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    source = { ...source, attributes: source.attributes.map((a) => ({ ...a, value: "Зелёный" })) };
    await refresh();
    expect((await read()).hasChanges).toBe(true);
    await db
      .update(schema.productRegulatoryAttributeValues)
      .set({ value: { type: "string", value: "Зелёный" } })
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, actor.tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, existingId),
        ),
      );
    expect((await read()).hasChanges).toBe(false);
    await db
      .update(schema.productRegulatoryAttributeValues)
      .set({ state: "inapplicable" })
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, actor.tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, existingId),
        ),
      );
    expect((await read()).hasChanges).toBe(false);
    await db
      .update(schema.productRegulatoryAttributeValues)
      .set({ value: { type: "string", value: "Красный" } })
      .where(
        and(
          eq(schema.productRegulatoryAttributeValues.tenantId, actor.tenantId),
          eq(schema.productRegulatoryAttributeValues.productId, existingId),
        ),
      );
    await db
      .update(schema.nationalCatalogSchemaVersions)
      .set({ status: "retired" })
      .where(eq(schema.nationalCatalogSchemaVersions.id, c.id));
    expect((await read()).hasChanges).toBe(false);
    await db
      .update(schema.nationalCatalogSchemaVersions)
      .set({ status: "active" })
      .where(eq(schema.nationalCatalogSchemaVersions.id, c.id));
    source = { ...source, categories: [] };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
  });
  it("fences the old in-flight refresh and preserves its delay and budget for redelivery after confirmation", async () => {
    await apply(decision(await preview()));
    const p = await preview();
    const link = (await links())[0]!;
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    let calls = 0;
    let admitted: unknown;
    const worker = new NationalCatalogLinkRefreshService(
      db,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      {
        getFeedProductsByIds: async () => {
          calls++;
          if (calls === 1) {
            admitted = (await links())[0]!.refreshCheckpoint;
            expect((await apply(decision(p))).items[0]?.product).toBe("applied");
          }
          return {
            status: "ok",
            value: {
              products: [{ ...source, name: calls === 1 ? "Stale in flight" : "After redelivery" }],
            },
            etag: null,
            contentHash: "f".repeat(64),
            usage: { total: null, method: null },
          };
        },
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw new Error("no photo request");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    await worker.request(actor, existingId);
    await worker.resume(actor.tenantId, link.id);
    const { readRefreshCheckpoint } =
      await import("../src/modules/national-catalog/national-catalog-refresh-state");
    const original = readRefreshCheckpoint(admitted)!;
    const saved = (await links())[0]!;
    const rebased = readRefreshCheckpoint(saved.refreshCheckpoint)!;
    expect(saved.observedProjection).toMatchObject({ values: { name: source.name } });
    expect(rebased).toMatchObject({
      revision: saved.revision,
      actor: original.actor,
      stepId: original.stepId,
      attempts: original.attempts,
      nextRetryAt: original.nextRetryAt,
      runId: null,
      enqueuePending: true,
    });
    await worker.resume(actor.tenantId, link.id);
    expect(calls).toBe(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(rebased.nextRetryAt!) + 1);
    try {
      await worker.resume(actor.tenantId, link.id);
    } finally {
      clock.mockRestore();
    }
    expect(calls).toBe(2);
    const completed = (await links())[0]!;
    expect(completed.observedProjection).toMatchObject({ values: { name: "After redelivery" } });
    expect(readRefreshCheckpoint(completed.refreshCheckpoint)).toMatchObject({
      attempts: 2,
      enqueuePending: false,
    });
  });
  it("keeps a newer failed refresh attempt while using the preview check time for its successful observation", async () => {
    await apply(decision(await preview()));
    const p = await preview();
    const [prepared] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const worker = new NationalCatalogLinkRefreshService(
      db,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      {
        getFeedProductsByIds: async () => {
          throw Error("controlled provider outage");
        },
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw Error("no photo");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    const link = (await links())[0]!;
    await worker.request(actor, existingId);
    await worker.resume(actor.tenantId, link.id);
    const failed = (await links())[0]!;
    expect(failed.lastOutcome).toBe("error");
    await apply(decision(p));
    const reviewed = (await links())[0]!;
    expect(reviewed.lastSuccessAt).toEqual(prepared!.createdAt);
    expect(reviewed.lastAttemptAt).toEqual(failed.lastAttemptAt);
    expect(reviewed.lastOutcome).toBe("error");
    expect(reviewed.refreshErrorCode).toBe(failed.refreshErrorCode);
  });
  it("preserves a later completed observation when confirming an older retained-link comparison", async () => {
    await apply(decision(await preview()));
    const p = await preview();
    const [prepared] = await db
      .select()
      .from(schema.nationalCatalogImportPreviews)
      .where(eq(schema.nationalCatalogImportPreviews.id, p.id));
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const authorization = new AuthorizationService(db);
    const entitlements = new EntitlementsService(db, "managed_only");
    const worker = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => ({
          status: "ok",
          value: {
            products: [
              {
                ...source,
                name: "Later provider name",
                status: "draft",
                detailedStatuses: ["future_provider_status"],
              },
            ],
          },
          etag: null,
          contentHash: "f".repeat(64),
          usage: { total: null, method: null },
        }),
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw new Error("no photo request");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    const link = (await links())[0]!;
    await worker.request(actor, existingId);
    await worker.resume(actor.tenantId, link.id);
    const observed = (await links())[0]!;
    expect(observed.lastSuccessAt!.getTime()).toBeGreaterThanOrEqual(prepared!.createdAt.getTime());
    const result = await apply(decision(p));
    expect(result.items[0]?.product).toBe("applied");
    const confirmed = (await links())[0]!;
    expect(confirmed.latestSnapshotId).toBe(observed.latestSnapshotId);
    expect(confirmed.observedProjection).toEqual(observed.observedProjection);
    expect(confirmed.rawStatus).toBe("draft");
    expect(confirmed.statusKeys).toEqual(["draft", "unknown"]);
    expect(confirmed.lastSuccessAt).toEqual(observed.lastSuccessAt);
    expect(confirmed.lastAttemptAt).toEqual(observed.lastAttemptAt);
    expect(confirmed.reviewedProjection).toMatchObject({ values: { name: source.name } });
    expect(
      await new NationalCatalogLinkService(db, authorization, entitlements).read(
        actor.tenantId,
        existingId,
      ),
    ).toMatchObject({
      hasChanges: true,
      statusKeys: ["draft", "unknown"],
      rawStatus: "draft",
      rawDetailedStatuses: ["future_provider_status"],
    });
  });
  it("keeps rejected good_name print-name review unchanged on identical refresh", async () => {
    const c = await existingAttribute();
    await db.insert(schema.nationalCatalogAttributeMappings).values({
      schemaVersionId: c.id,
      sourceAttributeId: "good_name",
      targetField: "print_name",
      conversion: { kind: "string_trim" },
      mappingVersion: 1,
    });
    await db
      .update(schema.products)
      .set({ printName: "Local rejected title" })
      .where(eq(schema.products.id, existingId));
    const p = await preview();
    expect(p.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "print_name", applicable: true, after: "Из ЧЗ" }),
      ]),
    );
    const result = await apply(decision(p));
    expect(result.items[0]?.product).toBe("applied");
    const link = (await links())[0];
    if (!link?.reviewedSnapshotId) throw new Error("confirmed snapshot required");
    const reviewedSnapshotId = link.reviewedSnapshotId;
    const receiptQuery = () =>
      db
        .select()
        .from(schema.nationalCatalogImportOperationItems)
        .where(eq(schema.nationalCatalogImportOperationItems.operationId, result.operationId));
    const snapshotQuery = () =>
      db
        .select()
        .from(schema.nationalCatalogCardSnapshots)
        .where(eq(schema.nationalCatalogCardSnapshots.id, reviewedSnapshotId));
    const receipts = await receiptQuery();
    const snapshots = await snapshotQuery();
    expect(receipts).toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const authorization = new AuthorizationService(db),
      entitlements = new EntitlementsService(db, "managed_only");
    const worker = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => ({
          status: "ok",
          value: { products: [source] },
          etag: null,
          contentHash: "f".repeat(64),
          usage: { total: null, method: null },
        }),
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw new Error("no photo request");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    const read = () =>
      new NationalCatalogLinkService(db, authorization, entitlements).read(
        actor.tenantId,
        existingId,
      );
    const refresh = async () => {
      await worker.request(actor, existingId);
      await worker.resume(actor.tenantId, link.id);
    };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    const observed = (await links())[0];
    expect(observed?.observedMeaningfulHash).toBe(link.reviewedMeaningfulHash);
    expect(observed?.reviewedMeaningfulHash).toBe(link.reviewedMeaningfulHash);
    expect(observed?.reviewedProjection).toEqual(link.reviewedProjection);
    expect(observed?.reviewedProjection).toMatchObject({
      values: { "stable:print_name": "Из ЧЗ" },
    });
    expect(observed?.reviewedSnapshotId).toBe(link.reviewedSnapshotId);
    expect(await receiptQuery()).toEqual(receipts);
    expect(await snapshotQuery()).toEqual(snapshots);
    expect((await product())?.printName).toBe("Local rejected title");
  });
  it("compares first-filled supported values against known absence under the pinned reviewed schema", async () => {
    const c = await existingAttribute();
    const attribute = source.attributes[0];
    if (!attribute) throw new Error("attribute fixture");
    source = { ...source, attributes: [] };
    await apply(decision(await preview()));
    const link = (await links())[0];
    if (!link) throw new Error("link");
    const reviewed = link.reviewedProjection;
    expect(reviewed).toMatchObject({
      values: { name: "Из ЧЗ" },
      context: { schemaVersionId: c.id },
    });
    const { NationalCatalogLinkRefreshService } =
      await import("../src/modules/national-catalog/national-catalog-link-refresh.service");
    const { NationalCatalogLinkService } =
      await import("../src/modules/national-catalog/national-catalog-link.service");
    const authorization = new AuthorizationService(db),
      entitlements = new EntitlementsService(db, "managed_only");
    const worker = new NationalCatalogLinkRefreshService(
      db,
      authorization,
      entitlements,
      {
        getFeedProductsByIds: async () => ({
          status: "ok",
          value: { products: [source] },
          etag: null,
          contentHash: "f".repeat(64),
          usage: { total: null, method: null },
        }),
      },
      {
        run: async (_context, fn) =>
          fn({
            auth: { baseUrl: "https://catalog.invalid", token: "test-only" },
            signal: new AbortController().signal,
          }),
        runExternal: async () => {
          throw new Error("no photo request");
        },
      },
      { enabled: true, photos: { enabled: false, verifiedHosts: [] } },
    );
    const read = () =>
      new NationalCatalogLinkService(db, authorization, entitlements).read(
        actor.tenantId,
        existingId,
      );
    const refresh = async () => {
      await worker.request(actor, existingId);
      await worker.resume(actor.tenantId, link.id);
    };
    source = { ...source, attributes: [{ ...attribute, value: "Зелёный" }] };
    await refresh();
    expect((await read()).hasChanges).toBe(true);
    source = { ...source, attributes: [{ ...attribute, value: "Красный" }] };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    source = { ...source, attributes: [] };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    await db.insert(schema.nationalCatalogAttributeMappings).values({
      schemaVersionId: c.id,
      sourceAttributeId: "999",
      targetField: "print_name",
      conversion: { kind: "string_trim" },
      mappingVersion: 1,
    });
    source = { ...source, attributes: [{ ...attribute, id: 999, value: "Unpinned title" }] };
    await refresh();
    expect((await read()).hasChanges).toBe(false);
    expect((await links())[0]?.reviewedProjection).toEqual(reviewed);
  });
});
