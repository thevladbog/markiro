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
describe.skipIf(!url)("Transformation revision concurrency", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it.each(["consumer", "origin"])(
    "forces %s first against finalized void and retries a waiting stale snapshot",
    async (first) => {
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
      const childCommand = await finalizationCommand(c, child);
      const runConsumer = () =>
        c.store.finalize(c.tenant, c.actor, child.id, childCommand, "race-consumer");
      const runOrigin = () =>
        c.store.void(
          c.tenant,
          c.actor,
          c.original.id,
          { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Invalid origin" },
          "race-origin",
        );
      const eventId = first === "consumer" ? child.id : c.original.id;
      const status = first === "consumer" ? "finalized" : "void";
      const settle = (run: () => Promise<unknown>) =>
        run().then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      let leader: ReturnType<typeof settle> | undefined,
        follower: ReturnType<typeof settle> | undefined;
      const barrier = await f.pool.connect();
      try {
        await barrier.query("SELECT pg_advisory_lock(20404)");
        await f.pool.query(
          `CREATE FUNCTION revision_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${eventId}'::uuid AND NEW.status='${status}' THEN PERFORM pg_advisory_xact_lock(20404); END IF; RETURN NEW; END $$; CREATE TRIGGER revision_barrier BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION revision_barrier()`,
        );
        leader = settle(first === "consumer" ? runConsumer : runOrigin);
        let pid: number | undefined;
        await expect
          .poll(
            async () => {
              const rows = (
                await f.pool.query<{ pid: number }>(
                  "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'update%traceability_events%'",
                )
              ).rows;
              pid = rows[0]?.pid;
              return rows.length;
            },
            { timeout: 3000 },
          )
          .toBe(1);
        follower = settle(first === "consumer" ? runOrigin : runConsumer);
        await expect
          .poll(
            async () =>
              (
                await f.pool.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%traceability_lots%'",
                  [pid],
                )
              ).rows[0]?.n,
            { timeout: 3000 },
          )
          .toBe(1);
        await barrier.query("SELECT pg_advisory_unlock(20404)");
        expect(await leader).toMatchObject({ ok: true });
        expect(await follower).toMatchObject({
          ok: false,
          error: {
            response: {
              code: first === "consumer" ? "traceability_downstream_blocked" : "event_incomplete",
            },
          },
        });
        const state = await revisionState(f, c.tenant);
        expect(state.roots.find((r: { id: string }) => r.id === c.original.id)).toMatchObject({
          current_event_id: first === "consumer" ? c.original.id : null,
          pending_draft_id: null,
          lifecycle_version: first === "consumer" ? 4 : 5,
        });
        expect(state.events.find((e: { id: string }) => e.id === child.id)).toMatchObject({
          status: first === "consumer" ? "finalized" : "draft",
        });
        expect(
          state.lots.find((l: { id: string }) => l.id === c.original.snapshot.outputs[0]!.lotId),
        ).toMatchObject({ current_dependency_version: 2, status: "active" });
        expect(
          state.audits.filter(
            (a: { request_id: string; target_type: string }) =>
              ["race-consumer", "race-origin"].includes(a.request_id) &&
              a.target_type === "traceability_event",
          ),
        ).toMatchObject([
          {
            organization_id: c.tenant,
            actor_user_id: c.actor,
            action:
              first === "consumer"
                ? "traceability.transformation.finalized"
                : "traceability.transformation.voided",
            target_id: eventId,
            outcome: "success",
          },
        ]);
      } finally {
        await barrier.query("SELECT pg_advisory_unlock(20404)");
        await leader;
        await follower;
        await f.pool.query(
          "DROP TRIGGER IF EXISTS revision_barrier ON traceability_events; DROP FUNCTION IF EXISTS revision_barrier()",
        );
        barrier.release();
      }
    },
  );
  it.each(["finalize", "void"])(
    "serializes pending amendment %s first on its root",
    async (first) => {
      const c = await seedTransformationRevision(f);
      const command = await finalizationCommand(c, c.amendment);
      const runFinalize = () =>
        c.store.finalize(c.tenant, c.actor, c.amendment.id, command, "race-finalize");
      const runVoid = () =>
        c.store.void(
          c.tenant,
          c.actor,
          c.amendment.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 3,
            expectedDraftVersion: 1,
            reason: "Cancel draft",
          },
          "race-void",
        );
      const settle = (run: () => Promise<unknown>) =>
        run().then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      let leader: ReturnType<typeof settle> | undefined,
        follower: ReturnType<typeof settle> | undefined;
      const barrier = await f.pool.connect();
      try {
        await barrier.query("SELECT pg_advisory_lock(20405)");
        await f.pool.query(
          `CREATE FUNCTION pending_revision_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${c.amendment.id}'::uuid AND NEW.status='${first === "finalize" ? "finalized" : "void"}' THEN PERFORM pg_advisory_xact_lock(20405); END IF; RETURN NEW; END $$; CREATE TRIGGER pending_revision_barrier BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION pending_revision_barrier()`,
        );
        leader = settle(first === "finalize" ? runFinalize : runVoid);
        let pid: number | undefined;
        await expect
          .poll(
            async () => {
              const rows = (
                await f.pool.query<{ pid: number }>(
                  "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'update%traceability_events%'",
                )
              ).rows;
              pid = rows[0]?.pid;
              return rows.length;
            },
            { timeout: 3000 },
          )
          .toBe(1);
        follower = settle(first === "finalize" ? runVoid : runFinalize);
        await expect
          .poll(
            async () =>
              (
                await f.pool.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%transformation_event_roots%'",
                  [pid],
                )
              ).rows[0]?.n,
            { timeout: 3000 },
          )
          .toBe(1);
        await barrier.query("SELECT pg_advisory_unlock(20405)");
        expect(await leader).toMatchObject({ ok: true });
        expect(await follower).toMatchObject({
          ok: false,
          error: {
            response: {
              code:
                first === "finalize"
                  ? "transformation_lifecycle_conflict"
                  : "transformation_not_draft",
            },
          },
        });
        const state = await revisionState(f, c.tenant);
        expect(state.roots.find((r: { id: string }) => r.id === c.original.id)).toMatchObject({
          current_event_id: first === "finalize" ? c.amendment.id : c.original.id,
          pending_draft_id: null,
          lifecycle_version: 4,
        });
      } finally {
        await barrier.query("SELECT pg_advisory_unlock(20405)");
        await leader;
        await follower;
        await f.pool.query(
          "DROP TRIGGER IF EXISTS pending_revision_barrier ON traceability_events; DROP FUNCTION IF EXISTS pending_revision_barrier()",
        );
        barrier.release();
      }
    },
  );
});
