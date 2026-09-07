import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { receivingFinalizedRecordSchema } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedExemptReceiving, seedReceivingTenant } from "./support/us-receiving-fixture";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("exempt receiving finalization", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedExemptReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedExemptReceiving(fixture.db);
  });
  async function state() {
    const result = await fixture.pool.query(
      `SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM traceability_events t WHERE tenant_id=$1) events,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM traceability_lots t WHERE tenant_id=$1) lots,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id,line_no) FROM receiving_event_items t WHERE tenant_id=$1) items,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY event_id,position) FROM receiving_event_documents t WHERE tenant_id=$1) documents,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY year) FROM receiving_counters t WHERE tenant_id=$1) counters,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenant_audit_events t WHERE organization_id=$1) audits,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_key) FROM receiving_operations t WHERE tenant_id=$1) operations`,
      [c.tenant],
    );
    return result.rows;
  }
  async function ready() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "save",
    );
    const before = await state();
    const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(check).toMatchObject({ state: "complete", exemptReviewRequiredLines: [1] });
    expect(await state()).toEqual(before);
    return {
      saved,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: check.inputDigest,
        reviewedExemptLines: [1],
      },
    };
  }
  it("persists a separate own proposal and requires exact QA review before atomic assignment", async () => {
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing fixture line");
    Object.assign(first, {
      exemptSupplier: true,
      exemptReason: "Synthetic receipt-specific supplier declaration",
      tlc: null,
      exemptReceipt: {
        evidenceUrl: "https://supplier.example.test/declarations/2026-09",
        tlcHandling: "assign_if_missing",
        proposedTlc: "=Own/Ä-001",
      },
    });
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "save",
    );
    const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: saved.draftVersion,
    });
    expect(check).toMatchObject({ state: "complete", exemptReviewRequiredLines: [1] });
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: saved.draftVersion,
      expectedInputDigest: check.inputDigest,
    };
    const before = await state();
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "missing-review"),
    ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
    expect(await state()).toEqual(before);
    const reviewed = { ...command, reviewedExemptLines: [1] };
    const result = await store.finalize(c.tenant, c.actor, saved.id, reviewed, "reviewed");
    expect(result.snapshot).toMatchObject({
      snapshotVersion: 2,
      confirmation: { reviewedExemptLines: [1] },
      items: [
        {
          tlc: "=Own/Ä-001",
          quantity: "500.000",
          receiptBasis: {
            kind: "exempt_assigned_tlc",
            receivedTlc: null,
            reviewedBy: c.actor,
            reviewedAt: result.finalizedAt,
          },
        },
        { receiptBasis: { kind: "ordinary" } },
      ],
    });
    expect(await store.finalize(c.tenant, c.actor, saved.id, reviewed, "retry")).toEqual(result);
    const stored = await fixture.pool.query(
      "SELECT tlc,exempt_receipt FROM receiving_event_items WHERE tenant_id=$1 AND event_id=$2 AND line_no=1",
      [c.tenant, saved.id],
    );
    expect(stored.rows[0]?.tlc).toBeNull();
    expect(stored.rows[0]?.exempt_receipt).toEqual(first.exemptReceipt);
    const lots = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    const newId = result.snapshot.items[0]?.lotId;
    expect(lots).toHaveLength(2);
    expect(lots.find((l) => l.id === newId)).toMatchObject({
      tenantId: c.tenant,
      productId: c.product,
      tlc: "=Own/Ä-001",
      assignmentBasis: "exempt_supplier_receipt",
      status: "active",
      revision: 1,
      sourceLocationId: c.location,
      sourceReferenceValue: null,
      sourceLockedAt: new Date(result.finalizedAt),
      createdBy: c.actor,
      updatedBy: c.actor,
      lastSourceReason: null,
      lastStatusReason: null,
    });
    expect(lots.find((l) => l.id === c.lot)).toMatchObject({
      tenantId: c.tenant,
      assignmentBasis: "imported",
      status: "active",
      revision: 2,
      sourceLockedAt: new Date(result.finalizedAt),
    });
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    const finalizedAudits = audits.filter((a) => a.requestId === "reviewed");
    expect(finalizedAudits).toHaveLength(3);
    expect(
      finalizedAudits.find((a) => a.action === "traceability.receiving.finalized"),
    ).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      targetType: "traceability_event",
      targetId: saved.id,
      outcome: "success",
      before: saved,
      after: result,
    });
    expect(finalizedAudits.find((a) => a.action === "traceability.lot.created")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      targetType: "traceability_lot",
      targetId: newId,
      outcome: "success",
      before: null,
      after: {
        id: newId,
        eventId: saved.id,
        productId: c.product,
        tlc: "=Own/Ä-001",
        assignmentBasis: "exempt_supplier_receipt",
        status: "active",
        revision: 1,
        source: { kind: "location", locationId: c.location },
        sourceLockedAt: result.finalizedAt,
        createdBy: c.actor,
        updatedBy: c.actor,
        createdAt: result.finalizedAt,
        updatedAt: result.finalizedAt,
      },
    });
    expect(
      finalizedAudits.find((a) => a.action === "traceability.lot.source_locked"),
    ).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      targetType: "traceability_lot",
      targetId: c.lot,
      outcome: "success",
      before: { id: c.lot, assignmentBasis: "imported", revision: 1, sourceLockedAt: null },
      after: {
        id: c.lot,
        eventId: saved.id,
        assignmentBasis: "imported",
        revision: 2,
        sourceLockedAt: result.finalizedAt,
      },
    });
  });
  it.each([[], [2], [1, 2]].map((reviews) => ({ reviews })))(
    "denies the wrong review set $reviews with exact line findings and zero effects",
    async ({ reviews }) => {
      const { saved, command } = await ready();
      const before = await state();
      const expected = reviews.length === 0 ? [1] : reviews.length === 1 ? [1, 2] : [2];
      await expect(
        store.finalize(
          c.tenant,
          c.actor,
          saved.id,
          { ...command, reviewedExemptLines: reviews },
          "wrong-set",
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: "event_incomplete",
          issues: expected.map((line) => ({
            severity: "error",
            group: "lines",
            line,
            field: "exemption",
            code: "exemption_review_required",
            detail: null,
          })),
        },
      });
      expect(await state()).toEqual(before);
    },
  );
  it.each(["location", "reference", "linked"] as const)(
    "preserves a supplier TLC and its distinct physical source (%s)",
    async (kind) => {
      const [location] = await fixture.db
        .select()
        .from(schema.traceabilityLocations)
        .where(eq(schema.traceabilityLocations.id, c.location));
      if (!location) throw new Error("Missing location");
      const sourceId = randomUUID();
      await fixture.db
        .insert(schema.traceabilityLocations)
        .values({ ...location, id: sourceId, name: "Separate supplier source" });
      const first = c.draft.items[0];
      if (!first) throw new Error("Missing line");
      first.tlc = kind === "linked" ? "00001" : "=Supplier/Ä";
      first.exemptReceipt = {
        evidenceUrl: "https://例子.test/Declaration/Ä",
        tlcHandling: "preserve_existing",
        proposedTlc: null,
      };
      first.source =
        kind === "reference"
          ? {
              kind: "reference",
              referenceKind: "web_url",
              referenceValue: "HTTP://supplier.example.test/Source/Ä",
              resolvedLocationId: sourceId,
            }
          : { kind: "location", locationId: sourceId };
      if (kind === "linked") {
        first.lotLinkMode = "link_existing";
        first.lotId = c.lot;
        c.draft.items = [first];
        await fixture.pool.query(
          "UPDATE traceability_lots SET source_location_id=$1,assignment_basis='transformation' WHERE tenant_id=$2 AND id=$3",
          [sourceId, c.tenant, c.lot],
        );
      }
      const { saved, command } = await ready();
      const result = await store.finalize(c.tenant, c.actor, saved.id, command, "preserve");
      expect(result.snapshot.items[0]).toMatchObject({
        tlc: first.tlc,
        source: first.source,
        sourceDescription: { locationId: sourceId },
        receiptBasis: {
          kind: "exempt_existing_tlc",
          reason: first.exemptReason,
          evidenceUrl: first.exemptReceipt.evidenceUrl,
          reviewedBy: c.actor,
          reviewedAt: result.finalizedAt,
        },
      });
      expect(result.snapshot.locationId).toBe(c.location);
      const row = (
        await fixture.pool.query(
          "SELECT assignment_basis,status,revision,source_locked_at FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
          [c.tenant, result.snapshot.items[0]?.lotId],
        )
      ).rows[0];
      expect(row).toEqual({
        assignment_basis: kind === "linked" ? "transformation" : "imported",
        status: "active",
        revision: kind === "linked" ? 2 : 1,
        source_locked_at: new Date(result.finalizedAt),
      });
      await fixture.pool.query("UPDATE traceability_locations SET archived=true WHERE id=$1", [
        sourceId,
      ]);
      expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(result);
      expect(await store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(result);
    },
  );
  it.each(["own", "ordinary", "existing"] as const)(
    "blocks effective TLC collisions with %s identities",
    async (kind) => {
      const first = c.draft.items[0];
      if (!first) throw new Error("Missing line");
      if (kind === "existing")
        await fixture.pool.query("UPDATE traceability_lots SET tlc='=Own/Ä-001' WHERE id=$1", [
          c.lot,
        ]);
      else
        c.draft.items.push({
          ...first,
          exemptSupplier: kind === "own",
          tlc: kind === "ordinary" ? "=Own/Ä-001" : null,
        });
      const saved = await store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.draft },
        "save",
      );
      const before = await state();
      const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      expect(
        check.issues.filter((i) => i.code === "duplicate_identity").map((i) => i.line),
      ).toEqual(kind === "existing" ? [1] : [1, 3]);
      await expect(
        store.finalize(
          c.tenant,
          c.actor,
          saved.id,
          {
            operationKey: randomUUID(),
            expectedDraftVersion: 1,
            expectedInputDigest: check.inputDigest,
            reviewedExemptLines: kind === "own" ? [1, 3] : [1],
          },
          "collision",
        ),
      ).rejects.toMatchObject({ response: { code: "event_incomplete" } });
      expect(await state()).toEqual(before);
    },
  );
  it("retains inactive hidden inputs without review, own assignment or semantic normalization", async () => {
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing line");
    first.exemptSupplier = false;
    first.tlc = "SUPPLIER";
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "save",
    );
    const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(check).toMatchObject({ state: "complete", exemptReviewRequiredLines: [] });
    const result = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: check.inputDigest,
      },
      "ordinary",
    );
    expect(result.snapshot.items[0]).toMatchObject({
      tlc: "SUPPLIER",
      receiptBasis: { kind: "ordinary" },
    });
    expect(
      (
        await fixture.pool.query("SELECT tlc,assignment_basis FROM traceability_lots WHERE id=$1", [
          result.snapshot.items[0]?.lotId,
        ])
      ).rows,
    ).toEqual([{ tlc: "SUPPLIER", assignment_basis: "imported" }]);
    expect(
      (
        await fixture.pool.query(
          "SELECT exempt_receipt FROM receiving_event_items WHERE event_id=$1 AND line_no=1",
          [saved.id],
        )
      ).rows[0]?.exempt_receipt,
    ).toEqual(first.exemptReceipt);
  });
  it.each([
    {},
    { evidenceUrl: null, tlcHandling: "unknown", proposedTlc: null },
    {
      evidenceUrl: "https://u:p@example.test",
      tlcHandling: "preserve_existing",
      proposedTlc: null,
    },
    { evidenceUrl: null, tlcHandling: null, proposedTlc: null, reviewedBy: "forged" },
  ])("rejects malformed extensions without writes %j", async (extension) => {
    const before = await state();
    const draft = {
      ...c.draft,
      items: c.draft.items.map((item, index) =>
        index === 0 ? { ...item, exemptReceipt: extension } : item,
      ),
    };
    await expect(
      store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft }, "invalid"),
    ).rejects.toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });
  it("denies current QA loss, foreign tenancy, stale version/digest and rebinding after success", async () => {
    const { saved, command } = await ready();
    const before = await state();
    const foreign = await seedReceivingTenant(fixture.db);
    await expect(
      store.finalize(foreign.tenant, foreign.actor, saved.id, command, "foreign"),
    ).rejects.toMatchObject({ status: 404 });
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_operator" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "operator"),
    ).rejects.toMatchObject({ status: 403 });
    await fixture.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, { ...command, expectedDraftVersion: 2 }, "stale"),
    ).rejects.toMatchObject({ response: { code: "receiving_draft_conflict" } });
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        { ...command, expectedInputDigest: "a".repeat(64) },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "receiving_readiness_changed" } });
    expect(await state()).toEqual(before);
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "authorized");
    const after = await state();
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        { ...command, reviewedExemptLines: [] },
        "rebound",
      ),
    ).rejects.toMatchObject({ response: { code: "receiving_operation_conflict" } });
    await fixture.pool.query("UPDATE traceability_locations SET archived=true WHERE id=$1", [
      c.location,
    ]);
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "repeat")).toEqual(result);
    await fixture.db
      .update(schema.member)
      .set({ role: "traceability_operator" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "revoked-replay"),
    ).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(after);
  });
  it("rolls back the entire exempt assignment on audit failure", async () => {
    const { saved, command } = await ready();
    const before = await state();
    await fixture.pool.query(
      "CREATE FUNCTION synthetic_exempt_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.receiving.finalized' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_exempt_audit_fail BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_exempt_audit_fail()",
    );
    try {
      await expect(
        store.finalize(c.tenant, c.actor, saved.id, command, "fail"),
      ).rejects.toBeDefined();
    } finally {
      await fixture.pool.query(
        "DROP TRIGGER synthetic_exempt_audit_fail ON tenant_audit_events; DROP FUNCTION synthetic_exempt_audit_fail()",
      );
    }
    expect(await state()).toEqual(before);
    expect((await store.finalize(c.tenant, c.actor, saved.id, command, "retry")).status).toBe(
      "finalized",
    );
  });
  it("records receipt review in the generic profile without inventing FTR coverage", async () => {
    await fixture.pool.query(
      "DELETE FROM product_traceability_profiles WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    await fixture.pool.query(
      "UPDATE traceability_profiles SET code='US_GENERIC_LOT_TRACEABILITY' WHERE tenant_id=$1",
      [c.tenant],
    );
    const { saved, command } = await ready();
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "generic");
    expect(result.snapshot).toMatchObject({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      items: [
        {
          coverage: { coverageStatus: "unknown", reviewedBy: null, reviewedAt: null },
          receiptBasis: {
            kind: "exempt_assigned_tlc",
            reviewedBy: c.actor,
            reviewedAt: result.finalizedAt,
          },
        },
        { receiptBasis: { kind: "ordinary" } },
      ],
    });
    expect(result.snapshot.confirmation.warnings.map((issue) => issue.code)).toEqual([
      "not_assessed",
      "not_assessed",
    ]);
  });
  it("keeps manual lot creation forbidden for the receipt-only assignment basis", async () => {
    const before = await state();
    await expect(
      new UsLotStore(fixture.db).createLot(
        c.tenant,
        c.actor,
        {
          productId: c.product,
          tlc: "OWN",
          source: { kind: "location", locationId: c.location },
          assignmentBasis: "exempt_supplier_receipt",
        },
        "manual",
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(await state()).toEqual(before);
  });
  it.each([
    "https://example.test:99999/path",
    "https://xn--/source",
    "https://999.999.999.999/path",
  ])("fails closed on privileged invalid evidence %s", async (evidenceUrl) => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "UPDATE receiving_event_items SET exempt_receipt=jsonb_set(exempt_receipt,'{evidenceUrl}',to_jsonb($1::text)) WHERE event_id=$2 AND line_no=1",
      [evidenceUrl, saved.id],
    );
    const before = await state();
    for (const pending of [
      () => store.getDraft(c.tenant, c.actor, saved.id),
      () => store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }),
      () => store.finalize(c.tenant, c.actor, saved.id, command, "invalid-evidence"),
    ])
      await expect(pending()).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
    expect(await state()).toEqual(before);
  });
  it.each(["reviewedBy", "reviewedAt", "evidenceUrl"] as const)(
    "rejects corrupt v2 frozen %s in both record and successful-receipt readers",
    async (field) => {
      const { saved, command } = await ready();
      const result = await store.finalize(c.tenant, c.actor, saved.id, command, "finalize");
      const corrupt = structuredClone(result);
      if (corrupt.snapshot.snapshotVersion !== 2) throw new Error("Expected v2");
      const basis = corrupt.snapshot.items[0]?.receiptBasis;
      if (!basis || basis.kind === "ordinary") throw new Error("Expected exempt basis");
      basis[field] =
        field === "reviewedBy"
          ? "forged"
          : field === "reviewedAt"
            ? "2026-09-07T00:00:00.000Z"
            : "https://xn--/source";
      expect(receivingFinalizedRecordSchema.safeParse(corrupt).success).toBe(false);
      const connection = await fixture.pool.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("ALTER TABLE traceability_events DISABLE TRIGGER USER");
        await connection.query(
          "UPDATE traceability_events SET finalization_snapshot=$1 WHERE tenant_id=$2 AND id=$3",
          [corrupt.snapshot, c.tenant, saved.id],
        );
        await connection.query("ALTER TABLE traceability_events ENABLE TRIGGER USER");
        await connection.query(
          "UPDATE receiving_operations SET result=$1 WHERE tenant_id=$2 AND operation_key=$3",
          [corrupt, c.tenant, command.operationKey],
        );
        await connection.query("COMMIT");
      } finally {
        await connection.query("ROLLBACK");
        connection.release();
      }
      const before = await state();
      await expect(store.getRecord(c.tenant, c.actor, saved.id)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
      await expect(
        store.finalize(c.tenant, c.actor, saved.id, command, "replay"),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
      expect(await state()).toEqual(before);
    },
  );
});
