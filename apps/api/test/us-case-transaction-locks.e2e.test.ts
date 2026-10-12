import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import { caseLinkResultSchema, type CaseLinkResult } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { describe, expect, it, type TestContext } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  insertCaseTransactionSupport,
  seedCaseTransactionTarget,
  type CaseTransactionFixture,
  type CaseTransactionTarget,
} from "./support/us-case-transaction-fixture";
import {
  abortable,
  barrier,
  outcome,
  startObservation,
  waitBlocked,
  withOwnedWork,
  ownClient,
  connectClient,
  driverCode,
  type OwnCleanup,
  type CleanupEvidence,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
type Connection = ReturnType<typeof createDb>;
type Worker = (connection: Connection) => Promise<unknown>;

function driverConstraint(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  if ("constraint" in error) return error.constraint;
  return "cause" in error ? driverConstraint(error.cause) : undefined;
}

function connection(f: CaseTransactionFixture, own: OwnCleanup, name: string) {
  if (!base) throw new Error("Missing isolated database");
  const url = new URL(base);
  url.pathname = "/" + f.databaseName;
  const c = createDb(url.toString(), {
    max: 1,
    statement_timeout: 5000,
    connectionTimeoutMillis: 5000,
  });
  own("end-" + name, () => c.pool.end());
  return c;
}

async function ownedTest(
  test: TestContext,
  run: (f: CaseTransactionFixture, signal: AbortSignal) => Promise<void>,
) {
  const observation = startObservation(test, (signal) =>
    withOwnedWork(async (own) => {
      if (!base) throw new Error("Missing isolated database");
      const f = await createUsDatasetJournalFixture(base);
      own("fixture-dispose-verified", () => f.close());
      await run(f, signal);
    }),
  );
  // This wrapper has no readiness phase; observe both promises immediately.
  const readiness = outcome(observation.ready);
  try {
    expect((await observation.running).error).toBeUndefined();
  } finally {
    await observation.cleanup();
    await readiness;
  }
}

function nativeWorker(
  target: CaseTransactionTarget,
  operationKey: string,
  ssccs: readonly string[],
  requestId: string,
) {
  let attempts = 0;
  const pids: number[] = [];
  const run = (c: Connection) =>
    c.db.transaction(
      async (tx) => {
        attempts++;
        const pid = (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing native transaction PID");
        pids.push(pid);
        return new UsCaseStore(c.db).linkInTransaction(
          tx,
          target.tenant,
          target.actor,
          target.lotId,
          { operationKey, ssccs },
          requestId,
        );
      },
      { isolationLevel: "repeatable read" },
    );
  return { run, pids, attempts: () => attempts };
}

const publicLink =
  (t: CaseTransactionTarget, key: string, ssccs: readonly string[], requestId: string): Worker =>
  (c) =>
    new UsCaseStore(c.db).link(t.tenant, t.actor, t.lotId, { operationKey: key, ssccs }, requestId);

async function caseState(f: CaseTransactionFixture, t: CaseTransactionTarget) {
  return {
    links: (
      await f.pool.query("SELECT * FROM trace_lot_boxes WHERE tenant_id=$1 ORDER BY linked_at,id", [
        t.tenant,
      ])
    ).rows,
    operations: (
      await f.pool.query<{ operation_key: string; command: string; bytes: string }>(
        "SELECT operation_key,command,result::text AS bytes FROM trace_lot_box_operations WHERE tenant_id=$1 ORDER BY command,operation_key",
        [t.tenant],
      )
    ).rows,
    audits: (
      await f.pool.query<{ body: Record<string, unknown> }>(
        "SELECT to_jsonb(a) AS body FROM tenant_audit_events a WHERE organization_id=$1 AND action IN ('case.link','case.unlink') ORDER BY id",
        [t.tenant],
      )
    ).rows.map((r) => r.body),
  };
}

function assertLinkAudit(
  state: Awaited<ReturnType<typeof caseState>>,
  t: CaseTransactionTarget,
  key: string,
  requestId: string,
  result: CaseLinkResult,
) {
  const audits = state.audits.filter(
    (a) => (a.after as { operationKey?: string }).operationKey === key,
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    organization_id: t.tenant,
    actor_user_id: t.actor,
    action: "case.link",
    outcome: "success",
    target_type: "traceability_lot",
    target_id: t.lotId,
    request_id: requestId,
  });
  expect(audits[0]?.before).toEqual({ links: result.unchanged });
  expect(audits[0]?.after).toEqual({
    tenantId: t.tenant,
    operationKey: key,
    lotId: t.lotId,
    source: "manual",
    result,
  });
  expect(
    JSON.parse(state.operations.find((o) => o.operation_key === key)?.bytes ?? "null"),
  ).toEqual(result);
}

async function prepare(f: CaseTransactionFixture, count = 1) {
  const target = await seedCaseTransactionTarget(f);
  const ssccs = Array.from({ length: count }, (_, i) => buildSscc(9, "9999999", i + 1));
  const boxes = await f.db.transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
  return { target, ssccs, boxes };
}

// The trigger pauses a real writer after its business locks are acquired. The
// dedicated one-client pools retain the observed PID through the actual command.
async function race(
  f: CaseTransactionFixture,
  signal: AbortSignal,
  gateAt: { table: string; event: "INSERT" | "UPDATE"; condition: string },
  leader: Worker,
  follower: Worker,
  observed: (
    pids: { leader: number; follower: number },
    own: OwnCleanup,
  ) => Promise<void> = async () => {},
) {
  return withOwnedWork(async (own) => {
    const a = connection(f, own, "leader"),
      b = connection(f, own, "follower");
    const observer = connection(f, own, "observer"),
      gatePool = connection(f, own, "gate");
    const key = Math.floor(Math.random() * 1000000000) + 1;
    const name = "case_gate_" + randomUUID().replaceAll("-", "");
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${gateAt.condition} THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END $$`,
    );
    own("gate-function", async () => {
      await f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    });
    await f.pool.query(
      `CREATE TRIGGER ${name} BEFORE ${gateAt.event} ON ${gateAt.table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    own("gate-trigger", async () => {
      await f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${gateAt.table}`);
    });
    const workers: { first?: ReturnType<typeof outcome>; second?: ReturnType<typeof outcome> } = {};
    own("workers-drain", async () => {
      await Promise.all([workers.first, workers.second]);
    });
    const gate = await connectClient(gatePool.pool);
    ownClient(own, gate, "gate-unlock-destroy", () =>
      gate.query("SELECT pg_advisory_unlock($1)", [key]),
    );
    const leaderPid = (await a.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    const followerPid = (await b.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]?.pid;
    const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!leaderPid || !followerPid || !gatePid) throw new Error("Missing actual owned PID");
    await gate.query("SELECT pg_advisory_lock($1)", [key]);
    const first = (workers.first = outcome(leader(a)));
    await waitBlocked(observer, gatePid, leaderPid, signal);
    const second = (workers.second = outcome(follower(b)));
    await waitBlocked(observer, leaderPid, followerPid, signal);
    const actual = (
      await observer.pool.query<{ pid: number; active: boolean }>(
        "SELECT pid, xact_start IS NOT NULL AS active FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[])",
        [[leaderPid, followerPid]],
      )
    ).rows;
    expect(actual).toHaveLength(2);
    expect(actual.every((row) => row.active)).toBe(true);
    await observed({ leader: leaderPid, follower: followerPid }, own);
    await gate.query("SELECT pg_advisory_unlock($1)", [key]);
    const results = await Promise.all([first, second]);
    console.info("Case writer schedule", {
      table: gateAt.table,
      leaderPid,
      followerPid,
      leaderCode: driverCode(results[0]?.error),
      followerCode: driverCode(results[1]?.error),
    });
    return results;
  });
}

async function freshNative(
  f: CaseTransactionFixture,
  n: ReturnType<typeof nativeWorker>,
  initial: Awaited<ReturnType<typeof outcome>>,
) {
  expect(n.attempts()).toBe(1);
  expect(n.pids).toHaveLength(1);
  if (initial.error) {
    expect(["40001", "40P01"]).toContain(driverCode(initial.error));
    // The failed transaction has drained before this explicit external retry.
    return withOwnedWork(async (own) => n.run(connection(f, own, "external-retry")));
  }
  return caseLinkResultSchema.parse(initial.value);
}

describe.skipIf(!base)("Case native actual PostgreSQL lock schedules", () => {
  it("preserves an early setup error despite a real cleanup SQL failure and verifies owned database disposal", async (test) => {
    const primary = new Error("owned_case_before_readiness");
    let evidence: CleanupEvidence | undefined,
      disposed = false,
      destroyed = false,
      pid = 0;
    const observation = startObservation(test, () =>
      withOwnedWork(
        async (own) => {
          if (!base) throw new Error("Missing isolated database");
          const f = await createUsDatasetJournalFixture(base);
          own("fixture-dispose", async () => {
            await f.close();
            disposed = true;
          });
          const client = await connectClient(f.pool);
          ownClient(
            own,
            client,
            "bad-savepoint-rollback",
            () => client.query("ROLLBACK TO SAVEPOINT nonexistent_owned_case_savepoint"),
            () => {
              client.release(true);
              destroyed = true;
            },
          );
          await client.query("BEGIN");
          pid =
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ??
            0;
          throw primary;
        },
        (reported) => {
          evidence = reported;
        },
      ),
    );
    const readiness = outcome(observation.ready);
    try {
      expect((await readiness).error).toBe(primary);
      expect((await observation.running).error).toBe(primary);
      expect(evidence?.primaryError).toBe(primary);
      expect(evidence?.cleanupFailures).toHaveLength(1);
      expect(evidence?.cleanupFailures[0]?.phase).toBe("bad-savepoint-rollback");
      expect(driverCode(evidence?.cleanupFailures[0]?.error)).toBe("3B001");
      expect(destroyed && disposed).toBe(true);
      expect(pid).toBeGreaterThan(0);
      console.info("Case early failure independently disposed", {
        pid,
        primary: primary.message,
        cleanupCode: "3B001",
      });
    } finally {
      await observation.cleanup();
      await readiness;
    }
  });

  const timeouts: {
    phase: string;
    observed: boolean;
    sameReason: boolean;
    aborted: boolean;
    disposed: boolean;
    attempts: number;
    pids: number[];
  }[] = [];
  for (const phase of ["before readiness", "native waiter"] as const) {
    // An ordinary assertion test below prevents unrelated failures from counting
    // as successful timeout evidence. This is Vitest's real TestContext.signal.
    it.fails(
      `runner cancellation drains ${phase} and disposes its exact database`,
      { timeout: 5000 },
      async (test) => {
        let observed = false,
          disposed = false,
          attempts = 0;
        const pids: number[] = [];
        const observation = startObservation(test, (signal, ready) =>
          withOwnedWork(async (own) => {
            if (!base) throw new Error("Missing isolated database");
            const f = await createUsDatasetJournalFixture(base);
            own("timeout-fixture-dispose", async () => {
              await f.close();
              disposed = true;
            });
            if (phase === "before readiness") {
              const client = await connectClient(f.pool);
              ownClient(own, client, "timeout-setup-rollback", () => client.query("ROLLBACK"));
              await client.query("BEGIN");
              const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
                .rows[0]?.pid;
              if (!pid) throw new Error("Missing setup transaction PID");
              pids.push(pid);
              observed = true;
              await abortable(barrier().promise, signal);
            } else {
              const { target: t, ssccs } = await prepare(f),
                key = randomUUID();
              const n = nativeWorker(t, key, ssccs, "cancel-native-waiter");
              await race(
                f,
                signal,
                {
                  table: "trace_lot_boxes",
                  event: "INSERT",
                  condition: `NEW.tenant_id='${t.tenant}'`,
                },
                publicLink(t, key, ssccs, "cancel-public-holder"),
                n.run,
                async (workers) => {
                  pids.push(workers.leader, workers.follower);
                  expect(n.pids).toEqual([workers.follower]);
                  attempts = n.attempts();
                  observed = true;
                  await abortable(ready(), signal);
                },
              );
            }
          }),
        );
        const readiness = outcome(observation.ready);
        test.onTestFinished(async () => {
          await observation.cleanup();
          await readiness;
          const finished = await observation.running;
          timeouts.push({
            phase,
            observed,
            sameReason: finished.error === test.signal.reason,
            aborted: test.signal.aborted,
            disposed,
            attempts,
            pids,
          });
          console.info("Case actual runner cancellation", timeouts.at(-1));
        });
        const first = await readiness;
        if (first.error) throw first.error;
        const result = await observation.running;
        if (result.error) throw result.error;
      },
    );
  }
  it("proves actual runner signals reached both intended phases and disposal completed after worker drain", () => {
    expect(timeouts).toEqual([
      {
        phase: "before readiness",
        observed: true,
        sameReason: true,
        aborted: true,
        disposed: true,
        attempts: 0,
        pids: [expect.any(Number)],
      },
      {
        phase: "native waiter",
        observed: true,
        sameReason: true,
        aborted: true,
        disposed: true,
        attempts: 1,
        pids: [expect.any(Number), expect.any(Number)],
      },
    ]);
    expect(timeouts.every((row) => row.pids.every((pid) => pid > 0))).toBe(true);
  });
  it.for(["native", "public"] as const)(
    "permits only one lot for a shared box with %s first",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const c = await seedFinalizableTransformation(f);
        const original = await f.db.transaction(
          (tx) =>
            c.store.finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              c.saved.id,
              c.command,
              "native-first-origin",
            ),
          { isolationLevel: "repeatable read" },
        );
        const second = await f.db.transaction(
          async (tx) => {
            const draft = await c.store.createDraftInTransaction(
              tx,
              c.tenant,
              c.actor,
              {
                operationKey: randomUUID(),
                draft: {
                  ...c.saved.draft,
                  outputs: c.saved.draft.outputs.map((line) => ({
                    ...line,
                    tlc: "SECOND-NATIVE-OUTPUT",
                  })),
                },
              },
              "native-second-draft",
            );
            const ready = await c.store.checkReadinessInTransaction(
              tx,
              c.tenant,
              c.actor,
              draft.id,
              { expectedDraftVersion: 1 },
            );
            return c.store.finalizeInTransaction(
              tx,
              c.tenant,
              c.actor,
              draft.id,
              {
                operationKey: randomUUID(),
                expectedDraftVersion: 1,
                expectedInputDigest: ready.inputDigest,
              },
              "native-second-origin",
            );
          },
          { isolationLevel: "repeatable read" },
        );
        const firstLot = original.snapshot.outputs[0]?.lotId,
          secondLot = second.snapshot.outputs[0]?.lotId;
        if (!firstLot || !secondLot) throw new Error("Expected two finalized outputs");
        const t: CaseTransactionTarget = {
          tenant: c.tenant,
          actor: c.actor,
          product: c.product,
          finalized: original,
          lotId: firstLot,
          transformationStore: c.store,
          caseStore: new UsCaseStore(f.db),
        };
        const other = { ...t, lotId: secondLot, finalized: second };
        const ssccs = [buildSscc(9, "9999999", 1)];
        await f.db.transaction((tx) => insertCaseTransactionSupport(tx, t, ssccs, 1));
        const nativeKey = randomUUID(),
          publicKey = randomUUID();
        const n = nativeWorker(t, nativeKey, ssccs, "native-cross-lot"),
          p = publicLink(other, publicKey, ssccs, "public-cross-lot");
        const results = await race(
          f,
          signal,
          { table: "trace_lot_boxes", event: "INSERT", condition: `NEW.tenant_id='${t.tenant}'` },
          winner === "native" ? n.run : p,
          winner === "native" ? p : n.run,
        );
        expect(results[0]?.error).toBeUndefined();
        expect(n.attempts()).toBe(1);
        const losing = results[1];
        if (winner === "native")
          expect(losing?.error).toMatchObject({ response: { code: "case_link_conflict" } });
        else {
          // A stale RR snapshot can reach the active-box unique constraint because
          // the two contenders hold different lot rows; propagate it without retry.
          expect(["40001", "40P01", "23505"]).toContain(driverCode(losing?.error));
          if (driverCode(losing?.error) === "23505")
            expect(driverConstraint(losing?.error)).toBe("trace_lot_boxes_one_active_box_uq");
          await expect(
            withOwnedWork(async (own) => n.run(connection(f, own, "cross-lot-fresh"))),
          ).rejects.toMatchObject({ response: { code: "case_link_conflict" } });
        }
        const state = await caseState(f, t);
        expect(state.links).toHaveLength(1);
        expect(state.operations).toHaveLength(1);
        expect(state.audits).toHaveLength(1);
        assertLinkAudit(
          state,
          winner === "native" ? t : other,
          winner === "native" ? nativeKey : publicKey,
          winner === "native" ? "native-cross-lot" : "public-cross-lot",
          caseLinkResultSchema.parse(results[0]?.value),
        );
      }),
  );

  it("locks the lowest SSCC first even when the native payload is reversed", async (test) =>
    ownedTest(test, async (f, signal) => {
      const { target: t, ssccs, boxes } = await prepare(f, 2);
      const low = boxes[0],
        high = boxes[1];
      if (!low || !high) throw new Error("Expected ordered boxes");
      expect(low.sscc < high.sscc).toBe(true);
      await withOwnedWork(async (own) => {
        const native = connection(f, own, "sorted-native"),
          observer = connection(f, own, "sorted-observer");
        const worker: { pending?: ReturnType<typeof outcome> } = {};
        own("sort-worker-drain", async () => {
          await worker.pending;
        });
        const holder = await connectClient(f.pool);
        ownClient(own, holder, "sort-holder-release", () => holder.query("ROLLBACK"));
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM boxes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          t.tenant,
          low.id,
        ]);
        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const workerPid = (
          await native.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]?.pid;
        if (!holderPid || !workerPid) throw new Error("Missing sort PIDs");
        const key = randomUUID(),
          n = nativeWorker(t, key, [...ssccs].reverse(), "native-sorted");
        const pending = (worker.pending = outcome(n.run(native)));
        await waitBlocked(observer, holderPid, workerPid, signal);
        expect(n.pids).toEqual([workerPid]);
        // An independent NOWAIT read proves the higher box was not locked first.
        await observer.db.transaction(async (tx) => {
          const available = await tx.execute(
            sql`SELECT id FROM boxes WHERE tenant_id=${t.tenant} AND id=${high.id} FOR UPDATE NOWAIT`,
          );
          expect(available.rows).toHaveLength(1);
        });
        await holder.query("ROLLBACK");
        const completed = await pending;
        expect(completed.error).toBeUndefined();
        const result = caseLinkResultSchema.parse(completed.value);
        expect(result.created.map((row) => row.ssccAtLink)).toEqual(ssccs);
        expect(n.attempts()).toBe(1);
        assertLinkAudit(await caseState(f, t), t, key, "native-sorted", result);
      });
    }));

  it.for(["link", "finalize"] as const)(
    "retains stable output and original bytes with %s first against amendment finalization",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const { target: t, ssccs } = await prepare(f, 2);
        const originalKey = randomUUID();
        const originalLink = await t.caseStore.link(
          t.tenant,
          t.actor,
          t.lotId,
          { operationKey: originalKey, ssccs: [ssccs[0]] },
          "before-amendment",
        );
        const before = await caseState(f, t);
        const originalId = originalLink.created[0]?.linkId;
        if (!originalId) throw new Error("Expected original persisted link identity");
        const originalRow = before.links.find((row) => row.id === originalId);
        expect(originalRow).toBeDefined();
        expect(originalRow?.unlinked_at).toBeNull();
        const originalBytes = (
          await f.pool.query<{ bytes: string }>(
            "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE tenant_id=$1 AND id=$2",
            [t.tenant, t.finalized.id],
          )
        ).rows[0]?.bytes;
        const amendment = await t.transformationStore.amend(
          t.tenant,
          t.actor,
          t.finalized.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Owned metadata correction",
          },
          "public-amend",
        );
        expect(await caseState(f, t)).toEqual(before);
        if (amendment.record.status !== "draft") throw new Error("Expected amendment draft");
        const draft = amendment.record;
        const ready = await t.transformationStore.checkReadiness(t.tenant, t.actor, draft.id, {
          expectedDraftVersion: draft.draftVersion,
        });
        const finalize: Worker = (c) =>
          new UsTransformationStore(c.db).finalize(
            t.tenant,
            t.actor,
            draft.id,
            {
              operationKey: randomUUID(),
              expectedDraftVersion: draft.draftVersion,
              expectedInputDigest: ready.inputDigest,
            },
            "public-revision-finalize",
          );
        const nextCode = ssccs[1];
        if (!nextCode) throw new Error("Expected second eligible box");
        const newKey = randomUUID(),
          n = nativeWorker(t, newKey, [nextCode], "native-during-revision");
        const results = await race(
          f,
          signal,
          winner === "link"
            ? {
                table: "trace_lot_boxes",
                event: "INSERT",
                condition: `NEW.tenant_id='${t.tenant}'`,
              }
            : {
                table: "traceability_events",
                event: "UPDATE",
                condition: `NEW.id='${draft.id}' AND NEW.status='finalized'`,
              },
          winner === "link" ? n.run : finalize,
          winner === "link" ? finalize : n.run,
        );
        const finalResult = results[winner === "link" ? 1 : 0];
        expect(finalResult?.error).toBeUndefined();
        const nr = await freshNative(f, n, results[winner === "link" ? 0 : 1]);
        expect(nr.created).toHaveLength(1);
        const current = await t.transformationStore.getRecord(t.tenant, t.actor, draft.id);
        expect(current).toMatchObject({
          status: "finalized",
          snapshot: { outputs: [{ lotId: t.lotId }] },
        });
        expect(
          (
            await f.pool.query<{ bytes: string }>(
              "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE tenant_id=$1 AND id=$2",
              [t.tenant, t.finalized.id],
            )
          ).rows[0]?.bytes,
        ).toBe(originalBytes);
        const after = await caseState(f, t);
        expect(after.links).toHaveLength(2);
        expect(after.links.find((row) => row.id === originalId)).toEqual(originalRow);
        const newId = nr.created[0]?.linkId;
        if (!newId) throw new Error("Expected new persisted link identity");
        expect(newId).not.toBe(originalId);
        expect(
          after.links
            .filter((row) => row.unlinked_at === null)
            .map((row) => row.id)
            .sort(),
        ).toEqual([originalId, newId].sort());
        expect(after.operations).toHaveLength(2);
        expect(after.audits).toHaveLength(2);
        expect(after.operations.find((o) => o.operation_key === originalKey)).toEqual(
          before.operations[0],
        );
        assertLinkAudit(after, t, originalKey, "before-amendment", originalLink);
        assertLinkAudit(after, t, newKey, "native-during-revision", nr);
        expect(
          await t.caseStore.link(
            t.tenant,
            t.actor,
            t.lotId,
            { operationKey: originalKey, ssccs: [ssccs[0]] },
            "historical-after-amendment",
          ),
        ).toEqual(originalLink);
      }),
  );
  it.for(["link", "unlink"] as const)(
    "preserves link history and exact audits with %s first",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const { target: t, ssccs } = await prepare(f);
        const firstKey = randomUUID(),
          linkKey = randomUUID(),
          unlinkKey = randomUUID();
        const original = await t.caseStore.link(
          t.tenant,
          t.actor,
          t.lotId,
          { operationKey: firstKey, ssccs },
          "original-link",
        );
        const old = original.created[0];
        if (!old) throw new Error("Missing original link");
        const n = nativeWorker(t, linkKey, ssccs, "native-relink");
        const unlink: Worker = (c) =>
          new UsCaseStore(c.db).unlink(
            t.tenant,
            t.actor,
            t.lotId,
            old.linkId,
            { operationKey: unlinkKey, reason: "Owned wrong-lot correction" },
            "public-unlink",
          );
        const results = await race(
          f,
          signal,
          winner === "link"
            ? {
                table: "tenant_audit_events",
                event: "INSERT",
                condition: `NEW.organization_id='${t.tenant}' AND NEW.action='case.link' AND NEW.request_id='native-relink'`,
              }
            : { table: "trace_lot_boxes", event: "UPDATE", condition: `NEW.id='${old.linkId}'` },
          winner === "link" ? n.run : unlink,
          winner === "link" ? unlink : n.run,
        );
        const native = await freshNative(f, n, results[winner === "link" ? 0 : 1]);
        const removed = results[winner === "link" ? 1 : 0];
        expect(removed.error).toBeUndefined();
        expect(native).toMatchObject(
          winner === "link"
            ? { created: [], unchanged: [old] }
            : { created: [{ boxId: old.boxId }], unchanged: [] },
        );
        const state = await caseState(f, t);
        expect(state.links).toHaveLength(winner === "link" ? 1 : 2);
        expect(state.operations).toHaveLength(3);
        expect(state.audits).toHaveLength(3);
        assertLinkAudit(state, t, firstKey, "original-link", original);
        assertLinkAudit(state, t, linkKey, "native-relink", native);
        const audit = state.audits.find((a) => a.action === "case.unlink");
        expect(audit).toMatchObject({
          organization_id: t.tenant,
          actor_user_id: t.actor,
          target_type: "trace_lot_box",
          target_id: old.linkId,
          outcome: "success",
          request_id: "public-unlink",
        });
        expect(audit?.before).toEqual({ link: old });
        expect(audit?.after).toEqual({
          tenantId: t.tenant,
          operationKey: unlinkKey,
          lotId: t.lotId,
          boxId: old.boxId,
          linkId: old.linkId,
          ssccAtLink: old.ssccAtLink,
          source: "manual",
          reason: "Owned wrong-lot correction",
          result: removed.value,
        });
        const replacement =
          winner === "link"
            ? await t.caseStore.link(
                t.tenant,
                t.actor,
                t.lotId,
                { operationKey: randomUUID(), ssccs },
                "later-relink",
              )
            : native;
        expect(replacement.created[0]?.linkId).not.toBe(old.linkId);
        const beforeStale = await f.snapshot();
        await expect(
          t.caseStore.unlink(
            t.tenant,
            t.actor,
            t.lotId,
            old.linkId,
            { operationKey: randomUUID(), reason: "Delayed old-row intent" },
            "stale-unlink",
          ),
        ).rejects.toMatchObject({ response: { code: "case_link_stale" } });
        expect(await f.snapshot()).toEqual(beforeStale);
        expect(
          (await t.caseStore.list(t.tenant, t.actor, t.lotId, { limit: 100 })).rows.filter(
            (r) => !r.unlinkedAt,
          ),
        ).toEqual(replacement.created);
      }),
  );

  it.for(["link", "void"] as const)(
    "preserves historical receipt and current-origin rules with %s first",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        const { target: t, ssccs } = await prepare(f, 2);
        const key = randomUUID();
        const firstCode = ssccs[0],
          nextCode = ssccs[1];
        if (!firstCode || !nextCode) throw new Error("Expected two eligible boxes");
        const n = nativeWorker(t, key, [firstCode], "native-before-void");
        const voidKey = randomUUID();
        const voidOrigin: Worker = (c) =>
          new UsTransformationStore(c.db).void(
            t.tenant,
            t.actor,
            t.finalized.id,
            { operationKey: voidKey, expectedLifecycleVersion: 2, reason: "Owned invalid origin" },
            "public-void",
          );
        const beforeEvents = (
          await f.pool.query<{ bytes: string }>(
            "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE tenant_id=$1 AND id=$2",
            [t.tenant, t.finalized.id],
          )
        ).rows[0]?.bytes;
        const results = await race(
          f,
          signal,
          winner === "link"
            ? {
                table: "trace_lot_boxes",
                event: "INSERT",
                condition: `NEW.tenant_id='${t.tenant}'`,
              }
            : {
                table: "traceability_events",
                event: "UPDATE",
                condition: `NEW.tenant_id='${t.tenant}' AND NEW.id='${t.finalized.id}' AND NEW.status='void'`,
              },
          winner === "link" ? n.run : voidOrigin,
          winner === "link" ? voidOrigin : n.run,
        );
        const initial = results[winner === "link" ? 0 : 1];
        expect(results[winner === "link" ? 1 : 0]?.error).toBeUndefined();
        expect(n.attempts()).toBe(1);
        if (winner === "void") {
          expect(["40001", "40P01"]).toContain(driverCode(initial.error));
          await expect(
            withOwnedWork(async (own) => n.run(connection(f, own, "fresh-denied"))),
          ).rejects.toMatchObject({ response: { code: "case_origin_not_current" } });
          const state = await caseState(f, t);
          expect(state).toEqual({ links: [], operations: [], audits: [] });
        } else {
          expect(initial.error).toBeUndefined();
          const linked = caseLinkResultSchema.parse(initial.value);
          const state = await caseState(f, t);
          expect(state.links).toHaveLength(1);
          expect(state.operations).toHaveLength(1);
          expect(state.audits).toHaveLength(1);
          assertLinkAudit(state, t, key, "native-before-void", linked);
          const beforeReplay = await f.snapshot();
          expect(
            await withOwnedWork(async (own) => n.run(connection(f, own, "historical-replay"))),
          ).toEqual(linked);
          expect(
            await t.caseStore.link(
              t.tenant,
              t.actor,
              t.lotId,
              { operationKey: key, ssccs: [ssccs[0]] },
              "public-history",
            ),
          ).toEqual(linked);
          expect(await f.snapshot()).toEqual(beforeReplay);
          expect(await caseState(f, t)).toEqual(state);
          const page = await t.caseStore.list(t.tenant, t.actor, t.lotId, { limit: 100 });
          expect(page.activeCount).toBe(1);
          expect(page.rows[0]).toMatchObject({
            originState: "gap",
            linkId: linked.created[0]?.linkId,
          });
          const unchanged = await t.caseStore.link(
            t.tenant,
            t.actor,
            t.lotId,
            { operationKey: randomUUID(), ssccs: [ssccs[0]] },
            "same-lot-gap-noop",
          );
          expect(unchanged).toMatchObject({ created: [], unchanged: [{ originState: "gap" }] });
          const old = linked.created[0];
          if (!old) throw new Error("Missing historical link");
          const unlinkKey = randomUUID();
          const unlinked = await t.caseStore.unlink(
            t.tenant,
            t.actor,
            t.lotId,
            old.linkId,
            { operationKey: unlinkKey, reason: "Origin gap cleanup" },
            "gap-unlink",
          );
          const audit = (await caseState(f, t)).audits.find((a) => a.request_id === "gap-unlink");
          expect(audit).toMatchObject({
            organization_id: t.tenant,
            actor_user_id: t.actor,
            action: "case.unlink",
            target_type: "trace_lot_box",
            target_id: old.linkId,
            outcome: "success",
          });
          expect(audit?.before).toEqual({ link: { ...old, originState: "gap" } });
          expect(audit?.after).toEqual({
            tenantId: t.tenant,
            operationKey: unlinkKey,
            lotId: t.lotId,
            boxId: old.boxId,
            linkId: old.linkId,
            ssccAtLink: old.ssccAtLink,
            source: "manual",
            reason: "Origin gap cleanup",
            result: unlinked,
          });
        }
        const deniedBefore = await f.snapshot();
        const newLink = nativeWorker(t, randomUUID(), [nextCode], "new-box-after-void");
        await expect(
          withOwnedWork(async (own) => newLink.run(connection(f, own, "new-box-denied"))),
        ).rejects.toMatchObject({ response: { code: "case_origin_not_current" } });
        expect(await f.snapshot()).toEqual(deniedBefore);
        expect(
          (
            await f.pool.query<{ bytes: string }>(
              "SELECT finalization_snapshot::text AS bytes FROM traceability_events WHERE tenant_id=$1 AND id=$2",
              [t.tenant, t.finalized.id],
            )
          ).rows[0]?.bytes,
        ).toBe(beforeEvents);
      }),
  );
  it.for(["native", "public"] as const)(
    "converges same/distinct link keys with %s winning",
    async (winner, test) =>
      ownedTest(test, async (f, signal) => {
        for (const sameKey of [true, false]) {
          const { target: t, ssccs, boxes } = await prepare(f);
          const nativeKey = randomUUID(),
            publicKey = sameKey ? nativeKey : randomUUID();
          const n = nativeWorker(t, nativeKey, ssccs, "native-link"),
            p = publicLink(t, publicKey, ssccs, "public-link");
          const results = await race(
            f,
            signal,
            { table: "trace_lot_boxes", event: "INSERT", condition: `NEW.tenant_id='${t.tenant}'` },
            winner === "native" ? n.run : p,
            winner === "native" ? p : n.run,
          );
          const nr = await freshNative(f, n, results[winner === "native" ? 0 : 1]);
          const pr = results[winner === "native" ? 1 : 0];
          expect(pr.error).toBeUndefined();
          const publicResult = caseLinkResultSchema.parse(pr.value);
          const winning = winner === "native" ? nr : publicResult;
          expect(winning.created).toHaveLength(1);
          if (sameKey) expect(nr).toEqual(publicResult);
          else
            expect(winner === "native" ? publicResult : nr).toEqual({
              lotId: t.lotId,
              created: [],
              unchanged: winning.created,
            });
          const ownedBoxId = boxes[0]?.id;
          expect(
            (
              await f.pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM trace_lot_boxes WHERE tenant_id=$1 AND box_id=$2 AND unlinked_at IS NULL",
                [t.tenant, ownedBoxId],
              )
            ).rows[0]?.n,
          ).toBe(1);
          const state = await caseState(f, t);
          expect(state.operations).toHaveLength(sameKey ? 1 : 2);
          expect(state.audits).toHaveLength(sameKey ? 1 : 2);
          assertLinkAudit(
            state,
            t,
            nativeKey,
            sameKey && winner === "public" ? "public-link" : "native-link",
            nr,
          );
          if (!sameKey) assertLinkAudit(state, t, publicKey, "public-link", publicResult);
        }
      }),
  );

  it("arbitrates operation before the lot in the inversion-sensitive public/native schedule", async (test) =>
    ownedTest(test, async (f, signal) => {
      const { target: t, ssccs } = await prepare(f),
        key = randomUUID();
      await withOwnedWork(async (own) => {
        const pub = connection(f, own, "public"),
          nat = connection(f, own, "native"),
          obs = connection(f, own, "observer");
        const workers: {
          publicResult?: ReturnType<typeof outcome>;
          nativeResult?: ReturnType<typeof outcome>;
        } = {};
        own("workers-drain", async () => {
          await Promise.all([workers.publicResult, workers.nativeResult]);
        });
        const gate = await connectClient(f.pool);
        ownClient(own, gate, "lot-rollback", () => gate.query("ROLLBACK"));
        await gate.query("BEGIN");
        await gate.query(
          "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [t.tenant, t.lotId],
        );
        const gatePid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const publicPid = (await pub.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        const nativePid = (await nat.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]?.pid;
        if (!gatePid || !publicPid || !nativePid) throw new Error("Missing inversion PIDs");
        const n = nativeWorker(t, key, ssccs, "native-inversion");
        const publicResult = (workers.publicResult = outcome(
          publicLink(t, key, ssccs, "public-inversion")(pub),
        ));
        await waitBlocked(obs, gatePid, publicPid, signal);
        const nativeResult = (workers.nativeResult = outcome(n.run(nat)));
        await waitBlocked(obs, publicPid, nativePid, signal);
        expect(n.pids).toEqual([nativePid]);
        await gate.query("ROLLBACK");
        const [p, native] = await Promise.all([publicResult, nativeResult]);
        expect(p.error).toBeUndefined();
        expect(await freshNative(f, n, native)).toEqual(p.value);
        const state = await caseState(f, t);
        expect(state.links).toHaveLength(1);
        expect(state.operations).toHaveLength(1);
        expect(state.audits).toHaveLength(1);
        assertLinkAudit(state, t, key, "public-inversion", caseLinkResultSchema.parse(p.value));
      });
    }));
});
