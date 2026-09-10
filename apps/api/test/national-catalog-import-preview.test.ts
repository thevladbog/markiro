import { parseImportDiff } from "../src/modules/national-catalog/national-catalog-import-apply-state";
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
import type { DbTx } from "../src/modules/national-catalog/national-catalog-import.types";
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
function cardWithProductFields() {
  const source = card();
  // Synthetic attribute IDs; source names/units and value formats match the reported card.
  source.attributes = [
    { id: 900001, name: "Код продукции в ЕГАИС", value: "0300005753630000036", gtin: GTIN },
    { id: 900002, name: "Срок годности, дней", value: "365", gtin: null },
  ].map((a) => ({
    ...a,
    valueId: null,
    attributeValueId: null,
    valueType: null,
    groupId: null,
    groupName: null,
    locationId: null,
    level: null,
    multiplier: null,
  }));
  return source;
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
      requiresEntryIds: [],
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
      sourceId: "foreign",
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
  let sessions: NationalCatalogImportService;
  let features = { ownCatalog: true, gtinLookup: true };
  const detail = vi.fn<NationalCatalogClient["getFeedProductsByIds"]>();
  const categories = vi.fn<NationalCatalogClient["listCategories"]>();
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
    sessions = new NationalCatalogImportService(
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
      { getFeedProductsByIds: detail, listCategories: categories },
      coordinator,
    );
    detail.mockReset().mockResolvedValue(feed([card()]));
    categories.mockReset().mockResolvedValue({
      ...feed([]),
      value: { categories: [] },
    });
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
  it("offers an exact ChZ product group for a new product without an activated category schema", async () => {
    const source = card();
    source.categories = [{ id: 30064, name: "Категория товара" }];
    detail.mockResolvedValue(feed([source]));
    categories.mockResolvedValue({
      ...feed([]),
      value: {
        categories: [
          {
            id: 30064,
            name: "Категория товара",
            parentId: null,
            level: 1,
            active: true,
            gismtCodes: [23],
            raw: {},
          },
        ],
      },
    });
    const data = await run();
    expect(data.items[0]?.fields).toContainEqual(
      expect.objectContaining({
        labelKey: "chz_product_group_code",
        applicable: true,
        selectedByDefault: true,
        before: null,
        after: expect.any(String),
      }),
    );
    const [stored] = await db.select().from(previews).where(eq(previews.id, data.items[0]!.id));
    expect(parseImportDiff(stored!.diff).entries).toContainEqual(
      expect.objectContaining({
        target: "product_group",
        currentValue: null,
        proposedValue: 23,
      }),
    );
  });
  it.each([
    [[23, 25], "product_group_ambiguous"],
    [[999999], "product_group_unknown"],
    [[], "product_group_unavailable"],
  ] as const)("does not auto-select unresolved ChZ group %j", async (codes, reason) => {
    const source = card();
    source.categories = [{ id: 30064, name: "Категория товара" }];
    detail.mockResolvedValue(feed([source]));
    categories.mockResolvedValue({
      ...feed([]),
      value: {
        categories: [
          {
            id: 30064,
            name: "Категория товара",
            parentId: null,
            level: 1,
            active: true,
            gismtCodes: [...codes],
            raw: {},
          },
        ],
      },
    });
    const data = await run();
    expect(data.items[0]?.fields).toContainEqual(
      expect.objectContaining({
        labelKey: "chz_product_group_code",
        applicable: false,
        selectedByDefault: false,
        reason,
      }),
    );
  });
  async function local(name = "Моё", archived = false) {
    const [p] = await db
      .insert(schema.products)
      .values({ tenantId: actor.tenantId, gtin14: GTIN, name, archived })
      .returning();
    if (!p) throw new Error("fixture");
    return p;
  }
  it("imports EGAIS and shelf life into unbound product fields with source evidence", async () => {
    const source = cardWithProductFields();
    detail.mockResolvedValue(feed([source]));
    const result = await run();
    const p = result.items[0]!;
    expect(p.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labelKey: "egais_code",
          before: null,
          after: "0300005753630000036",
          applicable: true,
          requiresEntryIds: [],
        }),
        expect.objectContaining({
          labelKey: "shelf_life_days",
          before: null,
          after: "365",
          applicable: true,
          requiresEntryIds: [],
        }),
      ]),
    );
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    const applies = new NationalCatalogImportApplyService(
      new NationalCatalogImportRepository(db),
      sessions,
    );
    const accepted = await applies.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: p.fields.filter((f) => f.applicable).map((f) => f.id),
          linkAction: p.linkAction,
          photo: { kind: "keep" },
        },
      ],
    });
    await applies.resume(actor.tenantId, accepted.operationId);
    const receipt = await applies.read(actor.tenantId, sessionId, accepted.operationId);
    expect(receipt.items[0]?.product).toBe("applied");
    const productId = receipt.items[0]!.productId!;
    const [product] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(product).toMatchObject({
      egaisCode: "0300005753630000036",
      shelfLifeDays: 365,
      chzProductGroupCode: null,
    });
    const codes = await db
      .select()
      .from(schema.productEgaisCodes)
      .where(eq(schema.productEgaisCodes.productId, productId));
    expect(codes).toEqual([
      expect.objectContaining({
        tenantId: actor.tenantId,
        code: "0300005753630000036",
        isPrimary: true,
        source: "national_catalog",
        sourceRef: expect.stringMatching(/^national-catalog-snapshot:/),
      }),
    ]);
    const [audit] = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.targetId, productId),
          eq(schema.tenantAuditEvents.action, "national_catalog.link.confirmed"),
        ),
      );
    expect(audit).toMatchObject({
      organizationId: actor.tenantId,
      actorUserId: actor.userId,
      outcome: "success",
      targetType: "product",
      after: {
        acceptedEntries: expect.arrayContaining([
          expect.objectContaining({
            target: "product_field",
            targetField: "egais_code",
            sourceAttributeId: 900001,
          }),
        ]),
      },
    });
    const [link] = await db
      .select()
      .from(schema.nationalCatalogProductLinks)
      .where(eq(schema.nationalCatalogProductLinks.productId, productId));
    expect(link?.reviewedProjection).toMatchObject({
      values: { "stable:egais_code": "0300005753630000036", "stable:shelf_life_days": 365 },
      productFieldMappings: [
        { targetField: "egais_code", sourceAttributeId: 900001, mappingVersion: 1 },
        { targetField: "shelf_life_days", sourceAttributeId: 900002, mappingVersion: 1 },
      ],
    });
  });
  it.each([
    { acceptedKeys: [] },
    { acceptedKeys: ["egais_code"] },
    { acceptedKeys: ["shelf_life_days"] },
    { acceptedKeys: ["egais_code", "shelf_life_days"] },
  ])(
    "preserves unselected fields and alternate EGAIS codes when selecting $acceptedKeys",
    async ({ acceptedKeys }) => {
      const p = await local();
      await db
        .update(schema.nationalCatalogImportItems)
        .set({ productId: p.id, match: "existing" })
        .where(eq(schema.nationalCatalogImportItems.id, itemId));
      const oldCode = "0000000000000000001";
      const alternateCode = "0000000000000000002";
      await db
        .update(schema.products)
        .set({ egaisCode: oldCode, shelfLifeDays: 90 })
        .where(eq(schema.products.id, p.id));
      await db.insert(schema.productEgaisCodes).values([
        {
          tenantId: actor.tenantId,
          productId: p.id,
          code: oldCode,
          isPrimary: true,
          source: "manual",
        },
        {
          tenantId: actor.tenantId,
          productId: p.id,
          code: alternateCode,
          isPrimary: false,
          source: "manual",
        },
      ]);
      detail.mockResolvedValue(feed([cardWithProductFields()]));
      const preview = (await run()).items[0]!;
      expect(preview.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            labelKey: "egais_code",
            before: oldCode,
            selectedByDefault: false,
          }),
          expect.objectContaining({
            labelKey: "shelf_life_days",
            before: "90",
            selectedByDefault: false,
          }),
        ]),
      );
      const { NationalCatalogImportApplyService } =
        await import("../src/modules/national-catalog/national-catalog-import-apply.service");
      const applies = new NationalCatalogImportApplyService(
        new NationalCatalogImportRepository(db),
        sessions,
      );
      const accepted = await applies.start(actor, sessionId, {
        requestId: randomUUID(),
        decisions: [
          {
            previewId: preview.id,
            acceptedEntryIds: preview.fields
              .filter((f) => f.labelKey && acceptedKeys.includes(f.labelKey))
              .map((f) => f.id),
            linkAction: preview.linkAction,
            photo: { kind: "keep" },
          },
        ],
      });
      await applies.resume(actor.tenantId, accepted.operationId);
      const receipt = await applies.read(actor.tenantId, sessionId, accepted.operationId);
      expect(receipt.items[0]).toMatchObject({ product: "applied", reason: null });
      const [actual] = await db.select().from(schema.products).where(eq(schema.products.id, p.id));
      expect(actual).toMatchObject({
        name: "Моё",
        egaisCode: acceptedKeys.includes("egais_code") ? "0300005753630000036" : oldCode,
        shelfLifeDays: acceptedKeys.includes("shelf_life_days") ? 365 : 90,
      });
      const codes = await db
        .select()
        .from(schema.productEgaisCodes)
        .where(eq(schema.productEgaisCodes.productId, p.id));
      expect(codes.map((c) => c.code)).toEqual(expect.arrayContaining([oldCode, alternateCode]));
      expect(codes.filter((c) => c.isPrimary).map((c) => c.code)).toEqual([actual!.egaisCode]);
      await applies.resume(actor.tenantId, accepted.operationId);
      expect(
        await db
          .select()
          .from(schema.productEgaisCodes)
          .where(eq(schema.productEgaisCodes.productId, p.id)),
      ).toEqual(codes);
    },
  );
  it("rejects a concurrent EGAIS edit before applying the accepted product field", async () => {
    const p = await local();
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: p.id, match: "existing" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    detail.mockResolvedValue(feed([cardWithProductFields()]));
    const preview = (await run()).items[0]!;
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    const applies = new NationalCatalogImportApplyService(
      new NationalCatalogImportRepository(db),
      sessions,
    );
    const accepted = await applies.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: preview.id,
          acceptedEntryIds: preview.fields
            .filter((f) => f.labelKey === "egais_code")
            .map((f) => f.id),
          linkAction: preview.linkAction,
          photo: { kind: "keep" },
        },
      ],
    });
    await db
      .update(schema.products)
      .set({ egaisCode: "0000000000000000009" })
      .where(eq(schema.products.id, p.id));
    await applies.resume(actor.tenantId, accepted.operationId);
    const receipt = await applies.read(actor.tenantId, sessionId, accepted.operationId);
    expect(receipt.items[0]).toMatchObject({ product: "conflict", reason: "product_changed" });
    const [actual] = await db.select().from(schema.products).where(eq(schema.products.id, p.id));
    expect(actual?.egaisCode).toBe("0000000000000000009");
    expect(
      await db
        .select()
        .from(schema.nationalCatalogProductLinks)
        .where(eq(schema.nationalCatalogProductLinks.productId, p.id)),
    ).toEqual([]);
  });
  it("keeps a full EGAIS collection and requires an explicit collection edit before adding code 21", async () => {
    const p = await local();
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ productId: p.id, match: "existing" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    const codes = Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(19, "0"));
    await db
      .update(schema.products)
      .set({ egaisCode: codes[0] })
      .where(eq(schema.products.id, p.id));
    await db.insert(schema.productEgaisCodes).values(
      codes.map((code, index) => ({
        tenantId: actor.tenantId,
        productId: p.id,
        code,
        isPrimary: index === 0,
        source: "manual" as const,
      })),
    );
    const source = cardWithProductFields();
    detail.mockResolvedValue(feed([source]));
    const preview = (await run()).items[0]!;
    expect(preview.fields.find((f) => f.labelKey === "egais_code")).toMatchObject({
      applicable: false,
      reason: "egais_code_limit",
      before: codes[0],
    });
    source.attributes[0]!.value = codes[1]!;
    const existing = (await run()).items[0]!;
    expect(existing.fields.find((f) => f.labelKey === "egais_code")).toMatchObject({
      applicable: true,
      reason: null,
      after: codes[1],
    });
  });
  it("does not offer equal product fields or accept a provider ID shared by two field labels", async () => {
    const p = await local();
    const source = cardWithProductFields();
    await db
      .update(schema.products)
      .set({ egaisCode: "0300005753630000036", shelfLifeDays: 365 })
      .where(eq(schema.products.id, p.id));
    detail.mockResolvedValue(feed([source]));
    const same = (await run()).items[0]!;
    expect(
      same.fields.filter(
        (field) => field.labelKey === "egais_code" || field.labelKey === "shelf_life_days",
      ),
    ).toEqual([]);
    await db
      .update(schema.products)
      .set({ egaisCode: null, shelfLifeDays: null })
      .where(eq(schema.products.id, p.id));
    source.attributes[1]!.id = source.attributes[0]!.id;
    const ambiguous = (await run()).items[0]!;
    expect(
      ambiguous.fields.filter(
        (field) => field.labelKey === "egais_code" || field.labelKey === "shelf_life_days",
      ),
    ).toEqual([
      expect.objectContaining({ applicable: false }),
      expect.objectContaining({ applicable: false }),
    ]);
  });
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
  it.each(["success", "failure", "categories"])(
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
        return outcome === "categories"
          ? feed([{ ...card(), categories: [{ id: 30064, name: "Категория" }] }])
          : outcome === "success"
            ? feed([card()])
            : { status: "unavailable" };
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
      expect(categories).not.toHaveBeenCalled();
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
  it.each([
    { existingProfile: false, mapped: false },
    { existingProfile: true, mapped: false },
    { existingProfile: true, mapped: true },
  ])(
    "imports ordinary fields independently of a competing category mapping: $existingProfile/$mapped",
    async ({ existingProfile, mapped }) => {
      const c = await category(15);
      c.value.attributes.push(...cardWithProductFields().attributes);
      await db.insert(schema.nationalCatalogAttributeMappings).values({
        schemaVersionId: c.id,
        sourceAttributeId: "900002",
        targetField: "shelf_life_days",
        conversion: { kind: "positive_integer" },
        mappingVersion: 1,
      });
      if (existingProfile) {
        const p = await local();
        await db
          .update(schema.products)
          .set({ chzProductGroupCode: 15, boxCapacity: 12, palletCapacity: 20, status: "active" })
          .where(eq(schema.products.id, p.id));
        await db
          .update(schema.nationalCatalogImportItems)
          .set({ productId: p.id, match: "existing" })
          .where(eq(schema.nationalCatalogImportItems.id, itemId));
        await db.insert(schema.productRegulatoryProfiles).values({
          tenantId: actor.tenantId,
          productId: p.id,
          categoryId: c.categoryId,
          categoryName: "Категория",
          schemaVersionId: c.id,
          source: "manual",
          revision: 7,
          confirmedAt: new Date(),
        });
      }
      const initial = await run();
      const prepared = existingProfile
        ? initial
        : await run({
            ...request(),
            categoryChoices: [{ itemId, optionId: initial.items[0]!.categoryOptions[0]!.optionId }],
          });
      const p = prepared.items[0]!;
      const shelf = p.fields.filter((f) => f.labelKey === "shelf_life_days");
      expect(shelf).toHaveLength(1);
      expect(shelf[0]).toMatchObject({ applicable: true, requiresEntryIds: [] });
      const { NationalCatalogImportApplyService } =
        await import("../src/modules/national-catalog/national-catalog-import-apply.service");
      const applies = new NationalCatalogImportApplyService(
        new NationalCatalogImportRepository(db),
        sessions,
      );
      const accepted = await applies.start(actor, sessionId, {
        requestId: randomUUID(),
        decisions: [
          {
            previewId: p.id,
            acceptedEntryIds: p.fields
              .filter(
                (f) =>
                  f.labelKey === "shelf_life_days" ||
                  f.labelKey === "egais_code" ||
                  f.labelKey === "name" ||
                  (mapped && f.label === "Цвет"),
              )
              .map((f) => f.id),
            linkAction: p.linkAction,
            photo: { kind: "keep" },
          },
        ],
      });
      await applies.resume(actor.tenantId, accepted.operationId);
      const receipt = await applies.read(actor.tenantId, sessionId, accepted.operationId);
      expect(receipt.items[0]).toMatchObject({ product: "applied", reason: null });
      const productId = receipt.items[0]!.productId!;
      const [product] = await db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, productId));
      expect(product).toMatchObject({
        shelfLifeDays: 365,
        egaisCode: "0300005753630000036",
        status: existingProfile ? "active" : "draft",
      });
      const profiles = await db
        .select()
        .from(schema.productRegulatoryProfiles)
        .where(eq(schema.productRegulatoryProfiles.productId, productId));
      expect(profiles).toEqual(existingProfile ? [expect.objectContaining({ revision: 8 })] : []);
    },
  );
  it("keeps accepted failed-photo bytes recoverable after session payload cleanup and provider removal", async () => {
    const source = card();
    source.images = [
      { sourceId: "good_img", url: "https://images.example/image", barcode: GTIN, primary: true },
    ];
    detail.mockResolvedValue(feed([source]));
    const prepared = await run();
    const p = prepared.items[0]!;
    const candidate = p.photos[0]!;
    const { NationalCatalogImageService } =
      await import("../src/modules/national-catalog/national-catalog-image.service");
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    const { ProductsService } = await import("../src/modules/products/products.service");
    const { MediaAssetsService } = await import("../src/modules/media/media-assets.service");
    const sharp = (await import("sharp")).default;
    const objects = new Map<string, Buffer>();
    const storage = {
      put: vi.fn(async (key: string, body: Buffer) => {
        objects.set(key, Buffer.from(body));
      }),
      get: vi.fn(async (key: string) => {
        const body = objects.get(key);
        if (!body) throw Error("missing fixture bytes");
        return { body, contentType: "image/webp" };
      }),
      delete: vi.fn(async (key: string) => {
        objects.delete(key);
      }),
    };
    const repository = new NationalCatalogImportRepository(db);
    const media = new MediaAssetsService(db, storage as never);
    const products = new ProductsService(db, {} as never, media, storage as never);
    const download = vi.fn(async () =>
      sharp({ create: { width: 20, height: 10, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    const images = new NationalCatalogImageService(
      repository,
      sessions,
      { runExternal: async (_context, fn) => fn(new AbortController().signal) },
      storage,
      products,
      { enabled: true, verifiedHosts: ["images.example"] },
      download,
    );
    await images.prepare(actor, sessionId, p.id, candidate.candidateId);
    await images.resume(actor.tenantId, sessionId, p.id, candidate.candidateId);
    const applies = new NationalCatalogImportApplyService(repository, sessions);
    const accepted = await applies.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: p.fields.filter((field) => field.applicable).map((field) => field.id),
          linkAction: p.linkAction,
          photo: { kind: "candidate", candidateId: candidate.candidateId },
        },
      ],
    });
    await applies.resume(actor.tenantId, accepted.operationId);
    storage.get.mockRejectedValueOnce(Error("injected storage outage"));
    await images.apply(actor.tenantId, accepted.operationId, p.id);
    const receiptQuery = () =>
      db
        .select()
        .from(schema.nationalCatalogImportOperationItems)
        .where(eq(schema.nationalCatalogImportOperationItems.operationId, accepted.operationId));
    const [before] = await receiptQuery();
    expect(before).toMatchObject({
      productResult: "applied",
      imageResult: "failed",
      imageRetryEligible: true,
    });
    const expiredAt = new Date(Date.now() - 1000);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ startedAt: new Date(Date.now() - 86_400_001), expiresAt: expiredAt })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await db.update(previews).set({ expiresAt: expiredAt }).where(eq(previews.id, p.id));
    await sessions.releaseExpired(new Date(), 1);
    await images.releaseExpired(new Date(), 1);
    const [savedPreview] = await db.select().from(previews).where(eq(previews.id, p.id));
    expect(savedPreview?.payloadPurgedAt).toBeNull();
    expect(objects.size).toBe(1);
    await db
      .delete(schema.integrationChannels)
      .where(eq(schema.integrationChannels.tenantId, actor.tenantId));
    const clock = vi.spyOn(Date, "now").mockReturnValue(before!.nextImageAttemptAt!.getTime() + 1);
    try {
      await images.apply(actor.tenantId, accepted.operationId, p.id);
    } finally {
      clock.mockRestore();
    }
    const [after] = await receiptQuery();
    expect(after).toMatchObject({
      productResult: "applied",
      imageResult: "applied",
      imageRetryEligible: false,
    });
    expect(after!.decision).toEqual(before!.decision);
    expect(after!.appliedEvidence).toEqual(before!.appliedEvidence);
    expect(download).toHaveBeenCalledOnce();
  });
  it.each(["closed-session", "infrastructure"] as const)(
    "preserves collector terminal outcome between rollback and late %s catch",
    async (failure) => {
      const { NationalCatalogImportApplyService } =
        await import("../src/modules/national-catalog/national-catalog-import-apply.service");
      const p = (await run()).items[0]!;
      let afterRollback: (() => Promise<void>) | null = null;
      const repository = new (class extends NationalCatalogImportRepository {
        override async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
          try {
            return await super.transaction(fn);
          } catch (error) {
            const continuation = afterRollback;
            afterRollback = null;
            if (continuation) await continuation();
            throw error;
          }
        }
      })(db);
      const applies = new NationalCatalogImportApplyService(repository, sessions);
      const operation = await applies.start(actor, sessionId, {
        requestId: randomUUID(),
        decisions: [
          {
            previewId: p.id,
            acceptedEntryIds: p.fields.filter((f) => f.applicable).map((f) => f.id),
            linkAction: p.linkAction,
            photo: { kind: "keep" },
          },
        ],
      });
      const receipts = schema.nationalCatalogImportOperationItems;
      const readReceipt = async () =>
        (
          await db.select().from(receipts).where(eq(receipts.operationId, operation.operationId))
        )[0]!;
      const readFailures = () =>
        db
          .select()
          .from(schema.tenantAuditEvents)
          .where(
            and(
              eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
              eq(schema.tenantAuditEvents.action, "national_catalog.import.item_failed"),
            ),
          );
      const before = await readReceipt();
      const [beforeSession] = await db
        .select()
        .from(schema.nationalCatalogImportSessions)
        .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
      await db
        .update(schema.nationalCatalogImportSessions)
        .set({ startedAt: new Date(0), expiresAt: new Date(1) })
        .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
      const phases: string[] = [];
      const originalAccess = sessions.assertSessionAccess.bind(sessions);
      const access = vi
        .spyOn(sessions, "assertSessionAccess")
        .mockImplementationOnce(async (tx, currentActor, currentSession) => {
          phases.push("product-transaction");
          await tx
            .update(schema.nationalCatalogImportSessions)
            .set({ incompleteReason: "rollback_marker" })
            .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
          if (failure === "infrastructure") throw Error("injected stale infrastructure failure");
          await originalAccess(tx, currentActor, currentSession);
        });
      let collected: typeof receipts.$inferSelect | undefined;
      let collectedAudits: Awaited<ReturnType<typeof readFailures>> = [];
      afterRollback = async () => {
        const [rolledBack] = await db
          .select()
          .from(schema.nationalCatalogImportSessions)
          .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
        expect(rolledBack?.incompleteReason).toBe(beforeSession?.incompleteReason);
        expect((await readReceipt()).productResult).toBe("pending");
        phases.push("rolled-back");
        await sessions.releaseExpired(new Date(), 1);
        collected = await readReceipt();
        collectedAudits = await readFailures();
        expect(collected).toMatchObject({
          productResult: "failed",
          errorCode: "import_session_closed",
          attempts: before.attempts,
          nextAttemptAt: null,
          nextImageAttemptAt: null,
          imageRetryEligible: false,
          decision: before.decision,
          appliedEvidence: before.appliedEvidence,
        });
        expect(collectedAudits).toHaveLength(1);
        expect(collectedAudits[0]).toMatchObject({
          organizationId: actor.tenantId,
          actorUserId: actor.userId,
          action: "national_catalog.import.item_failed",
          outcome: "failure",
          targetType: "national_catalog_import_preview",
          targetId: p.id,
          before: null,
          after: {
            operationId: operation.operationId,
            previewId: p.id,
            result: "failed",
            reason: "import_session_closed",
          },
        });
        phases.push("collector-committed");
      };
      try {
        await applies.resume(actor.tenantId, operation.operationId);
      } finally {
        access.mockRestore();
      }
      phases.push("catch-returned");
      expect(phases).toEqual([
        "product-transaction",
        "rolled-back",
        "collector-committed",
        "catch-returned",
      ]);
      expect.soft(await readReceipt()).toEqual(collected);
      expect.soft(await readFailures()).toEqual(collectedAudits);
      const [savedOperation] = await db
        .select()
        .from(schema.nationalCatalogImportOperations)
        .where(eq(schema.nationalCatalogImportOperations.id, operation.operationId));
      expect.soft(savedOperation).toMatchObject({ state: "finished", enqueuePending: false });
      expect(
        await db.select().from(schema.products).where(eq(schema.products.tenantId, actor.tenantId)),
      ).toHaveLength(0);
    },
  );
  it("records a genuine due infrastructure retry before applying without duplicate terminal replay", async () => {
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    const p = (await run()).items[0]!;
    const applies = new NationalCatalogImportApplyService(
      new NationalCatalogImportRepository(db),
      sessions,
    );
    const operation = await applies.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: p.fields.filter((f) => f.applicable).map((f) => f.id),
          linkAction: p.linkAction,
          photo: { kind: "keep" },
        },
      ],
    });
    const readReceipt = async () =>
      (
        await db
          .select()
          .from(schema.nationalCatalogImportOperationItems)
          .where(eq(schema.nationalCatalogImportOperationItems.operationId, operation.operationId))
      )[0]!;
    const before = await readReceipt();
    const access = vi
      .spyOn(sessions, "assertSessionAccess")
      .mockRejectedValueOnce(Error("injected first failure"))
      .mockRejectedValueOnce(Error("injected second failure"));
    const now = vi.spyOn(Date, "now");
    try {
      await applies.resume(actor.tenantId, operation.operationId);
      const first = await readReceipt();
      expect(first).toMatchObject({
        productResult: "failed",
        errorCode: "infrastructure_failure",
        attempts: 1,
        decision: before.decision,
        appliedEvidence: null,
      });
      await applies.resume(actor.tenantId, operation.operationId);
      expect(access).toHaveBeenCalledTimes(1);
      now.mockReturnValue(first.nextAttemptAt!.getTime() + 1);
      await applies.resume(actor.tenantId, operation.operationId);
      const second = await readReceipt();
      expect(second).toMatchObject({
        productResult: "failed",
        errorCode: "infrastructure_failure",
        attempts: 2,
        decision: before.decision,
        appliedEvidence: null,
      });
      expect(second.nextAttemptAt!.getTime()).toBeGreaterThan(first.nextAttemptAt!.getTime());
      now.mockReturnValue(second.nextAttemptAt!.getTime() + 1);
      await applies.resume(actor.tenantId, operation.operationId);
      const applied = await readReceipt();
      expect(applied).toMatchObject({
        productResult: "applied",
        nextAttemptAt: null,
        decision: before.decision,
      });
      await applies.resume(actor.tenantId, operation.operationId);
      expect(await readReceipt()).toEqual(applied);
      const failures = await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
            eq(schema.tenantAuditEvents.action, "national_catalog.import.item_failed"),
          ),
        );
      expect(failures).toHaveLength(2);
      for (const audit of failures)
        expect(audit).toMatchObject({
          organizationId: actor.tenantId,
          actorUserId: actor.userId,
          action: "national_catalog.import.item_failed",
          outcome: "failure",
          targetType: "national_catalog_import_preview",
          targetId: p.id,
          before: null,
          after: {
            operationId: operation.operationId,
            previewId: p.id,
            result: "failed",
            reason: "infrastructure_failure",
          },
        });
    } finally {
      access.mockRestore();
      now.mockRestore();
    }
  });
  it("ends expired pending core work without rewriting its accepted decision or duplicating failure audit", async () => {
    const { NationalCatalogImportApplyService } =
      await import("../src/modules/national-catalog/national-catalog-import-apply.service");
    const p = (await run()).items[0]!;
    const applies = new NationalCatalogImportApplyService(
      new NationalCatalogImportRepository(db),
      sessions,
    );
    const operation = await applies.start(actor, sessionId, {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: p.id,
          acceptedEntryIds: p.fields.filter((field) => field.applicable).map((field) => field.id),
          linkAction: p.linkAction,
          photo: { kind: "keep" },
        },
      ],
    });
    const receipts = schema.nationalCatalogImportOperationItems;
    const readReceipt = async () =>
      (await db.select().from(receipts).where(eq(receipts.operationId, operation.operationId)))[0]!;
    const before = await readReceipt();
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ startedAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await sessions.releaseExpired(new Date(), 1);
    await applies.resume(actor.tenantId, operation.operationId);
    await sessions.releaseExpired(new Date(), 1);
    const after = await readReceipt();
    expect(after).toMatchObject({
      productResult: "failed",
      errorCode: "import_session_closed",
      imageRetryEligible: false,
      nextAttemptAt: null,
      nextImageAttemptAt: null,
    });
    expect(after.decision).toEqual(before.decision);
    expect(after.appliedEvidence).toEqual(before.appliedEvidence);
    const audit = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, actor.tenantId),
          eq(schema.tenantAuditEvents.action, "national_catalog.import.item_failed"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      organizationId: actor.tenantId,
      actorUserId: actor.userId,
      targetType: "national_catalog_import_preview",
      targetId: p.id,
      outcome: "failure",
      before: null,
      after: {
        operationId: operation.operationId,
        previewId: p.id,
        result: "failed",
        reason: "import_session_closed",
      },
    });
  });
  it("scrubs an abandoned session that never prepared a preview", async () => {
    const started = await sessions.start(actor, { mode: "gtins", text: "BAD" });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ startedAt: new Date(0), expiresAt: new Date(1) })
      .where(eq(schema.nationalCatalogImportSessions.id, started.id));
    await sessions.releaseExpired(new Date(), 1);
    const rows = await db
      .select()
      .from(schema.nationalCatalogImportItems)
      .where(eq(schema.nationalCatalogImportItems.sessionId, started.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      input: null,
      source: null,
      name: null,
      rawStatus: null,
      rawDetailedStatuses: [],
    });
    expect(await db.select().from(previews).where(eq(previews.sessionId, started.id))).toHaveLength(
      0,
    );
    expect((await sessions.read(actor.tenantId, started.id)).state).toBe("expired");
  });
  it("scrubs expired abandoned session and preparation payloads in independently bounded batches", async () => {
    const prepared = await service.prepare(actor, sessionId, {
      ...request(),
      manualNames: [{ itemId, name: "Private draft" }],
    });
    const [before] = await db
      .select()
      .from(preparations)
      .where(eq(preparations.id, prepared.preparation.id));
    const extra = randomUUID();
    await db.insert(schema.nationalCatalogImportItems).values({
      id: extra,
      tenantId: actor.tenantId,
      sessionId,
      input: "unconfirmed input",
      name: "Unconfirmed",
      source: { raw: "private" },
      match: "invalid",
    });
    const expiredAt = new Date(Date.now() - 1000);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ startedAt: new Date(Date.now() - 86_400_001), expiresAt: expiredAt })
      .where(eq(schema.nationalCatalogImportSessions.id, sessionId));
    await db
      .update(preparations)
      .set({ expiresAt: expiredAt })
      .where(eq(preparations.id, prepared.preparation.id));
    await sessions.releaseExpired(new Date(), 1);
    const first = await db
      .select()
      .from(schema.nationalCatalogImportItems)
      .where(eq(schema.nationalCatalogImportItems.sessionId, sessionId));
    expect(first.filter((row) => row.source !== null)).toHaveLength(1);
    await sessions.releaseExpired(new Date(), 1);
    const remaining = await db
      .select()
      .from(schema.nationalCatalogImportItems)
      .where(eq(schema.nationalCatalogImportItems.sessionId, sessionId));
    expect(remaining).toHaveLength(2);
    expect(
      remaining.every((row) => row.source === null && row.input === null && row.name === null),
    ).toBe(true);
    const [after] = await db
      .select()
      .from(preparations)
      .where(eq(preparations.id, prepared.preparation.id));
    expect(after).toMatchObject({
      id: before?.id,
      requestId: before?.requestId,
      requestHash: before?.requestHash,
      request: {},
      checkpoint: { work: [], completed: [], failures: [], enqueuePending: false },
    });
    await expect(
      service.readPreparation(actor.tenantId, sessionId, prepared.preparation.id),
    ).rejects.toThrow("import_preparation_closed");
    await service.resumePreparation(actor.tenantId, sessionId, prepared.preparation.id);
    expect(detail).not.toHaveBeenCalled();
    const session = await sessions.read(actor.tenantId, sessionId);
    expect(session.state).toBe("expired");
  });
  it.each([false, true])(
    "requires initial category for stable mapped fields through preparation and legacy projection (existing=%s)",
    async (existing) => {
      if (existing) {
        const productId = randomUUID();
        await db
          .insert(schema.products)
          .values({ id: productId, tenantId: actor.tenantId, gtin14: GTIN, name: "Existing" });
        await db
          .update(schema.nationalCatalogImportItems)
          .set({ productId, match: "existing" })
          .where(eq(schema.nationalCatalogImportItems.id, itemId));
      }
      const c = await category();
      await db.insert(schema.nationalCatalogAttributeMappings).values({
        schemaVersionId: c.id,
        sourceAttributeId: "good_name",
        targetField: "print_name",
        conversion: { kind: "string_trim" },
        mappingVersion: 1,
      });
      const initial = await run();
      const option = initial.items[0]!.categoryOptions[0]!;
      const selected = await run({
        ...request(),
        categoryChoices: [{ itemId, optionId: option.optionId }],
      });
      const view = selected.items[0]!;
      const [row] = await db.select().from(previews).where(eq(previews.id, view.id));
      const diff = parseImportDiff(row!.diff);
      const binding = diff.entries.find((e) => e.target === "category")!;
      const stable = diff.entries.find(
        (e) => e.target === "mapped" && e.entry.target === "stable_field",
      )!;
      expect(view.fields.find((f) => f.id === stable.entryId)?.requiresEntryIds).toEqual([
        binding.entryId,
      ]);
      expect(() => assertPreviewEntrySelection(diff, [stable.entryId])).toThrow(
        "category_entry_required",
      );
      const legacy = {
        ...diff,
        entries: diff.entries.map((e) =>
          e.target === "mapped" ? { ...e, requiresEntryIds: [] } : e,
        ),
      };
      await db.update(previews).set({ diff: legacy }).where(eq(previews.id, view.id));
      const projected = await service.readPreparation(
        actor.tenantId,
        sessionId,
        selected.preparation.id,
      );
      expect(
        projected.items[0]!.fields.find((f) => f.id === stable.entryId)?.requiresEntryIds,
      ).toEqual([binding.entryId]);
      const [unchanged] = await db.select().from(previews).where(eq(previews.id, view.id));
      expect(unchanged!.diff).toEqual(legacy);
      const { NationalCatalogImportApplyService } =
        await import("../src/modules/national-catalog/national-catalog-import-apply.service");
      const applies = new NationalCatalogImportApplyService(
        new NationalCatalogImportRepository(db),
        sessions,
      );
      const body = {
        requestId: randomUUID(),
        decisions: [
          {
            previewId: view.id,
            acceptedEntryIds: [stable.entryId],
            linkAction: view.linkAction,
            photo: { kind: "keep" as const },
          },
        ],
      };
      await expect(applies.start(actor, sessionId, body)).rejects.toThrow(
        "category_entry_required",
      );
      body.decisions[0]!.acceptedEntryIds = projected.items[0]!.fields.filter(
        (field) => field.applicable,
      ).map((field) => field.id);
      const accepted = await applies.start(actor, sessionId, body);
      await applies.resume(actor.tenantId, accepted.operationId);
      const receipt = await applies.read(actor.tenantId, sessionId, accepted.operationId);
      expect(receipt.items[0]?.product).toBe("applied");
      const [product] = await db
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, receipt.items[0]!.productId!));
      expect(product?.printName).toBe(c.value.name);
    },
  );
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
    const selectedBody = { ...request(), categoryChoices: [{ itemId, optionId: choice.optionId }] };
    const selected = await run(selectedBody);
    expect(selected.items[0]?.fields.filter((f) => f.applicable)).toHaveLength(3);
    const [row] = await db.select().from(previews).where(eq(previews.id, selected.items[0]!.id));
    const diff = row?.diff as StoredImportDiff;
    expect(diff.entries.filter((entry) => entry.target === "name")).toHaveLength(1);
    const attr = diff.entries.find((entry) => entry.target === "mapped");
    const binding = diff.entries.find((entry) => entry.target === "category");
    if (!attr || !binding) throw new Error("Missing category entries");
    expect(selected.items[0]?.fields.find((field) => field.id === attr.entryId)).toHaveProperty(
      "requiresEntryIds",
      [binding.entryId],
    );
    expect(() => assertPreviewEntrySelection(diff, [attr.entryId])).toThrow(
      "category_entry_required",
    );
    expect(() => assertPreviewEntrySelection(diff, [attr.entryId, binding.entryId])).not.toThrow();
    // Persist an actual v1 view with the dependency property absent, while keeping
    // authoritative private entries and all original source/decision hashes.
    const { identity, ...legacyView } = diff.view;
    expect(identity).toEqual({ gtin14: GTIN, cardId: String(c.value.id), name: c.value.name });
    const legacy = {
      ...diff,
      view: {
        ...legacyView,
        fields: diff.view.fields.map(({ requiresEntryIds: _dependencies, ...field }) => field),
      },
    };
    await db.update(previews).set({ diff: legacy }).where(eq(previews.id, selected.items[0]!.id));
    const [beforeLegacyRead] = await db
      .select()
      .from(previews)
      .where(eq(previews.id, selected.items[0]!.id));
    await db
      .update(schema.nationalCatalogImportItems)
      .set({ name: "Changed after comparison" })
      .where(eq(schema.nationalCatalogImportItems.id, itemId));
    const restored = await service.readPreparation(
      actor.tenantId,
      sessionId,
      selected.preparation.id,
    );
    expect(restored.items[0]?.identity).toEqual({
      gtin14: GTIN,
      cardId: String(c.value.id),
      name: c.value.name,
    });
    expect(
      restored.items[0]?.fields.find((field) => field.id === attr.entryId)?.requiresEntryIds,
    ).toEqual([binding.entryId]);
    const replayed = await service.prepare(actor, sessionId, selectedBody);
    expect(replayed.preparation.id).toBe(selected.preparation.id);
    expect(
      replayed.items[0]?.fields.find((field) => field.id === attr.entryId)?.requiresEntryIds,
    ).toEqual([binding.entryId]);
    const [afterLegacyRead] = await db
      .select()
      .from(previews)
      .where(eq(previews.id, selected.items[0]!.id));
    expect(afterLegacyRead).toEqual(beforeLegacyRead);
    const parsedLegacy = parseImportDiff(legacy);
    expect(() => assertPreviewEntrySelection(parsedLegacy, [attr.entryId])).toThrow(
      "category_entry_required",
    );
    expect(() =>
      assertPreviewEntrySelection(parsedLegacy, [binding.entryId, attr.entryId]),
    ).not.toThrow();

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
