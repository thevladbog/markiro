import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { receivingAmendmentDraftSchema, type ReceivingDraft } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedCompleteReceiving,
  seedExemptReceiving,
  emptyReceivingItem,
} from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving revision readiness v4", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const create = (draft = c.draft) =>
    store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft }, "create");
  const check = (id: string, expectedDraftVersion = 1) =>
    store.checkRevisionReadiness(c.tenant, c.actor, id, { expectedDraftVersion });
  async function finalize(draft: ReceivingDraft = c.draft) {
    const saved = await create(draft);
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    return store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      },
      "finalize",
    );
  }
  async function start() {
    const original = await finalize();
    const started = await store.amend(
      c.tenant,
      c.actor,
      original.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        reason: "Correct receipt",
      },
      "amend",
    );
    if (started.record.content.kind !== "draft") throw new Error("Expected draft");
    return {
      original,
      started,
      draft: receivingAmendmentDraftSchema.parse(started.record.content.draft),
    };
  }
  const save = (id: string, draft: ReturnType<typeof receivingAmendmentDraftSchema.parse>) =>
    store.saveAmendment(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        draft,
      },
      "save",
    );
  async function state() {
    return (
      await f.pool.query(
        `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [c.tenant],
      )
    ).rows;
  }
  it("checks an original revision without switching its legacy readiness or writing state", async () => {
    const saved = await create(),
      before = await state();
    const v3 = await store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 });
    const ready = await check(saved.id);
    expect(ready).toMatchObject({
      eventId: saved.id,
      draftVersion: 1,
      rootId: saved.id,
      previousRevisionId: null,
      expectedLifecycleVersion: 1,
      ruleVersion: "receiving-readiness-v4",
      state: "complete",
      exemptReviewRequiredLines: [],
    });
    expect(ready.issues).toEqual(v3.issues);
    expect(ready.inputDigest).not.toBe(v3.inputDigest);
    expect((await check(saved.id)).inputDigest).toBe(ready.inputDigest);
    expect(
      (await store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }))
        .inputDigest,
    ).toBe(v3.inputDigest);
    expect(await state()).toEqual(before);
  });
  it("recognizes bound create and linked lines without false duplicate or new-lot errors", async () => {
    const { original, started } = await start(),
      before = await state();
    const ready = await check(started.eventId);
    expect(ready).toMatchObject({
      eventId: started.eventId,
      draftVersion: 1,
      rootId: original.id,
      previousRevisionId: original.id,
      expectedLifecycleVersion: 3,
      ruleVersion: "receiving-readiness-v4",
      state: "complete",
      issues: [],
      exemptReviewRequiredLines: [],
    });
    expect((await check(started.eventId)).inputDigest).toBe(ready.inputDigest);
    expect(await state()).toEqual(before);
  });
  it.each(["consumed", "shipped", "quarantined", "recalled", "archived"] as const)(
    "checks retained %s lots without mutating them",
    async (status) => {
      const { started } = await start();
      const ready = await check(started.eventId);
      await f.db
        .update(schema.traceabilityLots)
        .set({ status })
        .where(eq(schema.traceabilityLots.id, c.lot));
      const before = await state(),
        changed = await check(started.eventId);
      expect(changed.state).toBe("complete");
      expect(changed.inputDigest).not.toBe(ready.inputDigest);
      expect(await state()).toEqual(before);
    },
  );
  it("requires fresh review for retained own assignments at their original source after a header correction", async () => {
    c = await seedExemptReceiving(f.db);
    const { started, draft } = await start();
    const newLocation = randomUUID();
    const [location] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!location) throw new Error("Missing location");
    await f.db.insert(schema.traceabilityLocations).values({ ...location, id: newLocation });
    draft.locationId = newLocation;
    await save(started.eventId, draft);
    const before = await state();
    expect(await check(started.eventId, 2)).toMatchObject({
      state: "complete",
      exemptReviewRequiredLines: [1],
    });
    expect(await state()).toEqual(before);
  });
  it("keeps active-only and duplicate-identity rules for newly added unbound lines", async () => {
    const { started, draft } = await start();
    const linked = draft.items[1],
      created = draft.items[0];
    if (!linked || !created) throw new Error("Missing lines");
    draft.items.push(
      { ...linked, previousLineNo: null },
      { ...created, previousLineNo: null, lotId: null },
    );
    await save(started.eventId, draft);
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "archived" })
      .where(eq(schema.traceabilityLots.id, c.lot));
    const ready = await check(started.eventId, 2);
    expect(ready.state).toBe("blocked");
    expect(ready.issues.filter((i) => i.field === "lot")).toEqual([
      { severity: "error", group: "lines", line: 3, field: "lot", code: "inactive", detail: null },
      {
        severity: "error",
        group: "lines",
        line: 4,
        field: "lot",
        code: "duplicate_identity",
        detail: null,
      },
    ]);
  });
  it("reports incomplete saved corrections instead of trusting the predecessor's old check", async () => {
    const { started, draft } = await start();
    draft.items.push({ ...emptyReceivingItem, previousLineNo: null });
    draft.documentIds = [];
    await save(started.eventId, draft);
    const ready = await check(started.eventId, 2);
    expect(ready.state).toBe("blocked");
    expect(ready.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "lines", line: 3, field: "product", code: "required" }),
        expect.objectContaining({ group: "documents", code: "required" }),
      ]),
    );
  });
  it("binds all prior lot tokens, even when that predecessor line was removed", async () => {
    const { started, draft } = await start();
    draft.items = draft.items.filter((i) => i.lotId !== c.lot);
    await save(started.eventId, draft);
    const before = await check(started.eventId, 2);
    const linked = c.draft.items[1];
    if (!linked) throw new Error("Missing linked line");
    const second = await finalize({ ...c.draft, items: [linked] });
    const after = await check(started.eventId, 2);
    expect(after.state).toBe("complete");
    expect(after.inputDigest).not.toBe(before.inputDigest);
    expect(after.draftVersion).toBe(before.draftVersion);
    expect(after.expectedLifecycleVersion).toBe(before.expectedLifecycleVersion);
    await store.void(
      c.tenant,
      c.actor,
      second.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 2,
        expectedDraftVersion: null,
        reason: "Duplicate receipt",
      },
      "void-second",
    );
    const restoredCount = await check(started.eventId, 2);
    expect(restoredCount.inputDigest).not.toBe(before.inputDigest);
    expect(restoredCount.inputDigest).not.toBe(after.inputDigest);
  });
  it.each(["product", "location", "party", "document"] as const)(
    "rechecks current %s activity and includes it in the digest",
    async (kind) => {
      const { started } = await start(),
        ready = await check(started.eventId);
      if (kind === "product")
        await f.db
          .update(schema.products)
          .set({ archived: true })
          .where(eq(schema.products.id, c.product));
      if (kind === "location")
        await f.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, c.location));
      if (kind === "party")
        await f.db
          .update(schema.traceabilityParties)
          .set({ archived: true })
          .where(eq(schema.traceabilityParties.id, c.party));
      if (kind === "document")
        await f.db
          .update(schema.referenceDocuments)
          .set({ archivedAt: new Date() })
          .where(eq(schema.referenceDocuments.id, c.document));
      const after = await check(started.eventId);
      expect(after.state).toBe("blocked");
      expect(after.issues.some((i) => i.code === "inactive")).toBe(true);
      expect(after.inputDigest).not.toBe(ready.inputDigest);
    },
  );
  it("requires current read access, not QA, and refuses revoked membership and foreign targets", async () => {
    const { started } = await start();
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    expect((await check(started.eventId)).state).toBe("complete");
    const foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: foreign.draft },
      "foreign",
    );
    for (const id of [other.id, randomUUID()])
      await expect(check(id)).rejects.toMatchObject({ status: 404 });
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(check(started.eventId)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects strict query changes, stale saved versions and terminal revisions", async () => {
    const { original, started } = await start();
    for (const query of [
      {},
      { expectedDraftVersion: "01" },
      { expectedDraftVersion: 1, expectedLifecycleVersion: 3 },
      { expectedDraftVersion: [1, 1] },
    ])
      await expect(
        store.checkRevisionReadiness(c.tenant, c.actor, started.eventId, query),
      ).rejects.toMatchObject({ status: 400 });
    await expect(check(started.eventId, 2)).rejects.toMatchObject({
      status: 409,
      response: { code: "receiving_draft_conflict" },
    });
    await expect(check(original.id)).rejects.toMatchObject({
      status: 409,
      response: { code: "receiving_lifecycle_conflict" },
    });
    await store.void(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancelled",
      },
      "cancel",
    );
    await expect(check(started.eventId)).rejects.toMatchObject({
      status: 409,
      response: { code: "receiving_lifecycle_conflict" },
    });
  });
  it("fails closed on unsupported persisted CTEs even when the checked draft has no lots", async () => {
    const saved = await create({ ...c.draft, items: [] });
    const unknown = await create();
    const constraint = (
      await f.pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='traceability_events'::regclass AND conname='traceability_events_lifecycle_valid'",
      )
    ).rows[0]?.definition;
    if (!constraint) throw new Error("Missing synthetic constraint");
    const connection = await f.pool.connect();
    try {
      await connection.query(
        "BEGIN; SET LOCAL session_replication_role='replica'; ALTER TABLE traceability_events DROP CONSTRAINT traceability_events_lifecycle_valid",
      );
      await connection.query(
        "UPDATE traceability_events SET type='shipping' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, unknown.id],
      );
      await connection.query("COMMIT");
      const before = await state();
      await expect(check(saved.id)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_database_unavailable" },
      });
      expect(await state()).toEqual(before);
    } finally {
      await connection.query("BEGIN; SET LOCAL session_replication_role='replica'");
      await connection.query(
        "UPDATE traceability_events SET type='receiving' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, unknown.id],
      );
      await connection.query(
        `ALTER TABLE traceability_events ADD CONSTRAINT traceability_events_lifecycle_valid ${constraint}`,
      );
      await connection.query("COMMIT");
      connection.release();
    }
  });
  it("does not ignore a missing predecessor lot merely because its line was removed", async () => {
    const { started, draft } = await start();
    draft.items = draft.items.filter((i) => i.lotId !== c.lot);
    await save(started.eventId, draft);
    const connection = await f.pool.connect();
    try {
      // Corrupt, FK-bypassed storage is confined to this owned synthetic DB.
      await connection.query("BEGIN; SET LOCAL session_replication_role='replica'");
      await connection.query("DELETE FROM traceability_lots WHERE tenant_id=$1 AND id=$2", [
        c.tenant,
        c.lot,
      ]);
      await connection.query("COMMIT");
    } finally {
      connection.release();
    }
    const before = await state();
    await expect(check(started.eventId, 2)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    expect(await state()).toEqual(before);
  });
  it("checks all one hundred bindings without treating repeated lot lines as repeated support", async () => {
    const linked = c.draft.items[1];
    if (!linked) throw new Error("Missing linked line");
    c.draft.items = Array.from({ length: 100 }, (_, index) => ({
      ...linked,
      quantity: String(index + 1),
    }));
    const { started, draft } = await start();
    draft.items.reverse();
    await save(started.eventId, draft);
    const before = await state();
    expect(await check(started.eventId, 2)).toMatchObject({ state: "complete", issues: [] });
    expect((await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).supportCount).toBe(1);
    expect(await state()).toEqual(before);
  });
  it("requires fresh review for a preserved exempt TLC and does not inherit old evidence validity", async () => {
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing line");
    first.exemptSupplier = true;
    first.exemptReason = "Supplier declaration";
    first.exemptReceipt = {
      tlcHandling: "preserve_existing",
      proposedTlc: null,
      evidenceUrl: "https://supplier.example.test/declared",
    };
    const { started, draft } = await start();
    expect(await check(started.eventId)).toMatchObject({
      state: "complete",
      exemptReviewRequiredLines: [1],
    });
    const line = draft.items[0];
    if (!line?.exemptReceipt) throw new Error("Missing receipt details");
    line.exemptReceipt.evidenceUrl = null;
    await save(started.eventId, draft);
    const ready = await check(started.eventId, 2);
    expect(ready).toMatchObject({ state: "blocked", exemptReviewRequiredLines: [1] });
    expect(ready.issues).toContainEqual({
      severity: "error",
      group: "lines",
      line: 1,
      field: "exemption",
      code: "required",
      detail: "evidenceUrl",
    });
  });
  it("binds current profile and coverage changes without claiming generic FTR applicability", async () => {
    const { started } = await start(),
      ready = await check(started.eventId);
    await f.db
      .delete(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.tenantId, c.tenant));
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    const generic = await check(started.eventId);
    expect(generic).toMatchObject({
      state: "complete",
      profileCode: "US_GENERIC_LOT_TRACEABILITY",
    });
    expect(generic.issues).toContainEqual({
      severity: "warning",
      group: "lines",
      line: 1,
      field: "coverage",
      code: "not_assessed",
      detail: null,
    });
    expect(generic.inputDigest).not.toBe(ready.inputDigest);
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(check(started.eventId)).rejects.toMatchObject({
      status: 503,
      response: { code: "traceability_profile_invalid" },
    });
  });
});
