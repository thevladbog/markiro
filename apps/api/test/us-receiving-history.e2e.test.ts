import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
  voidStoredEvent,
} from "./support/us-receiving-lifecycle-storage";
import {
  readReceivingLiveRecord,
  readReceivingRevisions,
} from "../src/modules/traceability/receiving/us-receiving-history";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving revision read foundation", () => {
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
    store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft: c.draft }, "create");
  async function finalized() {
    const saved = await create();
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
      },
      "finalize",
    );
  }
  it("reads the saved original draft in a separate live envelope without changing its legacy response", async () => {
    const saved = await create();
    expect(await store.getLiveRecord(c.tenant, c.actor, saved.id.toUpperCase())).toEqual({
      recordVersion: 2,
      id: saved.id,
      eventNumber: saved.eventNumber,
      revision: 1,
      draftVersion: 1,
      status: "draft",
      timeZone: saved.timeZone,
      createdBy: saved.createdBy,
      updatedBy: saved.updatedBy,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      lifecycle: {
        rootId: saved.id,
        lifecycleVersion: 1,
        previousRevisionId: null,
        supersededByEventId: null,
        currentEventId: null,
        pendingDraftId: saved.id,
        amendmentReason: null,
        supersededAt: null,
        supersededBy: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
      },
      content: { kind: "draft", draft: saved.draft },
    });
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(saved);
  });
  it("reads frozen v2 and v3 content independently of current lifecycle and live master labels", async () => {
    const original = await finalized();
    const pending = await createStoredAmendment(f, c.tenant, original.id);
    const draft = await store.getLiveRecord(c.tenant, c.actor, pending);
    expect(draft).toMatchObject({
      revision: 2,
      status: "draft",
      lifecycle: {
        rootId: original.id,
        previousRevisionId: original.id,
        currentEventId: original.id,
        pendingDraftId: pending,
        amendmentReason: "Correct receipt",
      },
    });
    if (draft.content.kind !== "draft") throw new Error("Expected draft content");
    expect(draft.content.draft.items).toMatchObject([
      { previousLineNo: 1, lotId: original.snapshot.items[0]?.lotId },
      { previousLineNo: 2, lotId: c.lot },
    ]);
    const frozen = await finalizeStoredAmendment(f, c.tenant, pending);
    await f.db
      .update(schema.products)
      .set({ name: "Changed live name" })
      .where(eq(schema.products.id, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed live label" })
      .where(eq(schema.traceabilityLocations.id, c.location));
    const old = await store.getLiveRecord(c.tenant, c.actor, original.id);
    expect(old).toMatchObject({
      status: "amended",
      lifecycle: { currentEventId: pending, supersededByEventId: pending, lifecycleVersion: 4 },
      content: {
        kind: "finalized",
        finalizedAt: original.finalizedAt,
        finalizedBy: original.finalizedBy,
        snapshot: original.snapshot,
      },
    });
    expect((await store.getLiveRecord(c.tenant, c.actor, pending)).content).toEqual({
      kind: "finalized",
      finalizedAt: new Date(new Date(original.finalizedAt).getTime() + 1000).toISOString(),
      finalizedBy: c.actor,
      snapshot: frozen,
    });
    await voidStoredEvent(f, c.tenant, pending);
    expect(await store.getLiveRecord(c.tenant, c.actor, pending)).toMatchObject({
      status: "void",
      lifecycle: { currentEventId: null, pendingDraftId: null, voidReason: "Entered in error" },
      content: { kind: "finalized", snapshot: frozen },
    });
  });
  it("includes abandoned revisions in ordered bounded history from any same-root UUID", async () => {
    const original = await finalized();
    const abandoned = await createStoredAmendment(f, c.tenant, original.id);
    await voidStoredEvent(f, c.tenant, abandoned);
    const next = await createStoredAmendment(f, c.tenant, original.id);
    for (const id of [original.id, abandoned, next]) {
      const history = await store.listRevisions(c.tenant, c.actor, id, {});
      expect(history).toMatchObject({ limit: 50, offset: 0, lifecycleVersion: 5 });
      expect(
        history.items.map((item) => [
          item.id,
          item.revision,
          item.status,
          item.lineCount,
          item.documentCount,
        ]),
      ).toEqual([
        [original.id, 1, "finalized", 2, 1],
        [abandoned, 2, "void", 2, 1],
        [next, 3, "draft", 2, 1],
      ]);
      expect(await store.listRevisions(c.tenant, c.actor, id, { limit: "1", offset: "1" })).toEqual(
        { items: [history.items[1]], limit: 1, offset: 1, lifecycleVersion: 5 },
      );
      expect(await store.listRevisions(c.tenant, c.actor, id, { offset: "100000" })).toEqual({
        items: [],
        limit: 50,
        offset: 100000,
        lifecycleVersion: 5,
      });
    }
  });
  it("keeps void draft input without fabricating frozen finalization", async () => {
    const saved = await create();
    await voidStoredEvent(f, c.tenant, saved.id);
    expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toMatchObject({
      status: "void",
      content: { kind: "draft", draft: saved.draft },
      lifecycle: { currentEventId: null, pendingDraftId: null },
    });
  });
  it("returns a version-pinned v1 specimen without upgrading or normalizing its frozen content", async () => {
    const original = await finalized();
    if (original.snapshot.snapshotVersion !== 2) throw new Error("Expected current v2 writer");
    const v1 = {
      ...original.snapshot,
      snapshotVersion: 1,
      items: original.snapshot.items.map((item) => {
        const { receiptBasis, ...legacy } = item;
        void receiptBasis;
        return legacy;
      }),
      confirmation: {
        ruleVersion: "receiving-readiness-v2",
        inputDigest: original.snapshot.confirmation.inputDigest,
        warnings: original.snapshot.confirmation.warnings,
      },
    };
    const rollback = new Error("rollback v1 specimen");
    await expect(
      f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx
          .update(schema.traceabilityEvents)
          .set({ finalizationSnapshot: v1 })
          .where(eq(schema.traceabilityEvents.id, original.id));
        const record = await readReceivingLiveRecord(tx, c.tenant, original.id);
        expect(record.content).toEqual({
          kind: "finalized",
          finalizedAt: original.finalizedAt,
          finalizedBy: original.finalizedBy,
          snapshot: v1,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  it("writes no records, tokens, receipts or audit while reading detail, history and basis", async () => {
    const original = await finalized();
    const pending = await createStoredAmendment(f, c.tenant, original.id);
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
    await store.getLiveRecord(c.tenant, c.actor, original.id);
    await store.getLiveRecord(c.tenant, c.actor, pending);
    await store.listRevisions(c.tenant, c.actor, pending, {});
    await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
    expect(await state()).toEqual(before);
  });
  it("denies foreign and missing revisions even with an empty requested page", async () => {
    const saved = await create(),
      other = await seedCompleteReceiving(f.db);
    for (const id of [saved.id, randomUUID()]) {
      await expect(store.getLiveRecord(other.tenant, other.actor, id)).rejects.toMatchObject({
        status: 404,
        response: { code: "receiving_draft_not_found" },
      });
      await expect(
        store.listRevisions(other.tenant, other.actor, id, { offset: "100000" }),
      ).rejects.toMatchObject({ status: 404, response: { code: "receiving_draft_not_found" } });
    }
  });
  it("allows readers but requires current membership on every history/detail call", async () => {
    const saved = await create();
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    expect((await store.listRevisions(c.tenant, c.actor, saved.id, {})).items).toHaveLength(1);
    expect((await store.getLiveRecord(c.tenant, c.actor, saved.id)).id).toBe(saved.id);
    await f.db.delete(schema.member).where(eq(schema.member.id, c.member));
    await expect(store.listRevisions(c.tenant, c.actor, saved.id, {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(store.getLiveRecord(c.tenant, c.actor, saved.id)).rejects.toMatchObject({
      status: 403,
    });
  });
  it.each(["counter", "pending", "predecessor", "snapshot", "binding"])(
    "rejects corrupt chain %s instead of an apparently valid empty history page",
    async (kind) => {
      const original = await finalized();
      const pending = await createStoredAmendment(f, c.tenant, original.id);
      const rollback = new Error("rollback synthetic corruption");
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
          else if (kind === "predecessor")
            await tx
              .update(schema.traceabilityEvents)
              .set({ previousRevisionId: pending })
              .where(eq(schema.traceabilityEvents.id, pending));
          else if (kind === "binding")
            await tx
              .update(schema.receivingEventItems)
              .set({ lotId: c.lot })
              .where(
                and(
                  eq(schema.receivingEventItems.eventId, pending),
                  eq(schema.receivingEventItems.lineNo, 1),
                ),
              );
          else
            await tx
              .update(schema.traceabilityEvents)
              .set({ finalizationSnapshot: {} })
              .where(eq(schema.traceabilityEvents.id, original.id));
          await expect(
            readReceivingRevisions(tx, c.tenant, original.id, { limit: 1, offset: 100000 }),
          ).rejects.toMatchObject({ status: 503 });
          await expect(readReceivingLiveRecord(tx, c.tenant, original.id)).rejects.toMatchObject({
            status: 503,
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it.each([
    { limit: "101" },
    { offset: "100001" },
    { offset: "01" },
    { status: "finalized" },
    { limit: ["1", "2"] },
  ])("rejects invalid history query %j", async (query) => {
    const saved = await create();
    await expect(store.listRevisions(c.tenant, c.actor, saved.id, query)).rejects.toMatchObject({
      status: 400,
    });
  });
});
