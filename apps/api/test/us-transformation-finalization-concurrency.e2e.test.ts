import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  seedFinalizableTransformation,
  transformationEffects,
  type TransformationFixtureDatabase,
} from "./support/us-transformation-finalization-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("Transformation finalization concurrency", () => {
  let f: TransformationFixtureDatabase;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it("returns one durable result for concurrent identical operation keys", async () => {
    const c = await seedFinalizableTransformation(f);
    const [a, b] = await Promise.all(
      ["a", "b"].map((request) =>
        c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, request),
      ),
    );
    expect(a).toEqual(b);
    expect(a?.status).toBe("finalized");
    expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
  });
  it("serializes different keys on one original draft without duplicate output or evidence", async () => {
    const c = await seedFinalizableTransformation(f);
    const results = await Promise.allSettled(
      ["a", "b"].map((request) =>
        c.store.finalize(
          c.tenant,
          c.actor,
          c.saved.id,
          { ...c.command, operationKey: randomUUID() },
          request,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { response: { code: "transformation_not_draft" } },
    });
    expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
      lots: 1,
      edges: 2,
      bindings: 1,
      receipts: 1,
      audits: 1,
    });
  });

  it("locks input lots in UUID order and reloads coverage after a concurrent change", async () => {
    const c = await seedFinalizableTransformation(f);
    const firstLotId = c.origin.snapshot.items.map((line) => line.lotId).sort()[0];
    if (!firstLotId) throw new Error("Missing input lot");
    const writer = await f.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await writer.query(
        "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [c.tenant, firstLotId],
      );
      pending = c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "waiting").then(
        (value) => ({ success: true, value }),
        (error: unknown) => ({ success: false, error }),
      );
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%traceability_lots%'",
                [pid],
              )
            ).rows[0]?.n,
          { timeout: 2000 },
        )
        .toBe(1);
      const remainingLotId = c.origin.snapshot.items.map((line) => line.lotId).sort()[1];
      if (!remainingLotId) throw new Error("Missing second input lot");
      // The blocked finalizer must not already hold the later UUID out of order.
      await expect(
        f.pool.query(
          "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
          [c.tenant, remainingLotId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await writer.query(
        "UPDATE product_traceability_profiles SET coverage_status='unknown',reviewed_by=NULL,reviewed_at=NULL WHERE tenant_id=$1 AND product_id=$2",
        [c.tenant, c.product],
      );
      await writer.query("COMMIT");
      expect(await pending).toMatchObject({
        success: false,
        error: { response: { code: "event_incomplete" } },
      });
      expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual({
        lots: 0,
        edges: 0,
        bindings: 0,
        receipts: 0,
        audits: 0,
      });
      expect(await c.store.getRecord(c.tenant, c.actor, c.saved.id)).toEqual(c.saved);
    } finally {
      await writer.query("ROLLBACK");
      await pending;
      writer.release();
    }
  });

  it.each(["consumer", "origin"])(
    "forces %s first with a waiting stale snapshot and commits only the safe outcome",
    async (first) => {
      const c = await seedFinalizableTransformation(f);
      const barrier = await f.pool.connect();
      const key = 20402;
      const eventId = first === "consumer" ? c.saved.id : c.origin.id;
      const status = first === "consumer" ? "finalized" : "void";
      const runConsumer = () =>
        c.store.finalize(c.tenant, c.actor, c.saved.id, c.command, "racing-consumer");
      const runOrigin = () =>
        c.receiving.void(
          c.tenant,
          c.actor,
          c.origin.id,
          {
            commandVersion: 2,
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            expectedDraftVersion: null,
            reason: "Incorrect origin",
          },
          "racing-origin",
        );
      const settle = (run: () => Promise<unknown>) =>
        run().then(
          (value) => ({ ok: true, value }),
          (error: unknown) => ({ ok: false, error }),
        );
      let leader: ReturnType<typeof settle> | undefined;
      let follower: ReturnType<typeof settle> | undefined;
      try {
        await barrier.query("SELECT pg_advisory_lock($1)", [key]);
        await f.pool
          .query(`CREATE FUNCTION synthetic_origin_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id='${eventId}'::uuid AND NEW.status='${status}' THEN PERFORM pg_advisory_xact_lock(${key}); END IF;
        RETURN NEW; END $$; CREATE TRIGGER synthetic_origin_barrier BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION synthetic_origin_barrier()`);
        leader = settle(first === "consumer" ? runConsumer : runOrigin);
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
        follower = settle(first === "consumer" ? runOrigin : runConsumer);
        await expect
          .poll(
            async () =>
              (
                await f.pool.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%traceability_lots%'",
                  [leaderPid],
                )
              ).rows[0]?.n,
            { timeout: 3000 },
          )
          .toBe(1);
        // The loser already established a repeatable-read snapshot and is waiting on the winner's lot lock.
        await barrier.query("SELECT pg_advisory_unlock($1)", [key]);
        expect(await leader).toMatchObject({ ok: true });
        expect(await follower).toMatchObject({
          ok: false,
          error: {
            response: {
              code: first === "consumer" ? "traceability_downstream_blocked" : "event_incomplete",
            },
          },
        });
        expect(await transformationEffects(f, c.tenant, c.saved.id)).toEqual(
          first === "consumer"
            ? { lots: 1, edges: 2, bindings: 1, receipts: 1, audits: 1 }
            : { lots: 0, edges: 0, bindings: 0, receipts: 0, audits: 0 },
        );
        expect(
          (
            await f.pool.query(
              "SELECT status,current_event_id FROM traceability_events e JOIN receiving_event_roots r ON r.tenant_id=e.tenant_id AND r.id=e.root_event_id WHERE e.tenant_id=$1 AND e.id=$2",
              [c.tenant, c.origin.id],
            )
          ).rows,
        ).toEqual([
          {
            status: first === "consumer" ? "finalized" : "void",
            current_event_id: first === "consumer" ? c.origin.id : null,
          },
        ]);
        expect(
          (
            await f.pool.query(
              "SELECT current_dependency_version FROM traceability_lots WHERE tenant_id=$1 AND assignment_basis<>'transformation' ORDER BY id",
              [c.tenant],
            )
          ).rows,
        ).toEqual([{ current_dependency_version: 2 }, { current_dependency_version: 2 }]);
        expect(
          (
            await f.pool.query(
              "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,request_id FROM tenant_audit_events WHERE organization_id=$1 AND request_id IN ('racing-origin','racing-consumer') AND target_type='traceability_event'",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          {
            organization_id: c.tenant,
            actor_user_id: c.actor,
            action:
              first === "consumer"
                ? "traceability.transformation.finalized"
                : "traceability.receiving.voided",
            outcome: "success",
            target_type: "traceability_event",
            target_id: eventId,
            request_id: first === "consumer" ? "racing-consumer" : "racing-origin",
          },
        ]);
      } finally {
        await barrier.query("SELECT pg_advisory_unlock($1)", [key]);
        await leader;
        await follower;
        await f.pool.query(
          "DROP TRIGGER IF EXISTS synthetic_origin_barrier ON traceability_events; DROP FUNCTION IF EXISTS synthetic_origin_barrier()",
        );
        barrier.release();
      }
    },
  );
});
