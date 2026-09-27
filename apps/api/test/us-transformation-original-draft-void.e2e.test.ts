import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import {
  seedFinalizableTransformation,
  transformationEffects,
} from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

async function readEffects(f: Fixture, tenant: string) {
  const { rows } = await f.pool.query(
    `SELECT
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM traceability_lots x WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY event_id,input_lot_id,output_lot_id) FROM lot_genealogy_edges x WHERE tenant_id=$1) AS edges,
      (SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM trace_lot_boxes x WHERE tenant_id=$1) AS cases,
      (SELECT jsonb_agg(finalization_snapshot ORDER BY id) FROM traceability_events x WHERE tenant_id=$1 AND finalization_snapshot IS NOT NULL) AS snapshots`,
    [tenant],
  );
  return rows[0];
}

describe.skipIf(!url)("Transformation original draft void", () => {
  let f: Fixture;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => f?.close());

  it("retains a void original as history without lot, case, genealogy or snapshot effects", async () => {
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
      "create-original",
    );
    const beforeEffects = await readEffects(f, c.tenant);
    const command = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      expectedDraftVersion: draft.draftVersion,
      reason: "Duplicate work order",
    };
    const receipt = await store.void(c.tenant, c.actor, draft.id, command, "void-original");
    expect(receipt.record).toMatchObject({
      status: "void",
      id: draft.id,
      lifecycle: {
        currentEventId: null,
        pendingDraftId: null,
        lifecycleVersion: 2,
        voidReason: command.reason,
        voidedBy: c.actor,
      },
    });
    expect(await store.void(c.tenant, c.actor, draft.id, command, "exact-replay")).toEqual(receipt);
    expect(await store.getRecord(c.tenant, c.actor, draft.id)).toEqual(receipt.record);
    expect(await readEffects(f, c.tenant)).toEqual(beforeEffects);
    await expect(
      store.amend(
        c.tenant,
        c.actor,
        draft.id,
        { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Reopen" },
        "reopen",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_lifecycle_conflict" } });
    await expect(
      store.saveDraft(
        c.tenant,
        c.actor,
        draft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: draft.draftVersion,
          draft: draft.draft,
        },
        "save-void",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_not_draft" } });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          eq(schema.tenantAuditEvents.targetId, draft.id),
        ),
      );
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.action === "traceability.transformation.voided")).toMatchObject({
      organizationId: c.tenant,
      actorUserId: c.actor,
      action: "traceability.transformation.voided",
      outcome: "success",
      targetType: "traceability_event",
      targetId: draft.id,
      before: draft,
      after: {
        rootId: draft.id,
        revision: 1,
        reason: command.reason,
        result: "voided",
        record: receipt.record,
      },
      requestId: "void-original",
    });
    await f.db
      .update(schema.member)
      .set({ role: "traceability_production" })
      .where(eq(schema.member.id, c.member));
    await expect(
      store.void(c.tenant, c.actor, draft.id, command, "denied-replay"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires exact current versions and a reason", async () => {
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
      "create",
    );
    const base = {
      operationKey: randomUUID(),
      expectedLifecycleVersion: 1,
      expectedDraftVersion: 1,
      reason: "Duplicate",
    };
    await expect(
      store.void(c.tenant, c.actor, draft.id, { ...base, expectedDraftVersion: 2 }, "stale-draft"),
    ).rejects.toMatchObject({ response: { code: "transformation_draft_conflict" } });
    await expect(
      store.void(
        c.tenant,
        c.actor,
        draft.id,
        { ...base, expectedLifecycleVersion: 2 },
        "stale-lifecycle",
      ),
    ).rejects.toMatchObject({ response: { code: "transformation_lifecycle_conflict" } });
    await expect(
      store.void(c.tenant, c.actor, draft.id, { ...base, reason: "" }, "no-reason"),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.getRecord(c.tenant, c.actor, draft.id)).status).toBe("draft");
  });

  it.each([
    ["save", "void", "transformation_draft_conflict"],
    ["void", "save", "transformation_not_draft"],
    ["finalize", "void", "transformation_lifecycle_conflict"],
    ["void", "finalize", "transformation_not_draft"],
  ] as const)("serializes original draft %s before %s", async (first, second, losingCode) => {
    const c = await seedFinalizableTransformation(f);
    const commands = {
      save: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        draft: { ...c.saved.draft, notes: "Revised before QA" },
      },
      void: {
        operationKey: randomUUID(),
        expectedLifecycleVersion: 1,
        expectedDraftVersion: 1,
        reason: "Cancel original draft",
      },
      finalize: c.command,
    };
    const run = (action: "save" | "void" | "finalize") =>
      action === "save"
        ? c.store.saveDraft(c.tenant, c.actor, c.saved.id, commands.save, `race-${action}`)
        : action === "void"
          ? c.store.void(c.tenant, c.actor, c.saved.id, commands.void, `race-${action}`)
          : c.store.finalize(c.tenant, c.actor, c.saved.id, commands.finalize, `race-${action}`);
    const settle = (action: "save" | "void" | "finalize") =>
      run(action).then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
    const barrier = await f.pool.connect();
    const key = 20406;
    let leader: ReturnType<typeof settle> | undefined;
    let follower: ReturnType<typeof settle> | undefined;
    try {
      await barrier.query("SELECT pg_advisory_lock($1)", [key]);
      await f.pool.query(
        `CREATE FUNCTION original_void_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.id='${c.saved.id}'::uuid AND
            (NEW.status='void' OR NEW.status='finalized' OR NEW.draft_version=2)
          THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
          RETURN NEW; END $$;
          CREATE TRIGGER original_void_barrier BEFORE UPDATE ON traceability_events
          FOR EACH ROW EXECUTE FUNCTION original_void_barrier()`,
      );
      leader = settle(first);
      let leaderPid: number | undefined;
      await expect
        .poll(
          async () => {
            const rows = (
              await f.pool.query<{ pid: number }>(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'update%traceability_events%'",
              )
            ).rows;
            leaderPid = rows[0]?.pid;
            return rows.length;
          },
          { timeout: 3000 },
        )
        .toBe(1);
      follower = settle(second);
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%transformation_event_roots%'",
                [leaderPid],
              )
            ).rows[0]?.n,
          { timeout: 3000 },
        )
        .toBe(1);
      await barrier.query("SELECT pg_advisory_unlock($1)", [key]);
      expect(await leader).toMatchObject({ ok: true });
      expect(await follower).toMatchObject({
        ok: false,
        error: { status: 409, response: { code: losingCode } },
      });
      const state = await f.pool.query<{
        status: string;
        draft_version: number;
        lifecycle_version: number;
        current_event_id: string | null;
        pending_draft_id: string | null;
      }>(
        `SELECT e.status,e.draft_version,r.lifecycle_version,r.current_event_id,r.pending_draft_id
         FROM traceability_events e JOIN transformation_event_roots r
           ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id
         WHERE e.tenant_id=$1 AND e.id=$2`,
        [c.tenant, c.saved.id],
      );
      expect(state.rows[0]).toEqual({
        status: first === "save" ? "draft" : first === "void" ? "void" : "finalized",
        draft_version: first === "save" ? 2 : 1,
        lifecycle_version: first === "save" ? 1 : 2,
        current_event_id: first === "finalize" ? c.saved.id : null,
        pending_draft_id: first === "save" ? c.saved.id : null,
      });
      const evidence = await f.pool.query<{
        request_id: string;
        action: string;
        outcome: string;
        actor_user_id: string;
        organization_id: string;
        target_id: string;
      }>(
        "SELECT request_id,action,outcome,actor_user_id,organization_id,target_id FROM tenant_audit_events WHERE organization_id=$1 AND request_id IN ('race-save','race-void','race-finalize') ORDER BY request_id",
        [c.tenant],
      );
      expect(evidence.rows.filter((row) => row.target_id === c.saved.id)).toEqual([
        expect.objectContaining({
          request_id: `race-${first}`,
          action: `traceability.transformation.${first === "save" ? "draft_saved" : first === "void" ? "voided" : "finalized"}`,
          outcome: "success",
          actor_user_id: c.actor,
          organization_id: c.tenant,
          target_id: c.saved.id,
        }),
      ]);
      expect(evidence.rows.filter((row) => row.request_id === `race-${second}`)).toEqual([]);
      const receipts = await f.pool.query<{ command: string; operation_key: string }>(
        "SELECT command,operation_key FROM transformation_operations WHERE tenant_id=$1 AND event_id=$2 AND operation_key IN ($3,$4)",
        [c.tenant, c.saved.id, commands[first].operationKey, commands[second].operationKey],
      );
      expect(receipts.rows).toEqual([
        { command: `transformation.${first}`, operation_key: commands[first].operationKey },
      ]);
      expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
        lots: first === "finalize" ? 1 : 0,
        edges: first === "finalize" ? 2 : 0,
        bindings: first === "finalize" ? 1 : 0,
        receipts: first === "finalize" ? 1 : 0,
        audits: first === "finalize" ? 1 : 0,
      });
    } finally {
      await barrier.query("SELECT pg_advisory_unlock($1)", [key]);
      await leader;
      await follower;
      await f.pool.query(
        "DROP TRIGGER IF EXISTS original_void_barrier ON traceability_events; DROP FUNCTION IF EXISTS original_void_barrier()",
      );
      barrier.release();
    }
  });
});
