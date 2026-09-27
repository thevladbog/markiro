import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedTransformationRevision,
  finalizationCommand,
  downstreamDraft,
  revisionState,
} from "./support/us-transformation-revision-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation amendment finalization", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it("replaces inputs with stable output identity and immutable prior evidence", async () => {
    const c = await seedTransformationRevision(f);
    await f.pool.query(
      "UPDATE traceability_lots SET status='quarantined',last_status_reason='Synthetic hold' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.original.snapshot.outputs[0]!.lotId],
    );
    const before = await revisionState(f, c.tenant);
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...c.amendment.draft, inputs: [c.amendment.draft.inputs[0]!] },
      },
      "save",
    );
    const command = await finalizationCommand(c, saved);
    const result = await c.store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      command,
      "revision-finalize",
    );
    expect(result.snapshot).toMatchObject({
      revision: 2,
      previousRevisionId: c.original.id,
      outputs: c.original.snapshot.outputs,
    });
    expect(result.snapshot.inputs).toHaveLength(1);
    expect(result.lifecycle).toMatchObject({
      currentEventId: saved.id,
      pendingDraftId: null,
      lifecycleVersion: 4,
    });
    expect(await c.store.getRecord(c.tenant, c.actor, c.original.id)).toMatchObject({
      status: "amended",
      snapshot: c.original.snapshot,
      lifecycle: { supersededByEventId: saved.id },
    });
    const after = await revisionState(f, c.tenant);
    expect(after.edges.filter((e: { event_id: string }) => e.event_id === c.original.id)).toEqual(
      before.edges,
    );
    expect(
      after.lots.map(
        ({ current_dependency_version: _epoch, ...lot }: Record<string, unknown>) => lot,
      ),
    ).toEqual(
      before.lots.map(
        ({ current_dependency_version: _epoch, ...lot }: Record<string, unknown>) => lot,
      ),
    );
    expect(await c.store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(result);
    expect(
      after.audits.find((a: { request_id: string }) => a.request_id === "revision-finalize"),
    ).toMatchObject({
      organization_id: c.tenant,
      actor_user_id: c.actor,
      action: "traceability.transformation.finalized",
      outcome: "success",
      target_type: "traceability_event",
      target_id: saved.id,
      before: saved,
      after: result,
    });
  });
  it("blocks material change with downstream but allows documentary-only correction", async () => {
    const c = await seedTransformationRevision(f);
    const child = await downstreamDraft(c);
    await c.store.finalize(
      c.tenant,
      c.actor,
      child.id,
      await finalizationCommand(c, child),
      "child",
    );
    const changed = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...c.amendment.draft, eventDate: "2026-09-25" },
      },
      "change",
    );
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        changed.id,
        await finalizationCommand(c, changed),
        "blocked",
      ),
    ).rejects.toMatchObject({
      response: {
        code: "traceability_downstream_blocked",
        blockers: [
          {
            lotId: c.original.snapshot.outputs[0]!.lotId,
            eventId: child.id,
            rootId: child.id,
            revision: 1,
          },
        ],
      },
    });
    expect(await revisionState(f, c.tenant)).toEqual(before);
    const documentary = await c.store.saveDraft(
      c.tenant,
      c.actor,
      changed.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        draft: {
          ...c.amendment.draft,
          notes: "Documentary correction",
          reasonNote: "Updated annotation",
        },
      },
      "documentary",
    );
    const result = await c.store.finalize(
      c.tenant,
      c.actor,
      documentary.id,
      await finalizationCommand(c, documentary),
      "documentary-finalize",
    );
    expect(result.snapshot.inputs).toEqual(c.original.snapshot.inputs);
    expect(result.snapshot.outputs).toEqual(c.original.snapshot.outputs);
    const after = await revisionState(f, c.tenant);
    expect(after.edges.filter((e: { event_id: string }) => e.event_id === c.original.id)).toEqual(
      before.edges.filter((e: { event_id: string }) => e.event_id === c.original.id),
    );
  });
  it("rejects a self-cycle in the candidate current graph", async () => {
    const c = await seedTransformationRevision(f);
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.amendment.draft,
          inputs: [
            {
              kind: "ftl_lot",
              lotId: c.original.snapshot.outputs[0]!.lotId,
              quantity: "1",
              unitOfMeasure: "case",
            },
          ],
        },
      },
      "cycle",
    );
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        await finalizationCommand(c, saved),
        "cycle-finalize",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_genealogy_cycle" } });
    expect(await revisionState(f, c.tenant)).toEqual(before);
  });
  it.each(["audit", "edge", "receipt"])(
    "rolls back all amendment effects on %s insertion failure",
    async (failure) => {
      const c = await seedTransformationRevision(f);
      const command = await finalizationCommand(c, c.amendment);
      const before = await revisionState(f, c.tenant);
      const table = {
        audit: "tenant_audit_events",
        edge: "lot_genealogy_edges",
        receipt: "transformation_operations",
      }[failure];
      await f.pool.query(
        `CREATE FUNCTION reject_revision_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic revision failure'; END $$; CREATE TRIGGER reject_revision_effect BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_revision_effect()`,
      );
      try {
        await expect(
          c.store.finalize(c.tenant, c.actor, c.amendment.id, command, "failure"),
        ).rejects.toThrow();
        expect(await revisionState(f, c.tenant)).toEqual(before);
      } finally {
        await f.pool.query(
          `DROP TRIGGER reject_revision_effect ON ${table}; DROP FUNCTION reject_revision_effect()`,
        );
      }
    },
  );
  it("rejects stale draft/readiness and replaced pending revisions, and reauthorizes replay", async () => {
    const c = await seedTransformationRevision(f);
    const command = await finalizationCommand(c, c.amendment);
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        c.amendment.id,
        { ...command, expectedDraftVersion: 2 },
        "stale-version",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_draft_conflict" } });
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        c.amendment.id,
        { ...command, expectedInputDigest: "0".repeat(64) },
        "stale-readiness",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_readiness_changed" } });
    await expect(
      c.store.finalize(c.tenant, c.actor, c.origin.id, command, "wrong-type"),
    ).rejects.toMatchObject({ status: 404 });
    const other = await seedTransformationRevision(f);
    await expect(
      other.store.finalize(other.tenant, other.actor, c.amendment.id, command, "foreign"),
    ).rejects.toMatchObject({ status: 404 });
    expect(await revisionState(f, c.tenant)).toEqual(before);
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
    const next = await c.store.amend(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "New correction" },
      "next",
    );
    await expect(
      c.store.finalize(c.tenant, c.actor, c.amendment.id, command, "obsolete"),
    ).rejects.toMatchObject({ response: { code: "transformation_not_draft" } });
    if (next.record.status !== "draft") throw new Error("Expected draft");
    const nextCommand = await finalizationCommand(c, next.record);
    const finalized = await c.store.finalize(
      c.tenant,
      c.actor,
      next.eventId,
      nextCommand,
      "new-finalize",
    );
    expect(finalized.revision).toBe(3);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        next.eventId,
        { ...nextCommand, expectedDraftVersion: 2 },
        "body-conflict",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
    await f.pool.query("UPDATE member SET role='viewer' WHERE id=$1", [c.member]);
    await expect(
      c.store.finalize(c.tenant, c.actor, next.eventId, nextCommand, "unauthorized-replay"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("rejects forged server-owned output bindings on finalization", async () => {
    const c = await seedTransformationRevision(f);
    await f.pool.query(
      "UPDATE transformation_event_outputs SET lot_id=$1 WHERE tenant_id=$2 AND event_id=$3",
      [c.origin.snapshot.items[0]!.lotId, c.tenant, c.amendment.id],
    );
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        c.amendment.id,
        await finalizationCommand(c, c.amendment),
        "forged",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_output_identity_locked" } });
    expect(await revisionState(f, c.tenant)).toEqual(before);
  });
  it("rejects a cycle through another current revision without rewriting historical edges", async () => {
    const c = await seedTransformationRevision(f);
    const child = await downstreamDraft(c);
    const finalizedChild = await c.store.finalize(
      c.tenant,
      c.actor,
      child.id,
      await finalizationCommand(c, child),
      "child",
    );
    const saved = await c.store.saveDraft(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: {
          ...c.amendment.draft,
          inputs: [
            {
              kind: "ftl_lot",
              lotId: finalizedChild.snapshot.outputs[0]!.lotId,
              quantity: "1",
              unitOfMeasure: "case",
            },
          ],
        },
      },
      "cycle",
    );
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        await finalizationCommand(c, saved),
        "cycle-finalize",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_genealogy_cycle" } });
    expect(await revisionState(f, c.tenant)).toEqual(before);
  });
});
