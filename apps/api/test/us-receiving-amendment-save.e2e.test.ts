import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  receivingAmendmentDraftSchema,
  type ReceivingAmendmentDraft,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedCompleteReceiving,
  seedExemptReceiving,
  emptyReceivingItem,
} from "./support/us-receiving-fixture";
import { finalizeStoredAmendment } from "./support/us-receiving-lifecycle-storage";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving amendment save", () => {
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

  async function start() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "create",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
    const original = await store.finalize(
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
    const started = await store.amend(
      c.tenant,
      c.actor,
      saved.id,
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
  const input = (draft: ReceivingAmendmentDraft, version = 1) => ({
    commandVersion: 2,
    operationKey: randomUUID(),
    expectedLifecycleVersion: 3,
    expectedDraftVersion: version,
    draft,
  });
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
    ).rows[0];
  }
  it("saves corrections and reordering with exact retained lots, unchanged basis/root and a full audit", async () => {
    const { original, started, draft } = await start();
    const before = await state();
    draft.notes = "Recount checked";
    draft.items.reverse();
    const first = draft.items[0];
    if (!first) throw new Error("Missing line");
    first.quantity = "0.25";
    const command = input(draft);
    const receipt = await store.saveAmendment(
      c.tenant,
      c.actor,
      started.eventId,
      command,
      "save-request",
    );
    expect(receipt).toMatchObject({
      receiptVersion: 2,
      command: "receiving.save",
      operationKey: command.operationKey,
      eventId: started.eventId,
      record: {
        revision: 2,
        draftVersion: 2,
        updatedBy: c.actor,
        lifecycle: started.record.lifecycle,
        content: { kind: "draft", draft },
      },
    });
    expect(receipt.record.id).toBe(started.eventId);
    expect(receipt.record.eventNumber).toBe(original.eventNumber);
    const after = await state();
    expect(after?.lots).toEqual(before?.lots);
    expect(after?.roots).toEqual(before?.roots);
    expect((await store.getLiveRecord(c.tenant, c.actor, original.id)).content).toEqual({
      kind: "finalized",
      finalizedAt: original.finalizedAt,
      finalizedBy: original.finalizedBy,
      snapshot: original.snapshot,
    });
    expect(
      (
        await f.pool.query(
          "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.draft_saved'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.draft_saved",
        outcome: "success",
        target_type: "traceability_event",
        target_id: started.eventId,
        before: started.record,
        after: receipt.record,
        request_id: "save-request",
      },
    ]);
    expect(
      (
        await f.pool.query(
          "SELECT event_id,result FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.save' AND operation_key=$2",
          [c.tenant, command.operationKey],
        )
      ).rows,
    ).toEqual([{ event_id: started.eventId, result: receipt }]);
    expect(await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "retry")).toEqual(
      receipt,
    );
    expect(await state()).toEqual(after);
  });
  it("remembers unchanged saves without updating timestamps, versions, audit or lots", async () => {
    const { started, draft } = await start();
    const before = await state();
    const command = input(draft);
    const receipt = await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "no-op");
    expect(receipt.record).toEqual(started.record);
    const after = await state();
    expect({ ...after, receipts: null }).toEqual({ ...before, receipts: null });
    expect(await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "retry")).toEqual(
      receipt,
    );
    expect(await state()).toEqual(after);
  });
  const lockedChanges: [string, Partial<ReceivingAmendmentDraft["items"][number]>, string[]][] = [
    ["lot", { lotId: randomUUID() }, ["lotId"]],
    ["product", { productId: randomUUID() }, ["productId"]],
    ["exact TLC", { tlc: "000new" }, ["tlc"]],
    ["source", { source: { kind: "location", locationId: randomUUID() } }, ["source"]],
    ["original mode", { lotLinkMode: "link_existing" }, ["lotLinkMode"]],
    ["receipt handling", { exemptSupplier: true }, ["receiptHandling"]],
    ["unknown predecessor line", { previousLineNo: 100 }, ["previousLineNo"]],
    ["multiple fields", { lotId: null, productId: null, tlc: null }, ["lotId", "productId", "tlc"]],
  ];
  it.each(lockedChanges)(
    "rejects retained %s disagreement before any write",
    async (_label, change, fields) => {
      const { started, draft } = await start();
      Object.assign(draft.items[0] ?? {}, change);
      const before = await state();
      await expect(
        store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft), "invalid"),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "lot_identity_locked", lines: [{ lineNo: 1, fields }] },
      });
      expect(await state()).toEqual(before);
    },
  );
  it("permits removed and incomplete new lines without deleting old lots or changing support", async () => {
    const { started, draft } = await start();
    draft.items = [{ ...emptyReceivingItem, previousLineNo: null }];
    draft.documentIds = [];
    const before = await state();
    const saved = await store.saveAmendment(
      c.tenant,
      c.actor,
      started.eventId,
      input(draft),
      "save",
    );
    expect(saved.record.content).toEqual({
      kind: "draft",
      draft: { ...draft, items: draft.items.map((i) => ({ ...i, exemptReceipt: null })) },
    });
    expect((await state())?.lots).toEqual(before?.lots);
    expect((await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).supportCount).toBe(1);
  });
  it.each(["consumed", "shipped", "quarantined", "recalled", "archived"] as const)(
    "allows retained %s lots but not an added use of that same lot",
    async (status) => {
      const { started, draft } = await start();
      await f.db
        .update(schema.traceabilityLots)
        .set({ status })
        .where(eq(schema.traceabilityLots.id, c.lot));
      draft.notes = "Documentation corrected";
      const saved = await store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        input(draft),
        "save",
      );
      expect(saved.record.draftVersion).toBe(2);
      const linked = draft.items[1];
      if (!linked) throw new Error("Missing linked line");
      draft.items.push({ ...linked, previousLineNo: null });
      const before = await state();
      await expect(
        store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft, 2), "new-use"),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_reference_inactive" } });
      expect(await state()).toEqual(before);
    },
  );
  it("keeps own assignment and its old source when the receipt location and evidence are corrected", async () => {
    c = await seedExemptReceiving(f.db);
    const { started, draft } = await start();
    const other = await seedCompleteReceiving(f.db);
    const location = randomUUID();
    const [row] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, other.location));
    if (!row) throw new Error("Missing location");
    await f.db
      .insert(schema.traceabilityLocations)
      .values({ ...row, id: location, tenantId: c.tenant, partyId: c.party });
    draft.locationId = location;
    const line = draft.items[0];
    if (!line?.exemptReceipt) throw new Error("Missing exempt line");
    line.exemptReason = "Corrected declaration";
    line.exemptReceipt.evidenceUrl = "https://supplier.example.test/correction";
    const before = await state();
    const saved = await store.saveAmendment(
      c.tenant,
      c.actor,
      started.eventId,
      input(draft),
      "save",
    );
    expect(saved.record.content).toEqual({ kind: "draft", draft });
    expect(line.tlc).toBeNull();
    expect(line.source).toEqual({ kind: "location", locationId: c.location });
    expect((await state())?.lots).toEqual(before?.lots);
    line.exemptReceipt.proposedTlc = "replacement";
    await expect(
      store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft, 2), "replace"),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "lot_identity_locked",
        lines: [{ lineNo: 1, fields: ["receiptHandling"] }],
      },
    });
  });
  it("replays a historical save after cancellation, but rechecks QA before replay", async () => {
    const { started, draft } = await start();
    draft.notes = "Corrected";
    const command = input(draft);
    const receipt = await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
    await store.void(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 2,
        reason: "Cancel correction",
      },
      "void",
    );
    const before = await state();
    expect(await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "retry")).toEqual(
      receipt,
    );
    expect((await store.getLiveRecord(c.tenant, c.actor, started.eventId)).status).toBe("void");
    expect(await state()).toEqual(before);
    await f.db
      .update(schema.member)
      .set({ role: "operator" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.saveAmendment(c.tenant, c.actor, started.eventId, command, "revoked"),
    ).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(before);
  });
  it.each([
    "traceability_receiving",
    "traceability_auditor",
    "traceability_shipping",
    "traceability_production",
    "manager",
  ])("requires current QA for first execution and replay by %s", async (role) => {
    const { started, draft } = await start();
    draft.notes = "Corrected";
    const command = input(draft);
    await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
    await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
    const before = await state();
    for (const value of [command, input(draft, 2)])
      await expect(
        store.saveAmendment(c.tenant, c.actor, started.eventId, value, "denied"),
      ).rejects.toMatchObject({ status: 403, response: { code: "insufficient_permission" } });
    expect(await state()).toEqual(before);
  });
  it("records a different current QA actor without replacing the revision creator", async () => {
    const { started, draft } = await start(),
      qa = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: qa, name: "Synthetic QA", email: `${qa}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      userId: qa,
      organizationId: c.tenant,
      role: "traceability_qa",
      createdAt: new Date(),
    });
    draft.notes = "QA correction";
    const saved = await store.saveAmendment(c.tenant, qa, started.eventId, input(draft), "qa-save");
    expect(saved.record).toMatchObject({ createdBy: c.actor, updatedBy: qa });
    expect(
      (
        await f.pool.query(
          "SELECT actor_user_id,target_id,outcome,before,after FROM tenant_audit_events WHERE organization_id=$1 AND request_id='qa-save'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([
      {
        actor_user_id: qa,
        target_id: started.eventId,
        outcome: "success",
        before: started.record,
        after: saved.record,
      },
    ]);
  });
  it("rejects stale draft/root versions and never turns an original or cancelled revision into an amendment", async () => {
    const { original, started, draft } = await start();
    draft.notes = "Corrected";
    const before = await state();
    await expect(
      store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft, 2), "stale-draft"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_draft_conflict" } });
    await expect(
      store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        { ...input(draft), expectedLifecycleVersion: 2 },
        "stale-root",
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "receiving_lifecycle_conflict",
        rootId: original.id,
        lifecycleVersion: 3,
        currentEventId: original.id,
        pendingDraftId: started.eventId,
      },
    });
    await expect(
      store.saveAmendment(c.tenant, c.actor, original.id, input(draft), "original"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
    expect(await state()).toEqual(before);
    await store.void(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel",
      },
      "cancel",
    );
    const cancelled = await state();
    await expect(
      store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        { ...input(draft), expectedLifecycleVersion: 4 },
        "resurrect",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
    expect(await state()).toEqual(cancelled);
  });
  it("binds operation keys to exact targets, draft content and expected versions", async () => {
    const { started, draft } = await start();
    const command = input({ ...draft, notes: "Corrected" });
    await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
    const before = await state();
    for (const [target, value] of [
      [randomUUID(), command],
      [started.eventId, { ...command, expectedDraftVersion: 2 }],
      [started.eventId, { ...command, expectedLifecycleVersion: 4 }],
      [started.eventId, { ...command, draft: { ...command.draft, notes: "Another correction" } }],
    ] as const)
      await expect(
        store.saveAmendment(c.tenant, c.actor, target, value, "changed"),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    expect(await state()).toEqual(before);
  });
  it("denies missing/cross-tenant targets and references without leaking identity", async () => {
    const { started, draft } = await start(),
      foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: foreign.draft },
      "foreign",
    );
    const before = await state();
    for (const id of [randomUUID(), other.id])
      await expect(
        store.saveAmendment(c.tenant, c.actor, id, input(draft), "foreign-target"),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
    const first = draft.items[0];
    if (!first) throw new Error("Missing line");
    for (const next of [
      { ...draft, locationId: foreign.location },
      { ...draft, documentIds: [foreign.document] },
      {
        ...draft,
        items: [
          ...draft.items,
          { ...first, previousLineNo: null, lotId: foreign.lot, lotLinkMode: "link_existing" },
        ],
      },
      {
        ...draft,
        items: [
          ...draft.items,
          { ...first, previousLineNo: null, productId: foreign.product, lotId: null },
        ],
      },
    ])
      await expect(
        store.saveAmendment(
          c.tenant,
          c.actor,
          started.eventId,
          { ...input(draft), draft: next },
          "foreign-reference",
        ),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_reference_not_found" } });
    expect(await state()).toEqual(before);
  });
  it("rejects malformed/duplicate bindings and cannot activate the versioned save through the legacy path", async () => {
    const { started, draft } = await start();
    const before = await state();
    const first = draft.items[0];
    if (!first) throw new Error("Missing line");
    for (const patch of [
      { commandVersion: 1 },
      { expectedDraftVersion: 0 },
      { expectedLifecycleVersion: null },
      { extra: true },
      { reason: "Changed reason" },
      { operationKey: "bad" },
      { draft: { ...draft, items: [first, first] } },
      { draft: { ...draft, items: [{ ...first, previousLineNo: undefined }] } },
    ])
      await expect(
        store.saveAmendment(
          c.tenant,
          c.actor,
          started.eventId,
          { ...input(draft), ...patch },
          "bad",
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.saveDraft(c.tenant, c.actor, started.eventId, input(draft), "legacy-path"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        { operationKey: randomUUID(), expectedDraftVersion: 1, draft },
        "legacy-input",
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });
  it("rejects corrupt saved receipt data and identity without another effect", async () => {
    const { started, draft } = await start(),
      command = input(draft);
    const receipt = await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
    for (const result of [
      {},
      { ...receipt, command: "receiving.amend" },
      { ...receipt, operationKey: randomUUID() },
      { ...receipt, inputDigest: "0".repeat(64) },
      { ...receipt, eventId: randomUUID() },
    ]) {
      await f.pool.query(
        "UPDATE receiving_operations SET result=$1 WHERE tenant_id=$2 AND command='receiving.save' AND operation_key=$3",
        [result, c.tenant, command.operationKey],
      );
      const before = await state();
      await expect(
        store.saveAmendment(c.tenant, c.actor, started.eventId, command, "corrupt"),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
      expect(await state()).toEqual(before);
    }
  });
  it.each(["tenant_audit_events", "receiving_operations"] as const)(
    "rolls back header, children and receipt on %s failure",
    async (table) => {
      const { started, draft } = await start();
      draft.notes = "Corrected";
      draft.items.reverse();
      draft.documentIds = [];
      const command = input(draft),
        before = await state();
      await f.pool.query(
        `CREATE FUNCTION synthetic_amendment_save_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic amendment save failure'; END $$; CREATE TRIGGER synthetic_amendment_save_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_amendment_save_fail()`,
      );
      try {
        await expect(
          store.saveAmendment(c.tenant, c.actor, started.eventId, command, "failed"),
        ).rejects.toBeDefined();
      } finally {
        await f.pool.query(
          `DROP TRIGGER synthetic_amendment_save_fail ON ${table}; DROP FUNCTION synthetic_amendment_save_fail()`,
        );
      }
      expect(await state()).toEqual(before);
      expect(
        (await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "retry")).record
          .draftVersion,
      ).toBe(2);
    },
  );
  it("locks the complete reference source tuple, including resolved location", async () => {
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing line");
    first.source = {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://supplier.example.test/original",
      resolvedLocationId: c.location,
    };
    const { started, draft } = await start();
    const line = draft.items[0];
    if (line?.source?.kind !== "reference") throw new Error("Missing reference");
    for (const source of [
      { ...line.source, referenceValue: "https://supplier.example.test/changed" },
      { ...line.source, resolvedLocationId: randomUUID() },
    ]) {
      const before = await state();
      await expect(
        store.saveAmendment(
          c.tenant,
          c.actor,
          started.eventId,
          input({ ...draft, items: [{ ...line, source }] }),
          "identity",
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "lot_identity_locked", lines: [{ lineNo: 1, fields: ["source"] }] },
      });
      expect(await state()).toEqual(before);
    }
  });
  it("retains distinct predecessor line bindings even when both lines reference the same lot", async () => {
    const linked = c.draft.items[1];
    if (!linked) throw new Error("Missing linked line");
    c.draft.items = [linked, { ...linked, quantity: "7" }];
    const { started, draft } = await start();
    draft.items.reverse();
    const saved = await store.saveAmendment(
      c.tenant,
      c.actor,
      started.eventId,
      input(draft),
      "reorder",
    );
    expect(saved.record.content).toEqual({ kind: "draft", draft });
    expect((await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).supportCount).toBe(1);
  });
  it("uses an immediate v3 predecessor's saved lines, not its older origin binding", async () => {
    const { started } = await start();
    // Raw v3 storage specimen only: amendment finalization is not implemented by this fixture.
    await finalizeStoredAmendment(f, c.tenant, started.eventId);
    const next = await store.amend(
      c.tenant,
      c.actor,
      started.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Next correction",
      },
      "next",
    );
    if (next.record.content.kind !== "draft") throw new Error("Expected draft");
    const draft = receivingAmendmentDraftSchema.parse(next.record.content.draft);
    draft.notes = "New correction";
    draft.items.reverse();
    const receipt = await store.saveAmendment(
      c.tenant,
      c.actor,
      next.eventId,
      { ...input(draft), expectedLifecycleVersion: 5 },
      "save-v3",
    );
    expect(receipt.record).toMatchObject({
      revision: 3,
      draftVersion: 2,
      lifecycle: { previousRevisionId: started.eventId },
      content: { kind: "draft", draft },
    });
  });
  it("does not wrap an exhausted draft version, while unchanged saves still succeed", async () => {
    const { started, draft } = await start();
    await f.pool.query(
      "UPDATE traceability_events SET draft_version=2147483647 WHERE tenant_id=$1 AND id=$2",
      [c.tenant, started.eventId],
    );
    const before = await state();
    await expect(
      store.saveAmendment(
        c.tenant,
        c.actor,
        started.eventId,
        input({ ...draft, notes: "Overflow" }, 2147483647),
        "overflow",
      ),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await state()).toEqual(before);
    expect(
      (
        await store.saveAmendment(
          c.tenant,
          c.actor,
          started.eventId,
          input(draft, 2147483647),
          "unchanged",
        )
      ).record.draftVersion,
    ).toBe(2147483647);
  });
  it.each(["product", "location", "party", "document"] as const)(
    "rechecks the current %s on changed saves without applying finalization KDE rules",
    async (reference) => {
      const { started, draft } = await start();
      if (reference === "product")
        await f.db
          .update(schema.products)
          .set({ archived: true })
          .where(eq(schema.products.id, c.product));
      if (reference === "location")
        await f.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, c.location));
      if (reference === "party")
        await f.db
          .update(schema.traceabilityParties)
          .set({ archived: true })
          .where(eq(schema.traceabilityParties.id, c.party));
      if (reference === "document")
        await f.db
          .update(schema.referenceDocuments)
          .set({ archivedAt: new Date() })
          .where(eq(schema.referenceDocuments.id, c.document));
      const before = await state();
      await expect(
        store.saveAmendment(
          c.tenant,
          c.actor,
          started.eventId,
          input({ ...draft, notes: "Correction" }),
          "inactive",
        ),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_reference_inactive" } });
      expect(await state()).toEqual(before);
      // Existing no-op semantics: acknowledge already saved input without refreshing it.
      expect(
        (await store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft), "no-op"))
          .record,
      ).toEqual(started.record);
    },
  );
  it("rechecks the current profile before historical save replay", async () => {
    const { started, draft } = await start(),
      command = input(draft);
    await store.saveAmendment(c.tenant, c.actor, started.eventId, command, "save");
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "RU_CHZ" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    const before = await state();
    await expect(
      store.saveAmendment(c.tenant, c.actor, started.eventId, command, "profile-changed"),
    ).rejects.toMatchObject({ status: 503, response: { code: "traceability_profile_invalid" } });
    expect(await state()).toEqual(before);
  });
  it("fails closed on an unsupported stored CTE even for an unchanged save", async () => {
    const { started, draft } = await start();
    const unknown = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: { ...c.draft, items: [], documentIds: [] } },
      "unknown-fixture",
    );
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
      await expect(
        store.saveAmendment(c.tenant, c.actor, started.eventId, input(draft), "unknown-kind"),
      ).rejects.toMatchObject({ status: 503 });
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
});
