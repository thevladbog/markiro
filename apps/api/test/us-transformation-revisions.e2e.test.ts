import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { emptyReceivingDraft, seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  finalizationCommand,
  seedTransformationRevision,
} from "./support/us-transformation-revision-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation bounded revision history", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => f?.close());

  it("pages all historical revisions in order with one root snapshot and visible void reason", async () => {
    const c = await seedTransformationRevision(f);
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Canceled correction",
      },
      "cancel-revision-2",
    );
    const thirdReceipt = await c.store.amend(
      c.tenant,
      c.actor,
      c.original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "New QA correction",
      },
      "start-revision-3",
    );
    if (thirdReceipt.record.status !== "draft") throw new Error("Expected revision 3 draft");
    const third = await c.store.finalize(
      c.tenant,
      c.actor,
      thirdReceipt.record.id,
      await finalizationCommand(c, thirdReceipt.record),
      "finalize-revision-3",
    );
    const first = await c.store.listRevisions(c.tenant, c.actor, third.id, { limit: 2, offset: 0 });
    const second = await c.store.listRevisions(c.tenant, c.actor, c.amendment.id, {
      limit: 2,
      offset: 2,
    });
    expect(first.items.map((row) => [row.revision, row.status])).toEqual([
      [1, "amended"],
      [2, "void"],
    ]);
    expect(second.items.map((row) => [row.revision, row.status])).toEqual([[3, "finalized"]]);
    expect(first.items[1]).toMatchObject({
      id: c.amendment.id,
      previousRevisionId: c.original.id,
      voidReason: "Canceled correction",
    });
    expect(second.items[0]).toMatchObject({
      id: third.id,
      previousRevisionId: c.original.id,
      amendmentReason: "New QA correction",
    });
    expect(
      [...first.items, ...second.items].map((row) => [
        row.rootId,
        row.eventNumber,
        row.timeZone,
        row.lifecycleVersion,
        row.currentEventId,
        row.pendingDraftId,
      ]),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        c.original.id,
        c.original.eventNumber,
        c.original.timeZone,
        6,
        third.id,
        null,
      ]),
    );
    expect(first.lifecycleVersion).toBe(6);
    expect(second.lifecycleVersion).toBe(6);
    expect(
      await c.store.listRevisions(c.tenant, c.actor, c.original.id, { limit: 2, offset: 3 }),
    ).toMatchObject({ items: [], limit: 2, offset: 3 });
  });

  it("reads both pages after a canceled draft and its finalized predecessor are void", async () => {
    const c = await seedTransformationRevision(f);
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel pending correction",
      },
      "cancel-revision-2",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Withdraw original",
      },
      "void-revision-1",
    );
    const first = await c.store.listRevisions(c.tenant, c.actor, c.original.id, {
      limit: 1,
      offset: 0,
    });
    const second = await c.store.listRevisions(c.tenant, c.actor, c.amendment.id, {
      limit: 1,
      offset: 1,
    });
    expect(first).toMatchObject({
      lifecycleVersion: 5,
      items: [
        {
          id: c.original.id,
          revision: 1,
          status: "void",
          voidReason: "Withdraw original",
          currentEventId: null,
          pendingDraftId: null,
        },
      ],
    });
    expect(second).toMatchObject({
      lifecycleVersion: 5,
      items: [
        {
          id: c.amendment.id,
          revision: 2,
          status: "void",
          previousRevisionId: c.original.id,
          voidReason: "Cancel pending correction",
          currentEventId: null,
          pendingDraftId: null,
        },
      ],
    });
  });

  it("rejects a corrupt lifecycle version before returning ordinary or empty off-page history", async () => {
    const c = await seedReceivingTenant(f.db);
    const store = new UsTransformationStore(f.db);
    const draft = await store.createDraft(
      c.tenant,
      c.actor,
      {
        operationKey: randomUUID(),
        draft: {
          eventDate: null,
          processorLocationId: null,
          reason: null,
          reasonNote: null,
          notes: null,
          inputs: [],
          outputs: [],
          documentIds: [],
        },
      },
      "create-lifecycle-corruption",
    );
    await f.pool.query("ALTER TABLE transformation_event_roots DISABLE TRIGGER USER");
    try {
      await f.pool.query(
        "UPDATE transformation_event_roots SET lifecycle_version=99 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, draft.id],
      );
    } finally {
      await f.pool.query("ALTER TABLE transformation_event_roots ENABLE TRIGGER USER");
    }
    for (const offset of [0, 100000]) {
      await expect(
        store.listRevisions(c.tenant, c.actor, draft.id, { limit: 1, offset }),
      ).rejects.toMatchObject({ status: 503 });
    }
  });

  it("denies foreign and wrong-type IDs and fails closed on a corrupt root or omitted predecessor", async () => {
    const c = await seedTransformationRevision(f);
    const other = await seedTransformationRevision(f);
    const receivingTenant = await seedReceivingTenant(f.db);
    const receiving = await new UsReceivingStore(f.db).createDraft(
      receivingTenant.tenant,
      receivingTenant.actor,
      { operationKey: randomUUID(), draft: emptyReceivingDraft },
      "receiving",
    );
    for (const id of [other.original.id, receiving.id, randomUUID()]) {
      await expect(
        c.store.listRevisions(c.tenant, c.actor, id, { limit: 2, offset: 0 }),
      ).rejects.toMatchObject({ status: 404, response: { code: "transformation_not_found" } });
    }
    // Deliberately bypass only user triggers in this disposable fixture to exercise read-time guards.
    await f.pool.query("ALTER TABLE transformation_event_roots DISABLE TRIGGER USER");
    try {
      await f.pool.query(
        "UPDATE transformation_event_roots SET event_number='TRN-26-9999' WHERE tenant_id=$1 AND id=$2",
        [c.tenant, c.original.id],
      );
    } finally {
      await f.pool.query("ALTER TABLE transformation_event_roots ENABLE TRIGGER USER");
    }
    await expect(
      c.store.listRevisions(c.tenant, c.actor, c.original.id, { limit: 1, offset: 0 }),
    ).rejects.toMatchObject({ status: 503 });
    await f.pool.query("ALTER TABLE transformation_event_roots DISABLE TRIGGER USER");
    try {
      await f.pool.query(
        "UPDATE transformation_event_roots SET event_number=$3 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, c.original.id, c.original.eventNumber],
      );
    } finally {
      await f.pool.query("ALTER TABLE transformation_event_roots ENABLE TRIGGER USER");
    }
    // Corrupt a row that lies beyond page 1 while preserving valid foreign keys.
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel",
      },
      "cancel",
    );
    const third = await c.store.amend(
      c.tenant,
      c.actor,
      c.original.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 4,
        reason: "Try again",
      },
      "third",
    );
    await f.pool.query("ALTER TABLE traceability_events DISABLE TRIGGER USER");
    try {
      await f.pool.query(
        "UPDATE traceability_events SET previous_revision_id=$3 WHERE tenant_id=$1 AND id=$2",
        [c.tenant, third.eventId, c.amendment.id],
      );
    } finally {
      await f.pool.query("ALTER TABLE traceability_events ENABLE TRIGGER USER");
    }
    await expect(
      c.store.listRevisions(c.tenant, c.actor, c.original.id, { limit: 1, offset: 0 }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("reloads read authorization before parsing a revision query", async () => {
    const c = await seedTransformationRevision(f);
    await f.db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, c.member));
    await expect(
      c.store.listRevisions(c.tenant, c.actor, c.original.id, null),
    ).rejects.toMatchObject({ status: 403 });
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.id, c.member));
    expect(
      (await c.store.listRevisions(c.tenant, c.actor, c.original.id, { limit: 1, offset: 0 }))
        .items,
    ).toHaveLength(1);
    await expect(
      c.store.listRevisions(c.tenant, c.actor, c.original.id, { limit: 101, offset: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
