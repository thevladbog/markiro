import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  seedFinalizableTransformation,
  type TransformationFixtureDatabase,
} from "./us-transformation-finalization-fixture";

export async function seedMixedEvents(f: TransformationFixtureDatabase) {
  const c = await seedFinalizableTransformation(f);
  const original = await c.store.finalize(
    c.tenant,
    c.actor,
    c.saved.id,
    c.command,
    "events-finalize",
  );
  const amended = await c.store.amend(
    c.tenant,
    c.actor,
    original.id,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 2,
      reason: "Correct production",
    },
    "events-amend",
  );
  if (amended.record.status !== "draft") throw new Error("Expected amendment");
  const ready = await c.store.checkReadiness(c.tenant, c.actor, amended.eventId, {
    expectedDraftVersion: 1,
  });
  await c.store.finalize(
    c.tenant,
    c.actor,
    amended.eventId,
    {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: ready.inputDigest,
    },
    "events-revise",
  );
  const pending = await c.store.amend(
    c.tenant,
    c.actor,
    amended.eventId,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 4,
      reason: "Pending review",
    },
    "events-pending",
  );
  const receivingDraft = await c.receiving.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: c.draft,
    },
    "events-receiving",
  );
  const voidDraft = await c.store.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: { ...c.saved.draft, inputs: [], outputs: [], documentIds: [] },
    },
    "events-void-draft",
  );
  await c.store.void(
    c.tenant,
    c.actor,
    voidDraft.id,
    {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      expectedDraftVersion: 1,
      reason: "Duplicate",
    },
    "events-void",
  );
  const lastReceiving = await c.receiving.createDraft(
    c.tenant,
    c.actor,
    {
      operationKey: randomUUID(),
      draft: { ...c.draft, items: [] },
    },
    "events-last",
  );
  const orderedIds = [
    lastReceiving.id,
    voidDraft.id,
    receivingDraft.id,
    pending.eventId,
    amended.eventId,
    c.origin.id,
  ];
  await f.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
    for (const [index, id] of [...orderedIds, original.id].entries())
      await tx.execute(
        sql`UPDATE traceability_events SET created_at=${new Date(Date.UTC(2026, 0, 10 - index)).toISOString()}::timestamptz WHERE tenant_id=${c.tenant} AND id=${id}`,
      );
  });
  const foreign = await seedFinalizableTransformation(f);
  return {
    ...c,
    original,
    amended,
    pending,
    receivingDraft,
    voidDraft,
    lastReceiving,
    receivingIds: [c.origin.id, receivingDraft.id, lastReceiving.id],
    transformationIds: [original.id, amended.eventId, pending.eventId, voidDraft.id],
    foreignEventId: foreign.saved.id,
    orderedIds,
    expectedFirstFourIds: orderedIds.slice(0, 4),
  };
}
