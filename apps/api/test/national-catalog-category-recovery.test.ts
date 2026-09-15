import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema } from "@markiro/db";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductRegulatoryService } from "../src/modules/product-regulatory/product-regulatory.service";
import { createOrganization } from "./support/subscription-fixtures";
import { DrizzleNationalCatalogSchemaRepository } from "../src/modules/national-catalog/national-catalog-schema.service";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("reviewed categories on isolated Postgres", () => {
  const name = `markiro_nc_recovery_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = createDb(databaseUrl ?? "postgres://invalid");
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  const connection = createDb(url.href);
  const db = connection.db;
  const repository = new DrizzleNationalCatalogSchemaRepository(db);
  const principal: PlatformPrincipal = {
    userId: randomUUID(),
    role: "platform_admin",
    twoFactorReady: true,
    capabilities: platformCapabilitiesForRole.platform_admin,
  };
  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    await db.insert(schema.platformUsers).values({
      id: principal.userId,
      name: "Review actor",
      email: `${principal.userId}@example.invalid`,
      role: principal.role,
      status: "active",
    });
  }, 120_000);
  afterAll(async () => {
    await connection.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await maintenance.pool.end();
  });
  it("adds a new category and schema revision without deleting prior reviewed mappings", async () => {
    const groupCode = 7;
    const observeCategory = async (catId: number, hash: string) => {
      const categoryId = String(catId);
      const scopeKey = `national-catalog:category:${categoryId}`;
      await repository.observe({
        scopeKey,
        categoryId,
        categoryName: categoryId,
        gismtCodes: [groupCode],
        selectors: { catId },
        sourceVersion: "v3",
        etag: null,
        contentHash: hash.repeat(64),
        definition: { formatVersion: 2, scopeKey, categoryId, attributes: [] },
        status: "observed",
        fetchedAt: new Date(),
      });
      const [version] = await db
        .select()
        .from(schema.nationalCatalogSchemaVersions)
        .where(eq(schema.nationalCatalogSchemaVersions.contentHash, hash.repeat(64)));
      if (!version) throw new Error("Expected observed category");
      return version.id;
    };
    const beer = await observeCategory(900010, "a");
    const cider = await observeCategory(900011, "b");
    const revisedCider = await observeCategory(900011, "c");
    const ids = [beer, cider, revisedCider];
    await repository.reviewGroupMapping(
      groupCode,
      { state: "exact", schemaVersionIds: [beer] },
      principal,
    );
    await repository.activate(beer, principal);
    const [original] = await db
      .select()
      .from(schema.nationalCatalogCategoryGroupMappings)
      .where(eq(schema.nationalCatalogCategoryGroupMappings.schemaVersionId, beer));
    await repository.reviewGroupMapping(
      groupCode,
      { state: "exact", schemaVersionIds: [cider] },
      principal,
    );
    await repository.activate(cider, principal);
    await repository.reviewGroupMapping(
      groupCode,
      { state: "exact", schemaVersionIds: [beer, revisedCider] },
      principal,
    );
    await repository.activate(revisedCider, principal);
    const rows = await db
      .select()
      .from(schema.nationalCatalogCategoryGroupMappings)
      .where(eq(schema.nationalCatalogCategoryGroupMappings.chzProductGroupCode, groupCode));
    expect(
      rows
        .filter((r) => r.state === "exact")
        .map((r) => r.schemaVersionId)
        .sort(),
    ).toEqual(ids.sort());
    if (!original) throw new Error("Expected original reviewed mapping");
    expect(rows.find((r) => r.schemaVersionId === beer)?.id).toBe(original.id);
    const versions = await db.select().from(schema.nationalCatalogSchemaVersions);
    expect(versions.find((r) => r.id === beer)?.status).toBe("active");
    expect(versions.find((r) => r.id === cider)?.status).toBe("retired");
    expect(versions.find((r) => r.id === revisedCider)?.status).toBe("active");
    const tenantId = await createOrganization(db);
    const productId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: "04680089900024",
      name: "Test cider",
      chzProductGroupCode: groupCode,
      boxCapacity: 20,
      palletBoxCapacity: 3,
      status: "active",
    });
    const products = new ProductRegulatoryService(db);
    const options = await products.getCategoryOptions(tenantId, productId);
    expect(options.items.map((item) => item.schemaVersionId).sort()).toEqual(
      [beer, revisedCider].sort(),
    );
    expect(options.items.every((item) => item.mappingState === "exact")).toBe(true);
    await expect(
      products.getCategoryOptions(await createOrganization(db), productId),
    ).rejects.toThrow();
    const audits = await db
      .select()
      .from(schema.platformAuditEvents)
      .where(eq(schema.platformAuditEvents.action, "national_catalog.group_mapping.reviewed"));
    expect(audits).toHaveLength(3);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorPlatformUserId: principal.userId,
          actorRole: "platform_admin",
          outcome: "success",
          targetType: "chz_product_group",
          targetId: String(groupCode),
          after: { state: "exact", schemaVersionIds: [beer, revisedCider] },
        }),
      ]),
    );
  });

  it("lists category status, blocking reasons, and product-group review state", async () => {
    const categoryId = "245615018";
    const scopeKey = `national-catalog:category:${categoryId}`;
    const blockedReasons = [{ code: "unsupported_value_type", attributeId: "44" }] as const;
    await repository.observe({
      scopeKey,
      categoryId,
      categoryName: "Сидр",
      gismtCodes: [7],
      selectors: { catId: Number(categoryId) },
      sourceVersion: "v3",
      etag: null,
      contentHash: "d".repeat(64),
      definition: { observationVersion: 1, categoryId, scopeKey, blockedReasons },
      status: "observed",
      fetchedAt: new Date("2026-09-14T10:00:00.000Z"),
    });

    const result = await repository.list();
    expect(result.versions.find((version) => version.categoryId === categoryId)).toEqual(
      expect.objectContaining({
        categoryName: "Сидр",
        status: "observed",
        fetchedAt: "2026-09-14T10:00:00.000Z",
        blockedReasons,
        mappings: expect.arrayContaining([
          expect.objectContaining({
            chzProductGroupCode: 7,
            state: "ambiguous",
            reviewedAt: null,
          }),
        ]),
      }),
    );
  });
});
