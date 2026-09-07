import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { readReceivingRegistry } from "../src/modules/traceability/receiving/us-receiving-registry";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving current and historical registry", () => {
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
  const create = () =>
    store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: c.draft,
      },
      "registry-create",
    );
  const list = (query: unknown = {}) => store.listLiveRecords(c.tenant, c.actor, query);
  const ids = async (query: unknown = {}) =>
    (await list(query)).items.map((item) => item.id).sort();
  async function finalizeOriginal() {
    const draft = await create();
    const ready = await store.checkReadiness(c.tenant, c.actor, draft.id, {
      expectedDraftVersion: 1,
    });
    return store.finalize(
      c.tenant,
      c.actor,
      draft.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      },
      "registry-original-finalize",
    );
  }
  async function amend(id: string) {
    const current = await store.getLiveRecord(c.tenant, c.actor, id);
    return store.amend(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: current.lifecycle.lifecycleVersion,
        reason: "Correct count",
      },
      "registry-amend",
    );
  }
  async function voidRevision(id: string) {
    const current = await store.getLiveRecord(c.tenant, c.actor, id);
    return store.void(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: current.lifecycle.lifecycleVersion,
        expectedDraftVersion: current.status === "draft" ? current.draftVersion : null,
        reason: "Entered in error",
      },
      "registry-void",
    );
  }
  async function finalizeRevision(id: string) {
    const ready = await store.checkRevisionReadiness(c.tenant, c.actor, id, {
      expectedDraftVersion: 1,
    });
    return store.finalizeRevision(
      c.tenant,
      c.actor,
      id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        reviewedExemptLines: [],
      },
      "registry-revision-finalize",
    );
  }

  it("returns saved summary values and lifecycle without changing the legacy list response", async () => {
    const draft = await create();
    const old = await store.listRecords(c.tenant, c.actor, {});
    expect(await list()).toEqual({
      items: [
        {
          recordVersion: 2,
          id: draft.id,
          eventNumber: draft.eventNumber,
          revision: 1,
          draftVersion: 1,
          status: "draft",
          timeZone: draft.timeZone,
          createdAt: draft.createdAt,
          createdBy: c.actor,
          updatedAt: draft.updatedAt,
          updatedBy: c.actor,
          dateReceived: c.draft.dateReceived,
          locationId: c.location,
          previousSourceLocationId: c.location,
          lineCount: 2,
          documentCount: 1,
          lifecycle: {
            rootId: draft.id,
            lifecycleVersion: 1,
            previousRevisionId: null,
            supersededByEventId: null,
            currentEventId: null,
            pendingDraftId: draft.id,
            amendmentReason: null,
            supersededAt: null,
            supersededBy: null,
            voidedAt: null,
            voidedBy: null,
            voidReason: null,
          },
        },
      ],
      limit: 50,
      offset: 0,
    });
    expect(await store.listRecords(c.tenant, c.actor, {})).toEqual(old);
  });
  it("selects current receipt and pending draft, but never expands history for a status filter", async () => {
    const original = await finalizeOriginal();
    const abandoned = await amend(original.id);
    await voidRevision(abandoned.eventId);
    const pending = await amend(original.id);
    expect(await ids()).toEqual([original.id, pending.eventId].sort());
    expect(await ids({ status: "draft" })).toEqual([pending.eventId]);
    expect(await ids({ status: "finalized" })).toEqual([original.id]);
    expect(await ids({ status: "void" })).toEqual([]);
    expect(await ids({ status: "amended" })).toEqual([]);
    expect(await ids({ history: "all", status: "void" })).toEqual([abandoned.eventId]);
    await finalizeRevision(pending.eventId);
    expect(await ids()).toEqual([pending.eventId]);
    expect(await ids({ status: "amended" })).toEqual([]);
    expect(await ids({ history: "all", status: "amended" })).toEqual([original.id]);
    expect(await ids({ history: "all" })).toEqual(
      [original.id, abandoned.eventId, pending.eventId].sort(),
    );
  });
  it("keeps the last voided effective revision visible even when a later amendment draft was abandoned", async () => {
    const original = await finalizeOriginal();
    const revised = await amend(original.id);
    await finalizeRevision(revised.eventId);
    const abandoned = await amend(revised.eventId);
    await voidRevision(abandoned.eventId);
    await voidRevision(revised.eventId);
    expect(await ids()).toEqual([revised.eventId]);
    expect(await ids({ status: "void" })).toEqual([revised.eventId]);
    expect(await ids({ history: "all", status: "void" })).toEqual(
      [revised.eventId, abandoned.eventId].sort(),
    );
    expect(await ids({ status: "finalized" })).toEqual([]);
    expect((await list()).items[0]).toMatchObject({
      revision: 2,
      status: "void",
      lifecycle: {
        rootId: original.id,
        currentEventId: null,
        pendingDraftId: null,
        previousRevisionId: original.id,
        lifecycleVersion: 7,
        voidReason: "Entered in error",
      },
    });
  });
  it("keeps a void original draft visible for a never-finalized root", async () => {
    const draft = await create();
    await voidRevision(draft.id);
    expect(await ids()).toEqual([draft.id]);
    expect(await ids({ status: "draft" })).toEqual([]);
    expect(await ids({ history: "all" })).toEqual([draft.id]);
  });
  it("applies status before pagination and sorts by created time then UUID, not last update", async () => {
    const first = await create(),
      second = await create(),
      third = await create();
    await voidRevision(first.id);
    const rollback = new Error("rollback synthetic timestamp specimen");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
          .where(eq(schema.traceabilityEvents.tenantId, c.tenant));
        await tx
          .update(schema.traceabilityEvents)
          .set({ createdAt: new Date("2026-01-02T00:00:00Z") })
          .where(eq(schema.traceabilityEvents.id, first.id));
        const draftIds = [second.id, third.id].sort().reverse();
        const all = await readReceivingRegistry(tx, c.tenant, {
          history: "current",
          limit: 50,
          offset: 0,
        });
        expect(all.items.map((item) => item.id)).toEqual([first.id, ...draftIds]);
        const page = await readReceivingRegistry(tx, c.tenant, {
          history: "current",
          status: "draft",
          limit: 1,
          offset: 1,
        });
        expect(page.items.map((item) => item.id)).toEqual([draftIds[1]]);
        expect(page).toMatchObject({ limit: 1, offset: 1 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await list({ offset: "100000" })).toEqual({ items: [], limit: 50, offset: 100000 });
  });
  it("searches literal case-insensitive receiving numbers, never SQL wildcards or other fields", async () => {
    const draft = await create();
    for (const search of ["%", "_", "\\", "Synthetic", "' OR true --", draft.id])
      expect(await ids({ search })).toEqual([]);
    expect(await ids({ search: `  ${draft.eventNumber.toLowerCase()}  ` })).toEqual([draft.id]);
    expect(await ids({ search: "" })).toEqual([draft.id]);
  });
  it("scopes roots, children and matching duplicate numbers to the authorized tenant", async () => {
    const own = await create();
    const foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      {
        operationKey: randomUUID(),
        draft: { ...foreign.draft, items: [] },
      },
      "foreign-create",
    );
    expect(other.eventNumber).toBe(own.eventNumber);
    expect(await ids({ history: "all", search: own.eventNumber })).toEqual([own.id]);
    expect((await store.listLiveRecords(foreign.tenant, foreign.actor, {})).items).toMatchObject([
      { id: other.id, lineCount: 0, documentCount: 1 },
    ]);
    await expect(store.listLiveRecords(foreign.tenant, c.actor, {})).rejects.toMatchObject({
      status: 403,
    });
  });
  it.each(["traceability_auditor", "traceability_receiving", "traceability_qa"])(
    "allows current %s read access, then denies removed membership before validating a query",
    async (role) => {
      const draft = await create();
      await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
      expect(await ids()).toEqual([draft.id]);
      await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
      await expect(list({ tenantId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    },
  );
  it.each([
    { history: "latest" },
    { history: ["current", "all"] },
    { status: ["draft", "void"] },
    { status: "all" },
    { limit: "01" },
    { limit: "101" },
    { offset: "100001" },
    { search: "bad\u0000text" },
    { search: ["one", "two"] },
    { tenantId: "foreign" },
  ])("rejects invalid registry query %j", async (query) => {
    await expect(list(query)).rejects.toMatchObject({ status: 400 });
  });
  it("has no business, child, token, receipt or audit writes", async () => {
    const original = await finalizeOriginal();
    await amend(original.id);
    const state = async () =>
      (
        await f.pool.query(
          `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS operations,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
          [c.tenant],
        )
      ).rows;
    const before = await state();
    await list();
    await list({ history: "all", status: "amended", offset: "100000" });
    expect(await state()).toEqual(before);
  });
  it.each(["counter", "pending", "snapshot", "kind"])(
    "fails closed on matching-root %s corruption even if status or pagination would hide it",
    async (kind) => {
      const original = await finalizeOriginal();
      const pending = await amend(original.id);
      const rollback = new Error("rollback synthetic corrupt registry");
      await expect(
        f.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          if (kind === "counter")
            await tx
              .update(schema.receivingEventRoots)
              .set({ lifecycleVersion: 9 })
              .where(eq(schema.receivingEventRoots.id, original.id));
          else if (kind === "pending")
            await tx
              .update(schema.receivingEventRoots)
              .set({ pendingDraftId: null })
              .where(eq(schema.receivingEventRoots.id, original.id));
          else if (kind === "snapshot")
            await tx
              .update(schema.traceabilityEvents)
              .set({ finalizationSnapshot: {} })
              .where(eq(schema.traceabilityEvents.id, original.id));
          else {
            // CHECK constraints remain active with replica triggers disabled. The
            // removal and corrupt specimen exist only inside this rolled-back test.
            await tx.execute(
              sql`ALTER TABLE traceability_events DROP CONSTRAINT traceability_events_lifecycle_valid`,
            );
            await tx
              .update(schema.traceabilityEvents)
              .set({ type: "shipping" })
              .where(eq(schema.traceabilityEvents.id, pending.eventId));
          }
          await expect(
            readReceivingRegistry(tx, c.tenant, {
              history: "current",
              status: "void",
              search: original.eventNumber,
              limit: 1,
              offset: 100000,
            }),
          ).rejects.toMatchObject({ status: 503 });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it("does not inspect an unrelated tenant's corrupt root", async () => {
    const own = await create();
    const foreign = await seedCompleteReceiving(f.db);
    const other = await store.createDraft(
      foreign.tenant,
      foreign.actor,
      {
        operationKey: randomUUID(),
        draft: foreign.draft,
      },
      "foreign-create",
    );
    const rollback = new Error("rollback foreign corruption");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.receivingEventRoots)
          .set({ pendingDraftId: null })
          .where(
            and(
              eq(schema.receivingEventRoots.tenantId, foreign.tenant),
              eq(schema.receivingEventRoots.id, other.id),
            ),
          );
        const result = await readReceivingRegistry(tx, c.tenant, {
          history: "all",
          limit: 50,
          offset: 0,
        });
        expect(result.items.map((item) => item.id)).toEqual([own.id]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("validates a root when only its corrupt revision number matches the search", async () => {
    const own = await create();
    const rollback = new Error("rollback corrupt number specimen");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ eventNumber: "REC-99-999999" })
          .where(eq(schema.traceabilityEvents.id, own.id));
        await expect(
          readReceivingRegistry(tx, c.tenant, {
            history: "current",
            search: "REC-99-999999",
            limit: 50,
            offset: 0,
          }),
        ).rejects.toMatchObject({ status: 503 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
