import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { ReceivingDraft } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  emptyReceivingDraft as empty,
  emptyReceivingItem as item,
  seedReceivingTenant,
} from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US saved receiving readiness", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let context: Awaited<ReturnType<typeof seedReceivingTenant>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    context = await seedReceivingTenant(fixture.db);
  });
  const create = (draft: ReceivingDraft = empty) =>
    store.createDraft(
      context.tenant,
      context.actor,
      { operationKey: randomUUID(), draft },
      "ready-create",
    );
  const check = (id: string, query: unknown = { expectedDraftVersion: "1" }) =>
    store.checkReadiness(context.tenant, context.actor, id, query);
  const state = async () => ({
    events: await fixture.db.select().from(schema.traceabilityEvents),
    lines: await fixture.db.select().from(schema.receivingEventItems),
    documents: await fixture.db.select().from(schema.receivingEventDocuments),
    operations: await fixture.db.select().from(schema.receivingOperations),
    counters: await fixture.db.select().from(schema.receivingCounters),
    lots: await fixture.db.select().from(schema.traceabilityLots),
    audit: await fixture.db.select().from(schema.tenantAuditEvents),
  });
  async function completeDraft(): Promise<ReceivingDraft> {
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({
        phoneNumber: "+1 555 010 0100",
        streetAddress: "1 Test Street",
        city: "Chicago",
        stateOrRegion: "IL",
        zipOrPostalCode: "60601",
        countryCode: "US",
        roles: ["receive_at"],
      })
      .where(eq(schema.traceabilityLocations.id, context.location));
    await fixture.db.insert(schema.productTraceabilityProfiles).values({
      tenantId: context.tenant,
      productId: context.product,
      productName: "Synthetic apples",
      coverageStatus: "not_covered",
      coverageRationale: "Synthetic QA review",
      reviewedBy: context.actor,
      reviewedAt: new Date(),
    });
    return {
      ...empty,
      dateReceived: "2026-09-06",
      locationId: context.location,
      previousSourceLocationId: context.location,
      documentIds: [context.document],
      items: [
        {
          ...item,
          productId: context.product,
          tlc: "READINESS-0001",
          source: { kind: "location", locationId: context.location },
          quantity: "25.000",
          unitOfMeasure: "lb",
        },
      ],
    };
  }

  it("reports saved missing KDEs without changing drafts, lots, locks, receipts or audit", async () => {
    const created = await create();
    const before = await state();
    const result = await check(created.id);
    expect(result).toMatchObject({
      eventId: created.id,
      draftVersion: 1,
      profileCode: "US_FSMA204_PROCESSOR",
      state: "blocked",
      inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      checkedAt: expect.any(String),
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "header",
          line: null,
          field: "dateReceived",
          severity: "error",
        }),
        expect.objectContaining({ group: "lines", line: null, severity: "error" }),
        expect.objectContaining({ group: "documents", line: null, severity: "error" }),
      ]),
    );
    const repeated = await check(created.id);
    expect(repeated.inputDigest).toBe(result.inputDigest);
    expect(await state()).toEqual(before);
  });

  it("returns complete only for current complete saved inputs and preserves every persisted row", async () => {
    const created = await create(await completeDraft());
    const before = await state();
    const result = await check(created.id);
    expect(result.state).toBe("complete");
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(await state()).toEqual(before);
  });

  it("maps the stored GTIN into readiness and permits an absent GTIN", async () => {
    const created = await create(await completeDraft());
    const absent = await check(created.id);
    expect(absent).toMatchObject({
      state: "complete",
      ruleVersion: "receiving-readiness-v3",
      exemptReviewRequiredLines: [],
    });
    await fixture.db
      .update(schema.products)
      .set({ gtin14: "00000000000001" })
      .where(eq(schema.products.id, context.product));
    expect((await check(created.id)).issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "product",
      code: "format",
      detail: "gtin",
    });
  });

  it("rejects stale versions and strict malformed queries", async () => {
    const created = await create();
    await expect(check(created.id, { expectedDraftVersion: "2" })).rejects.toMatchObject({
      status: 409,
      response: { code: "receiving_draft_conflict" },
    });
    for (const query of [
      {},
      { expectedDraftVersion: "0" },
      { expectedDraftVersion: "01" },
      { expectedDraftVersion: "1", tenantId: context.tenant },
      { expectedDraftVersion: ["1", "1"] },
    ])
      await expect(check(created.id, query)).rejects.toMatchObject({ status: 400 });
  });

  it("tenant-scopes targets and reloads membership and profile before reading", async () => {
    const created = await create();
    const foreign = await seedReceivingTenant(fixture.db);
    await expect(
      store.checkReadiness(foreign.tenant, foreign.actor, created.id, {
        expectedDraftVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      store.checkReadiness(context.tenant, foreign.actor, created.id, {
        expectedDraftVersion: "1",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.id, context.member));
    await expect(check(created.id)).rejects.toMatchObject({ status: 403 });
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, context.member));
    expect((await check(created.id)).state).toBe("blocked");
    await fixture.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, context.tenant));
    await expect(check(created.id)).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
  });

  it("changes the digest when current referenced data changes without saving the draft", async () => {
    const created = await create(await completeDraft());
    const initial = await check(created.id);
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed current supplier" })
      .where(eq(schema.traceabilityLocations.id, context.location));
    const changed = await check(created.id);
    expect(changed.draftVersion).toBe(1);
    expect(changed.inputDigest).not.toBe(initial.inputDigest);
    expect(changed.state).toBe("complete");
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({ productName: "Changed current product" })
      .where(eq(schema.productTraceabilityProfiles.productId, context.product));
    expect((await check(created.id)).inputDigest).not.toBe(changed.inputDigest);
  });

  it("reports archived current references and location description or coverage gaps by saved line", async () => {
    const created = await create(await completeDraft());
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ phoneNumber: null })
      .where(eq(schema.traceabilityLocations.id, context.location));
    await fixture.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, context.product));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({ coverageStatus: "unknown", reviewedAt: null, reviewedBy: null })
      .where(eq(schema.productTraceabilityProfiles.productId, context.product));
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ archivedAt: new Date() })
      .where(eq(schema.referenceDocuments.id, context.document));
    const result = await check(created.id);
    expect(result.state).toBe("blocked");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "header", line: null, severity: "error" }),
        expect.objectContaining({ group: "lines", line: 1, field: "product", severity: "error" }),
        expect.objectContaining({ group: "lines", line: 1, severity: "error" }),
        expect.objectContaining({ group: "documents", severity: "error" }),
      ]),
    );
  });

  it("detects create collisions by tenant/source/TLC and preserves saved line numbering at the limit", async () => {
    const draft = await completeDraft();
    const source = {
      kind: "reference" as const,
      referenceKind: "web_url" as const,
      referenceValue: "https://supplier.example.test/Case/A",
      resolvedLocationId: context.location,
    };
    await fixture.db
      .update(schema.traceabilityLots)
      .set({
        tlc: "LINE-100",
        sourceReferenceKind: "web_url",
        sourceReferenceValue: source.referenceValue,
        sourceReferenceLocationId: context.location,
      })
      .where(eq(schema.traceabilityLots.id, context.lot));
    const template = draft.items[0];
    if (!template) throw new Error("Expected synthetic receiving line");
    draft.items = Array.from({ length: 100 }, (_, index) => ({
      ...template,
      source,
      tlc: `LINE-${index + 1}`,
    }));
    const created = await create(draft);
    const before = await state();
    const result = await check(created.id);
    expect(result.state).toBe("blocked");
    expect(result.issues.filter((issue) => issue.code === "duplicate_identity")).toEqual([
      expect.objectContaining({ group: "lines", line: 100, severity: "error" }),
    ]);
    expect(await state()).toEqual(before);
    await fixture.db
      .update(schema.traceabilityLots)
      .set({ tlc: "different-case" })
      .where(eq(schema.traceabilityLots.id, context.lot));
    const clear = await check(created.id);
    expect(clear.state).toBe("complete");
    expect(clear.inputDigest).not.toBe(result.inputDigest);
  });

  it("does not report an identical foreign-tenant lot as a create collision", async () => {
    const draft = await completeDraft();
    const foreign = await seedReceivingTenant(fixture.db);
    const source = {
      kind: "reference" as const,
      referenceKind: "web_url" as const,
      referenceValue: "https://supplier.example.test/shared",
      resolvedLocationId: context.location,
    };
    await fixture.db
      .update(schema.traceabilityLots)
      .set({
        tlc: "READINESS-0001",
        sourceReferenceKind: "web_url",
        sourceReferenceValue: source.referenceValue,
        sourceReferenceLocationId: foreign.location,
      })
      .where(eq(schema.traceabilityLots.id, foreign.lot));
    const line = draft.items[0];
    if (!line) throw new Error("Expected synthetic receiving line");
    line.source = source;
    const created = await create(draft);
    expect((await check(created.id)).state).toBe("complete");
  });

  it("uses reference kind and value for existing identity even when resolved locations differ", async () => {
    const draft = await completeDraft();
    const secondLocation = randomUUID();
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: secondLocation,
      tenantId: context.tenant,
      partyId: context.party,
      name: "Other source",
      businessName: "Other source",
    });
    const source = {
      kind: "reference" as const,
      referenceKind: "web_url" as const,
      referenceValue: "https://supplier.example.test/Exact/Case",
      resolvedLocationId: context.location,
    };
    await fixture.db
      .update(schema.traceabilityLots)
      .set({
        tlc: "READINESS-0001",
        sourceReferenceKind: "web_url",
        sourceReferenceValue: source.referenceValue,
        sourceReferenceLocationId: secondLocation,
      })
      .where(eq(schema.traceabilityLots.id, context.lot));
    const line = draft.items[0];
    if (!line) throw new Error("Expected synthetic receiving line");
    line.source = source;
    const created = await create(draft);
    expect((await check(created.id)).issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "lot",
      code: "duplicate_identity",
      detail: null,
    });
  });

  it("uses unknown defaults for an absent product profile and keeps generic coverage unassessed", async () => {
    const draft = await completeDraft();
    await fixture.db
      .delete(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.productId, context.product));
    const created = await create(draft);
    const fsma = await check(created.id);
    expect(fsma.state).toBe("blocked");
    expect(fsma.issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "coverage",
      code: "coverage_unresolved",
      detail: "coverageStatus",
    });
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, context.tenant));
    const generic = await check(created.id);
    expect(generic.state).toBe("complete");
    expect(generic.profileCode).toBe("US_GENERIC_LOT_TRACEABILITY");
    expect(generic.issues).toContainEqual({
      severity: "warning",
      group: "lines",
      line: 1,
      field: "coverage",
      code: "not_assessed",
      detail: null,
    });
    expect(generic.inputDigest).not.toBe(fsma.inputDigest);
  });

  it("uses current linked lot status and identity without changing saved lot links", async () => {
    const draft = await completeDraft();
    const line = draft.items[0];
    if (!line) throw new Error("Expected synthetic receiving line");
    await fixture.db
      .update(schema.traceabilityLots)
      .set({ sourceLocationId: context.location })
      .where(eq(schema.traceabilityLots.id, context.lot));
    line.lotLinkMode = "link_existing";
    line.lotId = context.lot;
    line.tlc = "00001";
    const created = await create(draft);
    const initial = await check(created.id);
    expect(initial.state).toBe("complete");
    await fixture.db
      .update(schema.traceabilityLots)
      .set({ status: "quarantined" })
      .where(eq(schema.traceabilityLots.id, context.lot));
    const changed = await check(created.id);
    expect(changed.issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "lot",
      code: "inactive",
      detail: null,
    });
    expect(changed.inputDigest).not.toBe(initial.inputDigest);
    expect((await store.getDraft(context.tenant, context.actor, created.id)).draft).toEqual({
      ...draft,
      items: draft.items.map((item) => ({ ...item, exemptReceipt: null })),
    });
  });

  it("blocks a selected document whose separate current issuer was archived", async () => {
    const draft = await completeDraft();
    const issuer = randomUUID();
    await fixture.db.insert(schema.traceabilityParties).values({
      id: issuer,
      tenantId: context.tenant,
      name: "Separate document issuer",
    });
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ partyId: issuer })
      .where(eq(schema.referenceDocuments.id, context.document));
    const created = await create(draft);
    const initial = await check(created.id);
    expect(initial.state).toBe("complete");
    await fixture.db
      .update(schema.traceabilityParties)
      .set({ archived: true })
      .where(eq(schema.traceabilityParties.id, issuer));
    const before = await state();
    const changed = await check(created.id);
    expect(changed.state).toBe("blocked");
    expect(changed.issues).toEqual([
      {
        severity: "error",
        group: "documents",
        line: null,
        field: "documents",
        code: "inactive",
        detail: null,
      },
    ]);
    expect(changed.inputDigest).not.toBe(initial.inputDigest);
    expect(await state()).toEqual(before);
  });

  it("changes digests for document, issuer and profile updates and saved versions", async () => {
    const created = await create(await completeDraft());
    const initial = await check(created.id);
    await fixture.db
      .update(schema.referenceDocuments)
      .set({ number: "CURRENT-DOC" })
      .where(eq(schema.referenceDocuments.id, context.document));
    const changedDocument = await check(created.id);
    expect(changedDocument.inputDigest).not.toBe(initial.inputDigest);
    await fixture.db
      .update(schema.traceabilityParties)
      .set({ legalName: "Current legal name" })
      .where(eq(schema.traceabilityParties.id, context.party));
    const changedParty = await check(created.id);
    expect(changedParty.inputDigest).not.toBe(changedDocument.inputDigest);
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ retentionYears: 6 })
      .where(eq(schema.traceabilityProfiles.tenantId, context.tenant));
    const changedProfile = await check(created.id);
    expect(changedProfile.inputDigest).not.toBe(changedParty.inputDigest);
    await store.saveDraft(
      context.tenant,
      context.actor,
      created.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...created.draft, notes: "Changed saved input" },
      },
      "readiness-save",
    );
    await expect(check(created.id)).rejects.toMatchObject({ status: 409 });
    const saved = await check(created.id, { expectedDraftVersion: "2" });
    expect(saved.inputDigest).not.toBe(changedProfile.inputDigest);
    expect(saved.draftVersion).toBe(2);
  });

  it("reads one snapshot when references change while authorization waits on a membership lock", async () => {
    const created = await create(await completeDraft());
    const connection = await fixture.pool.connect();
    let pending: ReturnType<typeof check> | undefined;
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT id FROM member WHERE id = $1 FOR UPDATE", [context.member]);
      pending = check(created.id);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await fixture.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%\"member\"%'",
        );
        if (status.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await fixture.db
        .update(schema.traceabilityLocations)
        .set({ phoneNumber: null })
        .where(eq(schema.traceabilityLocations.id, context.location));
      await connection.query("COMMIT");
      expect((await pending).state).toBe("complete");
      expect((await check(created.id)).state).toBe("blocked");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await pending?.catch(() => undefined);
    }
  });
});
