import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedReceivingTenant } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("ordinary receiving finalization", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(fixture.db);
  });
  async function ready() {
    const createInput = { operationKey: randomUUID(), draft: c.draft };
    const saved = await store.createDraft(c.tenant, c.actor, createInput, "save");
    const readiness = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(readiness.state).toBe("complete");
    return {
      saved,
      createInput,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: readiness.inputDigest,
      },
    };
  }
  it("atomically creates and links exact lots, freezes history and replays once with exact audits", async () => {
    const { saved, createInput, command } = await ready();
    expect(typeof store.finalize).toBe("function");
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "confirm");
    expect(result).toMatchObject({
      id: saved.id,
      status: "finalized",
      draftVersion: 1,
      revision: 1,
      finalizedBy: c.actor,
      snapshot: {
        items: [
          { tlc: "000NEW", quantity: "500.000", lotLinkMode: "create_on_finalize" },
          { tlc: "00001", quantity: "0.250", lotId: c.lot, lotLinkMode: "link_existing" },
        ],
        documents: [{ document: { number: "00001" }, issuer: { name: "Synthetic supplier" } }],
      },
    });
    const lots = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    expect(lots).toHaveLength(2);
    expect(lots.find((l) => l.id === c.lot)).toMatchObject({
      revision: 2,
      sourceLockedAt: new Date(result.finalizedAt),
      lastStatusReason: null,
      lastSourceReason: null,
    });
    expect(lots.find((l) => l.id !== c.lot)).toMatchObject({
      revision: 1,
      assignmentBasis: "imported",
      status: "active",
      sourceLockedAt: new Date(result.finalizedAt),
    });
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    expect(audits.filter((a) => a.requestId === "confirm")).toHaveLength(3);
    expect(audits.find((a) => a.action === "traceability.receiving.finalized")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      targetType: "traceability_event",
      targetId: saved.id,
      outcome: "success",
      requestId: "confirm",
      before: saved,
      after: result,
    });
    expect(audits.find((a) => a.action === "traceability.lot.source_locked")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      targetType: "traceability_lot",
      targetId: c.lot,
      outcome: "success",
      requestId: "confirm",
      before: { sourceLockedAt: null, revision: 1 },
      after: { eventId: saved.id, revision: 2, sourceLockedAt: result.finalizedAt },
    });
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed", archived: true })
      .where(eq(schema.traceabilityLocations.id, c.location));
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "retry")).toEqual(result);
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(result);
    expect(await store.createDraft(c.tenant, c.actor, createInput, "late-create")).toEqual(saved);
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
    ).toEqual(audits);
    expect((await store.listRecords(c.tenant, c.actor, {})).items).toMatchObject([
      { id: saved.id, status: "finalized" },
    ]);
    expect((await store.listRecords(c.tenant, c.actor, { status: "draft" })).items).toEqual([]);
    expect((await store.listDrafts(c.tenant, c.actor, {})).items).toEqual([]);
    for (const action of [
      () => store.getDraft(c.tenant, c.actor, saved.id),
      () => store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }),
      () =>
        store.saveDraft(
          c.tenant,
          c.actor,
          saved.id,
          { operationKey: randomUUID(), expectedDraftVersion: 1, draft: c.draft },
          "save",
        ),
      () =>
        store.finalize(
          c.tenant,
          c.actor,
          saved.id,
          { ...command, operationKey: randomUUID() },
          "new",
        ),
    ])
      await expect(action()).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_already_finalized" },
      });
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        { ...command, expectedDraftVersion: 2 },
        "rebound",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    await fixture.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("checks current QA, tenant, version, blockers and digest before effects", async () => {
    const { saved, command } = await ready();
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
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Current supplier" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "changed"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_readiness_changed" } });
    await fixture.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, c.product));
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "blocked"),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: "event_incomplete", issues: expect.any(Array) },
    });
    expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
    ).toHaveLength(1);
  });
  it("rolls back all lots, links, latches, header and receipt if audit fails", async () => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "CREATE FUNCTION synthetic_fail_receiving_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.receiving.finalized' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_fail_receiving_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_fail_receiving_audit()",
    );
    try {
      await expect(
        store.finalize(c.tenant, c.actor, saved.id, command, "fail"),
      ).rejects.toBeDefined();
    } finally {
      await fixture.pool.query(
        "DROP TRIGGER synthetic_fail_receiving_audit ON tenant_audit_events; DROP FUNCTION synthetic_fail_receiving_audit()",
      );
    }
    expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
    ).toMatchObject([{ id: c.lot, revision: 1, sourceLockedAt: null }]);
    expect(
      await fixture.db
        .select()
        .from(schema.receivingOperations)
        .where(eq(schema.receivingOperations.tenantId, c.tenant)),
    ).toHaveLength(1);
    expect((await store.finalize(c.tenant, c.actor, saved.id, command, "retry")).status).toBe(
      "finalized",
    );
  });
  it("guards raw finalized headers, children, moves and delete", async () => {
    const { saved, command } = await ready();
    await store.finalize(c.tenant, c.actor, saved.id, command, "confirm");
    const other = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "other",
    );
    for (const query of [
      "UPDATE traceability_events SET notes='tampered' WHERE id=$1",
      "DELETE FROM traceability_events WHERE id=$1",
      "UPDATE receiving_event_items SET quantity='2' WHERE event_id=$1",
      "DELETE FROM receiving_event_items WHERE event_id=$1",
      "UPDATE receiving_event_documents SET position=2 WHERE event_id=$1",
      "DELETE FROM receiving_event_documents WHERE event_id=$1",
    ])
      await expect(fixture.pool.query(query, [saved.id])).rejects.toMatchObject({ code: "23514" });
    for (const table of ["receiving_event_items", "receiving_event_documents"])
      for (const [from, to] of [
        [saved.id, other.id],
        [other.id, saved.id],
      ])
        await expect(
          fixture.pool.query(`UPDATE ${table} SET event_id=$1 WHERE event_id=$2`, [to, from]),
        ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier) VALUES ($1,$2,3,'create_on_finalize',false)",
        [c.tenant, saved.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("preserves an inactive exemption reason after the supplier flag is cleared", async () => {
    const line = c.draft.items[0];
    if (!line) throw new Error("Missing synthetic line");
    line.exemptReason = "Earlier draft supplier note";
    const { saved, command } = await ready();
    expect((await store.finalize(c.tenant, c.actor, saved.id, command, "ordinary")).status).toBe(
      "finalized",
    );
    const rows = await fixture.db
      .select()
      .from(schema.receivingEventItems)
      .where(eq(schema.receivingEventItems.eventId, saved.id));
    expect(rows.find((row) => row.lineNo === 1)).toMatchObject({
      exemptSupplier: false,
      exemptReason: "Earlier draft supplier note",
    });
  });
  it("keeps already latched lots byte-for-byte and retains historical save receipts", async () => {
    const lockedAt = new Date("2026-09-01T00:00:00.000Z");
    await fixture.db
      .update(schema.traceabilityLots)
      .set({
        sourceLockedAt: lockedAt,
        revision: 7,
        lastStatusReason: "Historical status",
        lastSourceReason: "Historical correction",
      })
      .where(eq(schema.traceabilityLots.id, c.lot));
    const { saved } = await ready();
    const saveInput = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      draft: { ...c.draft, notes: "Saved before finalization" },
    };
    const savedAgain = await store.saveDraft(c.tenant, c.actor, saved.id, saveInput, "save-again");
    const before = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.id, c.lot));
    const check = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 2,
    });
    await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedInputDigest: check.inputDigest,
      },
      "confirm",
    );
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.id, c.lot)),
    ).toEqual(before);
    expect(await store.saveDraft(c.tenant, c.actor, saved.id, saveInput, "late-save")).toEqual(
      savedAgain,
    );
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, c.lot));
    expect(audits).toEqual([]);
  });
  it("blocks exempt suppliers without creating lots or receipts", async () => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "UPDATE receiving_event_items SET exempt_supplier=true,exempt_reason='Pending exemption' WHERE event_id=$1 AND line_no=1",
      [saved.id],
    );
    await expect(
      store.finalize(c.tenant, c.actor, saved.id, command, "exempt"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "event_incomplete",
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "required", detail: "evidenceUrl" }),
        ]),
      },
    });
    expect(
      await fixture.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
    ).toHaveLength(1);
  });
  it("fails closed on corrupt frozen history without rebuilding it from live references", async () => {
    const { saved, command } = await ready();
    await store.finalize(c.tenant, c.actor, saved.id, command, "confirm");
    await fixture.pool.query(
      "ALTER TABLE traceability_events DISABLE TRIGGER receiving_header_finalization_guard",
    );
    try {
      await fixture.pool.query(
        "UPDATE traceability_events SET finalization_snapshot=finalization_snapshot || '{\"forged\":true}'::jsonb WHERE id=$1",
        [saved.id],
      );
    } finally {
      await fixture.pool.query(
        "ALTER TABLE traceability_events ENABLE TRIGGER receiving_header_finalization_guard",
      );
    }
    await expect(store.getRecord(c.tenant, c.actor, saved.id)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
  });
  it("rejects raw transitions with contradictory or incomplete frozen document data", async () => {
    const { saved, command } = await ready();
    const finalized = await store.finalize(c.tenant, c.actor, saved.id, command, "confirm");
    const next = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "next",
    );
    for (const line of finalized.snapshot.items)
      await fixture.pool.query(
        "UPDATE receiving_event_items SET lot_id=$1 WHERE event_id=$2 AND line_no=$3",
        [line.lotId, next.id, line.lineNo],
      );
    for (const change of ["number", "issuer", "product"]) {
      const snapshot = structuredClone(finalized.snapshot);
      const doc = snapshot.documents[0],
        line = snapshot.items[0];
      if (!doc || !line) throw new Error("Missing synthetic snapshot");
      if (change === "number") doc.document.number = "FORGED";
      if (change === "issuer" && doc.issuer) doc.issuer.name = "FORGED";
      if (change === "product") line.productDescription.productName = "FORGED";
      await expect(
        fixture.pool.query(
          "UPDATE traceability_events SET status='finalized',finalized_at=$1,updated_at=$1,finalized_by=$2,updated_by=$2,finalization_snapshot=$3 WHERE id=$4",
          [new Date(), c.actor, snapshot, next.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it("freezes exact reference sources and coordinate and package snapshots under the same locks", async () => {
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({
        addressKind: "coordinates",
        streetAddress: null,
        latitude: "41.123456",
        longitude: "-87.654321",
      })
      .where(eq(schema.traceabilityLocations.id, c.location));
    await fixture.db
      .update(schema.productTraceabilityProfiles)
      .set({
        packagingSizeValue: "12.500",
        packagingSizeUom: "lb",
        brandName: "Synthetic Brand",
      })
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    const line = c.draft.items[0];
    if (!line) throw new Error("Missing synthetic line");
    line.source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/Exact/Case?batch=0001",
      resolvedLocationId: c.location,
    };
    const { saved, command } = await ready();
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "reference");
    expect(result.snapshot.items[0]).toMatchObject({
      source: line.source,
      productDescription: {
        packagingSize: { value: "12.500", uom: "lb" },
        brandName: "Synthetic Brand",
      },
      sourceDescription: {
        address: { kind: "coordinates", latitude: "41.123456", longitude: "-87.654321" },
      },
    });
    const lotId = result.snapshot.items[0]?.lotId;
    const lots = await fixture.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    expect(lots.find((row) => row.id === lotId)).toMatchObject({
      sourceLocationId: null,
      sourceReferenceKind: "web_url",
      sourceReferenceValue: "https://supplier.example.test/Exact/Case?batch=0001",
      sourceReferenceLocationId: c.location,
    });
    const audit = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "reference"));
    expect(audit.find((row) => row.action === "traceability.lot.created")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.lot.created",
      outcome: "success",
      targetType: "traceability_lot",
      targetId: lotId,
      requestId: "reference",
      before: null,
      after: {
        id: lotId,
        productId: c.product,
        tlc: "000NEW",
        source: line.source,
        sourceLockedAt: result.finalizedAt,
        assignmentBasis: "imported",
        status: "active",
        revision: 1,
        createdBy: c.actor,
        updatedBy: c.actor,
        createdAt: result.finalizedAt,
        updatedAt: result.finalizedAt,
        eventId: saved.id,
      },
    });
  });
  it("finalizes generic unknown coverage and absent documents with frozen warnings", async () => {
    await fixture.db
      .delete(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    c.draft.documentIds = [];
    const { saved, command } = await ready();
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "generic");
    expect(result.snapshot).toMatchObject({
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
      documents: [],
      items: [
        { coverage: { coverageStatus: "unknown", reviewedAt: null, reviewedBy: null } },
        { coverage: { coverageStatus: "unknown", reviewedAt: null, reviewedBy: null } },
      ],
      confirmation: {
        warnings: expect.arrayContaining([
          expect.objectContaining({ severity: "warning", code: "not_assessed" }),
          expect.objectContaining({ severity: "warning", field: "documents" }),
        ]),
      },
    });
  });
});
