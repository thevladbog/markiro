import { randomUUID, createHash } from "node:crypto";
import { schema } from "@markiro/db";
import { HttpException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsRequestWorkerLifecycle } from "../src/modules/traceability/requests/us-request-worker-lifecycle";
import type { UsWorkerLease } from "../src/modules/traceability/requests/us-request-worker-types";
import { bindUsRequestPackageInputs } from "../src/modules/traceability/requests/us-request-package-inputs";
import { stableStringify } from "../src/modules/traceability/requests/us-request-snapshot";
import { verifyUsRequestRunEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { createUsRequestPackageFixture } from "./support/us-request-package-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("fenced US worker lifecycle in per-test disposable PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof createUsRequestPackageFixture>>;
  beforeEach(async () => {
    if (!url) throw new Error("Explicit isolated US database URL required");
    f = await createUsProfileTestDatabase(url);
    // Real preparation with consistent frozen chronology; expired-state fixtures
    // below INSERT prior attempts and never disable the immutable SQL guards.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 600_000);
    try {
      c = await createUsRequestPackageFixture(f.db, { mode: "export_ready" });
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
  afterEach(async () => {
    c?.destroy();
    await f?.close();
  });
  const scope = () => ({ tenantId: c.tenantId, runId: c.run.id });
  const lifecycle = () => new UsRequestWorkerLifecycle(f.db);
  const claim = async () => {
    const lease = await lifecycle().claimNext();
    if (!lease) throw new Error("Expected claimed synthetic work");
    return lease;
  };
  const errorCode = (code: string) => expect.objectContaining({ response: { code } });
  const metadataKeys = [
    "actorKind",
    "initiatorId",
    "requestId",
    "runId",
    "runRevision",
    "mode",
    "attemptId",
    "attemptNumber",
    "cycle",
    "cycleAttemptCount",
    "lifecycleVersion",
    "commandDigest",
    "scopedContentDigest",
    "inputDigest",
  ];
  const exactKeys = (value: unknown, extras: readonly string[] = []) => {
    if (value === null || typeof value !== "object") throw new Error("Missing audit metadata");
    expect(Object.keys(value).sort()).toEqual([...metadataKeys, ...extras].sort());
  };
  const audits = async (action: string) =>
    f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenantId),
          eq(schema.tenantAuditEvents.action, action),
        ),
      );
  const prior = async (count: number, age: number): Promise<UsWorkerLease> => {
    let lease: UsWorkerLease | undefined;
    for (let n = 1; n <= count; n++) {
      const start = new Date(Date.now() - age - (count - n) * 1000);
      const id = randomUUID(),
        token = randomUUID(),
        expiry = new Date(start.getTime() + 120_000),
        deadline = new Date(start.getTime() + 300_000);
      await f.db.insert(schema.traceExportAttempts).values({
        id,
        tenantId: c.tenantId,
        runId: c.run.id,
        attemptNumber: n,
        cycle: 1,
        token,
        status: n === count ? "active" : "failed",
        startedAt: start,
        leaseExpiresAt: expiry,
        deadlineAt: deadline,
        finishedAt: n === count ? null : new Date(start.getTime() + 1),
        failureCode: n === count ? null : "us_request_package_storage_timeout",
        retryable: n !== count,
      });
      lease = {
        ...scope(),
        attemptId: id,
        attemptNumber: n,
        cycle: 1,
        token,
        startedAt: start.toISOString(),
        expiresAt: expiry.toISOString(),
        deadlineAt: deadline.toISOString(),
      };
    }
    if (!lease) throw new Error("Missing prior durable-state fixture");
    await f.db
      .update(schema.traceExportRuns)
      .set({
        status: "processing",
        attemptCount: count,
        cycleAttemptCount: count,
        lifecycleVersion: count,
        leaseAttemptId: lease.attemptId,
        leaseToken: lease.token,
        leaseExpiresAt: new Date(lease.expiresAt),
        attemptDeadlineAt: new Date(lease.deadlineAt),
        generationStartedAt: new Date(lease.startedAt),
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    return lease;
  };
  const due = async () => {
    await f.db
      .update(schema.traceExportRuns)
      .set({
        nextAttemptAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '1 second'`,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
  };
  // Break caught: two processes claim the same prepared run or consume a duplicate attempt.
  it("grants exactly one lease to simultaneous service instances", async () => {
    const a = new UsRequestWorkerLifecycle(f.db),
      b = new UsRequestWorkerLifecycle(f.db);
    expect(() => verifyUsRequestRunEvidence(c.run, c.tenantId)).not.toThrow();
    expect(c.run).toMatchObject({
      attemptCount: 0,
      lifecycleVersion: 0,
      retryCycle: 1,
      cycleAttemptCount: 0,
      status: "queued",
    });
    const claims = await Promise.all([a.claimNext(), b.claimNext()]);
    expect(claims.filter((lease) => lease !== null)).toHaveLength(1);
    const attempts = await f.db.select().from(schema.traceExportAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      tenantId: c.tenantId,
      runId: c.run.id,
      attemptNumber: 1,
      cycle: 1,
      status: "active",
    });
    const state = await a.read(scope());
    expect(state.run).toMatchObject({
      status: "processing",
      attemptCount: 1,
      cycleAttemptCount: 1,
      lifecycleVersion: 1,
    });
    const lease = claims.find((v) => v !== null);
    expect(lease).toBeTruthy();
    expect(await audits("traceability.request.worker.claimed")).toMatchObject([
      {
        organizationId: c.tenantId,
        actorUserId: null,
        action: "traceability.request.worker.claimed",
        outcome: "success",
        targetType: "trace_export_run",
        targetId: c.run.id,
        before: null,
        after: {
          actorKind: "system",
          initiatorId: c.actorId,
          requestId: c.request.id,
          runId: c.run.id,
          runRevision: 1,
          mode: "export_ready",
          attemptId: lease?.attemptId,
          attemptNumber: 1,
          cycle: 1,
          cycleAttemptCount: 1,
          lifecycleVersion: 1,
          commandDigest: c.run.commandDigest,
          scopedContentDigest: c.run.scopedContentDigest,
          inputDigest: c.run.inputDigest,
        },
      },
    ]);
    exactKeys((await audits("traceability.request.worker.claimed"))[0]?.after);
    expect(Date.parse(lease?.expiresAt ?? "") - Date.parse(lease?.startedAt ?? "")).toBe(120_000);
    expect(Date.parse(lease?.deadlineAt ?? "") - Date.parse(lease?.startedAt ?? "")).toBe(300_000);
  });
  it("renews current ownership and rejects stale token without another audit", async () => {
    const lease = await claim(),
      renewed = await lifecycle().renew(lease);
    expect(renewed.token).toBe(lease.token);
    expect(renewed.deadlineAt).toBe(lease.deadlineAt);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));
    await expect(lifecycle().renew({ ...lease, token: randomUUID() })).rejects.toThrow(
      errorCode("us_request_worker_lease_lost"),
    );
    await expect(
      lifecycle().finishFailure(
        { ...lease, token: randomUUID() },
        { code: "us_request_package_storage_timeout", retryable: true },
      ),
    ).rejects.toThrow(errorCode("us_request_worker_lease_lost"));
    expect(await audits("traceability.request.worker.claimed")).toHaveLength(1);
  });
  it("cannot revive an expired valid prior attempt or cross its fixed deadline", async () => {
    const lease = await prior(1, 301_000);
    await expect(lifecycle().renew(lease)).rejects.toThrow(
      errorCode("us_request_worker_deadline_exceeded"),
    );
    await expect(
      lifecycle().finishFailure(lease, {
        code: "us_request_package_storage_timeout",
        retryable: true,
      }),
    ).rejects.toThrow();
    await lifecycle().recoverExpired(scope());
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({ status: "queued", attemptCount: 1, leaseToken: null });
    expect(state.attempts[0]).toMatchObject({
      status: "abandoned",
      failureCode: "us_request_worker_deadline_exceeded",
      retryable: true,
    });
    expect(state.run.nextAttemptAt?.getTime()).toBe(
      (state.attempts[0]?.finishedAt?.getTime() ?? 0) + 10_000,
    );
    await expect(lifecycle().claimNext()).resolves.toBeNull();
  });
  it("caps renewal at the fixed deadline with a valid near-deadline prior attempt", async () => {
    const original = await prior(1, 240_000);
    // Prior expiry is already old; seed a valid initial lease extending to deadline.
    await f.db
      .update(schema.traceExportAttempts)
      .set({ leaseExpiresAt: new Date(original.deadlineAt) })
      .where(eq(schema.traceExportAttempts.id, original.attemptId));
    await f.db
      .update(schema.traceExportRuns)
      .set({ leaseExpiresAt: new Date(original.deadlineAt) })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    const renewed = await lifecycle().renew({ ...original, expiresAt: original.deadlineAt });
    expect(renewed.expiresAt).toBe(original.deadlineAt);
    expect(renewed.deadlineAt).toBe(original.deadlineAt);
  });
  it("does not renew after lease expiry even before the deadline", async () => {
    const lease = await prior(1, 121_000);
    await expect(lifecycle().renew(lease)).rejects.toThrow(
      errorCode("us_request_worker_lease_lost"),
    );
    await lifecycle().recoverExpired(scope());
    expect((await lifecycle().read(scope())).attempts[0]?.failureCode).toBe(
      "us_request_worker_lease_lost",
    );
  });
  it("enforces DB-recorded 10/60-second backoff and exhausts exactly the third claim", async () => {
    const first = await claim();
    await lifecycle().finishFailure(first, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    let state = await lifecycle().read(scope());
    expect(state.run.nextAttemptAt?.getTime()).toBe(
      (state.attempts[0]?.finishedAt?.getTime() ?? 0) + 10_000,
    );
    expect(await lifecycle().claimNext()).toBeNull();
    await due();
    const second = await claim();
    await lifecycle().finishFailure(second, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    state = await lifecycle().read(scope());
    expect(state.run.nextAttemptAt?.getTime()).toBe(
      (state.attempts[1]?.finishedAt?.getTime() ?? 0) + 60_000,
    );
    expect(await lifecycle().claimNext()).toBeNull();
    await due();
    const third = await claim();
    await lifecycle().finishFailure(third, {
      code: "us_request_package_storage_timeout",
      retryable: true,
    });
    state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({
      status: "failed",
      failureCode: "us_request_worker_retry_limit",
      attemptCount: 3,
      cycleAttemptCount: 3,
      nextAttemptAt: null,
      leaseToken: null,
    });
    expect(state.run.completedAt).toEqual(state.attempts[2]?.finishedAt);
    expect(await lifecycle().claimNext()).toBeNull();
    expect(state.run.inputSnapshot).toEqual(c.run.inputSnapshot);
  });
  it("abandons an expired third attempt once and records exact recovery audit", async () => {
    const lease = await prior(3, 121_000);
    await Promise.all([lifecycle().recoverExpired(scope()), lifecycle().recoverExpired(scope())]);
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({
      status: "failed",
      failureCode: "us_request_worker_retry_limit",
      attemptCount: 3,
      cycleAttemptCount: 3,
      lifecycleVersion: 4,
      leaseToken: null,
    });
    expect(state.attempts[2]).toMatchObject({
      status: "abandoned",
      failureCode: "us_request_worker_lease_lost",
      retryable: true,
    });
    const rows = await audits("traceability.request.worker.recovered");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: c.tenantId,
      actorUserId: null,
      action: "traceability.request.worker.recovered",
      outcome: "failed",
      targetType: "trace_export_run",
      targetId: c.run.id,
      before: null,
      after: {
        actorKind: "system",
        initiatorId: c.actorId,
        requestId: c.request.id,
        runId: c.run.id,
        runRevision: 1,
        mode: "export_ready",
        attemptId: lease.attemptId,
        attemptNumber: 3,
        cycle: 1,
        cycleAttemptCount: 3,
        lifecycleVersion: 4,
        commandDigest: c.run.commandDigest,
        scopedContentDigest: c.run.scopedContentDigest,
        inputDigest: c.run.inputDigest,
        failureCode: "us_request_worker_lease_lost",
        retryable: true,
        terminalFailureCode: "us_request_worker_retry_limit",
        nextAttemptAt: null,
      },
    });
    exactKeys(rows[0]?.after, ["failureCode", "retryable", "terminalFailureCode", "nextAttemptAt"]);
  });
  it("checks initiator membership/profile freshly and denies wrong tenant", async () => {
    const lease = await claim();
    await lifecycle().authorize(lease);
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, c.actorId));
    await expect(lifecycle().authorize(lease)).rejects.toThrow(
      errorCode("insufficient_permission"),
    );
    await f.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.userId, c.actorId));
    await f.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenantId));
    await expect(lifecycle().authorize(lease)).rejects.toThrow(
      errorCode("us_request_profile_unsupported"),
    );
    await expect(lifecycle().read({ ...scope(), tenantId: randomUUID() })).rejects.toThrow();
    await expect(lifecycle().renew({ ...lease, tenantId: randomUUID() })).rejects.toThrow();
  });
  it("preserves checkpoint and frozen input across one idempotent authorized manual cycle", async () => {
    const lease = await claim();
    const model = bindUsRequestPackageInputs(
      c.run,
      c.tenantId,
      c.payloads,
      c.plan,
      c.context,
    ).model;
    await f.db.insert(schema.traceExportRenderCheckpoints).values({
      ...scope(),
      attemptId: lease.attemptId,
      model,
      modelDigest: createHash("sha256").update(stableStringify(model)).digest("hex"),
      executionDigest: "b".repeat(64),
      packageVersion: "us-request-package-v1",
      reportVersion: "us-request-report-pdf-v1",
    });
    await lifecycle().finishFailure(lease, { code: "insufficient_permission", retryable: false });
    const before = await lifecycle().read(scope());
    const body = {
      expectedLifecycleVersion: before.run.lifecycleVersion,
      reason: "Restored synthetic access",
      idempotencyKey: randomUUID(),
    };
    const receipts = await Promise.all([
      lifecycle().retry(scope(), c.actorId, body),
      lifecycle().retry(scope(), c.actorId, body),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    const next = await claim();
    expect(next).toMatchObject({ attemptNumber: 2, cycle: 2 });
    expect(await lifecycle().retry(scope(), c.actorId, body)).toEqual(receipts[0]);
    const after = await lifecycle().read(scope());
    expect(after.run).toMatchObject({ retryCycle: 2, attemptCount: 2, cycleAttemptCount: 1 });
    expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.run.inputSnapshot).toEqual(c.run.inputSnapshot);
    const rows = await audits("traceability.request.worker.retried");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: c.tenantId,
      actorUserId: c.actorId,
      action: "traceability.request.worker.retried",
      outcome: "success",
      targetType: "trace_export_run",
      targetId: c.run.id,
      before: null,
      after: {
        actorKind: "user",
        initiatorId: c.actorId,
        requestId: c.request.id,
        runId: c.run.id,
        runRevision: 1,
        mode: "export_ready",
        attemptId: null,
        attemptNumber: 1,
        cycle: 2,
        cycleAttemptCount: 0,
        lifecycleVersion: before.run.lifecycleVersion + 1,
        commandDigest: c.run.commandDigest,
        scopedContentDigest: c.run.scopedContentDigest,
        inputDigest: c.run.inputDigest,
        requestedBy: c.actorId,
        reason: body.reason,
        idempotencyKey: body.idempotencyKey,
        expectedLifecycleVersion: body.expectedLifecycleVersion,
      },
    });
    exactKeys(rows[0]?.after, [
      "requestedBy",
      "reason",
      "idempotencyKey",
      "expectedLifecycleVersion",
    ]);
    await expect(
      lifecycle().retry(scope(), c.actorId, { ...body, reason: "Different synthetic command" }),
    ).rejects.toThrow(errorCode("us_request_worker_retry_conflict"));
    await f.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, c.actorId));
    await expect(lifecycle().retry(scope(), c.actorId, body)).rejects.toThrow(
      errorCode("insufficient_permission"),
    );
  });
  it("denies unauthorized caller or revoked initiator even when another owner retries", async () => {
    const lease = await claim();
    await lifecycle().finishFailure(lease, { code: "insufficient_permission", retryable: false });
    const version = (await lifecycle().read(scope())).run.lifecycleVersion;
    const caller = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: caller, name: "Synthetic retry caller", email: `${caller}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: c.tenantId,
      userId: caller,
      role: "owner",
      createdAt: new Date(),
    });
    const body = {
      expectedLifecycleVersion: version,
      reason: "Restored synthetic authority",
      idempotencyKey: randomUUID(),
    };
    await f.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, c.actorId));
    await expect(lifecycle().retry(scope(), caller, body)).rejects.toThrow(
      errorCode("insufficient_permission"),
    );
    await f.db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.userId, c.actorId));
    await f.db
      .update(schema.member)
      .set({ role: "traceability_auditor" })
      .where(eq(schema.member.userId, caller));
    await expect(lifecycle().retry(scope(), caller, body)).rejects.toThrow(
      errorCode("insufficient_permission"),
    );
    expect(await audits("traceability.request.worker.retried")).toEqual([]);
    await f.db.update(schema.member).set({ role: "owner" }).where(eq(schema.member.userId, caller));
    await expect(
      lifecycle().retry(scope(), caller, { ...body, expectedLifecycleVersion: version + 1 }),
    ).rejects.toThrow(errorCode("us_request_worker_retry_conflict"));
    expect((await lifecycle().read(scope())).run.retryCycle).toBe(1);
    const receipt = await lifecycle().retry(scope(), caller, body);
    expect(receipt).toEqual({
      ...scope(),
      cycle: 2,
      lifecycleVersion: version + 1,
      requestedBy: caller,
      idempotencyKey: body.idempotencyKey,
    });
    await f.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.userId, c.actorId));
    await expect(lifecycle().retry(scope(), caller, body)).rejects.toThrow(
      errorCode("insufficient_permission"),
    );
  });
  it("serializes authority with a committed membership revocation", async () => {
    const lease = await claim(),
      client = await f.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE member SET role='member' WHERE user_id=$1", [c.actorId]);
      const result = lifecycle().authorize(lease);
      const assertion = expect(result).rejects.toThrow(errorCode("insufficient_permission"));
      await client.query("COMMIT");
      await assertion;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect((await lifecycle().read(scope())).run.status).toBe("processing");
  });
  it("takes fresh database time after waiting on the active run lock", async () => {
    const lease = await prior(1, 119_000),
      client = await f.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM trace_export_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [c.tenantId, c.run.id],
      );
      const renewal = lifecycle().renew(lease);
      const assertion = expect(renewal).rejects.toThrow(errorCode("us_request_worker_lease_lost"));
      await client.query(
        "SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)",
        [lease.expiresAt],
      );
      await client.query("COMMIT");
      await assertion;
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("rolls claim and attempt back together when the atomic audit fails", async () => {
    await f.pool.query(
      "CREATE FUNCTION reject_worker_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.worker.claimed' THEN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$",
    );
    await f.pool.query(
      "CREATE TRIGGER reject_worker_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_worker_audit()",
    );
    await expect(lifecycle().claimNext()).rejects.toThrow(
      errorCode("us_request_worker_unknown_failure"),
    );
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({
      status: "queued",
      attemptCount: 0,
      lifecycleVersion: 0,
      leaseToken: null,
    });
    expect(state.attempts).toEqual([]);
    expect(await audits("traceability.request.worker.claimed")).toEqual([]);
  });
  it("rejects ready retry and protects ready/finished attempts and retry receipts with SQL guards", async () => {
    const lease = await claim();
    await lifecycle().finishFailure(lease, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    await expect(
      f.db
        .update(schema.traceExportAttempts)
        .set({ failureCode: "insufficient_permission" })
        .where(eq(schema.traceExportAttempts.id, lease.attemptId)),
    ).rejects.toThrow();
    await expect(
      f.db
        .delete(schema.traceExportAttempts)
        .where(eq(schema.traceExportAttempts.id, lease.attemptId)),
    ).rejects.toThrow();
    const body = {
      expectedLifecycleVersion: 2,
      reason: "Synthetic retry",
      idempotencyKey: randomUUID(),
    };
    await lifecycle().retry(scope(), c.actorId, body);
    await expect(
      f.db
        .update(schema.traceExportRetryReceipts)
        .set({ reason: "Changed synthetic reason" })
        .where(eq(schema.traceExportRetryReceipts.runId, c.run.id)),
    ).rejects.toThrow();
    await expect(
      f.db
        .delete(schema.traceExportRetryReceipts)
        .where(eq(schema.traceExportRetryReceipts.runId, c.run.id)),
    ).rejects.toThrow();
    const next = await claim();
    // Seed a terminal winner's lifecycle evidence; publication belongs Task5.
    await f.db
      .update(schema.traceExportAttempts)
      .set({ status: "succeeded", finishedAt: sql`date_trunc('milliseconds',clock_timestamp())` })
      .where(eq(schema.traceExportAttempts.id, next.attemptId));
    await f.db
      .update(schema.traceExportRuns)
      .set({
        status: "ready",
        completedAt: sql`date_trunc('milliseconds',clock_timestamp())`,
        exportReady: true,
        leaseAttemptId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        attemptDeadlineAt: null,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    await expect(
      lifecycle().retry(scope(), c.actorId, {
        ...body,
        idempotencyKey: randomUUID(),
        expectedLifecycleVersion: 4,
      }),
    ).rejects.toThrow(errorCode("us_request_worker_retry_conflict"));
    await expect(
      f.db
        .update(schema.traceExportRuns)
        .set({ lifecycleVersion: 5 })
        .where(eq(schema.traceExportRuns.id, c.run.id)),
    ).rejects.toThrow();
    await expect(
      f.db.delete(schema.traceExportRuns).where(eq(schema.traceExportRuns.id, c.run.id)),
    ).rejects.toThrow();
    await lifecycle().recoverExpired(scope());
    expect(await lifecycle().claimNext()).toBeNull();
  });
  it("retains a migrated pre-worker lifetime count without inventing missing old attempts", async () => {
    await f.db
      .update(schema.traceExportRuns)
      .set({ attemptCount: 2 })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    const before = await lifecycle().read(scope());
    expect(before.run.attemptCount).toBe(2);
    expect(before.attempts).toEqual([]);
    const lease = await claim();
    expect(lease).toMatchObject({ attemptNumber: 3, cycle: 1 });
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({ attemptCount: 3, cycleAttemptCount: 1 });
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]?.attemptNumber).toBe(3);
    await lifecycle().finishFailure(lease, {
      code: "us_request_worker_unknown_failure",
      retryable: false,
    });
    const failed = await lifecycle().read(scope());
    await lifecycle().retry(scope(), c.actorId, {
      expectedLifecycleVersion: failed.run.lifecycleVersion,
      reason: "Synthetic retry of migrated count",
      idempotencyKey: randomUUID(),
    });
    expect(await claim()).toMatchObject({ attemptNumber: 4, cycle: 2 });
    expect((await lifecycle().read(scope())).run.attemptCount).toBe(4);
  });
  it("refuses a persisted permanent failure falsely marked retryable", async () => {
    const lease = await claim();
    await f.db
      .update(schema.traceExportAttempts)
      .set({
        status: "failed",
        finishedAt: sql`date_trunc('milliseconds',clock_timestamp())`,
        failureCode: "insufficient_permission",
        retryable: true,
      })
      .where(eq(schema.traceExportAttempts.id, lease.attemptId));
    await f.db
      .update(schema.traceExportRuns)
      .set({
        status: "failed",
        failureCode: "insufficient_permission",
        completedAt: sql`date_trunc('milliseconds',clock_timestamp())`,
        leaseAttemptId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        attemptDeadlineAt: null,
      })
      .where(eq(schema.traceExportRuns.id, c.run.id));
    await expect(
      lifecycle()
        .read(scope())
        .then(
          () => null,
          (error: unknown) => (error instanceof HttpException ? error.getResponse() : null),
        ),
    ).resolves.toEqual({ code: "us_request_worker_stored_invalid" });
  });
  it("recovers at most one expired run through queue selection then respects its backoff", async () => {
    await prior(1, 121_000);
    expect(await lifecycle().claimNext()).toBeNull();
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({ status: "queued", attemptCount: 1, cycleAttemptCount: 1 });
    expect(state.attempts[0]?.status).toBe("abandoned");
    expect(await lifecycle().claimNext()).toBeNull();
    await due();
    expect(await claim()).toMatchObject({ attemptNumber: 2, cycle: 1 });
  });
  it("does not recover an ambiguous processing run with a persisted publication reference", async () => {
    const lease = await prior(1, 121_000);
    await f.db.insert(schema.traceExportArtifacts).values({
      ...scope(),
      kind: "manifest",
      filename: "manifest.json",
      mediaType: "application/json",
      byteSize: 1n,
      sha256: "a".repeat(64),
      objectKey: `us/requests/${c.tenantId}/${c.run.id}/${lease.attemptId}/manifest.json`,
      publishedAt: sql`date_trunc('milliseconds',clock_timestamp())`,
    });
    await expect(lifecycle().recoverExpired(scope())).rejects.toThrow(
      errorCode("us_request_worker_stored_invalid"),
    );
    const state = await lifecycle().read(scope());
    expect(state.run).toMatchObject({
      status: "processing",
      attemptCount: 1,
      leaseToken: lease.token,
    });
    expect(state.attempts[0]?.status).toBe("active");
    expect(state.artifacts).toHaveLength(1);
    expect(await audits("traceability.request.worker.recovered")).toEqual([]);
  });
});
