import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { US_CAPABILITY } from "@markiro/domain";
import { ConflictException, ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  authorizeUsMasterData,
  type UsMasterDataTransaction,
} from "../master-data/us-master-data-support";
import {
  requireUsRequestPackageEvidence,
  verifyUsRequestRunEvidence,
  type UsTraceExportRunRow,
} from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";
import { classifyUsWorkerFailure, sanitizedUsWorkerError } from "./us-request-worker-failures";
import type { UsRequestWorkerLifecycleContract } from "./us-request-worker-lifecycle";
import {
  parseUsWorkerCheckpoint,
  parseUsWorkerLease,
  parseUsWorkerObjectEvidence,
  parseUsWorkerPackageExpectation,
  parseUsWorkerScope,
  usWorkerByteSizeFromDb,
  type UsWorkerLease,
  type UsWorkerObjectEvidence,
  type UsWorkerPackageExpectation,
  type UsWorkerRunState,
  type UsWorkerScope,
} from "./us-request-worker-types";

type Tx = UsMasterDataTransaction;
type Intent = typeof schema.traceExportObjectIntents.$inferSelect;
const runs = schema.traceExportRuns,
  intents = schema.traceExportObjectIntents;
const mismatch = () => new ConflictException({ code: "us_request_worker_checkpoint_mismatch" });
const lost = () => new ConflictException({ code: "us_request_worker_lease_lost" });
export const usWorkerPublicationInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const runScope = (scope: UsWorkerScope) =>
  and(eq(runs.tenantId, scope.tenantId), eq(runs.id, scope.runId));
const intentScope = (scope: UsWorkerScope) =>
  and(eq(intents.tenantId, scope.tenantId), eq(intents.runId, scope.runId));

/** Shared publication lock: cleanup must use this same row before issuing a fence. */
export async function lockUsWorkerPublicationRun(
  tx: Tx,
  scope: UsWorkerScope,
): Promise<UsTraceExportRunRow> {
  const [row] = await tx.select().from(runs).where(runScope(scope)).limit(1).for("update");
  if (!row) throw lost();
  verifyUsRequestRunEvidence(row, scope.tenantId);
  return row;
}
export async function usWorkerPublicationNow(tx: Tx): Promise<Date> {
  const result = await tx.execute<{ milliseconds: string }>(
    sql`select extract(epoch from date_trunc('milliseconds',clock_timestamp())) * 1000 as milliseconds`,
  );
  const value = Number(result.rows[0]?.milliseconds);
  if (!Number.isSafeInteger(value)) throw usWorkerPublicationInvalid();
  return new Date(value);
}
export function usWorkerIntentEvidence(row: Intent): UsWorkerObjectEvidence {
  return parseUsWorkerObjectEvidence({
    tenantId: row.tenantId,
    runId: row.runId,
    id: row.id,
    attemptId: row.attemptId,
    name: row.name,
    kind: row.kind,
    objectKey: row.objectKey,
    mediaType: row.mediaType,
    byteSize: usWorkerByteSizeFromDb(row.byteSize),
    sha256: row.sha256,
  });
}
export async function auditUsWorkerPublication(
  tx: Tx,
  row: UsTraceExportRunRow,
  attempt: typeof schema.traceExportAttempts.$inferSelect,
  action: "published" | "cleanup",
  outcome: string,
  now: Date,
  extra: Record<string, unknown>,
): Promise<void> {
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: row.tenantId,
    actorUserId: null,
    action: `traceability.request.worker.${action}`,
    outcome,
    targetType: "trace_export_run",
    targetId: row.id,
    before: null,
    after: {
      actorKind: "system",
      initiatorId: row.createdBy,
      requestId: row.requestId,
      runId: row.id,
      runRevision: row.revision,
      mode: row.mode,
      attemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      cycle: attempt.cycle,
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
function descriptors(expectation: UsWorkerPackageExpectation) {
  return [...expectation.entries.filter((d) => d.name !== "SHA256SUMS"), expectation.zip].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}
const kinds = {
  "records.xlsx": "xlsx",
  "plan.pdf": "plan_pdf",
  "validation.json": "validation_report",
  "request-report.pdf": "request_report",
  "manifest.json": "manifest",
  "package.zip": "package_zip",
} as const;

/** Internal trusted worker persistence. markVerified is called only after conditional
 * PUT and actual bounded read-back succeed; it is never a metadata/HTTP endpoint. */
export class UsRequestWorkerPublication {
  constructor(
    private readonly db: Db,
    private readonly lifecycle: UsRequestWorkerLifecycleContract,
  ) {}

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    // Each serialization retry opens a fresh transaction and repeats every read,
    // including authorization. Never retain an authorized transaction closure.
    for (let retry = 0; ; retry++) {
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
          await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
          return work(tx);
        });
      } catch (error) {
        if (
          retry < 2 &&
          classifyUsWorkerFailure(error).code === "us_request_worker_database_retryable"
        )
          continue;
        throw error;
      }
    }
  }
  private async expectation(tx: Tx, row: UsTraceExportRunRow): Promise<UsWorkerPackageExpectation> {
    const [saved] = await tx
      .select()
      .from(schema.traceExportRenderCheckpoints)
      .where(
        and(
          eq(schema.traceExportRenderCheckpoints.tenantId, row.tenantId),
          eq(schema.traceExportRenderCheckpoints.runId, row.id),
        ),
      )
      .limit(1);
    if (!saved || saved.packageExpectation === null) throw mismatch();
    const checkpoint = parseUsWorkerCheckpoint({
      model: saved.model,
      modelDigest: saved.modelDigest,
      executionDigest: saved.executionDigest,
      packageVersion: saved.packageVersion,
      reportVersion: saved.reportVersion,
    });
    const expected = parseUsWorkerPackageExpectation(saved.packageExpectation);
    const frozen = requireUsRequestPackageEvidence(row, row.tenantId),
      model = checkpoint.model;
    if (
      !equal(model.identity, {
        tenantId: row.tenantId,
        requestId: row.requestId,
        requestRevision: frozen.validationSnapshot.request.revision,
        runId: row.id,
        runRevision: row.revision,
        mode: row.mode,
        preparedBy: row.createdBy,
      }) ||
      !equal(model.request, frozen.validationSnapshot.request) ||
      !equal(model.scope, frozen.validationSnapshot.selection.scope) ||
      !equal(model.tenantOrigin, frozen.validationSnapshot.tenantOrigin) ||
      !equal(model.plan, frozen.validationSnapshot.plan) ||
      !equal(model.digests, {
        scopedContentDigest: row.scopedContentDigest,
        inputDigest: row.inputDigest,
      }) ||
      model.timing.preparationStartedAt !== frozen.generatedAt ||
      !equal(
        model.preReportFiles,
        expected.manifest.files.filter((d) => d.name !== "request-report.pdf"),
      )
    )
      throw mismatch();
    for (const key of [
      "identity",
      "timing",
      "tenantOrigin",
      "stamps",
      "selectionSummary",
      "findingsSummary",
      "renderFindings",
      "plan",
      "digests",
      "warningAcknowledgement",
      "missingFiles",
    ] as const)
      if (!equal(model[key], expected.manifest[key])) throw mismatch();
    const [owner] = await tx
      .select()
      .from(schema.traceExportAttempts)
      .where(
        and(
          eq(schema.traceExportAttempts.tenantId, row.tenantId),
          eq(schema.traceExportAttempts.runId, row.id),
          eq(schema.traceExportAttempts.id, saved.attemptId),
        ),
      )
      .limit(1);
    if (
      !owner ||
      (model.timing.workerStartedAt !== null &&
        model.timing.workerStartedAt !== owner.startedAt.toISOString()) ||
      Date.parse(model.timing.reportDataPreparedAt) < owner.startedAt.getTime() ||
      Date.parse(model.timing.reportDataPreparedAt) > owner.deadlineAt.getTime()
    )
      throw mismatch();
    return expected;
  }
  private async objects(tx: Tx, lease: UsWorkerLease): Promise<Intent[]> {
    return tx
      .select()
      .from(intents)
      .where(and(intentScope(lease), eq(intents.attemptId, lease.attemptId)))
      .orderBy(asc(intents.name))
      .for("update");
  }
  private assertObjects(
    rows: readonly Intent[],
    lease: UsWorkerLease,
    expected: UsWorkerPackageExpectation,
  ): void {
    const files = descriptors(expected);
    if (rows.length !== files.length) throw mismatch();
    for (let n = 0; n < files.length; n++) {
      const row = rows[n],
        file = files[n];
      if (!row || !file || file.name === "SHA256SUMS") throw mismatch();
      const evidence = usWorkerIntentEvidence(row);
      if (
        evidence.tenantId !== lease.tenantId ||
        evidence.runId !== lease.runId ||
        evidence.attemptId !== lease.attemptId ||
        !equal(
          {
            name: evidence.name,
            mediaType: evidence.mediaType,
            byteSize: evidence.byteSize,
            sha256: evidence.sha256,
          },
          file,
        )
      )
        throw mismatch();
    }
  }
  async allocate(
    leaseInput: UsWorkerLease,
    expectationInput: UsWorkerPackageExpectation,
  ): Promise<readonly UsWorkerObjectEvidence[]> {
    const lease = parseUsWorkerLease(leaseInput),
      candidate = parseUsWorkerPackageExpectation(expectationInput);
    try {
      return await this.transaction(async (tx) => {
        await this.lifecycle.assertActive(tx, lease);
        const row = await lockUsWorkerPublicationRun(tx, lease),
          expected = await this.expectation(tx, row);
        if (!equal(candidate, expected)) throw mismatch();
        let rows = await this.objects(tx, lease);
        await this.lifecycle.assertActive(tx, lease);
        if (rows.length) {
          this.assertObjects(rows, lease, expected);
          if (rows.some((o) => o.fencedAt || !["allocated", "verified"].includes(o.state)))
            throw lost();
          return rows.map(usWorkerIntentEvidence);
        }
        const values = descriptors(expected).map((file) => {
          if (file.name === "SHA256SUMS") throw mismatch();
          return {
            id: randomUUID(),
            tenantId: lease.tenantId,
            runId: lease.runId,
            attemptId: lease.attemptId,
            name: file.name,
            kind: kinds[file.name],
            objectKey: `us/requests/${lease.tenantId}/${lease.runId}/${lease.attemptId}/${file.name}`,
            mediaType: file.mediaType,
            byteSize: BigInt(file.byteSize),
            sha256: file.sha256,
          };
        });
        rows = await tx.insert(intents).values(values).returning();
        await this.lifecycle.assertActive(tx, lease);
        return rows.map(usWorkerIntentEvidence);
      });
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }
  async markVerified(
    leaseInput: UsWorkerLease,
    evidenceInput: UsWorkerObjectEvidence,
  ): Promise<void> {
    const lease = parseUsWorkerLease(leaseInput),
      evidence = parseUsWorkerObjectEvidence(evidenceInput);
    try {
      await this.transaction(async (tx) => {
        await this.lifecycle.assertActive(tx, lease);
        const run = await lockUsWorkerPublicationRun(tx, lease),
          expected = await this.expectation(tx, run),
          rows = await this.objects(tx, lease);
        this.assertObjects(rows, lease, expected);
        const row = rows.find((o) => o.id === evidence.id);
        if (!row || !equal(usWorkerIntentEvidence(row), evidence)) throw mismatch();
        if (row.fencedAt || !["allocated", "verified"].includes(row.state)) throw lost();
        await this.lifecycle.assertActive(tx, lease);
        if (row.state === "verified") return;
        await tx
          .update(intents)
          .set({ state: "verified", verifiedAt: await usWorkerPublicationNow(tx) })
          .where(eq(intents.id, row.id));
        await this.lifecycle.assertActive(tx, lease);
      });
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }
  private async authority(tx: Tx, row: UsTraceExportRunRow): Promise<void> {
    // Membership -> profile -> organization-profile precedes publication run lock.
    const profile = await authorizeUsMasterData(
      tx,
      row.tenantId,
      row.createdBy,
      US_CAPABILITY.QA_MANAGE,
    );
    await authorizeUsMasterData(tx, row.tenantId, row.createdBy, US_CAPABILITY.EXPORT_READ);
    if (profile !== "US_FSMA204_PROCESSOR")
      throw new ForbiddenException({ code: "us_request_profile_unsupported" });
  }
  private async assertWinner(
    tx: Tx,
    state: UsWorkerRunState,
    lease?: UsWorkerLease,
  ): Promise<void> {
    const row = state.run,
      expected = await this.expectation(tx, row);
    const winners = state.attempts.filter((a) => a.status === "succeeded"),
      winner = winners[0];
    if (
      winners.length !== 1 ||
      !winner ||
      !row.completedAt ||
      !row.reportRenderedAt ||
      row.failureCode !== null ||
      row.exportReady !== (row.mode === "export_ready") ||
      winner.finishedAt?.getTime() !== row.completedAt.getTime() ||
      winner.reportRenderedAt?.getTime() !== row.reportRenderedAt.getTime() ||
      row.completedAt.getTime() >= winner.leaseExpiresAt.getTime() ||
      row.completedAt.getTime() >= winner.deadlineAt.getTime() ||
      row.reportRenderedAt.getTime() > row.completedAt.getTime() ||
      row.reportRenderedAt.getTime() < Date.parse(expected.manifest.timing.reportDataPreparedAt) ||
      winner.attemptNumber !== row.attemptCount ||
      winner.cycle !== row.retryCycle ||
      row.leaseAttemptId !== null ||
      row.leaseToken !== null ||
      row.leaseExpiresAt !== null ||
      row.attemptDeadlineAt !== null ||
      (lease &&
        (winner.id !== lease.attemptId ||
          winner.token !== lease.token ||
          winner.startedAt.toISOString() !== lease.startedAt ||
          winner.deadlineAt.toISOString() !== lease.deadlineAt))
    )
      throw usWorkerPublicationInvalid();
    const winnerLease: UsWorkerLease = {
      tenantId: row.tenantId,
      runId: row.id,
      attemptId: winner.id,
      attemptNumber: winner.attemptNumber,
      cycle: winner.cycle,
      token: winner.token,
      startedAt: winner.startedAt.toISOString(),
      expiresAt: winner.leaseExpiresAt.toISOString(),
      deadlineAt: winner.deadlineAt.toISOString(),
    };
    const objects = await this.objects(tx, winnerLease);
    this.assertObjects(objects, winnerLease, expected);
    // Reconciliation's initial snapshot was read in a separate transaction.
    // Reread references under the publication lock so an intervening INSERT
    // cannot make a stale artifact array look like an exact committed winner.
    const artifacts = await tx
      .select()
      .from(schema.traceExportArtifacts)
      .where(
        and(
          eq(schema.traceExportArtifacts.tenantId, row.tenantId),
          eq(schema.traceExportArtifacts.runId, row.id),
        ),
      )
      .limit(7)
      .for("share");
    if (
      artifacts.length !== objects.length ||
      state.artifacts.length !== artifacts.length ||
      artifacts.some((artifact) => !state.artifacts.some((saved) => saved.id === artifact.id))
    )
      throw usWorkerPublicationInvalid();
    for (const object of objects) {
      const artifact = artifacts.find((a) => a.filename === object.name);
      if (
        object.state !== "referenced" ||
        !object.verifiedAt ||
        object.fencedAt ||
        object.deletedAt ||
        object.referencedAt?.getTime() !== row.completedAt.getTime() ||
        !artifact ||
        artifact.tenantId !== row.tenantId ||
        artifact.runId !== row.id ||
        artifact.kind !== object.kind ||
        artifact.objectKey !== object.objectKey ||
        artifact.mediaType !== object.mediaType ||
        artifact.byteSize !== object.byteSize ||
        artifact.sha256 !== object.sha256 ||
        artifact.publishedAt.getTime() !== row.completedAt.getTime()
      )
        throw usWorkerPublicationInvalid();
    }
  }
  async reconcile(scopeInput: UsWorkerScope): Promise<UsWorkerRunState> {
    const scope = parseUsWorkerScope(scopeInput);
    try {
      const state = await this.lifecycle.read(scope);
      await this.transaction(async (tx) => {
        const row = await lockUsWorkerPublicationRun(tx, scope);
        if (row.lifecycleVersion !== state.run.lifecycleVersion || row.status !== state.run.status)
          throw usWorkerPublicationInvalid();
        if (row.status === "ready") await this.assertWinner(tx, state);
        else if (state.artifacts.length || state.attempts.some((a) => a.status === "succeeded"))
          throw usWorkerPublicationInvalid();
      });
      return state;
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }
  async publish(leaseInput: UsWorkerLease): Promise<UsWorkerRunState> {
    const lease = parseUsWorkerLease(leaseInput);
    let mutationReached = false;
    try {
      await this.transaction(async (tx) => {
        const [initial] = await tx.select().from(runs).where(runScope(lease)).limit(1);
        if (!initial) throw lost();
        await this.authority(tx, initial);
        const row = await lockUsWorkerPublicationRun(tx, lease);
        if (row.status === "ready") return;
        await this.lifecycle.assertActive(tx, lease);
        const expected = await this.expectation(tx, row),
          objects = await this.objects(tx, lease);
        this.assertObjects(objects, lease, expected);
        if (
          objects.some(
            (o) =>
              o.state !== "verified" ||
              !o.verifiedAt ||
              o.fencedAt ||
              o.deletedAt ||
              o.referencedAt,
          )
        )
          throw mismatch();
        const [attempt] = await tx
          .select()
          .from(schema.traceExportAttempts)
          .where(
            and(
              eq(schema.traceExportAttempts.tenantId, lease.tenantId),
              eq(schema.traceExportAttempts.runId, lease.runId),
              eq(schema.traceExportAttempts.id, lease.attemptId),
            ),
          )
          .limit(1)
          .for("update");
        if (
          !attempt?.reportRenderedAt ||
          attempt.reportRenderedAt.getTime() <
            Date.parse(expected.manifest.timing.reportDataPreparedAt)
        )
          throw mismatch();
        const existing = await tx
          .select()
          .from(schema.traceExportArtifacts)
          .where(
            and(
              eq(schema.traceExportArtifacts.tenantId, lease.tenantId),
              eq(schema.traceExportArtifacts.runId, lease.runId),
            ),
          )
          .limit(1);
        if (existing.length) throw usWorkerPublicationInvalid();
        // This check occurs after all possibly blocking evidence reads.
        await this.lifecycle.assertActive(tx, lease);
        const now = await usWorkerPublicationNow(tx);
        // This timestamp is captured after the final active check's response.
        // Network/response delay can itself cross expiry; use persisted clocks.
        if (now.getTime() >= attempt.deadlineAt.getTime())
          throw new ConflictException({ code: "us_request_worker_deadline_exceeded" });
        if (now.getTime() >= attempt.leaseExpiresAt.getTime()) throw lost();
        if (attempt.reportRenderedAt.getTime() > now.getTime()) throw mismatch();
        await tx.insert(schema.traceExportArtifacts).values(
          objects.map((o) => ({
            tenantId: o.tenantId,
            runId: o.runId,
            kind: o.kind,
            filename: o.name,
            mediaType: o.mediaType,
            byteSize: o.byteSize,
            sha256: o.sha256,
            objectKey: o.objectKey,
            publishedAt: now,
          })),
        );
        mutationReached = true;
        for (const object of objects)
          await tx
            .update(intents)
            .set({ state: "referenced", referencedAt: now })
            .where(eq(intents.id, object.id));
        await tx
          .update(schema.traceExportAttempts)
          .set({ status: "succeeded", finishedAt: now })
          .where(eq(schema.traceExportAttempts.id, attempt.id));
        const [updated] = await tx
          .update(runs)
          .set({
            status: "ready",
            exportReady: row.mode === "export_ready",
            failureCode: null,
            completedAt: now,
            reportRenderedAt: attempt.reportRenderedAt,
            lifecycleVersion: row.lifecycleVersion + 1,
            leaseAttemptId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            attemptDeadlineAt: null,
            nextAttemptAt: null,
          })
          .where(runScope(lease))
          .returning();
        if (!updated) throw usWorkerPublicationInvalid();
        await auditUsWorkerPublication(tx, updated, attempt, "published", "success", now, {
          artifacts: objects.map(({ name, kind, sha256, byteSize }) => ({
            name,
            kind,
            sha256,
            byteSize: usWorkerByteSizeFromDb(byteSize),
          })),
        });
        // Inserts, foreign-key checks and audit writes may wait after the
        // publication timestamp was sampled. Reject the entire provisional
        // transaction if any of those waits exhausted persisted authority.
        // This is a pre-COMMIT fence check, not a measured COMMIT timestamp.
        const beforeCommit = await usWorkerPublicationNow(tx);
        if (beforeCommit.getTime() >= attempt.deadlineAt.getTime())
          throw new ConflictException({ code: "us_request_worker_deadline_exceeded" });
        if (beforeCommit.getTime() >= attempt.leaseExpiresAt.getTime()) throw lost();
      });
    } catch (error) {
      if (mutationReached) {
        const state = await this.reconcile({ tenantId: lease.tenantId, runId: lease.runId });
        if (state.run.status === "ready") {
          await this.transaction((tx) => this.assertWinner(tx, state, lease));
          return state;
        }
      }
      throw sanitizedUsWorkerError(error);
    }
    const state = await this.reconcile({ tenantId: lease.tenantId, runId: lease.runId });
    await this.transaction((tx) => this.assertWinner(tx, state, lease));
    return state;
  }
}
