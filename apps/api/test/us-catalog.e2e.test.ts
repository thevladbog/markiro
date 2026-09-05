import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { isUniqueConstraintViolation } from "../src/modules/traceability/master-data/us-master-data-support";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!url)("US catalog store with real isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsCatalogStore;
  let tenantId: string;
  let actorUserId: string;
  let memberId: string;
  let clock = Date.now();

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsCatalogStore(fixture.db);
    vi.useFakeTimers({ toFake: ["Date"] });
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await fixture?.close();
  });

  beforeEach(async () => {
    clock += 60_000;
    vi.setSystemTime(clock);
    tenantId = randomUUID();
    actorUserId = randomUUID();
    memberId = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US", slug: tenantId, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actorUserId, name: "Synthetic owner", email: `${actorUserId}@example.test` });
    await fixture.db.insert(schema.member).values({
      id: memberId,
      organizationId: tenantId,
      userId: actorUserId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: actorUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId, timeZone: "America/Chicago", updatedAt: new Date() });
  });

  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "creates and reads nullable and canonical products under %s",
    async (code) => {
      await fixture.db
        .update(schema.traceabilityProfiles)
        .set({ code })
        .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
      const withoutGtin = await store.createProduct(
        tenantId,
        actorUserId,
        { name: `  Nullable ${code}  ` },
        `create-null-${code}`,
      );
      const withGtin = await store.createProduct(
        tenantId,
        actorUserId,
        { name: `Canonical ${code}`, gtin: "96385074" },
        `create-gtin-${code}`,
      );
      expect(withoutGtin).toEqual({
        id: expect.any(String),
        name: `Nullable ${code}`,
        gtin14: null,
        archived: false,
        createdAt: new Date(clock).toISOString(),
        updatedAt: new Date(clock).toISOString(),
      });
      expect(withGtin).toMatchObject({ gtin14: "00000096385074", archived: false });
      expect(await store.getProduct(tenantId, actorUserId, withoutGtin.id)).toEqual(withoutGtin);
      const [stored] = await fixture.db
        .select({
          status: schema.products.status,
          printName: schema.products.printName,
          chzProductGroupCode: schema.products.chzProductGroupCode,
          boxCapacity: schema.products.boxCapacity,
          palletCapacity: schema.products.palletCapacity,
        })
        .from(schema.products)
        .where(eq(schema.products.id, withoutGtin.id));
      expect(stored).toEqual({
        status: "draft",
        printName: null,
        chzProductGroupCode: null,
        boxCapacity: null,
        palletCapacity: null,
      });
    },
  );

  it("enforces strict input, current membership, write roles and fail-closed profiles", async () => {
    await expect(
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Forged", tenantId: randomUUID() },
        "forged",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(store.getProduct(tenantId, actorUserId, "not-a-uuid")).rejects.toMatchObject({
      status: 400,
    });
    await expect(store.listProducts(tenantId, actorUserId, { forged: true })).rejects.toMatchObject(
      {
        status: 400,
      },
    );
    const readable = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Readable" },
      "readable",
    );
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, memberId));
    expect(await store.getProduct(tenantId, actorUserId, readable.id)).toEqual(readable);
    await expect(
      store.updateProduct(tenantId, actorUserId, readable.id, { name: "Blocked" }, "blocked"),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.db.delete(schema.member).where(eq(schema.member.id, memberId));
    await expect(store.listProducts(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 403,
    });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantId,
      userId: actorUserId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ", baselineVersion: null })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(store.listProducts(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(store.listProducts(tenantId, actorUserId, {})).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
  });

  it.each(["owner", "admin", "manager", "traceability_qa"])(
    "allows %s to write catalog master data",
    async (role) => {
      await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
      await expect(
        store.createProduct(tenantId, actorUserId, { name: `Allowed ${role}` }, role),
      ).resolves.toMatchObject({ name: `Allowed ${role}` });
    },
  );

  it.each([
    ["member", false],
    ["traceability_receiving", true],
    ["traceability_production", true],
    ["traceability_shipping", true],
    ["traceability_auditor", true],
    ["unknown", false],
  ] as const)("denies %s from writes and preserves its read policy", async (role, canRead) => {
    await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, memberId));
    await expect(
      store.createProduct(tenantId, actorUserId, { name: `Denied ${role}` }, role),
    ).rejects.toMatchObject({ status: 403 });
    if (canRead) {
      await expect(store.listProducts(tenantId, actorUserId, {})).resolves.toMatchObject({
        items: [],
      });
    } else {
      await expect(store.listProducts(tenantId, actorUserId, {})).rejects.toMatchObject({
        status: 403,
      });
    }
  });

  it("isolates tenant identities and fails closed for malformed persisted rows", async () => {
    const foreignTenantId = randomUUID();
    const foreignActorId = randomUUID();
    await fixture.db.insert(schema.organization).values({
      id: foreignTenantId,
      name: "Foreign tenant",
      slug: foreignTenantId,
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.user).values({
      id: foreignActorId,
      name: "Foreign owner",
      email: `${foreignActorId}@example.test`,
    });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: foreignTenantId,
      userId: foreignActorId,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: foreignTenantId,
      code: "US_GENERIC_LOT_TRACEABILITY",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: foreignActorId,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: foreignTenantId, timeZone: "America/New_York" });
    const foreign = await store.createProduct(
      foreignTenantId,
      foreignActorId,
      { name: "Foreign" },
      "foreign",
    );
    await expect(store.getProduct(tenantId, actorUserId, foreign.id)).rejects.toMatchObject({
      status: 404,
      response: { code: "product_not_found" },
    });
    await fixture.db
      .update(schema.products)
      .set({ name: " " })
      .where(
        and(eq(schema.products.tenantId, foreignTenantId), eq(schema.products.id, foreign.id)),
      );
    await expect(
      store.getProduct(foreignTenantId, foreignActorId, foreign.id),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
  });

  it("lists with literal search, archive selection and stable bounded pagination", async () => {
    const literal = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "A%_\\ literal" },
      "literal",
    );
    const alpha = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Alpha", gtin: "036000291452" },
      "alpha",
    );
    const beta = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Beta", gtin: "4006381333931" },
      "beta",
    );
    await store.updateProduct(tenantId, actorUserId, beta.id, { archived: true }, "archive-beta");
    expect((await store.listProducts(tenantId, actorUserId, { search: "%_\\" })).items).toEqual([
      literal,
    ]);
    expect(
      (
        await store.listProducts(tenantId, actorUserId, {
          search: "04006381333931",
          archived: "all",
        })
      ).items.map((item) => item.id),
    ).toEqual([beta.id]);
    expect(
      (
        await store.listProducts(tenantId, actorUserId, {
          archived: "all",
          limit: "1",
          offset: "1",
        })
      ).items,
    ).toEqual([alpha]);
  });

  it("distinguishes omission and explicit null while preserving canonical no-op timestamps", async () => {
    const created = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Mutable", gtin: "96385074" },
      "mutable-create",
    );
    clock += 60_000;
    vi.setSystemTime(clock);
    const renamed = await store.updateProduct(
      tenantId,
      actorUserId,
      created.id,
      { name: "Renamed" },
      "rename",
    );
    expect(renamed).toMatchObject({ name: "Renamed", gtin14: "00000096385074" });
    expect(renamed.updatedAt).not.toBe(created.updatedAt);
    clock += 60_000;
    vi.setSystemTime(clock);
    expect(
      await store.updateProduct(
        tenantId,
        actorUserId,
        created.id,
        { gtin: "00000096385074" },
        "canonical-noop",
      ),
    ).toEqual(renamed);
    const cleared = await store.updateProduct(
      tenantId,
      actorUserId,
      created.id,
      { gtin: null },
      "clear-gtin",
    );
    expect(cleared).toMatchObject({ name: "Renamed", gtin14: null });
    expect(cleared.updatedAt).toBe(new Date(clock).toISOString());
    const requestIds = (
      await fixture.db
        .select({ requestId: schema.tenantAuditEvents.requestId })
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, tenantId))
    ).map((row) => row.requestId);
    expect(requestIds).not.toContain("canonical-noop");
  });

  it("allows duplicate names and null GTINs but maps active GTIN create and restore conflicts", async () => {
    const original = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Duplicate", gtin: "96385074" },
      "original",
    );
    await store.createProduct(tenantId, actorUserId, { name: "Duplicate" }, "null-one");
    await store.createProduct(tenantId, actorUserId, { name: "Duplicate" }, "null-two");
    await expect(
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Conflict", gtin: "00000096385074" },
        "conflict",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "product_gtin_taken" } });
    const archived = await store.updateProduct(
      tenantId,
      actorUserId,
      original.id,
      { archived: true },
      "archive-original",
    );
    const replacement = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Replacement", gtin: "96385074" },
      "replacement",
    );
    await expect(
      store.updateProduct(
        tenantId,
        actorUserId,
        original.id,
        { archived: false },
        "restore-conflict",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "product_gtin_taken" } });
    expect(await store.getProduct(tenantId, actorUserId, original.id)).toEqual(archived);
    expect(replacement.id).not.toBe(original.id);
  });

  it("rejects GTIN changes when shifts, kiosk assignments or inventories reference the product", async () => {
    const [shiftProduct, kioskProduct, inventoryProduct] = await Promise.all([
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Shift", gtin: "96385074" },
        "create-shift",
      ),
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Kiosk", gtin: "036000291452" },
        "create-kiosk",
      ),
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Inventory", gtin: "4006381333931" },
        "create-inventory",
      ),
    ]);
    const kioskId = randomUUID();
    const lineId = randomUUID();
    await fixture.db.insert(schema.kiosks).values({ id: kioskId, tenantId, name: "US kiosk" });
    await fixture.db.insert(schema.lines).values({ id: lineId, tenantId, name: "US line" });
    await fixture.db.insert(schema.shifts).values({
      tenantId,
      productId: shiftProduct.id,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
    });
    await fixture.db
      .insert(schema.kioskProducts)
      .values({ tenantId, kioskId, productId: kioskProduct.id });
    await fixture.db.insert(schema.inventories).values({
      tenantId,
      number: `INVENTORY-${randomUUID()}`,
      productId: inventoryProduct.id,
      gtin14Snapshot: "04006381333931",
      lineId,
      mode: "check",
      productionDateFrom: "2026-09-01",
      productionDateTo: "2026-09-05",
      createdByUserId: actorUserId,
    });
    for (const product of [shiftProduct, kioskProduct, inventoryProduct]) {
      await expect(
        store.updateProduct(
          tenantId,
          actorUserId,
          product.id,
          { name: `${product.name} renamed` },
          `rename-${product.id}`,
        ),
      ).resolves.toMatchObject({ name: `${product.name} renamed` });
      await expect(
        store.updateProduct(
          tenantId,
          actorUserId,
          product.id,
          { gtin: null },
          `locked-${product.id}`,
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "product_gtin_locked" } });
    }
  });

  it("writes complete lifecycle audit snapshots atomically and rolls back when audit fails", async () => {
    const created = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Audited", gtin: "96385074" },
      "audit-create",
    );
    await fixture.pool.query(`
      ALTER TABLE tenant_audit_events
      ADD CONSTRAINT us_test_reject_product_update
      CHECK (request_id IS DISTINCT FROM 'forced-audit-failure')
    `);
    try {
      await expect(
        store.updateProduct(
          tenantId,
          actorUserId,
          created.id,
          { name: "Must roll back" },
          "forced-audit-failure",
        ),
      ).rejects.toBeTruthy();
    } finally {
      await fixture.pool.query(`
        ALTER TABLE tenant_audit_events DROP CONSTRAINT us_test_reject_product_update
      `);
    }
    expect(await store.getProduct(tenantId, actorUserId, created.id)).toEqual(created);
    clock += 60_000;
    vi.setSystemTime(clock);
    const updated = await store.updateProduct(
      tenantId,
      actorUserId,
      created.id,
      { name: "Committed" },
      "audit-update",
    );
    const archived = await store.updateProduct(
      tenantId,
      actorUserId,
      created.id,
      { archived: true },
      "audit-archive",
    );
    const restored = await store.updateProduct(
      tenantId,
      actorUserId,
      created.id,
      { archived: false },
      "audit-restore",
    );
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenantId));
    expect(audits).toHaveLength(4);
    const byRequestId = Object.fromEntries(
      audits.map(({ id: _id, createdAt: _createdAt, ...audit }) => [audit.requestId, audit]),
    );
    expect(byRequestId).toEqual({
      "audit-create": {
        organizationId: tenantId,
        actorUserId,
        action: "traceability.product.created",
        outcome: "success",
        targetType: "traceability_product",
        targetId: created.id,
        before: null,
        after: created,
        requestId: "audit-create",
      },
      "audit-update": {
        organizationId: tenantId,
        actorUserId,
        action: "traceability.product.updated",
        outcome: "success",
        targetType: "traceability_product",
        targetId: created.id,
        before: created,
        after: updated,
        requestId: "audit-update",
      },
      "audit-archive": {
        organizationId: tenantId,
        actorUserId,
        action: "traceability.product.archived",
        outcome: "success",
        targetType: "traceability_product",
        targetId: created.id,
        before: updated,
        after: archived,
        requestId: "audit-archive",
      },
      "audit-restore": {
        organizationId: tenantId,
        actorUserId,
        action: "traceability.product.restored",
        outcome: "success",
        targetType: "traceability_product",
        targetId: created.id,
        before: archived,
        after: restored,
        requestId: "audit-restore",
      },
    });
  });

  it("serializes concurrent active-GTIN creates and restores through the unique index", async () => {
    const creates = await Promise.allSettled([
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Concurrent A", gtin: "96385074" },
        "concurrent-a",
      ),
      store.createProduct(
        tenantId,
        actorUserId,
        { name: "Concurrent B", gtin: "00000096385074" },
        "concurrent-b",
      ),
    ]);
    expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(creates.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409, response: { code: "product_gtin_taken" } }),
      }),
    ]);

    const winner = creates.find((result) => result.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("Missing concurrent winner");
    await store.updateProduct(
      tenantId,
      actorUserId,
      winner.value.id,
      { archived: true },
      "archive-winner",
    );
    const second = await store.createProduct(
      tenantId,
      actorUserId,
      { name: "Restorer", gtin: "96385074" },
      "restorer",
    );
    await store.updateProduct(
      tenantId,
      actorUserId,
      second.id,
      { archived: true },
      "archive-restorer",
    );
    const restores = await Promise.allSettled([
      store.updateProduct(tenantId, actorUserId, winner.value.id, { archived: false }, "restore-a"),
      store.updateProduct(tenantId, actorUserId, second.id, { archived: false }, "restore-b"),
    ]);
    expect(restores.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(restores.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409, response: { code: "product_gtin_taken" } }),
      }),
    ]);
  });

  it("matches only the requested named unique constraint, including wrapped driver errors", () => {
    expect(
      isUniqueConstraintViolation(
        { code: "23505", constraint: "products_tenant_gtin_unarchived_uq" },
        "products_tenant_gtin_unarchived_uq",
      ),
    ).toBe(true);
    expect(
      isUniqueConstraintViolation(
        { cause: { code: "23505", constraint: "products_tenant_gtin_unarchived_uq" } },
        "products_tenant_gtin_unarchived_uq",
      ),
    ).toBe(true);
    for (const error of [null, undefined, "23505", {}, { code: "23505", constraint: "other" }]) {
      expect(isUniqueConstraintViolation(error, "products_tenant_gtin_unarchived_uq")).toBe(false);
    }
  });
});
