import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { importPrepareResponseSchema, type ImportPrepare } from "@markiro/platform-contracts";
import { AuthorizationService } from "../src/authorization/authorization.service";
import { EntitlementsService } from "../src/subscriptions/entitlements.service";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportRepository } from "../src/modules/national-catalog/national-catalog-import.repository";
import { NationalCatalogRequestCoordinator } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import {
  NationalCatalogImportPreviewService,
  defaultAcceptedEntries,
} from "../src/modules/national-catalog/national-catalog-import-preview.service";
import {
  assertPreviewEntrySelection,
  buildPhotoCandidates,
  productFingerprint,
  type StoredImportDiff,
} from "../src/modules/national-catalog/national-catalog-import-preview-builder";
import type { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import type { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import type { NationalCatalogProduct } from "../src/modules/national-catalog/national-catalog.types";
import { createManagedSubscription, createOrganization } from "./support/subscription-fixtures";
const GTIN = "04601234567893";
const preparations = schema.nationalCatalogImportPreparations;
const previews = schema.nationalCatalogImportPreviews;
function card(id = 1, name: string | null = "Из ЧЗ"): NationalCatalogProduct {
  return {
    id,
    name,
    status: "published",
    detailedStatuses: [],
    identifiers: [{ value: GTIN, type: "gtin", level: null, multiplier: null }],
    categories: [],
    attributes: [],
    images: [],
    imageIssues: [],
    raw: { good_id: id, good_name: name },
  };
}
function feed(products: NationalCatalogProduct[]) {
  return {
    status: "ok" as const,
    value: { products },
    contentHash: "a".repeat(64),
    etag: null,
    usage: { total: null, method: null },
  };
}
it("requires explicit field acceptance for an existing product", () => {
  const fields = [
    {
      id: "name",
      label: "Название",
      before: "Моё",
      after: "Из ЧЗ",
      applicable: true,
      reason: null,
      source: "national_catalog" as const,
      selectedByDefault: false,
    },
  ];
  expect(defaultAcceptedEntries("existing", fields)).toEqual([]);
  expect(defaultAcceptedEntries("new", fields)).toEqual(["name"]);
});

it("retains a sole foreign-GTIN photo as an explicit alternative, never as a fallback", () => {
  const source = card();
  source.images = [
    {
      sourceId: "foreign",
      url: "https://images.example.test/foreign",
      barcode: "14601234567890",
      primary: true,
    },
  ];
  expect(buildPhotoCandidates(source, GTIN, false)).toEqual([
    {
      url: "https://images.example.test/foreign",
      dto: expect.objectContaining({
        state: "pending",
        reason: "barcode_mismatch",
        selectedByDefault: false,
      }),
    },
  ]);
  source.images.push({
    sourceId: "invalid",
    url: "https://images.example.test/invalid",
    barcode: "bad",
    primary: true,
  });
  expect(buildPhotoCandidates(source, GTIN, false)[1]).toMatchObject({
    url: null,
    dto: { state: "failed", reason: "invalid_barcode", selectedByDefault: false },
  });
});
it("chooses only a unique matching or primary or unambiguous unbarcoded image by priority", () => {
  const source = card();
  source.images = [
    {
      sourceId: "unbound",
      url: "https://images.example.test/unbound",
      barcode: null,
      primary: true,
    },
    { sourceId: "match", url: "https://images.example.test/match", barcode: GTIN, primary: false },
  ];
  expect(buildPhotoCandidates(source, GTIN, false).map((c) => c.dto.selectedByDefault)).toEqual([
    false,
    true,
  ]);
  source.images[1]!.barcode = null;
  expect(buildPhotoCandidates(source, GTIN, false).map((c) => c.dto.selectedByDefault)).toEqual([
    true,
    false,
  ]);
  source.images[0]!.primary = false;
  expect(buildPhotoCandidates(source, GTIN, false).every((c) => !c.dto.selectedByDefault)).toBe(
    true,
  );
  source.images.pop();
  expect(buildPhotoCandidates(source, GTIN, false)[0]?.dto.selectedByDefault).toBe(true);
});
if (!process.env.DATABASE_URL)
  throw new Error("Preview tests require a dedicated PostgreSQL DATABASE_URL");
describe("immutable pre-product comparisons and durable preparation", () => {
  const databaseName = `markiro_nc_preview_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  url.pathname = `/${databaseName}`;
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let actor: { tenantId: string; userId: string };
  let sessionId: string;
  let itemId: string;
  let service: NationalCatalogImportPreviewService;
  let features = { ownCatalog: true, gtinLookup: true };
  const detail = vi.fn<NationalCatalogClient["getFeedProductsByIds"]>();
  const beforeToken = vi.fn<() => Promise<void>>();
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(url.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
  }, 120_000);
  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });
  beforeEach(async () => {
    actor = { tenantId: await createOrganization(db), userId: randomUUID() };
    await db.insert(schema.user).values({
      id: actor.userId,
      name: "Preview actor",
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
    const repository = new NationalCatalogImportRepository(db);
    const tokens = {
      getCatalogToken: async () => {
        await beforeToken();
        return {
          status: "ok",
          auth: { baseUrl: "https://markirovka.sandbox.crptech.ru/api/v3/true-api", token: "test" },
          obtainedAt: new Date(),
        };
      },
      invalidateAndRequestRefresh: async () => {},
    } as unknown as ChzTokenService;
    const coordinator = new NationalCatalogRequestCoordinator(
      db,
      tokens,
      "https://api.nk.sandbox.crptech.ru",
    );
    features = { ownCatalog: true, gtinLookup: true };
    const sessions = new NationalCatalogImportService(
      repository,
      { listOwnProducts: vi.fn(), getFeedProducts: vi.fn() },
      coordinator,
      new AuthorizationService(db),
      new EntitlementsService(db, "managed_only"),
      features,
    );
    sessionId = (await sessions.start(actor, { mode: "gtins", text: GTIN })).id;
    itemId = randomUUID();
    await db.insert(schema.nationalCatalogImportItems).values({
      id: itemId,
      tenantId: actor.tenantId,
      sessionId,
      gtin14: GTIN,
      cardId: "1",
      match: "new",
      selected: true,
      selectable: true,
      access: null,
      source: { good_id: 1 },
      sourceHash: "a".repeat(64),
    });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ loaded: 1, selected: 1 })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    service = new NationalCatalogImportPreviewService(
      repository,
      sessions,
      { getFeedProductsByIds: detail },
      coordinator,
    );
    detail.mockReset().mockResolvedValue(feed([card()]));
    beforeToken.mockReset();
  });
  const request = (): ImportPrepare => ({
    requestId: randomUUID(),
    itemIds: [itemId],
    manualNames: [],
    categoryChoices: [],
  });
  async function run(body = request()) {
    const started = await service.prepare(actor, sessionId, body);
    await service.resumePreparation(actor.tenantId, sessionId, started.preparation.id);
    return service.readPreparation(actor.tenantId, sessionId, started.preparation.id);
  }
  async function local(name = "Моё", archived = false) {
    const [p] = await db
      .insert(schema.products)
      .values({ tenantId: actor.tenantId, gtin14: GTIN, name, archived })
      .returning();
    if (!p) throw new Error("fixture");
    return p;
  }
  it("creates immutable name-only comparison for an unbound new product without product/profile/link/snapshot/proposal writes", async () => {
    const result = await run();
    expect(importPrepareResponseSchema.safeParse(result).success).toBe(true);
    expect(result.preparation).toMatchObject({ state: "ready", completed: 1, failures: [] });
    expect(result.items[0]).toMatchObject({
      productId: null,
      canApply: true,
      linkAction: "attach",
      fields: [
        expect.objectContaining({
          label: "Название",
          after: "Из ЧЗ",
          source: "national_catalog",
          selectedByDefault: true,
        }),
      ],
    });
    const [row] = await db.select().from(previews).where(eq(previews.id, result.items[0]!.id));
    expect(row?.previousValues).toMatchObject({ expectedAbsentGtin: GTIN });
    expect(row?.diff).toMatchObject({
      version: 1,
      entries: [expect.objectContaining({ target: "name", source: "national_catalog" })],
    });
    for (const table of [
      schema.products,
      schema.productRegulatoryProfiles,
      schema.nationalCatalogCardSnapshots,
      schema.productRegulatoryProposals,
      schema.nationalCatalogProductLinks,
    ])
      expect(await db.select().from(table).where(eq(table.tenantId, actor.tenantId))).toHaveLength(
        0,
      );
    expect(detail).toHaveBeenCalledWith(
      expect.anything(),
      ["1"],
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onResponse: expect.any(Function),
      }),
    );
  });
  it("replays request identity without HTTP and rejects changed body; new identity makes a new immutable comparison", async () => {
    const body = request();
    const first = await run(body);
    const repeated = await service.prepare(actor, sessionId, body);
    expect(repeated).toEqual(first);
    expect(detail).toHaveBeenCalledTimes(1);
    await expect(
      service.prepare(actor, sessionId, { ...body, manualNames: [{ itemId, name: "other" }] }),
    ).rejects.toMatchObject({ status: 409 });
    await local("Новое местное имя");
    detail.mockResolvedValue(feed([card(1, "Новый источник")]));
    expect(await service.prepare(actor, sessionId, body)).toEqual(first);
    const next = await run({ ...body, requestId: randomUUID() });
    expect(next.items[0]?.fields[0]).toMatchObject({
      before: "Новое местное имя",
      after: "Новый источник",
    });
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(
      await db.select().from(previews).where(eq(previews.tenantId, actor.tenantId)),
    ).toHaveLength(2);
  });
  it("keeps blank draft blocked until a separately validated manual name is supplied", async () => {
    detail.mockResolvedValue(feed([card(1, "   ")]));
    const blank = await run();
    expect(blank.items[0]).toMatchObject({ canApply: false, reason: "name_required", fields: [] });
    const named = await run({ ...request(), manualNames: [{ itemId, name: " Ручное " }] });
    expect(named.items[0]?.fields).toEqual([
      expect.objectContaining({ after: "Ручное", source: "manual" }),
    ]);
    expect(named.items[0]?.canApply).toBe(true);
  });
  it("unbound existing product stays explicit and exact unchanged names permit link-only", async () => {
    const p = await local();
    const changed = await run();
    expect(changed.items[0]).toMatchObject({
      productId: p.id,
      canApply: true,
      fields: [expect.objectContaining({ before: "Моё", selectedByDefault: false })],
    });
    detail.mockResolvedValue(feed([card(1, "Моё")]));
    const same = await run();
    expect(same.items[0]).toMatchObject({ canApply: true, fields: [], linkAction: "attach" });
  });
  it("shows replacement for an old link, without mutating it", async () => {
    const p = await local();
    await db.insert(schema.nationalCatalogProductLinks).values({
      tenantId: actor.tenantId,
      productId: p.id,
      environment: "production",
      cardId: "old",
      boundGtin14: GTIN,
      confirmedBy: actor.userId,
      revision: 7,
      observedMeaningfulHash: "b".repeat(64),
      reviewedMeaningfulHash: "c".repeat(64),
    });
    const result = await run();
    expect(result.items[0]?.linkAction).toBe("replace");
    const [stored] = await db.select().from(previews).where(eq(previews.id, result.items[0]!.id));
    expect(stored?.previousValues).toMatchObject({
      link: {
        cardId: "old",
        environment: "production",
        revision: 7,
        observedMeaningfulHash: "b".repeat(64),
        reviewedMeaningfulHash: "c".repeat(64),
      },
    });
    expect(
      (
        await db
          .select()
          .from(schema.nationalCatalogProductLinks)
          .where(eq(schema.nationalCatalogProductLinks.productId, p.id))
      )[0]?.cardId,
    ).toBe("old");
  });
  it.each(["wrong_card", "wrong_gtin", "archived_remote", "archived_local"])(
    "rejects changed selection source %s without a forged preview",
    async (kind) => {
      const value = card();
      if (kind === "wrong_card") value.id = 999;
      if (kind === "wrong_gtin") value.identifiers = [];
      if (kind === "archived_remote") value.status = "archived";
      if (kind === "archived_local") await local("Archived", true);
      detail.mockResolvedValue(feed([value]));
      const result = await run();
      expect(result.items).toEqual([]);
      expect(result.preparation.failures).toHaveLength(1);
    },
  );
  it("rejects cross-tenant/session IDs and unselected items before work", async () => {
    await expect(
      service.prepare({ ...actor, tenantId: await createOrganization(db) }, sessionId, request()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.prepare(actor, sessionId, { ...request(), itemIds: [randomUUID()] }),
    ).rejects.toMatchObject({ status: 422 });
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ selected: false })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    await expect(service.prepare(actor, sessionId, request())).rejects.toMatchObject({
      status: 422,
    });
    expect(detail).not.toHaveBeenCalled();
  });
  it("persists quota deferral without fake previews or consumed attempt, GET and repeated POST do not request", async () => {
    await db.insert(schema.nationalCatalogRequestLeases).values({
      tenantId: actor.tenantId,
      owner: randomUUID(),
      leaseUntil: new Date(0),
      nextAllowedAt: new Date(Date.now() + 300_000),
    });
    const body = request();
    const result = await run(body);
    expect(result.items).toEqual([]);
    expect(result.preparation.nextRetryAt).not.toBeNull();
    await service.readPreparation(actor.tenantId, sessionId, result.preparation.id);
    await service.prepare(actor, sessionId, body);
    expect(detail).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(preparations)
      .where(eq(preparations.id, result.preparation.id));
    expect(row?.checkpoint).toMatchObject({ attempts: 0, enqueuePending: true });
  });
  it("preserves admitted retry budget across reconstruction and manual retry resets only exhausted work", async () => {
    detail.mockResolvedValue({ status: "unavailable" });
    const result = await run();
    const id = result.preparation.id;
    for (let i = 1; i < 4; i++) {
      await db.execute(
        sql`update national_catalog_import_preparations set checkpoint=jsonb_set(checkpoint,'{nextRetryAt}','null') where id=${id}`,
      );
      await db
        .update(schema.nationalCatalogRequestLeases)
        .set({ nextAllowedAt: new Date(0), leaseUntil: new Date(0) })
        .where(eq(schema.nationalCatalogRequestLeases.tenantId, actor.tenantId));
      await service.resumePreparation(actor.tenantId, sessionId, id);
    }
    expect(detail).toHaveBeenCalledTimes(4);
    const failed = await service.readPreparation(actor.tenantId, sessionId, id);
    expect(failed.preparation.failures).toEqual([
      expect.objectContaining({ itemId, retryable: true }),
    ]);
    await service.prepare(actor, sessionId, {
      ...request(),
      requestId: failed.preparation.requestId,
    });
    await service.resumePreparation(actor.tenantId, sessionId, id);
    expect(detail).toHaveBeenCalledTimes(4);
    await service.retryPreparation(actor, sessionId, id);
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ nextAllowedAt: new Date(0) })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, actor.tenantId));
    detail.mockResolvedValue(feed([card()]));
    await service.resumePreparation(actor.tenantId, sessionId, id);
    expect((await service.readPreparation(actor.tenantId, sessionId, id)).items).toHaveLength(1);
  });
  it.each(["success", "failure"])(
    "rechecks revocation before accepting %s outcomes",
    async (outcome) => {
      detail.mockImplementation(async () => {
        await db
          .delete(schema.member)
          .where(
            and(
              eq(schema.member.organizationId, actor.tenantId),
              eq(schema.member.userId, actor.userId),
            ),
          );
        return outcome === "success" ? feed([card()]) : { status: "unavailable" };
      });
      const started = await service.prepare(actor, sessionId, request());
      await service.resumePreparation(actor.tenantId, sessionId, started.preparation.id);
      const [row] = await db
        .select()
        .from(preparations)
        .where(eq(preparations.id, started.preparation.id));
      expect(row?.checkpoint).toMatchObject({
        state: "blocked",
        reason: "permission_denied",
        completed: [],
        failures: [],
      });
      expect(
        await db.select().from(previews).where(eq(previews.tenantId, actor.tenantId)),
      ).toHaveLength(0);
    },
  );
  it("stores pending photo candidates with safe diagnostics and never chooses a foreign barcode", async () => {
    const value = card();
    value.images = [
      {
        sourceId: "wrong",
        url: "https://images.example.test/wrong",
        barcode: "14601234567890",
        primary: true,
      },
      { sourceId: "good", url: "https://images.example.test/good", barcode: GTIN, primary: false },
    ];
    value.imageIssues = [{ sourceId: "bad", reason: "invalid_barcode" }];
    detail.mockResolvedValue(feed([value]));
    const result = await run();
    expect(result.items[0]?.photos).toEqual([
      expect.objectContaining({
        state: "pending",
        reason: "barcode_mismatch",
        selectedByDefault: false,
      }),
      expect.objectContaining({ state: "pending", reason: null, selectedByDefault: true }),
      expect.objectContaining({
        state: "failed",
        reason: "invalid_barcode",
        selectedByDefault: false,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("images.example");
  });
  async function category(
    groupCode = 23,
    status: "active" | "observed" = "active",
    reviewed = true,
  ) {
    const id = randomUUID();
    const categoryId = String(parseInt(id.slice(0, 8), 16));
    const scopeKey = `test-${id}`;
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
            label: "Цвет",
            valueType: "string",
            multiplicity: "one",
            unit: null,
            requirementRules: [],
            presetMode: "none",
            presets: [],
          },
        ],
      },
      status,
      fetchedAt: new Date(),
      validatedAt: new Date(),
      activatedAt: status === "active" ? new Date() : null,
    });
    await db.insert(schema.nationalCatalogCategoryGroupMappings).values({
      chzProductGroupCode: groupCode,
      schemaVersionId: id,
      categoryId,
      state: "exact",
      reviewedBy: reviewed ? actor.userId : null,
      reviewedAt: reviewed ? new Date() : null,
    });
    const value = card();
    value.categories = [{ id: Number(categoryId), name: "Категория" }];
    value.attributes = [
      {
        id: 20,
        name: "Цвет",
        value: "Синий",
        valueId: null,
        attributeValueId: null,
        valueType: null,
        groupId: null,
        groupName: null,
        locationId: null,
        level: null,
        gtin: null,
        multiplier: null,
      },
    ];
    detail.mockResolvedValue(feed([value]));
    return { id, categoryId, value };
  }
  it("requires an explicit persisted category option, creates dependent entries and never duplicates mapped name", async () => {
    const c = await category();
    await db.insert(schema.nationalCatalogAttributeMappings).values({
      schemaVersionId: c.id,
      sourceAttributeId: "good_name",
      targetField: "name",
      conversion: { kind: "string_trim" },
      mappingVersion: 1,
    });
    const initial = await run();
    expect(initial.items[0]?.fields.filter((f) => f.applicable)).toHaveLength(1);
    expect(initial.items[0]?.categoryOptions).toHaveLength(1);
    const choice = initial.items[0]!.categoryOptions[0]!;
    const selected = await run({
      ...request(),
      categoryChoices: [{ itemId, optionId: choice.optionId }],
    });
    expect(selected.items[0]?.fields.filter((f) => f.applicable)).toHaveLength(3);
    const [row] = await db.select().from(previews).where(eq(previews.id, selected.items[0]!.id));
    const diff = row?.diff as StoredImportDiff;
    expect(diff.entries.filter((entry) => entry.target === "name")).toHaveLength(1);
    const attr = diff.entries.find((entry) => entry.target === "mapped");
    const binding = diff.entries.find((entry) => entry.target === "category");
    if (!attr || !binding) throw new Error("Missing category entries");
    expect(() => assertPreviewEntrySelection(diff, [attr.entryId])).toThrow(
      "category_entry_required",
    );
    expect(() => assertPreviewEntrySelection(diff, [attr.entryId, binding.entryId])).not.toThrow();
    expect(row?.previousValues).toMatchObject({
      expectedAbsentGtin: GTIN,
      initialProduct: {
        chzProductGroupCode: 23,
        boxCapacity: null,
        palletCapacity: null,
        status: "draft",
      },
    });
    expect(
      await db.select().from(schema.products).where(eq(schema.products.tenantId, actor.tenantId)),
    ).toHaveLength(0);
  });
  it.each(["inactive", "unreviewed", "incompatible"])(
    "keeps attributes read-only for %s mapping",
    async (kind) => {
      await category(23, kind === "inactive" ? "observed" : "active", kind !== "unreviewed");
      if (kind === "incompatible") {
        const p = await local();
        await db
          .update(schema.products)
          .set({ chzProductGroupCode: 15 })
          .where(eq(schema.products.id, p.id));
      }
      const result = await run();
      expect(result.items[0]?.categoryOptions).toEqual([]);
      expect(result.items[0]?.fields.filter((f) => f.applicable)).toHaveLength(1);
      expect(result.items[0]?.fields.find((f) => f.label === "Цвет")).toMatchObject({
        applicable: false,
        reason: "compatible_schema_required",
      });
    },
  );
  it("uses an existing profile category and rejects separate category change, even if a prior option exists", async () => {
    const c = await category();
    const initial = await run();
    const optionId = initial.items[0]!.categoryOptions[0]!.optionId;
    const p = await local();
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 23 })
      .where(eq(schema.products.id, p.id));
    await db.insert(schema.productRegulatoryProfiles).values({
      tenantId: actor.tenantId,
      productId: p.id,
      categoryId: c.categoryId,
      categoryName: "Existing",
      schemaVersionId: c.id,
      source: "manual",
      confirmedAt: new Date(),
      revision: 9,
    });
    const result = await run();
    expect(result.items[0]?.categoryOptions).toEqual([]);
    expect(result.items[0]?.fields.find((f) => f.label === "Цвет")).toMatchObject({
      applicable: true,
      selectedByDefault: false,
    });
    const [row] = await db.select().from(previews).where(eq(previews.id, result.items[0]!.id));
    expect(row?.expectedProfileRevision).toBe(9);
    const changed = await run({ ...request(), categoryChoices: [{ itemId, optionId }] });
    expect(changed.preparation.failures).toEqual([
      { itemId, reason: "category_change_separate", retryable: false },
    ]);
  });
  it("does not import attributes of different packaging GTIN into the selected product", async () => {
    const c = await category();
    c.value.attributes[0]!.gtin = "14601234567890";
    detail.mockResolvedValue(feed([c.value]));
    const initial = await run();
    const result = await run({
      ...request(),
      categoryChoices: [{ itemId, optionId: initial.items[0]!.categoryOptions[0]!.optionId }],
    });
    expect(result.items[0]?.fields.find((f) => f.label === "Цвет")?.applicable).toBe(false);
  });
  it("rejects arbitrary, cross-session, and expired category options and stale active schema", async () => {
    const c = await category();
    const first = await run();
    const optionId = first.items[0]!.categoryOptions[0]!.optionId;
    await expect(
      service.prepare(actor, sessionId, {
        ...request(),
        categoryChoices: [{ itemId, optionId: randomUUID() }],
      }),
    ).rejects.toMatchObject({ status: 422 });
    await db
      .update(previews)
      .set({ expiresAt: new Date(0) })
      .where(eq(previews.id, first.items[0]!.id));
    await expect(
      service.prepare(actor, sessionId, { ...request(), categoryChoices: [{ itemId, optionId }] }),
    ).rejects.toMatchObject({ status: 422 });
    await db
      .update(previews)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(previews.id, first.items[0]!.id));
    await db
      .update(schema.nationalCatalogSchemaVersions)
      .set({ status: "retired" })
      .where(eq(schema.nationalCatalogSchemaVersions.id, c.id));
    const stale = await run({ ...request(), categoryChoices: [{ itemId, optionId }] });
    expect(stale.preparation.failures[0]?.reason).toBe("category_option_stale");
  });
  it("keeps local photo changes independent from product fingerprint and defaults to keep", async () => {
    const p = await local();
    const first = await run();
    const assetId = randomUUID();
    await db.insert(schema.mediaAssets).values({
      id: assetId,
      ownerTenantId: actor.tenantId,
      objectKey: `test/${assetId}`,
      contentType: "image/webp",
      byteSize: 10,
      checksum: "f".repeat(64),
      width: 10,
      height: 10,
      status: "active",
    });
    await db
      .insert(schema.productImages)
      .values({ tenantId: actor.tenantId, productId: p.id, assetId });
    const value = card();
    value.images = [
      { sourceId: "good", url: "https://images.example.test/image", barcode: GTIN, primary: true },
    ];
    detail.mockResolvedValue(feed([value]));
    const next = await run();
    const [oldRow] = await db.select().from(previews).where(eq(previews.id, first.items[0]!.id));
    const [newRow] = await db.select().from(previews).where(eq(previews.id, next.items[0]!.id));
    expect(oldRow?.expectedProductRevision).toBe(productFingerprint(p));
    expect(newRow?.expectedProductRevision).toBe(oldRow?.expectedProductRevision);
    expect(oldRow?.previousPhoto).toBeNull();
    expect(newRow?.previousPhoto).toMatchObject({ assetId });
    expect(next.items[0]?.photos[0]?.selectedByDefault).toBe(false);
  });
  it("batches at 25 cards and retains successful siblings when a later batch fails", async () => {
    function gtin(n: number) {
      const body = String(n).padStart(13, "0");
      const sum = [...body].reduce(
        (sum, digit, i) => sum + Number(digit) * (i % 2 === 0 ? 3 : 1),
        0,
      );
      return body + ((10 - (sum % 10)) % 10);
    }
    const ids = [itemId];
    const cards = [card()];
    for (let i = 2; i <= 26; i++) {
      const id = randomUUID();
      ids.push(id);
      const value = card(i);
      value.identifiers[0]!.value = gtin(i);
      cards.push(value);
      await db.insert(itemsTable()).values({
        id,
        tenantId: actor.tenantId,
        sessionId,
        gtin14: gtin(i),
        cardId: String(i),
        match: "new",
        selected: true,
        selectable: true,
        source: {},
        sourceHash: "a".repeat(64),
      });
    }
    detail.mockImplementation(async (_auth, cardIds) =>
      feed(cards.filter((c) => cardIds.includes(String(c.id)))),
    );
    const started = await service.prepare(actor, sessionId, { ...request(), itemIds: ids });
    const [before] = await db
      .select()
      .from(preparations)
      .where(eq(preparations.id, started.preparation.id));
    const step = (before?.checkpoint as { stepId: string }).stepId;
    await service.resumePreparation(actor.tenantId, sessionId, started.preparation.id, step);
    const partial = await service.readPreparation(
      actor.tenantId,
      sessionId,
      started.preparation.id,
    );
    expect(partial.items).toHaveLength(25);
    await service.resumePreparation(actor.tenantId, sessionId, started.preparation.id, step);
    expect(detail).toHaveBeenCalledTimes(1);
    detail.mockResolvedValue({ status: "not_found" });
    await service.resumePreparation(actor.tenantId, sessionId, started.preparation.id);
    const end = await service.readPreparation(actor.tenantId, sessionId, started.preparation.id);
    expect(end.items).toEqual(partial.items);
    expect(end.preparation).toMatchObject({
      state: "partial",
      completed: 25,
      failures: [expect.objectContaining({ reason: "not_found" })],
    });
    expect(detail.mock.calls.every((call) => call[1].length <= 25)).toBe(true);
  });
  function itemsTable() {
    return schema.nationalCatalogImportItems;
  }
  it("does not reset running retries and attributes explicit blocked retry to the retrying user", async () => {
    detail.mockResolvedValue({ status: "forbidden", message: "safe" });
    const first = await run();
    const id = first.preparation.id;
    const retryUser = randomUUID();
    await db.insert(schema.user).values({
      id: retryUser,
      name: "Retry user",
      email: `${retryUser}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: randomUUID(),
      userId: retryUser,
      organizationId: actor.tenantId,
      role: "owner",
      createdAt: new Date(),
    });
    await service.retryPreparation({ ...actor, userId: retryUser }, sessionId, id);
    let [row] = await db.select().from(preparations).where(eq(preparations.id, id));
    expect(row?.actorId).toBe(retryUser);
    await service.retryPreparation(actor, sessionId, id);
    [row] = await db.select().from(preparations).where(eq(preparations.id, id));
    expect(row?.actorId).toBe(retryUser);
    await db.delete(schema.member).where(eq(schema.member.userId, retryUser));
    detail.mockResolvedValue(feed([card()]));
    await service.resumePreparation(actor.tenantId, sessionId, id);
    [row] = await db.select().from(preparations).where(eq(preparations.id, id));
    expect(row?.checkpoint).toMatchObject({ state: "blocked", reason: "permission_denied" });
    expect(detail).toHaveBeenCalledTimes(1);
  });
  it("refuses expired sessions and cross-session preparation/category identities without extending TTL", async () => {
    await category();
    const first = await run();
    const original = await db
      .select()
      .from(schema.nationalCatalogImportSessions)
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    const otherId = randomUUID();
    await db.insert(schema.nationalCatalogImportSessions).values({
      id: otherId,
      tenantId: actor.tenantId,
      actorId: actor.userId,
      environment: "sandbox",
      mode: "gtins",
      throughAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
    await expect(
      service.readPreparation(actor.tenantId, otherId, first.preparation.id),
    ).rejects.toMatchObject({ status: 404 });
    const otherItem = randomUUID();
    await db.insert(schema.nationalCatalogImportItems).values({
      id: otherItem,
      tenantId: actor.tenantId,
      sessionId: otherId,
      cardId: "1",
      gtin14: GTIN,
      selected: true,
      selectable: true,
      match: "new",
      source: {},
      sourceHash: "a".repeat(64),
    });
    await expect(
      service.prepare(actor, otherId, {
        ...request(),
        itemIds: [otherItem],
        categoryChoices: [
          { itemId: otherItem, optionId: first.items[0]!.categoryOptions[0]!.optionId },
        ],
      }),
    ).rejects.toMatchObject({ status: 422 });
    const next = await run();
    expect(next.items[0]?.expiresAt).toBe(original[0]?.expiresAt.toISOString());
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ expiresAt: new Date(Date.now() - 1), startedAt: new Date(Date.now() - 86400000) })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await expect(service.prepare(actor, sessionId, request())).rejects.toMatchObject({
      status: 410,
    });
    await expect(
      service.readPreparation(actor.tenantId, sessionId, first.preparation.id),
    ).rejects.toMatchObject({ status: 410 });
  });
  it("does not infer a compatible group from a profile when the local group is absent", async () => {
    const c = await category();
    const p = await local();
    await db.insert(schema.productRegulatoryProfiles).values({
      tenantId: actor.tenantId,
      productId: p.id,
      categoryId: c.categoryId,
      categoryName: "Existing",
      schemaVersionId: c.id,
      source: "manual",
      confirmedAt: new Date(),
    });
    const result = await run();
    expect(result.items[0]?.fields.find((f) => f.label === "Цвет")?.applicable).toBe(false);
  });
  it.each(["write_revoked", "read_only_subscription", "disabled", "environment"])(
    "reads stored comparisons after %s without authorizing a new mutation",
    async (kind) => {
      const initial = await run();
      if (kind === "write_revoked")
        await db
          .update(schema.member)
          .set({ role: "member" })
          .where(eq(schema.member.userId, actor.userId));
      if (kind === "read_only_subscription")
        await db
          .update(schema.tenantSubscriptions)
          .set({ status: "expired", endsAt: new Date(Date.now() - 1000) })
          .where(eq(schema.tenantSubscriptions.tenantId, actor.tenantId));
      if (kind === "disabled") features.gtinLookup = false;
      if (kind === "environment")
        await db
          .update(schema.integrationChannels)
          .set({ settings: { environment: "production" } })
          .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
      expect(
        await service.readPreparation(actor.tenantId, sessionId, initial.preparation.id),
      ).toEqual(initial);
      await expect(service.prepare(actor, sessionId, request())).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        service.retryPreparation(actor, sessionId, initial.preparation.id),
      ).rejects.toMatchObject({ status: 403 });
      expect(detail).toHaveBeenCalledTimes(1);
    },
  );
  it("returns machine-safe terminal read errors for cancelled preparation sessions", async () => {
    const initial = await service.prepare(actor, sessionId, request());
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await expect(
      service.readPreparation(actor.tenantId, sessionId, initial.preparation.id),
    ).rejects.toMatchObject({ status: 410, message: "import_preparation_closed" });
  });
  it.each(["x".repeat(201), "Название провайдера"])(
    "accepts an explicit validated manual correction over provider name %s",
    async (providerName) => {
      detail.mockResolvedValue(feed([card(1, providerName)]));
      const result = await run({
        ...request(),
        manualNames: [{ itemId, name: "Исправленное имя" }],
      });
      expect(result.items[0]).toMatchObject({
        canApply: true,
        fields: [expect.objectContaining({ after: "Исправленное имя", source: "manual" })],
      });
      const [row] = await db.select().from(previews).where(eq(previews.id, result.items[0]!.id));
      expect(row?.manualProvenance).toEqual([
        expect.objectContaining({
          target: "name",
          source: "manual",
          proposedValue: "Исправленное имя",
        }),
      ]);
    },
  );
  it("denies a foreign-tenant stored read without changing its actor or issuing provider calls", async () => {
    const result = await run();
    await expect(
      service.readPreparation(await createOrganization(db), sessionId, result.preparation.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(detail).toHaveBeenCalledTimes(1);
  });
});
