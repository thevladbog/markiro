import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedTransformationRevision,
  finalizationCommand,
  downstreamDraft,
  revisionState,
} from "./support/us-transformation-revision-fixture";
import { readCurrentTransformationOrigin } from "../src/modules/traceability/transformation/us-transformation-origin";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation finalized void", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it("voids finalized origin after canceling a pending draft while retaining lot/history", async () => {
    const c = await seedTransformationRevision(f);
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel pending",
      },
      "cancel",
    );
    await f.pool.query(
      "UPDATE traceability_lots SET status='recalled',last_status_reason='Synthetic recall' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.original.snapshot.outputs[0]!.lotId],
    );
    const before = await revisionState(f, c.tenant);
    const lotId = c.original.snapshot.outputs[0]!.lotId;
    expect(
      await f.db.transaction((tx) => readCurrentTransformationOrigin(tx, c.tenant, lotId)),
    ).toEqual({ lotId, currentOrigin: true, eventId: c.original.id });
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 4,
      reason: "Wrong origin",
    };
    const result = await c.store.void(c.tenant, c.actor, c.original.id, command, "void-origin");
    expect(result.record).toMatchObject({
      status: "void",
      snapshot: c.original.snapshot,
      lifecycle: { currentEventId: null, pendingDraftId: null, lifecycleVersion: 5 },
    });
    const after = await revisionState(f, c.tenant);
    expect(after.edges).toEqual(before.edges);
    expect(
      await f.db.transaction((tx) => readCurrentTransformationOrigin(tx, c.tenant, lotId)),
    ).toEqual({ lotId, currentOrigin: false, eventId: null });
    expect(
      after.lots.map(
        ({ current_dependency_version: _epoch, ...lot }: Record<string, unknown>) => lot,
      ),
    ).toEqual(
      before.lots.map(
        ({ current_dependency_version: _epoch, ...lot }: Record<string, unknown>) => lot,
      ),
    );
    expect(await c.store.void(c.tenant, c.actor, c.original.id, command, "replay")).toEqual(result);
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        c.original.id,
        { ...command, reason: "Changed" },
        "different",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_operation_conflict" } });
    expect(
      after.audits.find((a: { request_id: string }) => a.request_id === "void-origin"),
    ).toMatchObject({
      organization_id: c.tenant,
      actor_user_id: c.actor,
      action: "traceability.transformation.voided",
      outcome: "success",
      target_type: "traceability_event",
      target_id: c.original.id,
      after: { reason: command.reason, result: "voided", record: result.record },
    });
  });
  it("blocks void of a current downstream origin and rejects pending, tenant and type mismatches", async () => {
    const c = await seedTransformationRevision(f);
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 3,
      reason: "Wrong origin",
    };
    await expect(
      c.store.void(c.tenant, c.actor, c.original.id, command, "pending"),
    ).rejects.toMatchObject({ response: { code: "transformation_pending_amendment" } });
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      { ...command, expectedDraftVersion: 1 },
      "cancel",
    );
    const child = await downstreamDraft(c);
    await c.store.finalize(
      c.tenant,
      c.actor,
      child.id,
      await finalizationCommand(c, child),
      "child",
    );
    const before = await revisionState(f, c.tenant);
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        c.original.id,
        { ...command, operationKey: randomUUID(), expectedLifecycleVersion: 4 },
        "blocked",
      ),
    ).rejects.toMatchObject({
      response: { code: "traceability_downstream_blocked", blockers: [{ eventId: child.id }] },
    });
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        c.origin.id,
        { ...command, operationKey: randomUUID() },
        "wrong-type",
      ),
    ).rejects.toMatchObject({ status: 404 });
    const other = await seedTransformationRevision(f);
    await expect(
      other.store.void(other.tenant, other.actor, c.original.id, command, "foreign"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      f.db.transaction((tx) =>
        readCurrentTransformationOrigin(tx, other.tenant, c.original.snapshot.outputs[0]!.lotId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await revisionState(f, c.tenant)).toEqual(before);
  });
  it("rejects stale lifecycle versions, rolls back audit failure and reauthorizes replay", async () => {
    const c = await seedTransformationRevision(f);
    const revision = await c.store.finalize(
      c.tenant,
      c.actor,
      c.amendment.id,
      await finalizationCommand(c, c.amendment),
      "revision",
    );
    const before = await revisionState(f, c.tenant);
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 4,
      reason: "Wrong origin",
    };
    await expect(
      c.store.void(
        c.tenant,
        c.actor,
        revision.id,
        { ...command, expectedLifecycleVersion: 3 },
        "stale",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_lifecycle_conflict" } });
    await f.pool.query(
      `CREATE FUNCTION reject_void_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.transformation.voided' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_void_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_void_audit()`,
    );
    try {
      await expect(
        c.store.void(c.tenant, c.actor, revision.id, command, "failure"),
      ).rejects.toThrow();
      expect(await revisionState(f, c.tenant)).toEqual(before);
    } finally {
      await f.pool.query(
        `DROP TRIGGER reject_void_audit ON tenant_audit_events; DROP FUNCTION reject_void_audit()`,
      );
    }
    const result = await c.store.void(c.tenant, c.actor, revision.id, command, "success");
    expect(result.record.status).toBe("void");
    await f.pool.query("UPDATE member SET role='viewer' WHERE id=$1", [c.member]);
    await expect(
      c.store.void(c.tenant, c.actor, revision.id, command, "unauthorized-replay"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("ignores void historical consumers while retaining their edges", async () => {
    const c = await seedTransformationRevision(f);
    await c.store.void(
      c.tenant,
      c.actor,
      c.amendment.id,
      {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 3,
        expectedDraftVersion: 1,
        reason: "Cancel pending",
      },
      "cancel",
    );
    const child = await downstreamDraft(c);
    await c.store.finalize(
      c.tenant,
      c.actor,
      child.id,
      await finalizationCommand(c, child),
      "child",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      child.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Cancel descendant" },
      "void-child",
    );
    const before = await revisionState(f, c.tenant);
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Cancel origin" },
      "void-origin",
    );
    expect((await revisionState(f, c.tenant)).edges).toEqual(before.edges);
  });
});
