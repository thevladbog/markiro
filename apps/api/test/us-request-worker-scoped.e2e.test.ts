import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createDb, schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsRequestWorker } from "../src/modules/traceability/requests/us-request-worker";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import { UsRequestWorkerCleanup } from "../src/modules/traceability/requests/us-request-worker-cleanup";
import { createSyntheticUsRequestExecutionIdentity } from "../src/modules/traceability/requests/us-request-worker-execution";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  bindUsRequestWorkerFixture,
  createUsRequestWorkerFixture,
  createUsWorkerDatabaseTransport,
  prepareUsWorkerSource,
  requestWorkerFixtureBuild,
} from "./support/us-request-worker-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("exact-run US Request worker in owned PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let target: Awaited<ReturnType<typeof createUsRequestWorkerFixture>>;
  let foreign: typeof target;
  let sibling: typeof target;
  let clock: ReturnType<typeof createUsWorkerDatabaseTransport>;
  let child: string;
  const pending = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  beforeEach(async () => {
    if (!base) throw new Error("Explicit isolated US database URL required");
    database = await createUsProfileTestDatabase(base);
    const identity = await database.pool.query<{ name: string }>(
      "select current_database() as name",
    );
    const name = identity.rows[0]?.name;
    if (!name) throw new Error("Missing owned child identity");
    child = name;
    clock = createUsWorkerDatabaseTransport(database.db);
    foreign = await createUsRequestWorkerFixture(clock.db, { mode: "export_ready" });
    sibling = await createUsRequestWorkerFixture(clock.db, { mode: "export_ready" });
    if (!sibling.source.request.scope) throw new Error("Missing prepared request scope");
    target = bindUsRequestWorkerFixture(
      clock.db,
      await prepareUsWorkerSource(
        clock.db,
        {
          tenant: sibling.source.tenantId,
          actor: sibling.source.actorId,
        },
        "export_ready",
        sibling.source.request.scope,
      ),
    );
  }, 60_000);
  afterEach(async () => {
    await Promise.allSettled([...pending]);
    vi.restoreAllMocks();
    target?.destroy();
    sibling?.destroy();
    foreign?.destroy();
    await database?.close();
    if (base && child) {
      const observer = createDb(base);
      try {
        expect(
          (await observer.pool.query("select 1 from pg_database where datname=$1", [child])).rows,
        ).toEqual([]);
        expect(
          (await observer.pool.query("select 1 from pg_stat_activity where datname=$1", [child]))
            .rows,
        ).toEqual([]);
        console.info(`Scoped worker child normally disposed and absent: ${child}`);
      } finally {
        await observer.pool.end();
      }
    }
  });
  function worker(
    c = target,
    configured = true,
    build = requestWorkerFixtureBuild,
    forged = false,
  ) {
    const execution = createSyntheticUsRequestExecutionIdentity(build, {
      NODE_ENV: "test",
      MARKIRO_DEPLOYMENT_EDITION: "US",
    });
    return new UsRequestWorker(clock.db, {
      lifecycle: c.lifecycle,
      checkpoints: c.checkpoints,
      publication: c.publication,
      cleanup: new UsRequestWorkerCleanup(clock.db, target.storage.store),
      storage: configured ? target.storage.store : null,
      planReader: c.planReader,
      execution: forged ? { ...execution } : execution,
    });
  }
  async function snapshot(all = false) {
    const rows: Record<string, unknown> = {};
    for (const [table, column, excluded] of [
      ["trace_requests", "id", target.source.request.id],
      ["trace_export_runs", "id", target.scope.runId],
      ["trace_export_attempts", "run_id", target.scope.runId],
      ["trace_export_render_checkpoints", "run_id", target.scope.runId],
      ["trace_export_object_intents", "run_id", target.scope.runId],
      ["trace_export_artifacts", "run_id", target.scope.runId],
      ["trace_export_retry_receipts", "run_id", target.scope.runId],
      ["tenant_audit_events", "target_id", target.scope.runId],
    ])
      rows[String(table)] = (
        await database.pool.query(
          `select * from ${table} ${all ? "" : `where ${column} is distinct from $1`} order by 1`,
          all ? [] : [excluded],
        )
      ).rows;
    return {
      rows,
      objects: [target, sibling, foreign].map((c) =>
        [...c.storage.objects]
          .filter(
            ([key]) =>
              all || !key.startsWith(`us/requests/${target.scope.tenantId}/${target.scope.runId}/`),
          )
          .map(([key, value]) => [
            key,
            { bytes: Buffer.from(value.bytes), contentType: value.contentType },
          ]),
      ),
      plans: [target, sibling, foreign].map((c) =>
        [...c.source.planFixture.objects].map(([key, bytes]) => [key, Buffer.from(bytes)]),
      ),
    };
  }
  async function assertClaimAudit(
    lease: NonNullable<Awaited<ReturnType<UsRequestWorkerLifecycle["claimNext"]>>>,
  ) {
    const rows = await database.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.targetId, target.scope.runId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: target.scope.tenantId,
      actorUserId: null,
      action: "traceability.request.worker.claimed",
      outcome: "success",
      targetType: "trace_export_run",
      targetId: target.scope.runId,
      before: null,
      requestId: null,
      createdAt: new Date(lease.startedAt),
    });
    expect(rows[0]?.after).toEqual({
      actorKind: "system",
      initiatorId: target.source.actorId,
      requestId: target.source.request.id,
      runId: target.scope.runId,
      runRevision: 1,
      mode: "export_ready",
      attemptId: lease.attemptId,
      attemptNumber: 1,
      cycle: 1,
      cycleAttemptCount: 1,
      lifecycleVersion: 1,
      commandDigest: target.source.run.commandDigest,
      scopedContentDigest: target.source.run.scopedContentDigest,
      inputDigest: target.source.run.inputDigest,
    });
  }
  // Break caught: global selection instead of the explicitly selected durable run.
  it("claims exactly the selected tenant and run", async () => {
    const before = await snapshot();
    const lease = await target.lifecycle.claimScoped(target.scope);
    expect(lease).toMatchObject({ ...target.scope, attemptNumber: 1, cycle: 1 });
    if (!lease) throw new Error("Missing target lease");
    await assertClaimAudit(lease);
    expect(await snapshot()).toEqual(before);
    expect((await target.lifecycle.read(target.scope)).run).toMatchObject({
      status: "processing",
      attemptCount: 1,
      lifecycleVersion: 1,
    });
  });
  it("does not fall back for a missing run or a real run paired with the wrong tenant", async () => {
    const before = await snapshot(true);
    for (const scope of [
      { ...target.scope, runId: randomUUID() },
      { ...target.scope, tenantId: foreign.scope.tenantId },
    ]) {
      expect(await target.lifecycle.claimScoped(scope)).toBeNull();
      expect(await worker().runScoped(scope)).toEqual({ kind: "idle" });
    }
    expect(await snapshot(true)).toEqual(before);
  });
  it("rejects malformed and executable scopes before storage, identity, claim or sanitation", async () => {
    const before = await snapshot(true);
    let accessed = 0;
    for (const scope of [
      undefined,
      null,
      {},
      { ...target.scope, extra: true },
      { ...target.scope, runId: "not-a-run" },
      {
        runId: target.scope.runId,
        get tenantId() {
          accessed++;
          return target.scope.tenantId;
        },
      },
      { ...target.scope, execute: () => accessed++ },
    ]) {
      for (const invoke of [
        () => target.lifecycle.claimScoped(scope),
        () => worker(target, false, requestWorkerFixtureBuild, true).runScoped(scope),
        () => worker(target, true, requestWorkerFixtureBuild, true).runScoped(scope),
      ])
        await expect(invoke()).rejects.toMatchObject({
          response: { code: "us_request_worker_evidence_invalid" },
        });
    }
    expect(accessed).toBe(0);
    expect(await snapshot(true)).toEqual(before);
  });
  it("captures independent scope values before the caller mutates its object", async () => {
    const before = await snapshot();
    const scope = { ...target.scope };
    const claim = target.lifecycle.claimScoped(scope);
    scope.tenantId = foreign.scope.tenantId;
    scope.runId = foreign.scope.runId;
    expect(await claim).toMatchObject(target.scope);
    expect(await snapshot()).toEqual(before);
  });
  it("retains storage and execution preconditions before claiming a valid scope", async () => {
    const before = await snapshot(true);
    expect(
      await worker(target, false, requestWorkerFixtureBuild, true).runScoped(target.scope),
    ).toEqual({ kind: "storage_unavailable" });
    await expect(
      worker(target, true, requestWorkerFixtureBuild, true).runScoped(target.scope),
    ).rejects.toMatchObject({ response: { code: "us_request_worker_execution_invalid" } });
    expect(await snapshot(true)).toEqual(before);
  });
  it("uses SKIP LOCKED on an actually held target row without consuming older work", async () => {
    const before = await snapshot(true);
    const blocker = await database.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(
        "select id from trace_export_runs where tenant_id=$1 and id=$2 for update",
        [target.scope.tenantId, target.scope.runId],
      );
      const lock = await blocker.query<{ held: boolean }>(
        "select exists(select 1 from pg_locks where pid=pg_backend_pid() and relation='trace_export_runs'::regclass and mode='RowShareLock' and granted) as held",
      );
      expect(lock.rows[0]?.held).toBe(true);
      expect(await target.lifecycle.claimScoped(target.scope)).toBeNull();
      expect(await worker().runScoped(target.scope)).toEqual({ kind: "idle" });
      expect(await snapshot(true)).toEqual(before);
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
  });
  it("gives one lease and one exact audit to live concurrent service contenders", async () => {
    const before = await snapshot();
    const blocker = await database.pool.connect();
    let first: ReturnType<UsRequestWorkerLifecycle["claimScoped"]> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("lock table trace_export_runs in share mode");
      first = track(new UsRequestWorkerLifecycle(clock.db).claimScoped(target.scope));
      let observed = false;
      const end = performance.now() + 1000;
      while (!observed && performance.now() < end) {
        const locks = await database.pool.query<{ blocked: boolean }>(
          "select exists(select 1 from pg_locks where database=(select oid from pg_database where datname=current_database()) and relation='trace_export_runs'::regclass and mode='RowExclusiveLock' and not granted) as blocked",
        );
        observed = locks.rows[0]?.blocked === true;
      }
      expect(observed).toBe(true);
      expect(await new UsRequestWorkerLifecycle(clock.db).claimScoped(target.scope)).toBeNull();
      await blocker.query("commit");
      const lease = await first;
      if (!lease) throw new Error("Missing contender lease");
      await assertClaimAudit(lease);
      expect(await snapshot()).toEqual(before);
      expect((await target.lifecycle.read(target.scope)).attempts).toHaveLength(1);
    } finally {
      await blocker.query("rollback");
      blocker.release();
      await first;
    }
  });
  it.each(["not due", "active", "failed", "ready"] as const)(
    "returns idle for %s target without fallback",
    async (status) => {
      if (status === "not due")
        await database.pool.query(
          "update trace_export_runs set next_attempt_at=clock_timestamp()+interval '1 hour' where id=$1",
          [target.scope.runId],
        );
      else if (status === "ready") {
        expect(await worker().runScoped(target.scope)).toEqual({
          kind: "ready",
          scope: target.scope,
        });
        await target.verifyReady();
      } else {
        const lease = await target.lifecycle.claimScoped(target.scope);
        if (!lease) throw new Error("Missing target lease");
        if (status === "failed")
          await target.lifecycle.finishFailure(lease, {
            code: "insufficient_permission",
            retryable: false,
          });
      }
      const before = await snapshot(true);
      expect(await target.lifecycle.claimScoped(target.scope)).toBeNull();
      expect(await worker().runScoped(target.scope)).toEqual({ kind: "idle" });
      expect(await snapshot(true)).toEqual(before);
    },
  );
  it("recovers only its expired target and waits for the persisted retry schedule", async () => {
    const old = await foreign.lifecycle.claimScoped(foreign.scope);
    const lease = await target.lifecycle.claimScoped(target.scope);
    if (!old || !lease) throw new Error("Missing actual leases");
    await clock.advancePast(new Date(lease.expiresAt));
    const untouched = await snapshot(true);
    expect(
      await target.lifecycle.claimScoped({
        tenantId: target.scope.tenantId,
        runId: foreign.scope.runId,
      }),
    ).toBeNull();
    expect(await snapshot(true)).toEqual(untouched);
    const before = await snapshot();
    expect(await worker().runScoped(target.scope)).toEqual({ kind: "idle" });
    expect(await snapshot()).toEqual(before);
    const state = await target.lifecycle.read(target.scope);
    expect(state.run).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lifecycleVersion: 2,
      leaseAttemptId: null,
    });
    expect(state.attempts[0]).toMatchObject({
      status: "abandoned",
      failureCode: "us_request_worker_lease_lost",
      retryable: true,
    });
    expect(state.run.nextAttemptAt?.getTime()).toBe(
      (state.attempts[0]?.finishedAt?.getTime() ?? 0) + 10_000,
    );
    const audit = await database.pool.query(
      "select * from tenant_audit_events where target_id=$1 and action='traceability.request.worker.recovered'",
      [target.scope.runId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      organization_id: target.scope.tenantId,
      actor_user_id: null,
      target_type: "trace_export_run",
      outcome: "retry_scheduled",
      before: null,
    });
    expect(audit.rows[0]?.after).toEqual({
      actorKind: "system",
      initiatorId: target.source.actorId,
      requestId: target.source.request.id,
      runId: target.scope.runId,
      runRevision: 1,
      mode: "export_ready",
      attemptId: lease.attemptId,
      attemptNumber: 1,
      cycle: 1,
      cycleAttemptCount: 1,
      lifecycleVersion: 2,
      commandDigest: target.source.run.commandDigest,
      scopedContentDigest: target.source.run.scopedContentDigest,
      inputDigest: target.source.run.inputDigest,
      failureCode: "us_request_worker_lease_lost",
      retryable: true,
      terminalFailureCode: null,
      nextAttemptAt: state.run.nextAttemptAt?.toISOString(),
    });
    expect(await target.lifecycle.claimScoped(target.scope)).toBeNull();
    if (!state.run.nextAttemptAt) throw new Error("Missing durable schedule");
    await clock.advancePast(state.run.nextAttemptAt);
    expect(await target.instances().lifecycle.claimScoped(target.scope)).toMatchObject({
      ...target.scope,
      attemptNumber: 2,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("publishes actual target bytes while older foreign expired rows and private objects stay exact", async () => {
    let puts = 0;
    target.storage.faults.after = async (command, result) => {
      if (command instanceof PutObjectCommand && ++puts === 2) {
        const state = await foreign.lifecycle.read(foreign.scope);
        if (!state.run.leaseExpiresAt) throw new Error("Missing live foreign expiry");
        await clock.advancePast(state.run.leaseExpiresAt);
      }
      return result;
    };
    expect(await worker(foreign).runScoped(foreign.scope)).toEqual({
      kind: "lease_lost",
      scope: foreign.scope,
    });
    target.storage.faults.after = null;
    expect(target.storage.objects.size).toBe(2);
    const before = await snapshot();
    const claimNext = vi.spyOn(target.lifecycle, "claimNext");
    const supplied = { ...target.scope };
    const invocation = track(worker().runScoped(supplied));
    Object.assign(supplied, foreign.scope);
    expect(await invocation).toEqual({ kind: "ready", scope: target.scope });
    expect(claimNext).not.toHaveBeenCalled();
    await target.verifyReady();
    expect(await snapshot()).toEqual(before);
  });
  it.each(["authority", "profile", "build"] as const)(
    "classifies current %s drift for the target only",
    async (drift) => {
      if (drift === "authority")
        await database.db
          .update(schema.member)
          .set({ role: "viewer" })
          .where(eq(schema.member.userId, target.source.actorId));
      if (drift === "profile")
        await database.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
          .where(eq(schema.traceabilityProfiles.tenantId, target.scope.tenantId));
      const before = await snapshot();
      expect(
        await worker(
          target,
          true,
          drift === "build"
            ? { ...requestWorkerFixtureBuild, gitSha: "b".repeat(40) }
            : requestWorkerFixtureBuild,
        ).runScoped(target.scope),
      ).toEqual({
        kind: "failed",
        scope: target.scope,
        code:
          drift === "build"
            ? "us_request_worker_execution_invalid"
            : drift === "profile"
              ? "us_request_profile_unsupported"
              : "insufficient_permission",
      });
      expect(await snapshot()).toEqual(before);
      expect((await target.lifecycle.read(target.scope)).artifacts).toEqual([]);
    },
  );
  it("recreates scoped execution after a real provider fault with the existing retry delay", async () => {
    target.storage.faults.before = async (command) => {
      if (command instanceof PutObjectCommand)
        throw { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } };
    };
    const before = await snapshot();
    expect(await worker().runScoped(target.scope)).toEqual({
      kind: "retry_scheduled",
      scope: target.scope,
    });
    const failed = await target.lifecycle.read(target.scope);
    expect(failed.run.nextAttemptAt?.getTime()).toBe(
      (failed.attempts[0]?.finishedAt?.getTime() ?? 0) + 10_000,
    );
    expect(failed.attempts[0]).toMatchObject({ status: "failed", retryable: true });
    expect(failed.checkpoint).not.toBeNull();
    expect(failed.expectation).not.toBeNull();
    expect(failed.artifacts).toEqual([]);
    expect(await target.recreate().runScoped(target.scope)).toEqual({ kind: "idle" });
    if (!failed.run.nextAttemptAt) throw new Error("Missing retry schedule");
    await clock.advancePast(failed.run.nextAttemptAt);
    target.storage.faults.before = null;
    expect(await target.recreate().runScoped(target.scope)).toEqual({
      kind: "ready",
      scope: target.scope,
    });
    const { state } = await target.verifyReady();
    expect(state.checkpoint).toEqual(failed.checkpoint);
    expect(state.expectation).toEqual(failed.expectation);
    expect(state.attempts.map((a) => a.status)).toEqual(["failed", "succeeded"]);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["commit", "rollback"] as const)(
    "reconciles real publication %s reply loss through scoped execution",
    async (fault) => {
      const before = await snapshot();
      clock.faultCommit(fault, (text) => /^insert into "trace_export_artifacts"/i.test(text));
      expect(await worker().runScoped(target.scope)).toEqual({
        kind: fault === "commit" ? "ready" : "retry_scheduled",
        scope: target.scope,
      });
      expect(
        clock.statements.filter((s) => s.outcome !== "forwarded").map((s) => s.outcome),
      ).toEqual([fault === "commit" ? "committed_reply_lost" : "rolled_back_reply_lost"]);
      if (fault === "rollback") {
        const state = await target.lifecycle.read(target.scope);
        if (!state.run.nextAttemptAt) throw new Error("Missing retry schedule");
        await clock.advancePast(state.run.nextAttemptAt);
        expect(await target.recreate().runScoped(target.scope)).toEqual({
          kind: "ready",
          scope: target.scope,
        });
      } else expect(target.storage.calls.some((c) => c.kind === "delete")).toBe(false);
      await target.verifyReady();
      expect(await snapshot()).toEqual(before);
    },
  );
  it("keeps the global no-argument entry selecting the original oldest eligible run", async () => {
    expect(await target.lifecycle.claimNext()).toMatchObject(foreign.scope);
    const state = await target.lifecycle.read(foreign.scope);
    expect(state.run.status).toBe("processing");
    expect((await target.lifecycle.read(target.scope)).attempts).toEqual([]);
  });
});
