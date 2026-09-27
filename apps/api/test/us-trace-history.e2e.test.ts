import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedShippingLifecycle } from "./support/us-shipping-lifecycle-fixture";
import {
  seedTwoByTwoGenealogy,
  seedVoidedAmendmentDraftGenealogy,
} from "./support/us-transformation-genealogy-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("excluded trace history", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    f = await createUsProfileTestDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("reads Receiving drafts and void metadata without fabricating frozen evidence", async () => {
    const c = await seedCompleteReceiving(f.db);
    const receiving = new UsReceivingStore(f.db);
    const saved = await receiving.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "history-receiving",
    );
    const store = new UsTraceStore(f.db);
    expect((await store.history(c.tenant, c.actor, c.lot, {})).items[0]).toMatchObject({
      eventId: saved.id,
      type: "receiving",
      status: "draft",
      eventNumber: saved.eventNumber,
      revision: 1,
    });
    await receiving.void(
      c.tenant,
      c.actor,
      saved.id,
      {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: 1,
        expectedDraftVersion: 1,
        reason: "Receipt cancelled",
      },
      "history-receiving-void",
    );
    expect((await store.history(c.tenant, c.actor, c.lot, {})).items[0]).toMatchObject({
      eventId: saved.id,
      type: "receiving",
      status: "void",
      reason: "Receipt cancelled",
    });
  });

  it("fails closed for mismatched excluded event roots instead of undercounting", async () => {
    const c = await seedShippingLifecycle(f.db);
    const saved = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "history-corruption",
    );
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE shipping_event_roots DISABLE TRIGGER USER`);
      await tx.execute(
        sql`UPDATE shipping_event_roots SET event_number='SHP-26-9999' WHERE id=${saved.id}`,
      );
      await tx.execute(sql`ALTER TABLE shipping_event_roots ENABLE TRIGGER USER`);
    });
    const store = new UsTraceStore(f.db);
    await expect(store.history(c.tenant, c.actor, c.lot, {})).rejects.toMatchObject({
      status: 503,
    });
    await expect(store.read(c.tenant, c.actor, c.lot, { maxDepth: "0" })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("paginates equal creation timestamps with UUID ties and permits later insertions", async () => {
    const c = await seedShippingLifecycle(f.db);
    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      const saved = await c.store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: { ...c.draft, eventDate: null } },
        "history-draft",
      );
      ids.push(saved.id);
    }
    // Owned disposable database only: force a microsecond tie that real clocks can produce.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE traceability_events DISABLE TRIGGER USER`);
      await tx.execute(
        sql`UPDATE traceability_events SET created_at='2026-09-01T01:02:03.123456Z' WHERE id=ANY(${sql.param(ids)}::uuid[])`,
      );
      await tx.execute(sql`ALTER TABLE traceability_events ENABLE TRIGGER USER`);
    });
    ids.sort();
    const store = new UsTraceStore(f.db);
    const first = await store.history(c.tenant, c.actor, c.lot, { limit: "1" });
    expect(first.items.map((i) => i.eventId)).toEqual([ids[0]]);
    expect(first.items[0]).toMatchObject({
      type: "shipping",
      status: "draft",
      eventDate: null,
      reason: null,
      previousRevisionId: null,
      nextRevisionId: null,
    });
    expect(first.nextCursor).not.toBeNull();
    const inserted = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "later-draft",
    );
    const second = await store.history(c.tenant, c.actor, c.lot, {
      limit: "1",
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.eventId)).toEqual([ids[1]]);
    const third = await store.history(c.tenant, c.actor, c.lot, {
      limit: "1",
      cursor: second.nextCursor,
    });
    expect(third.items.map((i) => i.eventId)).toEqual([inserted.id]);
    expect(third.nextCursor).toBeNull();
  });

  it("excludes a pending amendment without withdrawing its current predecessor", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const pending = await c.store.amend(
      c.tenant,
      c.actor,
      c.revision.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Pending correction" },
      "history-amend",
    );
    const lot = c.revision.snapshot.outputs[0]!.lotId;
    const store = new UsTraceStore(f.db);
    const history = await store.history(c.tenant, c.actor, lot, {});
    expect(history.items.map((i) => i.eventId)).toEqual([c.original.id, pending.record.id]);
    expect(history.items[0]).toMatchObject({
      status: "amended",
      nextRevisionId: c.revision.id,
      previousRevisionId: null,
      eventNumber: c.original.eventNumber,
      eventDate: c.original.snapshot.eventDate,
    });
    expect(history.items[1]).toMatchObject({
      status: "draft",
      reason: "Pending correction",
      previousRevisionId: c.revision.id,
      nextRevisionId: null,
    });
    expect((await store.read(c.tenant, c.actor, lot, {})).currentEvents.map((i) => i.id)).toContain(
      c.revision.id,
    );
  });

  it("returns saved lifecycle metadata for void drafts without snapshots", async () => {
    const c = await seedVoidedAmendmentDraftGenealogy(f);
    const page = await new UsTraceStore(f.db).history(
      c.tenant,
      c.actor,
      c.original.snapshot.outputs[0]!.lotId,
      {},
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      eventId: c.voidedDraft.id,
      status: "void",
      reason: "Cancel proposed correction",
      previousRevisionId: c.original.id,
      nextRevisionId: null,
    });
  });

  it("bounds and validates cursors and hides foreign lots", async () => {
    const a = await seedShippingLifecycle(f.db),
      b = await seedShippingLifecycle(f.db);
    const store = new UsTraceStore(f.db);
    for (const cursor of [
      "!",
      "a".repeat(513),
      Buffer.from('{"createdAt":"bad"}').toString("base64url"),
    ]) {
      await expect(store.history(a.tenant, a.actor, a.lot, { cursor })).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(store.history(a.tenant, a.actor, b.lot, {})).rejects.toMatchObject({
      status: 404,
    });
    await f.db.delete(schema.member).where(eq(schema.member.organizationId, a.tenant));
    await expect(store.history(a.tenant, a.actor, a.lot, {})).rejects.toMatchObject({
      status: 403,
    });
  });

  it("counts only excluded revisions touching visible lots in a limited trace", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const pending = await c.store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.saved.draft },
      "input-only-draft",
    );
    expect(pending.status).toBe("draft");
    const store = new UsTraceStore(f.db),
      lot = c.revision.snapshot.outputs[0]!.lotId;
    expect(
      (await store.read(c.tenant, c.actor, lot, { maxDepth: "0" })).excludedSummary.count,
    ).toBe(1);
    expect((await store.read(c.tenant, c.actor, lot, {})).excludedSummary.count).toBe(2);
  });
});
