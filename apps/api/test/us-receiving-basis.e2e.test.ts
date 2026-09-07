import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { readReceivingBasis } from "../src/modules/traceability/receiving/us-receiving-basis";
import {
  createStoredAmendment,
  finalizeStoredAmendment,
  voidStoredEvent,
} from "./support/us-receiving-lifecycle-storage";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Receiving current basis reads", () => {
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
  async function receipt(duplicate = false) {
    const line = c.draft.items[1];
    if (!line) throw new Error("Missing linked fixture line");
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: { ...c.draft, items: duplicate ? [line, line] : [line] },
      },
      "create",
    );
    const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(ready.state).toBe("complete");
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
  it("distinguishes a manual lot from an attested receipt without changing any state", async () => {
    const before = (
      await f.pool.query("SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE id=$1", [c.lot])
    ).rows;
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual({
      lotId: c.lot,
      basisVersion: 1,
      state: "missing",
      supportCount: 0,
      items: [],
      limit: 50,
      offset: 0,
      hasMore: false,
    });
    expect(
      (
        await f.pool.query("SELECT to_jsonb(l) AS lot FROM traceability_lots l WHERE id=$1", [
          c.lot,
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await f.pool.query("SELECT id FROM tenant_audit_events WHERE organization_id=$1", [
          c.tenant,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.pool.query("SELECT operation_key FROM receiving_operations WHERE tenant_id=$1", [
          c.tenant,
        ])
      ).rows,
    ).toEqual([]);
  });
  it("counts supporting revisions rather than matching lines and returns stable pages", async () => {
    const a = await receipt(true),
      b = await receipt();
    const entries = [
      { rootId: a.id, eventId: a.id, eventNumber: a.eventNumber, revision: 1, lineNos: [1, 2] },
      { rootId: b.id, eventId: b.id, eventNumber: b.eventNumber, revision: 1, lineNos: [1] },
    ].sort((x, y) => x.rootId.localeCompare(y.rootId));
    for (const offset of [0, 1, 2, 100000]) {
      expect(
        await store.getLotReceivingBasis(c.tenant, c.actor, c.lot.toUpperCase(), {
          limit: "1",
          offset: String(offset),
        }),
      ).toEqual({
        lotId: c.lot,
        basisVersion: 3,
        state: "present",
        supportCount: 2,
        items: entries.slice(offset, offset + 1),
        limit: 1,
        offset,
        hasMore: offset === 0,
      });
    }
  });
  it("does not infer support from pending drafts, inactive lot status or another tenant", async () => {
    await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "draft",
    );
    await f.db
      .update(schema.traceabilityLots)
      .set({ status: "recalled" })
      .where(eq(schema.traceabilityLots.id, c.lot));
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      state: "missing",
      supportCount: 0,
    });
    const other = await seedCompleteReceiving(f.db);
    for (const lot of [c.lot, randomUUID()]) {
      await expect(
        store.getLotReceivingBasis(other.tenant, other.actor, lot, {}),
      ).rejects.toMatchObject({ status: 404, response: { code: "lot_not_found" } });
    }
  });
  it("rechecks membership and profile for every read", async () => {
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    expect((await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).state).toBe("missing");
    await f.db
      .update(schema.member)
      .set({ role: "operator" })
      .where(eq(schema.member.id, c.member));
    await expect(store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 403,
    });
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.id, c.member));
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await expect(store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 403,
      response: { code: "traceability_profile_required" },
    });
  });
  it("replaces support on amendment, retains it on draft cancellation and does not resurrect a void receipt", async () => {
    const original = await receipt();
    const abandoned = await createStoredAmendment(f, c.tenant, original.id);
    await voidStoredEvent(f, c.tenant, abandoned);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 2,
      supportCount: 1,
      items: [{ eventId: original.id }],
    });
    const next = await createStoredAmendment(f, c.tenant, original.id);
    await finalizeStoredAmendment(f, c.tenant, next);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 3,
      supportCount: 1,
      items: [{ eventId: next, revision: 3 }],
    });
    const before = (
      await f.pool.query(
        "SELECT (to_jsonb(l)-'receiving_basis_version') AS lot FROM traceability_lots l WHERE id=$1",
        [c.lot],
      )
    ).rows;
    await voidStoredEvent(f, c.tenant, next);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 4,
      state: "missing",
      supportCount: 0,
      items: [],
    });
    expect(
      (
        await f.pool.query(
          "SELECT (to_jsonb(l)-'receiving_basis_version') AS lot FROM traceability_lots l WHERE id=$1",
          [c.lot],
        )
      ).rows,
    ).toEqual(before);
    const renewed = await receipt();
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 5,
      state: "present",
      supportCount: 1,
      items: [{ eventId: renewed.id }],
    });
  });
  it("keeps independent support after one of two receipts is void", async () => {
    const a = await receipt(),
      b = await receipt(true);
    await voidStoredEvent(f, c.tenant, a.id);
    expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
      basisVersion: 4,
      state: "present",
      supportCount: 1,
      items: [{ eventId: b.id, lineNos: [1, 2] }],
    });
  });
  it.each(["pointer", "counter", "snapshot", "unknown_kind", "missing_root"])(
    "fails closed on %s corruption even outside the requested page",
    async (kind) => {
      const saved = await receipt();
      const rollback = new Error("rollback synthetic corruption");
      await expect(
        f.db.transaction(async (tx) => {
          // Corruption is transaction-local and rolled back, including any dropped check.
          await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
          if (kind === "unknown_kind") {
            await tx.execute(
              sql`ALTER TABLE traceability_events DROP CONSTRAINT traceability_events_lifecycle_valid`,
            );
            await tx
              .update(schema.traceabilityEvents)
              .set({ type: "shipping" })
              .where(eq(schema.traceabilityEvents.id, saved.id));
          } else if (kind === "pointer")
            await tx
              .update(schema.receivingEventRoots)
              .set({ currentEventId: null })
              .where(eq(schema.receivingEventRoots.id, saved.id));
          else if (kind === "counter")
            await tx
              .update(schema.receivingEventRoots)
              .set({ nextRevision: 7 })
              .where(eq(schema.receivingEventRoots.id, saved.id));
          else if (kind === "snapshot")
            await tx
              .update(schema.traceabilityEvents)
              .set({ finalizationSnapshot: {} })
              .where(eq(schema.traceabilityEvents.id, saved.id));
          else
            await tx
              .update(schema.traceabilityEvents)
              .set({ rootEventId: randomUUID() })
              .where(eq(schema.traceabilityEvents.id, saved.id));
          await expect(
            readReceivingBasis(tx, c.tenant, c.lot, { limit: 1, offset: 100000 }),
          ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    },
  );
  it.each([
    { limit: "0" },
    { limit: "101" },
    { offset: "100001" },
    { offset: "01" },
    { history: "all" },
    { limit: ["1", "2"] },
  ])("rejects invalid or ambiguous pagination %j", async (query) => {
    await expect(store.getLotReceivingBasis(c.tenant, c.actor, c.lot, query)).rejects.toMatchObject(
      { status: 400 },
    );
  });
  it("rejects malformed lot identifiers without querying a different identity", async () => {
    await expect(
      store.getLotReceivingBasis(c.tenant, c.actor, "not-a-uuid", {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});
