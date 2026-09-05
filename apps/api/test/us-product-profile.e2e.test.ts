import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;
const editable = {
  productName: "Apple Cups",
  brandName: null,
  commodity: "Apples",
  variety: null,
  packagingSizeValue: "6",
  packagingSizeUom: "oz",
  packagingStyle: "cup",
  defaultQuantityUom: "case",
  coverageStatus: "unknown",
  coverageRationale: null,
  ftlCategory: null,
  ftlSourceUrl: null,
  ftlSourceVersion: null,
};
const reviewed = {
  ...editable,
  coverageStatus: "covered",
  coverageRationale: "Manual synthetic review",
  ftlCategory: "Fruits (fresh-cut)",
  ftlSourceUrl: "https://example.test/ftl",
  ftlSourceVersion: "synthetic-v1",
};

describe.skipIf(!url)("US product profiles on isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsProductProfileStore;
  let tenantId: string;
  let actorUserId: string;
  let memberId: string;
  let productId: string;
  let clock = Date.now();
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsProductProfileStore(fixture.db);
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
    productId = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenantId, name: "Synthetic US", slug: tenantId, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actorUserId, name: "Synthetic QA", email: `${actorUserId}@example.test` });
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
      updatedByUserId: actorUserId,
    });
    await fixture.db.insert(schema.orgProfiles).values({ tenantId, timeZone: "America/Chicago" });
    await fixture.db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Catalog name", gtin14: null });
  });
  const put = (input: unknown, requestId = "save") =>
    store.putProfile(tenantId, actorUserId, productId, input, requestId);
  const get = () => store.getProfile(tenantId, actorUserId, productId);
  const role = (value: string) =>
    fixture.db.update(schema.member).set({ role: value }).where(eq(schema.member.id, memberId));
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.targetId, productId),
        ),
      )
      .orderBy(asc(schema.tenantAuditEvents.action));

  it("returns unsaved catalog-derived defaults without inserting rows or audit", async () => {
    expect(await get()).toEqual({
      ...editable,
      productName: "Catalog name",
      commodity: null,
      packagingSizeValue: null,
      packagingSizeUom: null,
      packagingStyle: null,
      defaultQuantityUom: null,
      productId,
      revision: 0,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(
      await fixture.db
        .select()
        .from(schema.productTraceabilityProfiles)
        .where(eq(schema.productTraceabilityProfiles.tenantId, tenantId)),
    ).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("persists descriptions separately from catalog fields, with exact audit and decimal padding", async () => {
    const before = await get();
    const after = await put(
      { ...editable, productName: " Apple Cups ", expectedRevision: 0 },
      "description-save",
    );
    expect(after).toEqual({
      ...editable,
      packagingSizeValue: "6.000",
      productId,
      revision: 1,
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
    });
    expect(await get()).toEqual(after);
    const [audit] = await audits();
    expect(await audits()).toHaveLength(1);
    expect(audit).toMatchObject({
      organizationId: tenantId,
      actorUserId,
      action: "traceability.product_profile.updated",
      outcome: "success",
      targetType: "traceability_product_profile",
      targetId: productId,
      requestId: "description-save",
      before,
      after,
    });
    await fixture.db
      .update(schema.products)
      .set({ name: "Renamed catalog", archived: true })
      .where(eq(schema.products.id, productId));
    expect(await get()).toEqual(after);
  });

  it("treats equivalent saves and immediate retries as no-ops but rejects stale/future revisions", async () => {
    const saved = await put({ ...editable, expectedRevision: 0 });
    vi.setSystemTime(clock + 30_000);
    expect(
      await put({ ...editable, packagingSizeValue: "6.000", expectedRevision: 1 }, "noop"),
    ).toEqual(saved);
    expect(await put({ ...editable, expectedRevision: 0 }, "retry")).toEqual(saved);
    await expect(put({ ...editable, expectedRevision: 2 })).rejects.toMatchObject({
      status: 409,
      response: { code: "product_profile_conflict" },
    });
    await expect(
      put({ ...editable, productName: "Overwrite", expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    await put({ ...editable, productName: "Second", expectedRevision: 1 });
    await expect(
      put({ ...editable, productName: "Second", expectedRevision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await audits()).toHaveLength(2);
  });

  it.each(["owner", "admin", "traceability_qa"])(
    "permits %s to review and stamps both exact audit events",
    async (value) => {
      await role(value);
      const before = await get();
      const after = await put({ ...reviewed, expectedRevision: 0 }, "qa-review");
      expect(after).toMatchObject({
        coverageStatus: "covered",
        reviewedBy: actorUserId,
        reviewedAt: new Date(clock).toISOString(),
        revision: 1,
      });
      const events = await audits();
      expect(events).toHaveLength(2);
      for (const [index, action] of [
        "traceability.product_profile.coverage_changed",
        "traceability.product_profile.updated",
      ].entries()) {
        expect(events[index]).toMatchObject({
          organizationId: tenantId,
          actorUserId,
          action,
          outcome: "success",
          targetType: "traceability_product_profile",
          targetId: productId,
          before,
          after,
          requestId: "qa-review",
        });
      }
    },
  );

  it("allows manager descriptions while preserving review attribution and refusing every coverage field change", async () => {
    const saved = await put({ ...reviewed, expectedRevision: 0 });
    await role("manager");
    vi.setSystemTime(clock + 30_000);
    const changed = await put({ ...reviewed, brandName: "Brand", expectedRevision: 1 });
    expect(changed).toMatchObject({
      revision: 2,
      brandName: "Brand",
      reviewedBy: saved.reviewedBy,
      reviewedAt: saved.reviewedAt,
      createdAt: saved.createdAt,
      updatedAt: new Date(clock + 30_000).toISOString(),
    });
    for (const patch of [
      { coverageStatus: "contains_ftl_same_form" },
      { coverageRationale: "Different rationale" },
      { ftlCategory: "Other category" },
      { ftlSourceUrl: "https://example.test/another" },
      { ftlSourceVersion: "v2" },
    ]) {
      await expect(
        put({ ...reviewed, brandName: "Brand", ...patch, expectedRevision: 2 }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(await get()).toEqual(changed);
    expect(await audits()).toHaveLength(3);
  });

  it("lets a manager save unreviewed descriptions but only QA reset a reviewed decision", async () => {
    await role("manager");
    await put({ ...editable, expectedRevision: 0 });
    await expect(put({ ...reviewed, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    await role("traceability_qa");
    await put({ ...reviewed, expectedRevision: 1 });
    await role("manager");
    await expect(put({ ...editable, expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
    await role("traceability_qa");
    vi.setSystemTime(clock + 30_000);
    expect(await put({ ...editable, expectedRevision: 2 })).toMatchObject({
      coverageStatus: "unknown",
      reviewedBy: actorUserId,
      reviewedAt: new Date(clock + 30_000).toISOString(),
      revision: 3,
    });
  });

  it.each([
    "traceability_receiving",
    "traceability_production",
    "traceability_shipping",
    "traceability_auditor",
    "member",
    "unknown",
  ])("reloads %s restrictions even for unchanged saves", async (value) => {
    await put({ ...editable, expectedRevision: 0 });
    await role(value);
    await expect(put({ ...editable, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    if (["member", "unknown"].includes(value))
      await expect(get()).rejects.toMatchObject({ status: 403 });
    else expect(await get()).toMatchObject({ revision: 1 });
    expect(await audits()).toHaveLength(1);
  });

  it("denies removed membership, foreign product IDs, malformed IDs and injected metadata", async () => {
    const foreignTenantId = randomUUID();
    const foreignProductId = randomUUID();
    await fixture.db.insert(schema.organization).values({
      id: foreignTenantId,
      name: "Foreign",
      slug: foreignTenantId,
      createdAt: new Date(),
    });
    await fixture.db
      .insert(schema.products)
      .values({ id: foreignProductId, tenantId: foreignTenantId, name: "Foreign product" });
    for (const id of [foreignProductId, randomUUID()]) {
      await expect(store.getProfile(tenantId, actorUserId, id)).rejects.toMatchObject({
        status: 404,
        response: { code: "product_not_found" },
      });
      await expect(
        store.putProfile(
          tenantId,
          actorUserId,
          id,
          { ...editable, expectedRevision: 0 },
          "foreign",
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
    await expect(store.getProfile(tenantId, actorUserId, "malformed")).rejects.toMatchObject({
      status: 400,
    });
    for (const patch of [
      { tenantId },
      { reviewedBy: actorUserId },
      { reviewedAt: new Date().toISOString() },
      { profileCode: "US_GENERIC_LOT_TRACEABILITY" },
      { packagingSizeValue: "6.0001" },
      { expectedRevision: undefined },
    ]) {
      await expect(put({ ...editable, expectedRevision: 0, ...patch })).rejects.toMatchObject({
        status: 400,
      });
    }
    await fixture.db.delete(schema.member).where(eq(schema.member.id, memberId));
    await expect(get()).rejects.toMatchObject({ status: 403 });
    await expect(put({ ...editable, expectedRevision: 0 })).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toEqual([]);
  });

  it("never accepts FTL classification for generic tenants, including unknown annotations", async () => {
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await put({ ...editable, expectedRevision: 0 });
    for (const input of [reviewed, { ...editable, coverageRationale: "Implied review" }]) {
      await expect(put({ ...input, expectedRevision: 1 })).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_master_data" },
      });
    }
    expect(await get()).toMatchObject({ coverageStatus: "unknown", reviewedBy: null });
    expect(await audits()).toHaveLength(1);
  });

  it("fails closed for RU, missing, stale-baseline and corrupt persisted US profiles", async () => {
    await put({ ...reviewed, expectedRevision: 0 });
    for (const patch of [
      { code: "RU_CHZ" as const },
      { code: "US_GENERIC_LOT_TRACEABILITY" as const },
      { code: "US_FSMA204_PROCESSOR" as const, baselineVersion: "wrong" },
    ]) {
      await fixture.db
        .update(schema.traceabilityProfiles)
        .set(patch)
        .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
      await expect(get()).rejects.toMatchObject({ status: 503 });
      await expect(put({ ...reviewed, expectedRevision: 1 })).rejects.toMatchObject({
        status: 503,
      });
    }
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await expect(get()).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toHaveLength(2);
  });

  it("rejects persisted review attribution in a generic profile even when editable coverage is empty", async () => {
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
    await fixture.db.insert(schema.productTraceabilityProfiles).values({
      tenantId,
      productId,
      productName: "Synthetic",
      reviewedBy: actorUserId,
      reviewedAt: new Date(),
    });
    await expect(get()).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await expect(put({ ...editable, expectedRevision: 1 })).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    expect(await audits()).toEqual([]);
    const [stored] = await fixture.db
      .select()
      .from(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.productId, productId));
    expect(stored).toMatchObject({ reviewedBy: actorUserId, revision: 1 });
  });

  it.each([0, 1])(
    "serializes divergent concurrent saves at revision %s",
    async (expectedRevision) => {
      if (expectedRevision === 1) await put({ ...editable, expectedRevision: 0 });
      const outcomes = await Promise.allSettled([
        put({ ...editable, productName: "Writer A", expectedRevision }, "A"),
        put({ ...editable, productName: "Writer B", expectedRevision }, "B"),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      expect(failure?.status === "rejected" ? failure.reason : null).toMatchObject({ status: 409 });
      const final = await get();
      expect(final.revision).toBe(expectedRevision + 1);
      const events = await audits();
      expect(events).toHaveLength(expectedRevision + 1);
      expect(
        events.some((event) => event.requestId === (final.productName === "Writer A" ? "A" : "B")),
      ).toBe(true);
    },
  );

  it("collapses identical concurrent first saves into one persisted revision and audit", async () => {
    const results = await Promise.all([
      put({ ...editable, expectedRevision: 0 }, "first"),
      put({ ...editable, expectedRevision: 0 }, "retry"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ revision: 1 });
    expect(await audits()).toHaveLength(1);
  });

  it("does not return or silently repair a corrupt stored review URL", async () => {
    await put({ ...reviewed, expectedRevision: 0 });
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({ ftlSourceUrl: "javascript:invalid" })
      .where(eq(schema.productTraceabilityProfiles.productId, productId));
    await expect(get()).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await expect(put({ ...reviewed, expectedRevision: 1 })).rejects.toMatchObject({ status: 503 });
    expect(await audits()).toHaveLength(2);
  });

  it("rolls back the profile and the first audit event if the coverage audit fails", async () => {
    const before = await put({ ...editable, expectedRevision: 0 });
    await fixture.pool.query(
      `CREATE FUNCTION us_test_reject_coverage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'traceability.product_profile.coverage_changed' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$`,
    );
    await fixture.pool.query(
      `CREATE TRIGGER us_test_reject_coverage_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION us_test_reject_coverage_audit()`,
    );
    try {
      await expect(put({ ...reviewed, expectedRevision: 1 })).rejects.toThrow();
      expect(await get()).toEqual(before);
      expect(await audits()).toHaveLength(1);
    } finally {
      await fixture.pool.query("DROP TRIGGER us_test_reject_coverage_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION us_test_reject_coverage_audit()");
    }
  });

  it("retains historical review attribution when its account is deleted", async () => {
    const before = await put({ ...reviewed, expectedRevision: 0 });
    await fixture.db.delete(schema.user).where(eq(schema.user.id, actorUserId));
    const [row] = await fixture.db
      .select()
      .from(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.productId, productId));
    expect(row).toMatchObject({
      reviewedBy: actorUserId,
      reviewedAt: new Date(clock),
      revision: 1,
    });
    const events = await audits();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.actorUserId).toBeNull();
      expect(event.after).toEqual(before);
    }
  });
});
