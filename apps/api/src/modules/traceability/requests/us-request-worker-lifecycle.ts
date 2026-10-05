import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest, US_CAPABILITY } from "@markiro/domain";
import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, or, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  isUniqueConstraintViolation,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import { verifyUsRequestRunEvidence, type UsTraceExportRunRow } from "./us-request-run-evidence";
import { classifyUsWorkerFailure, sanitizedUsWorkerError } from "./us-request-worker-failures";
import {
  parseUsWorkerCheckpoint,
  parseUsWorkerFailure,
  parseUsWorkerLease,
  parseUsWorkerPackageExpectation,
  parseUsWorkerRetryBody,
  parseUsWorkerRetryReceipt,
  parseUsWorkerScope,
  US_REQUEST_WORKER_POLICY as policy,
  usWorkerFailureCodeSchema,
  type UsWorkerFailure,
  type UsWorkerLease,
  type UsWorkerRetryBody,
  type UsWorkerRetryReceipt,
  type UsWorkerRunState,
  type UsWorkerScope,
} from "./us-request-worker-types";

const runs = schema.traceExportRuns,
  attempts = schema.traceExportAttempts;
type Attempt = typeof attempts.$inferSelect;
type Tx = UsMasterDataTransaction;
const storedInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
const conflict = () => new ConflictException({ code: "us_request_worker_retry_conflict" });
const lost = () => new ConflictException({ code: "us_request_worker_lease_lost" });
const deadline = () => new ConflictException({ code: "us_request_worker_deadline_exceeded" });
const scoped = (scope: UsWorkerScope) =>
  and(eq(runs.tenantId, scope.tenantId), eq(runs.id, scope.runId));
const clearLease = {
  leaseAttemptId: null,
  leaseToken: null,
  leaseExpiresAt: null,
  attemptDeadlineAt: null,
};

export interface UsRequestWorkerLifecycleContract {
  claimNext(): Promise<UsWorkerLease | null>;
  renew(lease: UsWorkerLease): Promise<UsWorkerLease>;
  authorize(lease: UsWorkerLease): Promise<void>;
  read(scope: UsWorkerScope): Promise<UsWorkerRunState>;
  finishFailure(lease: UsWorkerLease, failure: UsWorkerFailure): Promise<void>;
  recoverExpired(scope: UsWorkerScope): Promise<void>;
  retry(
    scope: UsWorkerScope,
    callerId: string,
    body: UsWorkerRetryBody,
  ): Promise<UsWorkerRetryReceipt>;
  assertActive(tx: Tx, lease: UsWorkerLease): Promise<void>;
}

async function dbTime(tx: Tx): Promise<Date> {
  const result = await tx.execute<{ milliseconds: string }>(
    sql`select extract(epoch from date_trunc('milliseconds', clock_timestamp())) * 1000 as milliseconds`,
  );
  const milliseconds = Number(result.rows[0]?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw storedInvalid();
  return new Date(milliseconds);
}
function leaseFrom(row: Attempt): UsWorkerLease {
  return parseUsWorkerLease({
    tenantId: row.tenantId,
    runId: row.runId,
    attemptId: row.id,
    attemptNumber: row.attemptNumber,
    cycle: row.cycle,
    token: row.token,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.leaseExpiresAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
  });
}
function validRun(row: UsTraceExportRunRow): void {
  verifyUsRequestRunEvidence(row, row.tenantId);
  validLifecycle(row);
}
function validLifecycle(row: UsTraceExportRunRow): void {
  if (
    !["queued", "processing", "failed", "ready"].includes(row.status) ||
    ![row.attemptCount, row.lifecycleVersion, row.retryCycle, row.cycleAttemptCount].every(
      Number.isSafeInteger,
    ) ||
    row.attemptCount < 0 ||
    row.lifecycleVersion < 0 ||
    row.retryCycle < 1 ||
    row.cycleAttemptCount < 0 ||
    row.cycleAttemptCount > policy.attemptsPerCycle ||
    row.cycleAttemptCount > row.attemptCount ||
    (row.failureCode !== null && !usWorkerFailureCodeSchema.safeParse(row.failureCode).success)
  )
    throw storedInvalid();
}
async function assertAuthorityTime(tx: Tx, attempt: Attempt): Promise<void> {
  const now = await dbTime(tx);
  if (now.getTime() >= attempt.deadlineAt.getTime()) throw deadline();
  if (now.getTime() >= attempt.leaseExpiresAt.getTime()) throw lost();
}
function validAttempt(row: Attempt): void {
  leaseFrom(row);
  if (
    !["active", "failed", "abandoned", "succeeded"].includes(row.status) ||
    (row.status === "active") !== (row.finishedAt === null) ||
    (row.status === "active" || row.status === "succeeded") !== (row.failureCode === null) ||
    (row.failureCode !== null && !usWorkerFailureCodeSchema.safeParse(row.failureCode).success) ||
    (row.finishedAt !== null && row.finishedAt.getTime() < row.startedAt.getTime())
  )
    throw storedInvalid();
  if (row.status === "failed")
    parseUsWorkerFailure({ code: row.failureCode, retryable: row.retryable });
  if (
    row.status === "abandoned" &&
    (!row.retryable ||
      (row.failureCode !== "us_request_worker_lease_lost" &&
        row.failureCode !== "us_request_worker_deadline_exceeded"))
  )
    throw storedInvalid();
  if ((row.status === "active" || row.status === "succeeded") && row.retryable)
    throw storedInvalid();
}

/** Internal persistence seam only: no queue runner, runtime registration or byte I/O. */
export class UsRequestWorkerLifecycle implements UsRequestWorkerLifecycleContract {
  constructor(private readonly db: Db) {}

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
        return work(tx);
      });
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }
  private async lockRun(tx: Tx, scope: UsWorkerScope): Promise<UsTraceExportRunRow> {
    const [row] = await tx.select().from(runs).where(scoped(scope)).limit(1).for("update");
    if (!row) throw lost();
    validRun(row);
    return row;
  }
  private async currentAttempt(tx: Tx, row: UsTraceExportRunRow): Promise<Attempt> {
    if (!row.leaseAttemptId || !row.leaseToken || !row.leaseExpiresAt || !row.attemptDeadlineAt)
      throw lost();
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.tenantId, row.tenantId),
          eq(attempts.runId, row.id),
          eq(attempts.id, row.leaseAttemptId),
        ),
      )
      .limit(1)
      .for("update");
    if (!attempt) throw storedInvalid();
    validAttempt(attempt);
    if (
      attempt.status !== "active" ||
      attempt.token !== row.leaseToken ||
      attempt.attemptNumber !== row.attemptCount ||
      attempt.cycle !== row.retryCycle ||
      attempt.leaseExpiresAt.getTime() !== row.leaseExpiresAt.getTime() ||
      attempt.deadlineAt.getTime() !== row.attemptDeadlineAt.getTime()
    )
      throw storedInvalid();
    return attempt;
  }
  private async active(tx: Tx, lease: UsWorkerLease) {
    const row = await this.lockRun(tx, lease);
    if (
      row.status !== "processing" ||
      row.leaseAttemptId !== lease.attemptId ||
      row.leaseToken !== lease.token ||
      row.attemptCount !== lease.attemptNumber ||
      row.retryCycle !== lease.cycle
    )
      throw lost();
    const attempt = await this.currentAttempt(tx, row);
    if (
      attempt.startedAt.toISOString() !== lease.startedAt ||
      attempt.deadlineAt.toISOString() !== lease.deadlineAt
    )
      throw lost();
    // Captured only after both row locks: lock waits cannot extend authority.
    const now = await dbTime(tx);
    if (now.getTime() >= attempt.deadlineAt.getTime()) throw deadline();
    if (now.getTime() >= attempt.leaseExpiresAt.getTime()) throw lost();
    return { row, attempt, now };
  }
  async assertActive(tx: Tx, leaseInput: UsWorkerLease): Promise<void> {
    await this.active(tx, parseUsWorkerLease(leaseInput));
  }
  private async authority(tx: Tx, tenantId: string, actorIds: readonly string[]): Promise<void> {
    // Lock all involved memberships before any profile, in a stable order.
    for (const actorId of [...new Set(actorIds)].sort()) {
      await tx
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actorId)))
        .limit(1)
        .for("share");
    }
    for (const actorId of [...new Set(actorIds)].sort()) {
      const profile = await authorizeUsMasterData(tx, tenantId, actorId, US_CAPABILITY.QA_MANAGE);
      await authorizeUsMasterData(tx, tenantId, actorId, US_CAPABILITY.EXPORT_READ);
      if (profile !== "US_FSMA204_PROCESSOR")
        throw new ForbiddenException({ code: "us_request_profile_unsupported" });
    }
  }
  async authorize(leaseInput: UsWorkerLease): Promise<void> {
    const lease = parseUsWorkerLease(leaseInput);
    await this.transaction(async (tx) => {
      // Initiator is an immutable database fact; never supplied by the worker.
      const [row] = await tx.select().from(runs).where(scoped(lease)).limit(1);
      if (!row) throw lost();
      await this.authority(tx, row.tenantId, [row.createdBy]);
      await this.assertActive(tx, lease);
    });
  }
  async claimNext(): Promise<UsWorkerLease | null> {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(runs)
        .where(
          or(
            and(
              eq(runs.status, "queued"),
              sql`(${runs.nextAttemptAt} IS NULL OR ${runs.nextAttemptAt} <= clock_timestamp())`,
            ),
            and(eq(runs.status, "processing"), sql`${runs.leaseExpiresAt} <= clock_timestamp()`),
          ),
        )
        .orderBy(asc(runs.startedAt), asc(runs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      try {
        validRun(row);
      } catch (error) {
        if (
          row.status !== "queued" ||
          classifyUsWorkerFailure(error).code !== "us_request_run_stored_invalid"
        )
          throw error;
        await this.disposeInvalidQueued(tx, row);
        return null;
      }
      if (row.status === "processing") {
        await this.recoverWithin(tx, row);
        return null;
      }
      const now = await dbTime(tx);
      if (row.status !== "queued" || (row.nextAttemptAt && row.nextAttemptAt > now)) return null;
      if (row.cycleAttemptCount >= policy.attemptsPerCycle) throw storedInvalid();
      const id = randomUUID(),
        token = randomUUID();
      const expiry = new Date(now.getTime() + policy.leaseMs),
        end = new Date(now.getTime() + policy.deadlineMs);
      const [attempt] = await tx
        .insert(attempts)
        .values({
          id,
          tenantId: row.tenantId,
          runId: row.id,
          attemptNumber: row.attemptCount + 1,
          cycle: row.retryCycle,
          token,
          status: "active",
          startedAt: now,
          leaseExpiresAt: expiry,
          deadlineAt: end,
        })
        .returning();
      if (!attempt) throw storedInvalid();
      const [updated] = await tx
        .update(runs)
        .set({
          status: "processing",
          attemptCount: row.attemptCount + 1,
          cycleAttemptCount: row.cycleAttemptCount + 1,
          lifecycleVersion: row.lifecycleVersion + 1,
          leaseAttemptId: id,
          leaseToken: token,
          leaseExpiresAt: expiry,
          attemptDeadlineAt: end,
          nextAttemptAt: null,
          generationStartedAt: row.generationStartedAt ?? now,
        })
        .where(scoped({ tenantId: row.tenantId, runId: row.id }))
        .returning();
      if (!updated) throw storedInvalid();
      await this.audit(tx, updated, attempt, "claimed", "success", now);
      return leaseFrom(attempt);
    });
  }
  private async disposeInvalidQueued(tx: Tx, row: UsTraceExportRunRow): Promise<void> {
    // The locked persisted scheduling identity is authoritative; corrupt frozen
    // content grants no execution authority and is neither read nor repaired here.
    validLifecycle(row);
    parseUsWorkerScope({ tenantId: row.tenantId, runId: row.id });
    parseUsWorkerScope({ tenantId: row.tenantId, runId: row.requestId });
    if (
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      typeof row.createdBy !== "string" ||
      !row.createdBy.trim() ||
      !Number.isSafeInteger(row.startedAt.getTime()) ||
      row.status !== "queued" ||
      row.leaseAttemptId !== null ||
      row.leaseToken !== null ||
      row.leaseExpiresAt !== null ||
      row.attemptDeadlineAt !== null ||
      row.completedAt !== null ||
      row.failureCode !== null ||
      row.exportReady
    )
      throw storedInvalid();
    const [request] = await tx
      .select({ id: schema.traceRequests.id })
      .from(schema.traceRequests)
      .where(
        and(
          eq(schema.traceRequests.tenantId, row.tenantId),
          eq(schema.traceRequests.id, row.requestId),
        ),
      )
      .limit(1);
    const [actor] = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, row.createdBy))
      .limit(1);
    const refs = await tx
      .select({ id: schema.traceExportArtifacts.id })
      .from(schema.traceExportArtifacts)
      .where(
        and(
          eq(schema.traceExportArtifacts.tenantId, row.tenantId),
          eq(schema.traceExportArtifacts.runId, row.id),
        ),
      )
      .limit(1);
    const owners = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.tenantId, row.tenantId),
          eq(attempts.runId, row.id),
          or(eq(attempts.status, "active"), eq(attempts.status, "succeeded")),
        ),
      )
      .limit(1);
    const winners = await tx
      .select({ id: schema.traceExportObjectIntents.id })
      .from(schema.traceExportObjectIntents)
      .where(
        and(
          eq(schema.traceExportObjectIntents.tenantId, row.tenantId),
          eq(schema.traceExportObjectIntents.runId, row.id),
          eq(schema.traceExportObjectIntents.state, "referenced"),
        ),
      )
      .limit(1);
    if (!request || !actor || refs.length || owners.length || winners.length) throw storedInvalid();
    const now = await dbTime(tx);
    if (row.startedAt > now || (row.nextAttemptAt && row.nextAttemptAt > now))
      throw storedInvalid();
    const code = "us_request_run_stored_invalid";
    const [updated] = await tx
      .update(runs)
      .set({
        status: "failed",
        failureCode: code,
        completedAt: now,
        nextAttemptAt: null,
        lifecycleVersion: row.lifecycleVersion + 1,
      })
      .where(scoped({ tenantId: row.tenantId, runId: row.id }))
      .returning();
    if (!updated) throw storedInvalid();
    await this.audit(tx, updated, null, "failed", "failed", now, {
      failureCode: code,
      retryable: false,
      terminalFailureCode: code,
      nextAttemptAt: null,
    });
  }
  async renew(leaseInput: UsWorkerLease): Promise<UsWorkerLease> {
    const lease = parseUsWorkerLease(leaseInput);
    return this.transaction(async (tx) => {
      const { row, attempt, now } = await this.active(tx, lease);
      const expiry = new Date(
        Math.min(
          attempt.deadlineAt.getTime(),
          Math.max(attempt.leaseExpiresAt.getTime(), now.getTime() + policy.leaseMs),
        ),
      );
      const [renewed] = await tx
        .update(attempts)
        .set({ leaseExpiresAt: expiry })
        .where(
          and(
            eq(attempts.tenantId, row.tenantId),
            eq(attempts.runId, row.id),
            eq(attempts.id, attempt.id),
          ),
        )
        .returning();
      await tx.update(runs).set({ leaseExpiresAt: expiry }).where(scoped(lease));
      if (!renewed) throw storedInvalid();
      // Check the OLD persisted authority after both writes, never the extension.
      await assertAuthorityTime(tx, attempt);
      return leaseFrom(renewed);
    });
  }
  async read(scopeInput: UsWorkerScope): Promise<UsWorkerRunState> {
    const scope = parseUsWorkerScope(scopeInput);
    return this.transaction(async (tx) => {
      // Internal evidence read is consistent with lifecycle/publication writers.
      const row = await this.lockRun(tx, scope);
      const history = await tx
        .select()
        .from(attempts)
        .where(and(eq(attempts.tenantId, scope.tenantId), eq(attempts.runId, scope.runId)))
        .orderBy(asc(attempts.attemptNumber));
      for (const attempt of history) validAttempt(attempt);
      // Migration preserves old lifetime counts without inventing old attempts.
      // Recorded history is a contiguous suffix ending at the current count;
      // only the leading pre-worker history may be unknown.
      const firstNumber = row.attemptCount - history.length + 1;
      if (
        history.length > row.attemptCount ||
        history.some(
          (a, index) =>
            a.attemptNumber !== firstNumber + index ||
            a.cycle > row.retryCycle ||
            (index > 0 &&
              (a.cycle < (history[index - 1]?.cycle ?? 1) ||
                a.cycle > (history[index - 1]?.cycle ?? 1) + 1)),
        ) ||
        history.filter((a) => a.cycle === row.retryCycle).length !== row.cycleAttemptCount
      )
        throw storedInvalid();
      const [checkpoint] = await tx
        .select()
        .from(schema.traceExportRenderCheckpoints)
        .where(
          and(
            eq(schema.traceExportRenderCheckpoints.tenantId, scope.tenantId),
            eq(schema.traceExportRenderCheckpoints.runId, scope.runId),
          ),
        );
      const artifacts = await tx
        .select()
        .from(schema.traceExportArtifacts)
        .where(
          and(
            eq(schema.traceExportArtifacts.tenantId, scope.tenantId),
            eq(schema.traceExportArtifacts.runId, scope.runId),
          ),
        );
      return {
        run: row,
        attempts: history,
        checkpoint: checkpoint
          ? parseUsWorkerCheckpoint({
              model: checkpoint.model,
              modelDigest: checkpoint.modelDigest,
              executionDigest: checkpoint.executionDigest,
              packageVersion: checkpoint.packageVersion,
              reportVersion: checkpoint.reportVersion,
            })
          : null,
        expectation:
          checkpoint?.packageExpectation === null || !checkpoint
            ? null
            : parseUsWorkerPackageExpectation(checkpoint.packageExpectation),
        artifacts,
      };
    });
  }
  async finishFailure(leaseInput: UsWorkerLease, failureInput: UsWorkerFailure): Promise<void> {
    const lease = parseUsWorkerLease(leaseInput),
      failure = parseUsWorkerFailure(failureInput);
    await this.transaction(async (tx) => {
      const { row, attempt, now } = await this.active(tx, lease);
      await this.transitionFailure(tx, row, attempt, now, failure, "failed");
      // transitionFailure provisionally clears the lease; retain its exact old
      // authority until every state/audit write has completed in this transaction.
      await assertAuthorityTime(tx, attempt);
    });
  }
  private async transitionFailure(
    tx: Tx,
    row: UsTraceExportRunRow,
    attempt: Attempt,
    now: Date,
    failure: UsWorkerFailure,
    status: "failed" | "abandoned",
  ): Promise<void> {
    const exhausted = failure.retryable && row.cycleAttemptCount >= policy.attemptsPerCycle;
    const terminal = !failure.retryable || exhausted;
    const terminalFailureCode = terminal
      ? exhausted
        ? "us_request_worker_retry_limit"
        : failure.code
      : null;
    const delay = row.cycleAttemptCount === 1 ? policy.retryDelaysMs[0] : policy.retryDelaysMs[1];
    const next = terminal ? null : new Date(now.getTime() + delay);
    await tx
      .update(attempts)
      .set({ status, finishedAt: now, failureCode: failure.code, retryable: failure.retryable })
      .where(
        and(
          eq(attempts.tenantId, row.tenantId),
          eq(attempts.runId, row.id),
          eq(attempts.id, attempt.id),
        ),
      );
    const [updated] = await tx
      .update(runs)
      .set({
        ...clearLease,
        status: terminal ? "failed" : "queued",
        failureCode: terminalFailureCode,
        completedAt: terminal ? now : null,
        nextAttemptAt: next,
        lifecycleVersion: row.lifecycleVersion + 1,
      })
      .where(scoped({ tenantId: row.tenantId, runId: row.id }))
      .returning();
    if (!updated) throw storedInvalid();
    await this.audit(
      tx,
      updated,
      attempt,
      status === "abandoned" ? "recovered" : "failed",
      terminal ? "failed" : "retry_scheduled",
      now,
      {
        failureCode: failure.code,
        retryable: failure.retryable,
        terminalFailureCode,
        nextAttemptAt: next?.toISOString() ?? null,
      },
    );
  }
  private async recoverWithin(tx: Tx, row: UsTraceExportRunRow): Promise<void> {
    if (row.status !== "processing") return;
    // Publication and recovery share this run lock. Any committed publication
    // reference is a reconcile-only condition, never assumed rollback/cleanup.
    const refs = await tx
      .select({ id: schema.traceExportArtifacts.id })
      .from(schema.traceExportArtifacts)
      .where(
        and(
          eq(schema.traceExportArtifacts.tenantId, row.tenantId),
          eq(schema.traceExportArtifacts.runId, row.id),
        ),
      )
      .limit(1);
    const succeeded = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.tenantId, row.tenantId),
          eq(attempts.runId, row.id),
          eq(attempts.status, "succeeded"),
        ),
      )
      .limit(1);
    if (refs.length || succeeded.length) throw storedInvalid();
    const attempt = await this.currentAttempt(tx, row),
      now = await dbTime(tx);
    if (
      now.getTime() < attempt.leaseExpiresAt.getTime() &&
      now.getTime() < attempt.deadlineAt.getTime()
    )
      return;
    await this.transitionFailure(
      tx,
      row,
      attempt,
      now,
      {
        code:
          now.getTime() >= attempt.deadlineAt.getTime()
            ? "us_request_worker_deadline_exceeded"
            : "us_request_worker_lease_lost",
        retryable: true,
      },
      "abandoned",
    );
  }
  async recoverExpired(scopeInput: UsWorkerScope): Promise<void> {
    const scope = parseUsWorkerScope(scopeInput);
    await this.transaction(async (tx) => {
      await this.recoverWithin(tx, await this.lockRun(tx, scope));
    });
  }
  async retry(
    scopeInput: UsWorkerScope,
    callerId: string,
    bodyInput: UsWorkerRetryBody,
  ): Promise<UsWorkerRetryReceipt> {
    const scope = parseUsWorkerScope(scopeInput);
    try {
      return await this.transaction(async (tx) => {
        const [initial] = await tx.select().from(runs).where(scoped(scope)).limit(1);
        if (!initial) throw lost();
        if (typeof callerId !== "string" || !callerId.length)
          throw new ForbiddenException({ code: "insufficient_permission" });
        await this.authority(tx, scope.tenantId, [callerId, initial.createdBy]);
        const body = parseUsWorkerRetryBody(bodyInput);
        const row = await this.lockRun(tx, scope);
        const digest = canonicalExportDigest({ ...scope, callerId, ...body });
        const [saved] = await tx
          .select()
          .from(schema.traceExportRetryReceipts)
          .where(
            and(
              eq(schema.traceExportRetryReceipts.tenantId, scope.tenantId),
              eq(schema.traceExportRetryReceipts.actorId, callerId),
              eq(schema.traceExportRetryReceipts.idempotencyKey, body.idempotencyKey),
            ),
          );
        const receipt = (cycle: number, lifecycleVersion: number) =>
          parseUsWorkerRetryReceipt({
            ...scope,
            cycle,
            lifecycleVersion,
            requestedBy: callerId,
            idempotencyKey: body.idempotencyKey,
          });
        // Current authorization always precedes receipt replay; version/state
        // checks belong only to a new intent, even after another claim starts.
        if (saved) {
          if (
            saved.runId !== row.id ||
            saved.commandDigest !== digest ||
            saved.reason !== body.reason ||
            saved.expectedLifecycleVersion !== body.expectedLifecycleVersion
          )
            throw conflict();
          return receipt(saved.cycle, saved.lifecycleVersion);
        }
        if (row.status !== "failed" || row.lifecycleVersion !== body.expectedLifecycleVersion)
          throw conflict();
        const now = await dbTime(tx),
          cycle = row.retryCycle + 1,
          version = row.lifecycleVersion + 1;
        const [updated] = await tx
          .update(runs)
          .set({
            ...clearLease,
            status: "queued",
            failureCode: null,
            completedAt: null,
            nextAttemptAt: now,
            retryCycle: cycle,
            cycleAttemptCount: 0,
            lifecycleVersion: version,
          })
          .where(scoped(scope))
          .returning();
        if (!updated) throw storedInvalid();
        try {
          await tx.insert(schema.traceExportRetryReceipts).values({
            ...scope,
            actorId: callerId,
            idempotencyKey: body.idempotencyKey,
            commandDigest: digest,
            reason: body.reason,
            expectedLifecycleVersion: body.expectedLifecycleVersion,
            cycle,
            lifecycleVersion: version,
            createdAt: now,
          });
        } catch (error) {
          if (isUniqueConstraintViolation(error, "trace_export_retry_receipts_command_uq"))
            throw conflict();
          throw error;
        }
        await this.audit(
          tx,
          updated,
          null,
          "retried",
          "success",
          now,
          {
            requestedBy: callerId,
            reason: body.reason,
            idempotencyKey: body.idempotencyKey,
            expectedLifecycleVersion: body.expectedLifecycleVersion,
          },
          callerId,
        );
        return receipt(cycle, version);
      });
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }
  private async audit(
    tx: Tx,
    row: UsTraceExportRunRow,
    attempt: Attempt | null,
    action: string,
    outcome: string,
    now: Date,
    extra: Record<string, unknown> = {},
    callerId: string | null = null,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: row.tenantId,
      actorUserId: callerId,
      action: `traceability.request.worker.${action}`,
      outcome,
      targetType: "trace_export_run",
      targetId: row.id,
      before: null,
      after: {
        actorKind: callerId === null ? "system" : "user",
        initiatorId: row.createdBy,
        requestId: row.requestId,
        runId: row.id,
        runRevision: row.revision,
        mode: row.mode,
        attemptId: attempt?.id ?? null,
        attemptNumber: attempt?.attemptNumber ?? row.attemptCount,
        cycle: row.retryCycle,
        cycleAttemptCount: row.cycleAttemptCount,
        lifecycleVersion: row.lifecycleVersion,
        commandDigest: row.commandDigest,
        scopedContentDigest: row.scopedContentDigest,
        inputDigest: row.inputDigest,
        ...extra,
      },
      createdAt: now,
    });
  }
}
