import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { receivingAmendmentDraftSchema, type ReceivingDraft } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedExemptReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving internal revision finalization", () => {
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
  async function command(id: string, version = 1) {
    const r = await store.checkRevisionReadiness(c.tenant, c.actor, id, {
      expectedDraftVersion: version,
    });
    return {
      commandVersion: 2 as const,
      operationKey: randomUUID(),
      expectedDraftVersion: version,
      expectedLifecycleVersion: r.expectedLifecycleVersion,
      previousRevisionId: r.previousRevisionId,
      expectedInputDigest: r.inputDigest,
      reviewedExemptLines: r.exemptReviewRequiredLines,
    };
  }
  const finalize = async (id: string, version = 1) =>
    store.finalizeRevision(c.tenant, c.actor, id, await command(id, version), "finalize");
  async function start(draft: ReceivingDraft = c.draft) {
    const original = await create(draft);
    const r = await store.checkReadiness(c.tenant, c.actor, original.id, {
      expectedDraftVersion: 1,
    });
    const old = await store.finalize(
      c.tenant,
      c.actor,
      original.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: r.inputDigest,
        reviewedExemptLines: r.exemptReviewRequiredLines,
      },
      "old-finalize",
    );
    const amended = await store.amend(
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
    if (amended.record.content.kind !== "draft") throw new Error("Missing draft");
    return {
      old,
      amended,
      draft: receivingAmendmentDraftSchema.parse(amended.record.content.draft),
    };
  }
  const save = (
    id: string,
    draft: ReturnType<typeof receivingAmendmentDraftSchema.parse>,
    rootVersion = 3,
  ) =>
    store.saveAmendment(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedLifecycleVersion: rootVersion,
        draft,
      },
      "save",
    );
  const lots = async () =>
    (
      await f.pool.query(
        "SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [c.tenant],
      )
    ).rows;
  const businessLots = async () =>
    (
      await f.pool.query(
        "SELECT to_jsonb(l)-'receiving_basis_version' AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
        [c.tenant],
      )
    ).rows;
  const state = async () =>
    (
      await f.pool.query(
        `SELECT
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS operations,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
        [c.tenant],
      )
    ).rows;
  it("finalizes an original with explicit created/linked v3 bindings and a durable receipt", async () => {
    const saved = await create(),
      input = await command(saved.id);
    const result = await store.finalizeRevision(c.tenant, c.actor, saved.id, input, "first");
    expect(result).toMatchObject({
      receiptVersion: 2,
      command: "receiving.finalize",
      operationKey: input.operationKey,
      eventId: saved.id,
      record: {
        status: "finalized",
        revision: 1,
        lifecycle: {
          rootId: saved.id,
          lifecycleVersion: 2,
          currentEventId: saved.id,
          pendingDraftId: null,
        },
        content: {
          kind: "finalized",
          snapshot: {
            snapshotVersion: 3,
            confirmation: {
              ruleVersion: "receiving-readiness-v4",
              inputDigest: input.expectedInputDigest,
            },
            items: [
              { lotBinding: { kind: "created" } },
              { lotBinding: { kind: "linked" }, lotId: c.lot },
            ],
          },
        },
      },
    });
    expect(await lots()).toHaveLength(2);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      supportCount: 1,
      basisVersion: 2,
    });
    const after = await state();
    expect(await store.finalizeRevision(c.tenant, c.actor, saved.id, input, "retry")).toEqual(
      result,
    );
    expect(await state()).toEqual(after);
  });
  it("replaces the current revision atomically, preserving lot identity and exact predecessor content", async () => {
    const { old, amended, draft } = await start();
    draft.notes = "Documentary correction";
    draft.items.reverse();
    await save(amended.eventId, draft);
    const before = await store.getLiveRecord(c.tenant, c.actor, amended.eventId);
    const predecessorBefore = await store.getLiveRecord(c.tenant, c.actor, old.id);
    const unchangedLots = await businessLots(),
      input = await command(amended.eventId, 2);
    const result = await store.finalizeRevision(
      c.tenant,
      c.actor,
      amended.eventId,
      input,
      "correction-finalize",
    );
    expect(result.record).toMatchObject({
      id: amended.eventId,
      eventNumber: old.eventNumber,
      revision: 2,
      draftVersion: 2,
      status: "finalized",
      lifecycle: { currentEventId: amended.eventId, pendingDraftId: null, lifecycleVersion: 4 },
    });
    const predecessorAfter = await store.getLiveRecord(c.tenant, c.actor, old.id);
    expect(predecessorAfter).toEqual({
      ...predecessorBefore,
      status: "amended",
      lifecycle: {
        ...predecessorBefore.lifecycle,
        lifecycleVersion: 4,
        currentEventId: amended.eventId,
        pendingDraftId: null,
        supersededByEventId: amended.eventId,
        supersededBy: c.actor,
        supersededAt: result.record.updatedAt,
      },
    });
    if (result.record.content.kind !== "finalized") throw new Error("Missing final snapshot");
    expect(
      result.record.content.snapshot.items.map((i) => ({
        lineNo: i.lineNo,
        lotId: i.lotId,
        binding: "lotBinding" in i ? i.lotBinding : null,
      })),
    ).toEqual([
      {
        lineNo: 1,
        lotId: old.snapshot.items[1]?.lotId,
        binding: { kind: "retained", previousEventId: old.id, previousLineNo: 2 },
      },
      {
        lineNo: 2,
        lotId: old.snapshot.items[0]?.lotId,
        binding: { kind: "retained", previousEventId: old.id, previousLineNo: 1 },
      },
    ]);
    expect(await businessLots()).toEqual(unchangedLots);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      supportCount: 1,
      basisVersion: 3,
      items: [{ eventId: amended.eventId, lineNos: [1] }],
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "correction-finalize"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.receiving.finalized",
      outcome: "success",
      targetType: "traceability_event",
      targetId: amended.eventId,
      before,
      after: {
        rootId: old.id,
        revision: 2,
        reason: "Correct receipt",
        result: "finalized",
        effect: {
          kind: "documentary",
          affectedLotIds: [],
          removedPreviousLineNos: [],
          identityLockedLineNos: [],
          invalidBindingLineNos: [],
        },
        record: result.record,
        predecessor: { before: predecessorBefore, after: predecessorAfter },
        lineLots: {
          before: old.snapshot.items.map((i) => ({ lineNo: i.lineNo, lotId: i.lotId })),
          after: result.record.content.snapshot.items.map((i) => ({
            lineNo: i.lineNo,
            lotId: i.lotId,
          })),
        },
      },
    });
    expect(Object.keys(audits[0]?.after ?? {}).sort()).toEqual([
      "effect",
      "lineLots",
      "predecessor",
      "reason",
      "record",
      "result",
      "revision",
      "rootId",
    ]);
  });
  it.each(["consumed", "shipped", "quarantined", "recalled", "archived"] as const)(
    "retains %s lots without fabricated lot creation or status/source changes",
    async (status) => {
      const { amended } = await start();
      await f.db
        .update(schema.traceabilityLots)
        .set({ status })
        .where(eq(schema.traceabilityLots.tenantId, c.tenant));
      const before = await businessLots();
      expect((await finalize(amended.eventId)).record.status).toBe("finalized");
      expect(await businessLots()).toEqual(before);
      expect(await lots()).toHaveLength(2);
    },
  );
  it("removes receipt support without deleting a removed lot and allocates only an unbound new line", async () => {
    const { amended, draft } = await start();
    draft.items = draft.items.filter((i) => i.lotId !== c.lot);
    const retained = draft.items[0];
    if (!retained) throw new Error("Missing retained line");
    draft.items.push({ ...retained, previousLineNo: null, lotId: null, tlc: "ADDITIONAL-LOT" });
    await save(amended.eventId, draft);
    const unchanged = await businessLots(),
      result = await finalize(amended.eventId, 2);
    expect(await lots()).toHaveLength(3);
    expect(await businessLots()).toEqual(expect.arrayContaining(unchanged));
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      state: "missing",
      supportCount: 0,
      basisVersion: 3,
    });
    expect(result.record.content).toMatchObject({
      kind: "finalized",
      snapshot: {
        items: [
          { lotBinding: { kind: "retained" } },
          { tlc: "ADDITIONAL-LOT", lotBinding: { kind: "created" } },
        ],
      },
    });
  });
  it("uses the immediate v3 predecessor on a second correction and replays old receipts after void", async () => {
    const { amended } = await start(),
      input = await command(amended.eventId);
    const first = await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "first");
    const next = await store.amend(
      c.tenant,
      c.actor,
      amended.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Another correction",
      },
      "next",
    );
    const last = await finalize(next.eventId);
    expect(last.record.content).toMatchObject({
      kind: "finalized",
      snapshot: {
        items: [
          { lotBinding: { kind: "retained", previousEventId: amended.eventId, previousLineNo: 1 } },
          { lotBinding: { kind: "retained", previousEventId: amended.eventId, previousLineNo: 2 } },
        ],
      },
    });
    await store.void(
      c.tenant,
      c.actor,
      next.eventId,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 6,
        expectedDraftVersion: null,
        reason: "Withdraw receipt",
      },
      "void",
    );
    const before = await state();
    expect(
      await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "replay"),
    ).toEqual(first);
    expect(await state()).toEqual(before);
    await expect(
      store.finalizeRevision(
        c.tenant,
        c.actor,
        amended.eventId,
        { ...input, operationKey: randomUUID() },
        "new-key",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_lifecycle_conflict" } });
  });
  it.each([
    "traceability_receiving",
    "traceability_shipping",
    "traceability_production",
    "traceability_auditor",
    "manager",
  ])("requires current QA for first execution and successful replay by %s", async (role) => {
    const { amended } = await start(),
      input = await command(amended.eventId);
    await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
    const before = await state();
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "denied"),
    ).rejects.toMatchObject({ status: 403 });
    expect(await state()).toEqual(before);
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "allowed");
    await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "denied-replay"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    [{ expectedLifecycleVersion: 2 }, "receiving_lifecycle_conflict"],
    [{ previousRevisionId: null }, "receiving_lifecycle_conflict"],
    [{ expectedDraftVersion: 2 }, "receiving_draft_conflict"],
    [{ expectedInputDigest: "0".repeat(64) }, "receiving_readiness_changed"],
    [{ reviewedExemptLines: [1] }, "event_incomplete"],
  ])("rejects stale confirmation %j without reserving the key", async (patch, code) => {
    const { amended } = await start(),
      input = await command(amended.eventId),
      before = await state();
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, { ...input, ...patch }, "stale"),
    ).rejects.toMatchObject({ status: 409, response: { code } });
    expect(await state()).toEqual(before);
    expect(
      (await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "corrected")).record
        .status,
    ).toBe("finalized");
  });
  it("treats exact quantity spelling as material without rounding or replacing its lot", async () => {
    const { amended, draft, old } = await start();
    const line = draft.items[0];
    if (!line) throw new Error("Missing line");
    line.quantity = "500";
    await save(amended.eventId, draft);
    const before = await businessLots(),
      result = await finalize(amended.eventId, 2);
    expect(result.record.content).toMatchObject({
      kind: "finalized",
      snapshot: {
        items: [
          { quantity: "500", lotId: old.snapshot.items[0]?.lotId },
          { quantity: "0.250", lotId: c.lot },
        ],
      },
    });
    expect(await businessLots()).toEqual(before);
    const audit = (
      await f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, c.tenant),
            eq(schema.tenantAuditEvents.targetId, amended.eventId),
            eq(schema.tenantAuditEvents.action, "traceability.receiving.finalized"),
            eq(schema.tenantAuditEvents.requestId, "finalize"),
          ),
        )
    )[0];
    expect(audit?.after).toMatchObject({
      effect: {
        kind: "material",
        affectedLotIds: [old.snapshot.items[0]?.lotId],
        removedPreviousLineNos: [],
      },
    });
  });
  it("rejects foreign/missing targets, malformed bodies and legacy input without any write", async () => {
    const { amended } = await start(),
      input = await command(amended.eventId);
    const foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      { operationKey: randomUUID(), draft: foreign.draft },
      "foreign",
    );
    const before = await state();
    for (const target of [randomUUID(), other.id])
      await expect(
        store.finalizeRevision(c.tenant, c.actor, target, input, "foreign"),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
    for (const patch of [
      { commandVersion: undefined },
      { commandVersion: 1 },
      { previousRevisionId: undefined },
      { reviewedExemptLines: undefined },
      { extra: true },
      { expectedLifecycleVersion: "3" },
      { reviewedExemptLines: [1, 1] },
    ])
      await expect(
        store.finalizeRevision(
          c.tenant,
          c.actor,
          amended.eventId,
          { ...input, ...patch },
          "malformed",
        ),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      store.finalize(c.tenant, c.actor, amended.eventId, input, "legacy"),
    ).rejects.toMatchObject({ status: 400 });
    expect(await state()).toEqual(before);
  });
  it("binds successful keys to exact command data and rejects corrupt receipts", async () => {
    const { amended } = await start(),
      input = await command(amended.eventId);
    await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "success");
    const before = await state();
    for (const [target, patch] of [
      [randomUUID(), {}],
      [amended.eventId, { expectedLifecycleVersion: 4 }],
      [amended.eventId, { reviewedExemptLines: [1] }],
      [amended.eventId, { previousRevisionId: randomUUID() }],
    ] as const)
      await expect(
        store.finalizeRevision(c.tenant, c.actor, target, { ...input, ...patch }, "changed"),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
    expect(await state()).toEqual(before);
    await f.db
      .update(schema.receivingOperations)
      .set({ result: {} })
      .where(eq(schema.receivingOperations.operationKey, input.operationKey));
    const corrupt = await state();
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "corrupt"),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await state()).toEqual(corrupt);
  });
  it("rejects changed support tokens even when draft and root versions stay unchanged", async () => {
    const { amended } = await start(),
      input = await command(amended.eventId);
    const second = await create({
      ...c.draft,
      items: c.draft.items.filter((i) => i.lotId === c.lot),
    });
    await finalize(second.id);
    const before = await state();
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "stale-basis"),
    ).rejects.toMatchObject({ status: 409, response: { code: "receiving_readiness_changed" } });
    expect(await state()).toEqual(before);
    await finalize(amended.eventId);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      supportCount: 2,
      basisVersion: 4,
    });
  });
  it.each(["tenant_audit_events", "receiving_operations"] as const)(
    "rolls back lots, supersession, root and tokens on %s failure",
    async (table) => {
      const { amended, draft } = await start();
      const first = draft.items[0];
      if (!first) throw new Error("Missing line");
      draft.items.push({ ...first, lotId: null, previousLineNo: null, tlc: "ROLLBACK-LOT" });
      await save(amended.eventId, draft);
      const input = await command(amended.eventId, 2),
        before = await state();
      // Fail only the final receiving audit, after the new lot and root writes.
      await f.pool
        .query(`CREATE FUNCTION synthetic_revision_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic revision failure'; END $$;
      CREATE TRIGGER synthetic_revision_fail BEFORE INSERT ON ${table} FOR EACH ROW ${table === "tenant_audit_events" ? "WHEN (NEW.action='traceability.receiving.finalized')" : ""} EXECUTE FUNCTION synthetic_revision_fail()`);
      try {
        await expect(
          store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "fail"),
        ).rejects.toBeDefined();
      } finally {
        await f.pool.query(
          `DROP TRIGGER synthetic_revision_fail ON ${table}; DROP FUNCTION synthetic_revision_fail()`,
        );
      }
      expect(await state()).toEqual(before);
      expect(
        (await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "recover")).record
          .status,
      ).toBe("finalized");
      expect(await lots()).toHaveLength(3);
    },
  );
  it.each(["40001", "40P01"])("caps %s retries at three with no partial state", async (code) => {
    const { amended } = await start(),
      input = await command(amended.eventId),
      before = await state();
    await f.pool.query(`CREATE SEQUENCE synthetic_revision_attempt;
      CREATE FUNCTION synthetic_revision_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_revision_attempt'); RAISE EXCEPTION 'synthetic retry' USING ERRCODE='${code}'; END $$;
      CREATE TRIGGER synthetic_revision_retry BEFORE INSERT ON receiving_operations FOR EACH ROW EXECUTE FUNCTION synthetic_revision_retry()`);
    try {
      await expect(
        store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "retry-exhausted"),
      ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
      expect(
        (await f.pool.query("SELECT last_value FROM synthetic_revision_attempt")).rows,
      ).toEqual([{ last_value: "3" }]);
    } finally {
      await f.pool.query(
        "DROP TRIGGER synthetic_revision_retry ON receiving_operations; DROP FUNCTION synthetic_revision_retry(); DROP SEQUENCE synthetic_revision_attempt",
      );
    }
    expect(await state()).toEqual(before);
    expect(
      (await store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "recovered")).record
        .status,
    ).toBe("finalized");
  });
  it.each(["product", "document", "new-linked-lot"] as const)(
    "rechecks current %s validity before any finalization write",
    async (kind) => {
      const { amended, draft } = await start();
      let version = 1;
      if (kind === "new-linked-lot") {
        const linked = draft.items[1];
        if (!linked) throw new Error("Missing linked line");
        draft.items.push({ ...linked, previousLineNo: null });
        await save(amended.eventId, draft);
        version = 2;
      }
      const input = await command(amended.eventId, version);
      if (kind === "product")
        await f.db
          .update(schema.products)
          .set({ archived: true })
          .where(eq(schema.products.id, c.product));
      if (kind === "document")
        await f.db
          .update(schema.referenceDocuments)
          .set({ archivedAt: new Date() })
          .where(eq(schema.referenceDocuments.id, c.document));
      if (kind === "new-linked-lot")
        await f.db
          .update(schema.traceabilityLots)
          .set({ status: "archived" })
          .where(eq(schema.traceabilityLots.id, c.lot));
      const before = await state();
      await expect(
        store.finalizeRevision(
          c.tenant,
          c.actor,
          amended.eventId,
          input,
          "invalid-current-reference",
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: "event_incomplete",
          issues: expect.arrayContaining([expect.objectContaining({ code: "inactive" })]),
        },
      });
      expect(await state()).toEqual(before);
    },
  );
  it("rolls back supersession and all prior token changes when an affected lot token is exhausted", async () => {
    const { amended } = await start();
    await f.db
      .update(schema.traceabilityLots)
      .set({ receivingBasisVersion: 2147483647 })
      .where(eq(schema.traceabilityLots.id, c.lot));
    const input = await command(amended.eventId),
      before = await state();
    await expect(
      store.finalizeRevision(c.tenant, c.actor, amended.eventId, input, "exhausted"),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await state()).toEqual(before);
  });
  it("requires fresh exempt QA and retains the original physical source after a header correction", async () => {
    c = await seedExemptReceiving(f.db);
    const { amended, draft } = await start();
    const [location] = await f.db
      .select()
      .from(schema.traceabilityLocations)
      .where(eq(schema.traceabilityLocations.id, c.location));
    if (!location) throw new Error("Missing location");
    const changedLocation = randomUUID();
    await f.db.insert(schema.traceabilityLocations).values({ ...location, id: changedLocation });
    draft.locationId = changedLocation;
    await save(amended.eventId, draft);
    const input = await command(amended.eventId, 2),
      before = await state();
    await expect(
      store.finalizeRevision(
        c.tenant,
        c.actor,
        amended.eventId,
        { ...input, reviewedExemptLines: [] },
        "missing-review",
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "event_incomplete" } });
    expect(await state()).toEqual(before);
    const qa = randomUUID();
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
    const unchanged = await businessLots(),
      result = await store.finalizeRevision(c.tenant, qa, amended.eventId, input, "fresh-review");
    expect(result.record.content).toMatchObject({
      kind: "finalized",
      snapshot: {
        locationId: changedLocation,
        items: [
          {
            source: { kind: "location", locationId: c.location },
            receiptBasis: {
              kind: "exempt_assigned_tlc",
              receivedTlc: null,
              reviewedBy: qa,
              reviewedAt: result.record.updatedAt,
            },
            lotBinding: { kind: "retained" },
          },
          { lotId: c.lot, receiptBasis: { kind: "ordinary" }, lotBinding: { kind: "retained" } },
        ],
      },
    });
    expect(await businessLots()).toEqual(unchanged);
    expect(result.record).toMatchObject({
      createdBy: c.actor,
      updatedBy: qa,
      content: { finalizedBy: qa },
    });
  });
});
