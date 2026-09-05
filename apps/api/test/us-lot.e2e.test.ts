import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US lot store in disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsLotStore;
  let tenant: string,
    actor: string,
    member: string,
    product: string,
    location: string,
    otherLocation: string,
    party: string;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsLotStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    tenant = randomUUID();
    actor = randomUUID();
    member = randomUUID();
    product = randomUUID();
    location = randomUUID();
    otherLocation = randomUUID();
    party = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenant, name: "Synthetic US", slug: tenant, createdAt: new Date() });
    await fixture.db
      .insert(schema.user)
      .values({ id: actor, name: "Synthetic owner", email: `${actor}@example.test` });
    await fixture.db.insert(schema.member).values({
      id: member,
      organizationId: tenant,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
      effectiveAt: new Date(),
      updatedByUserId: actor,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    await fixture.db
      .insert(schema.products)
      .values({ id: product, tenantId: tenant, name: "Synthetic apples", gtin14: null });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: party, tenantId: tenant, name: "Synthetic supplier" });
    await fixture.db.insert(schema.traceabilityLocations).values([
      { id: location, tenantId: tenant, partyId: party, name: "A", businessName: "A" },
      { id: otherLocation, tenantId: tenant, partyId: party, name: "B", businessName: "B" },
    ]);
  });
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenant))
      .orderBy(schema.tenantAuditEvents.createdAt);
  const input = (tlc = "A-1") => ({
    productId: product,
    tlc,
    source: { kind: "location", locationId: location },
  });
  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "persists a GTIN-less imported lot under %s with exact audit",
    async (code) => {
      await fixture.db
        .update(schema.traceabilityProfiles)
        .set({ code })
        .where(eq(schema.traceabilityProfiles.tenantId, tenant));
      const lot = await store.createLot(tenant, actor, input(" =Apple  á-01 "), "create-lot");
      expect(lot).toEqual({
        id: expect.any(String),
        productId: product,
        tlc: "=Apple  á-01",
        source: { kind: "location", locationId: location },
        assignmentBasis: "imported",
        status: "active",
        revision: 1,
        createdBy: actor,
        updatedBy: actor,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(await store.getLot(tenant, actor, lot.id)).toEqual(lot);
      expect(await store.listLots(tenant, actor, {})).toEqual({
        items: [lot],
        limit: 50,
        offset: 0,
      });
      expect(await audits()).toEqual([
        expect.objectContaining({
          organizationId: tenant,
          actorUserId: actor,
          action: "traceability.lot.created",
          outcome: "success",
          targetType: "traceability_lot",
          targetId: lot.id,
          before: null,
          after: lot,
          requestId: "create-lot",
        }),
      ]);
    },
  );
  it("retains missing and typed reference sources without an export-ready claim", async () => {
    const missing = await store.createLot(tenant, actor, { ...input(), source: null }, "missing");
    const source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "HtTpS://Supplier.example.test/Source/A",
      resolvedLocationId: location,
    };
    const referenced = await store.createLot(tenant, actor, { ...input(), source }, "reference");
    expect(missing.source).toBeNull();
    expect(referenced.source).toEqual(source);
    expect(referenced).not.toHaveProperty("exportReady");
    expect((await store.listLots(tenant, actor, { sourceLocationId: location })).items).toEqual([
      referenced,
    ]);
  });
  it("enforces source-aware identity, handles concurrent duplicate creates and preserves other source matches", async () => {
    const results = await Promise.allSettled([
      store.createLot(tenant, actor, input(), "one"),
      store.createLot(tenant, actor, input(), "two"),
    ]);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("Expected one winner");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409, response: { code: "LOT_DUPLICATE", existingId: winner.value.id } },
    });
    expect(await audits()).toHaveLength(1);
    const other = await store.createLot(
      tenant,
      actor,
      { ...input(), source: { kind: "location", locationId: otherLocation } },
      "other-source",
    );
    expect(other.id).not.toBe(winner.value.id);
    const anotherProduct = randomUUID();
    await fixture.db
      .insert(schema.products)
      .values({ id: anotherProduct, tenantId: tenant, name: "Another" });
    await expect(
      store.createLot(tenant, actor, { ...input(), productId: anotherProduct }, "other-product"),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "LOT_DUPLICATE", existingId: winner.value.id },
    });
  });
  it("does not merge a reference with a location or two differently cased URLs", async () => {
    const source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/A",
      resolvedLocationId: location,
    };
    const first = await store.createLot(tenant, actor, { ...input(), source }, "ref");
    await expect(
      store.createLot(
        tenant,
        actor,
        { ...input(), source: { ...source, resolvedLocationId: otherLocation } },
        "same-ref",
      ),
    ).rejects.toMatchObject({ status: 409, response: { existingId: first.id } });
    await store.createLot(
      tenant,
      actor,
      { ...input(), source: { ...source, referenceValue: "https://supplier.example.test/a" } },
      "different-case",
    );
    await store.createLot(tenant, actor, input(), "location");
    expect((await store.listLots(tenant, actor, {})).items).toHaveLength(3);
  });
  it.each(["transformation", "exempt_supplier_receipt", "initial_packing", "first_land_receiving"])(
    "rejects manual assignment %s",
    async (assignmentBasis) => {
      await expect(
        store.createLot(tenant, actor, { ...input(), assignmentBasis }, "wrong-basis"),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code:
            assignmentBasis === "initial_packing" || assignmentBasis === "first_land_receiving"
              ? "ASSIGNMENT_BASIS_RESERVED"
              : "ASSIGNMENT_BASIS_NOT_ALLOWED",
        },
      });
      expect(await audits()).toEqual([]);
    },
  );
  it.each([
    ["owner", true, true, true],
    ["admin", true, true, true],
    ["manager", true, true, false],
    ["traceability_qa", true, true, true],
    ["traceability_receiving", true, false, false],
    ["traceability_production", true, false, false],
    ["traceability_shipping", true, false, false],
    ["traceability_auditor", true, false, false],
    ["member", false, false, false],
    ["unknown", false, false, false],
  ] as const)(
    "enforces fresh %s role on reads, creates and QA status",
    async (role, read, write, qa) => {
      const lot = await store.createLot(tenant, actor, input(), "setup");
      await fixture.db.update(schema.member).set({ role }).where(eq(schema.member.id, member));
      const get = store.getLot(tenant, actor, lot.id);
      if (read) await expect(get).resolves.toEqual(lot);
      else await expect(get).rejects.toMatchObject({ status: 403 });
      const create = store.createLot(tenant, actor, input("B-1"), "role-create");
      if (write) await expect(create).resolves.toMatchObject({ tlc: "B-1" });
      else await expect(create).rejects.toMatchObject({ status: 403 });
      const status = store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "quarantined", reason: "QA review", expectedRevision: 1 },
        "role-status",
      );
      if (qa) await expect(status).resolves.toMatchObject({ status: "quarantined", revision: 2 });
      else await expect(status).rejects.toMatchObject({ status: 403 });
    },
  );
  it("rejects foreign identities without disclosing another tenant's lot", async () => {
    const otherTenant = randomUUID(),
      otherProduct = randomUUID(),
      foreignParty = randomUUID(),
      foreignLocation = randomUUID(),
      foreignLot = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: otherTenant, name: "Other", slug: otherTenant, createdAt: new Date() });
    await fixture.db
      .insert(schema.products)
      .values({ id: otherProduct, tenantId: otherTenant, name: "Other" });
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: foreignParty, tenantId: otherTenant, name: "Other" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: foreignLocation,
      tenantId: otherTenant,
      partyId: foreignParty,
      name: "Other",
      businessName: "Other",
    });
    await fixture.db.insert(schema.traceabilityLots).values({
      id: foreignLot,
      tenantId: otherTenant,
      productId: otherProduct,
      tlc: "A-1",
      assignmentBasis: "imported",
      createdBy: "historical",
      updatedBy: "historical",
    });
    await expect(store.getLot(tenant, actor, foreignLot)).rejects.toMatchObject({ status: 404 });
    await expect(
      store.changeStatus(
        tenant,
        actor,
        foreignLot,
        { status: "recalled", reason: "QA reviewed", expectedRevision: 1 },
        "foreign-status",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.createLot(tenant, actor, { ...input(), productId: otherProduct }, "foreign-product"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.createLot(
        tenant,
        actor,
        {
          ...input(),
          source: {
            kind: "reference",
            referenceKind: "web_url",
            referenceValue: "https://example.test/x",
            resolvedLocationId: foreignLocation,
          },
        },
        "foreign-source",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((await store.listLots(tenant, actor, {})).items).toEqual([]);
    await expect(
      store.createLot(tenant, actor, { ...input(), source: null }, "same-code-local"),
    ).resolves.toMatchObject({ tlc: "A-1" });
  });
  it("retains historical actors and audit snapshots after the account is deleted", async () => {
    const lot = await store.createLot(tenant, actor, input(), "historical-create");
    const next = await store.changeStatus(
      tenant,
      actor,
      lot.id,
      { status: "quarantined", reason: "Historical QA hold", expectedRevision: 1 },
      "historical-status",
    );
    const reader = randomUUID();
    await fixture.db.insert(schema.user).values({
      id: reader,
      name: "Synthetic auditor",
      email: `${reader}@example.test`,
    });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenant,
      userId: reader,
      role: "traceability_auditor",
      createdAt: new Date(),
    });
    await fixture.db.delete(schema.user).where(eq(schema.user.id, actor));
    expect(await store.getLot(tenant, reader, lot.id)).toEqual(next);
    expect(next).toMatchObject({ createdBy: actor, updatedBy: actor });
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorUserId: null,
        action: "traceability.lot.created",
        before: null,
        after: lot,
        requestId: "historical-create",
      }),
      expect.objectContaining({
        actorUserId: null,
        action: "traceability.lot.status_changed",
        before: lot,
        after: { ...next, reason: "Historical QA hold" },
        requestId: "historical-status",
      }),
    ]);
  });
  it("blocks archived references without damaging existing records", async () => {
    const lot = await store.createLot(tenant, actor, input(), "setup");
    await fixture.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, product));
    await expect(store.createLot(tenant, actor, input("B"), "archived")).rejects.toMatchObject({
      status: 409,
      response: { code: "lot_reference_archived" },
    });
    await fixture.db
      .update(schema.products)
      .set({ archived: false })
      .where(eq(schema.products.id, product));
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ archived: true })
      .where(eq(schema.traceabilityLocations.id, location));
    await expect(store.createLot(tenant, actor, input("B"), "archived")).rejects.toMatchObject({
      status: 409,
    });
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ archived: false })
      .where(eq(schema.traceabilityLocations.id, location));
    await fixture.db
      .update(schema.traceabilityParties)
      .set({ archived: true })
      .where(eq(schema.traceabilityParties.id, party));
    await expect(store.createLot(tenant, actor, input("B"), "archived")).rejects.toMatchObject({
      status: 409,
    });
    expect(await store.getLot(tenant, actor, lot.id)).toEqual(lot);
  });
  it("changes status with atomic exact audit, guards stale concurrency and retries without duplicate audit", async () => {
    const lot = await store.createLot(tenant, actor, input(), "create");
    const body = { status: "quarantined", reason: "Synthetic QA hold", expectedRevision: 1 };
    const next = await store.changeStatus(tenant, actor, lot.id, body, "hold");
    expect(next).toMatchObject({
      id: lot.id,
      status: "quarantined",
      revision: 2,
      updatedBy: actor,
    });
    expect(await store.changeStatus(tenant, actor, lot.id, body, "retry")).toEqual(next);
    await expect(
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { ...body, expectedRevision: next.revision },
        "new-command-without-transition",
      ),
    ).rejects.toMatchObject({ status: 422, response: { code: "LOT_TRANSITION_NOT_ALLOWED" } });
    expect(await audits()).toEqual([
      expect.objectContaining({ action: "traceability.lot.created", after: lot }),
      expect.objectContaining({
        organizationId: tenant,
        actorUserId: actor,
        action: "traceability.lot.status_changed",
        outcome: "success",
        targetType: "traceability_lot",
        targetId: lot.id,
        before: lot,
        after: { ...next, reason: "Synthetic QA hold" },
        requestId: "hold",
      }),
    ]);
    await expect(
      store.changeStatus(tenant, actor, lot.id, { ...body, status: "active" }, "stale"),
    ).rejects.toMatchObject({ status: 409, response: { code: "lot_revision_conflict" } });
    const results = await Promise.allSettled([
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "active", reason: "Released hold", expectedRevision: 2 },
        "release",
      ),
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "recalled", reason: "Recall decision", expectedRevision: 2 },
        "recall",
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    expect(await audits()).toHaveLength(3);
  });
  it("does not permit manual reopening, repeated active commands or archived identifier reuse", async () => {
    const lot = await store.createLot(tenant, actor, input(), "create");
    await expect(
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "active", reason: "No change", expectedRevision: 1 },
        "no-op",
      ),
    ).rejects.toMatchObject({ status: 422 });
    await store.changeStatus(
      tenant,
      actor,
      lot.id,
      { status: "shipped", reason: "Synthetic shipment", expectedRevision: 1 },
      "ship",
    );
    await expect(
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "active", reason: "Reopen", expectedRevision: 2 },
        "reopen",
      ),
    ).rejects.toMatchObject({ status: 422, response: { code: "LOT_TRANSITION_NOT_ALLOWED" } });
    await store.changeStatus(
      tenant,
      actor,
      lot.id,
      { status: "archived", reason: "Archive synthetic lot", expectedRevision: 2 },
      "archive",
    );
    await expect(
      store.createLot(tenant, actor, input(), "duplicate-archived"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("validates every boundary and literal search without silently coercing or expanding patterns", async () => {
    const literal = await store.createLot(tenant, actor, input("%_Apple"), "literal");
    await store.createLot(tenant, actor, input("Other Apple"), "other");
    expect((await store.listLots(tenant, actor, { search: "%_" })).items).toEqual([literal]);
    expect(
      (
        await store.listLots(tenant, actor, {
          productId: product,
          tlc: "%_Apple",
          assignmentBasis: "imported",
          status: "active",
          limit: 1,
          offset: 0,
        })
      ).items,
    ).toEqual([literal]);
    await expect(store.getLot(tenant, actor, "bad")).rejects.toMatchObject({ status: 400 });
    await expect(store.listLots(tenant, actor, { tenantId: tenant })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      store.createLot(tenant, actor, { ...input(), actorUserId: actor }, "forged"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.changeStatus(
        tenant,
        actor,
        literal.id,
        {
          status: "recalled",
          reason: "QA reviewed",
          expectedRevision: 1,
          context: "system:shipping_recalculation",
        },
        "forged-context",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("reloads revoked membership and fails closed for invalid US profile", async () => {
    const lot = await store.createLot(tenant, actor, input(), "setup");
    await fixture.db.delete(schema.member).where(eq(schema.member.id, member));
    await expect(store.listLots(tenant, actor, {})).rejects.toMatchObject({ status: 403 });
    await expect(
      store.changeStatus(
        tenant,
        actor,
        lot.id,
        { status: "recalled", reason: "QA reviewed", expectedRevision: 1 },
        "revoked",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.db.insert(schema.member).values({
      id: member,
      organizationId: tenant,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ", baselineVersion: null })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    await expect(store.listLots(tenant, actor, {})).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
  });
  it("rolls back both creation and status on audit failure", async () => {
    const lot = await store.createLot(tenant, actor, input(), "setup");
    await fixture.pool.query(
      "ALTER TABLE tenant_audit_events ADD CONSTRAINT reject_lot_test_audit CHECK(request_id <> 'force-lot-audit-fail') NOT VALID",
    );
    try {
      await expect(
        store.createLot(tenant, actor, input("ROLLBACK"), "force-lot-audit-fail"),
      ).rejects.toThrow();
      await expect(
        store.changeStatus(
          tenant,
          actor,
          lot.id,
          { status: "recalled", reason: "Rollback test", expectedRevision: 1 },
          "force-lot-audit-fail",
        ),
      ).rejects.toThrow();
      expect(await store.getLot(tenant, actor, lot.id)).toEqual(lot);
      expect((await store.listLots(tenant, actor, {})).items).toEqual([lot]);
      expect(await audits()).toHaveLength(1);
    } finally {
      await fixture.pool.query(
        "ALTER TABLE tenant_audit_events DROP CONSTRAINT reject_lot_test_audit",
      );
    }
  });
  it("fails closed on malformed persisted reference content", async () => {
    const lot = await store.createLot(
      tenant,
      actor,
      {
        ...input(),
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "https://example.test/source",
          resolvedLocationId: location,
        },
      },
      "setup",
    );
    await fixture.db
      .update(schema.traceabilityLots)
      .set({ sourceReferenceValue: "invalid persisted source" })
      .where(
        and(eq(schema.traceabilityLots.tenantId, tenant), eq(schema.traceabilityLots.id, lot.id)),
      );
    await expect(store.getLot(tenant, actor, lot.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    await expect(store.listLots(tenant, actor, {})).rejects.toMatchObject({ status: 503 });
  });
});
