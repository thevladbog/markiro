import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { assertUsRequestReportModel } from "./us-request-package-inputs";
import type { UsRequestPackageResult } from "./us-request-package";
import {
  US_REQUEST_PACKAGE_LIMITS as limits,
  type UsRequestPackageByteFile,
  type UsRequestPackageInputs,
  type UsRequestReportModel,
} from "./us-request-package-types";
import { verifyUsRequestPackageArchive } from "./us-request-package-zip";
import {
  requireUsRequestPackageEvidence,
  type UsTraceExportRunRow,
} from "./us-request-run-evidence";
import { stableStringify } from "./us-request-snapshot";
import { sanitizedUsWorkerError } from "./us-request-worker-failures";
import type { UsRequestWorkerLifecycleContract } from "./us-request-worker-lifecycle";
import {
  parseUsWorkerCheckpoint,
  parseUsWorkerLease,
  parseUsWorkerPackageExpectation,
  type UsWorkerCheckpoint,
  type UsWorkerLease,
  type UsWorkerPackageExpectation,
} from "./us-request-worker-types";

type Tx = UsMasterDataTransaction;
const checkpoints = schema.traceExportRenderCheckpoints;
const mismatch = () => new ConflictException({ code: "us_request_worker_checkpoint_mismatch" });
const storedInvalid = () =>
  new ServiceUnavailableException({ code: "us_request_worker_stored_invalid" });
const equal = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scoped = (lease: UsWorkerLease) =>
  and(eq(checkpoints.tenantId, lease.tenantId), eq(checkpoints.runId, lease.runId));
const descriptor = ({ bytes, ...file }: UsRequestPackageByteFile) => {
  void bytes;
  return file;
};

function assertFrozen(model: UsRequestReportModel, row: UsTraceExportRunRow): void {
  const frozen = requireUsRequestPackageEvidence(row, row.tenantId),
    snapshot = frozen.validationSnapshot;
  const byType = { receiving: 0, transformation: 0, shipping: 0 };
  const byLifecycle = { current_finalized: 0, historical_finalized: 0, draft: 0, void: 0 };
  const validation = { error: 0, warning: 0, info: 0 };
  for (const source of snapshot.sources) {
    byType[source.type] += 1;
    byLifecycle[source.lifecycle] += 1;
  }
  for (const finding of snapshot.findings) validation[finding.severity] += 1;
  const validationBytes = Buffer.from(stableStringify(frozen));
  const validationFile = model.preReportFiles.find((file) => file.name === "validation.json");
  if (
    !equal(model.identity, {
      tenantId: row.tenantId,
      requestId: row.requestId,
      requestRevision: snapshot.request.revision,
      runId: row.id,
      runRevision: row.revision,
      mode: frozen.mode,
      preparedBy: frozen.preparedBy,
    }) ||
    !equal(model.request, snapshot.request) ||
    !equal(model.scope, snapshot.selection.scope) ||
    !equal(model.tenantOrigin, snapshot.tenantOrigin) ||
    !equal(model.plan, snapshot.plan) ||
    !equal(model.warningAcknowledgement, frozen.warningAcknowledgement) ||
    !equal(model.digests, {
      scopedContentDigest: row.scopedContentDigest,
      inputDigest: row.inputDigest,
    }) ||
    model.timing.preparationStartedAt !== frozen.generatedAt ||
    !equal(model.stamps, {
      profile: snapshot.profile,
      timeZone: snapshot.timeZone,
      baselineId: snapshot.baselineId,
      registryId: snapshot.registryId,
      registryVersion: snapshot.registryVersion,
      registryHash: snapshot.registryHash,
      build: snapshot.build,
    }) ||
    !equal(model.selectionSummary, {
      capturedRevisionCount: snapshot.sources.length,
      workbookEventCount: frozen.exportInput?.events.length ?? 0,
      byType,
      byLifecycle,
    }) ||
    !equal(model.findingsSummary.validation, validation) ||
    validationFile?.byteSize !== validationBytes.length ||
    validationFile.sha256 !== hash(validationBytes)
  )
    throw mismatch();
}

function assertManifest(
  checkpoint: UsWorkerCheckpoint,
  expectation: UsWorkerPackageExpectation,
): void {
  const model = checkpoint.model,
    manifest = expectation.manifest;
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
  ] as const) {
    if (!equal(model[key], manifest[key])) throw mismatch();
  }
  if (
    manifest.packageVersion !== checkpoint.packageVersion ||
    manifest.reportRendererVersion !== checkpoint.reportVersion ||
    !equal(manifest.files.slice(0, -1), model.preReportFiles) ||
    manifest.files.at(-1)?.name !== "request-report.pdf"
  )
    throw mismatch();
}

/** Internal write-once evidence seam; owns no clock, renderer, storage or runtime. */
export class UsRequestWorkerCheckpoints {
  constructor(
    private readonly db: Db,
    private readonly lifecycle: UsRequestWorkerLifecycleContract,
  ) {}

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
      return work(tx);
    });
  }
  private async now(tx: Tx): Promise<number> {
    const result = await tx.execute<{ milliseconds: string }>(
      sql`select extract(epoch from date_trunc('milliseconds',clock_timestamp())) * 1000 as milliseconds`,
    );
    const value = Number(result.rows[0]?.milliseconds);
    if (!Number.isSafeInteger(value)) throw storedInvalid();
    return value;
  }
  private async run(tx: Tx, lease: UsWorkerLease): Promise<UsTraceExportRunRow> {
    const [row] = await tx
      .select()
      .from(schema.traceExportRuns)
      .where(
        and(
          eq(schema.traceExportRuns.tenantId, lease.tenantId),
          eq(schema.traceExportRuns.id, lease.runId),
        ),
      )
      .limit(1);
    if (!row) throw mismatch();
    requireUsRequestPackageEvidence(row, lease.tenantId);
    return row;
  }
  private async saved(tx: Tx, lease: UsWorkerLease, run: UsTraceExportRunRow) {
    const [row] = await tx.select().from(checkpoints).where(scoped(lease)).limit(1);
    if (!row) return null;
    try {
      const checkpoint = parseUsWorkerCheckpoint({
        model: row.model,
        modelDigest: row.modelDigest,
        executionDigest: row.executionDigest,
        packageVersion: row.packageVersion,
        reportVersion: row.reportVersion,
      });
      assertFrozen(checkpoint.model, run);
      const [attempt] = await tx
        .select()
        .from(schema.traceExportAttempts)
        .where(
          and(
            eq(schema.traceExportAttempts.tenantId, lease.tenantId),
            eq(schema.traceExportAttempts.runId, lease.runId),
            eq(schema.traceExportAttempts.id, row.attemptId),
          ),
        )
        .limit(1);
      const timing = checkpoint.model.timing;
      if (
        !attempt ||
        (timing.workerStartedAt !== null &&
          timing.workerStartedAt !== attempt.startedAt.toISOString()) ||
        Date.parse(timing.reportDataPreparedAt) < attempt.startedAt.getTime() ||
        Date.parse(timing.reportDataPreparedAt) > attempt.deadlineAt.getTime()
      )
        throw storedInvalid();
      const expectation =
        row.packageExpectation === null
          ? null
          : parseUsWorkerPackageExpectation(row.packageExpectation);
      if (expectation) assertManifest(checkpoint, expectation);
      return { checkpoint, expectation };
    } catch {
      throw storedInvalid();
    }
  }
  private async reconcile(lease: UsWorkerLease) {
    // A separate transaction/connection read after the uncertain transaction
    // has ended. Absence or unavailable verification is never assumed success.
    try {
      const state = await this.lifecycle.read({ tenantId: lease.tenantId, runId: lease.runId });
      // Also verify the first attempt binding: the lifecycle parser validates
      // the body, while this seam owns its relationship to frozen evidence.
      const saved = await this.transaction((tx) => this.saved(tx, lease, state.run));
      if (
        !equal(saved?.checkpoint ?? null, state.checkpoint) ||
        !equal(saved?.expectation ?? null, state.expectation)
      )
        throw storedInvalid();
      return state;
    } catch (error) {
      throw sanitizedUsWorkerError(error);
    }
  }

  async acceptReport(
    leaseInput: UsWorkerLease,
    checkpointInput: UsWorkerCheckpoint,
  ): Promise<UsWorkerCheckpoint> {
    const lease = parseUsWorkerLease(leaseInput),
      candidate = parseUsWorkerCheckpoint(checkpointInput);
    let writeReached = false;
    try {
      return await this.transaction(async (tx) => {
        await this.lifecycle.assertActive(tx, lease);
        const run = await this.run(tx, lease),
          saved = await this.saved(tx, lease, run);
        assertFrozen(candidate.model, run);
        // Evidence reads can wait on locks. Recheck DB time after those waits
        // before accepting either a new write or an identical saved winner.
        await this.lifecycle.assertActive(tx, lease);
        if (saved) {
          if (!equal(saved.checkpoint, candidate)) throw mismatch();
          return saved.checkpoint;
        }
        const timing = candidate.model.timing;
        if (
          timing.workerStartedAt !== lease.startedAt ||
          Date.parse(timing.reportDataPreparedAt) > (await this.now(tx))
        )
          throw mismatch();
        await tx.insert(checkpoints).values({
          tenantId: lease.tenantId,
          runId: lease.runId,
          attemptId: lease.attemptId,
          ...candidate,
        });
        await this.lifecycle.assertActive(tx, lease);
        // Only a fully guarded callback can have an ambiguous COMMIT. A known
        // rollback from the final clock check must not enter acceptance replay.
        writeReached = true;
        return candidate;
      });
    } catch (error) {
      if (writeReached) {
        const state = await this.reconcile(lease);
        if (state.checkpoint) {
          if (!equal(state.checkpoint, candidate)) throw mismatch();
          return state.checkpoint;
        }
      }
      throw sanitizedUsWorkerError(error);
    }
  }

  async acceptPackage(
    leaseInput: UsWorkerLease,
    expectationInput: UsWorkerPackageExpectation,
    renderedAt: string,
  ): Promise<UsWorkerPackageExpectation> {
    const lease = parseUsWorkerLease(leaseInput),
      candidate = parseUsWorkerPackageExpectation(expectationInput);
    const completion = Date.parse(renderedAt);
    if (!Number.isSafeInteger(completion) || new Date(completion).toISOString() !== renderedAt)
      throw mismatch();
    let writeReached = false;
    try {
      return await this.transaction(async (tx) => {
        await this.lifecycle.assertActive(tx, lease);
        const run = await this.run(tx, lease),
          saved = await this.saved(tx, lease, run);
        if (!saved) throw mismatch();
        assertManifest(saved.checkpoint, candidate);
        if (
          completion < Date.parse(lease.startedAt) ||
          completion < Date.parse(saved.checkpoint.model.timing.reportDataPreparedAt) ||
          completion > (await this.now(tx))
        )
          throw mismatch();
        if (saved.expectation && !equal(saved.expectation, candidate)) throw mismatch();
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
          .limit(1);
        if (!attempt) throw storedInvalid();
        if (attempt.reportRenderedAt && attempt.reportRenderedAt.toISOString() !== renderedAt)
          throw mismatch();
        await this.lifecycle.assertActive(tx, lease);
        if (!saved.expectation)
          await tx.update(checkpoints).set({ packageExpectation: candidate }).where(scoped(lease));
        if (!attempt.reportRenderedAt)
          await tx
            .update(schema.traceExportAttempts)
            .set({ reportRenderedAt: new Date(completion) })
            .where(
              and(
                eq(schema.traceExportAttempts.tenantId, lease.tenantId),
                eq(schema.traceExportAttempts.runId, lease.runId),
                eq(schema.traceExportAttempts.id, lease.attemptId),
              ),
            );
        await this.lifecycle.assertActive(tx, lease);
        writeReached = true;
        return saved.expectation ?? candidate;
      });
    } catch (error) {
      if (writeReached) {
        const state = await this.reconcile(lease),
          attempt = state.attempts.find((a) => a.id === lease.attemptId);
        if (state.expectation) {
          if (!equal(state.expectation, candidate)) throw mismatch();
          if (attempt?.reportRenderedAt?.toISOString() === renderedAt) return state.expectation;
        }
      }
      throw sanitizedUsWorkerError(error);
    }
  }

  assertReproduction(
    checkpointInput: UsWorkerCheckpoint,
    inputs: UsRequestPackageInputs,
    executionDigest: string,
  ): void {
    try {
      const checkpoint = parseUsWorkerCheckpoint(checkpointInput);
      assertUsRequestReportModel(inputs.model);
      if (
        executionDigest !== checkpoint.executionDigest ||
        !equal(inputs.model, checkpoint.model) ||
        !equal(inputs.preReportFiles.map(descriptor), checkpoint.model.preReportFiles)
      )
        throw mismatch();
      for (const file of inputs.preReportFiles) {
        if (
          !(file.bytes instanceof Uint8Array) ||
          file.byteSize !== file.bytes.length ||
          hash(file.bytes) !== file.sha256
        )
          throw mismatch();
      }
    } catch {
      throw mismatch();
    }
  }
  assertPackageReproduction(
    expectedInput: UsWorkerPackageExpectation,
    result: UsRequestPackageResult,
  ): void {
    try {
      const expected = parseUsWorkerPackageExpectation(expectedInput);
      if (
        !equal(expected.manifest, result.manifest) ||
        !equal(expected.entries, result.files.map(descriptor)) ||
        !equal(expected.zip, descriptor(result.zip)) ||
        result.runId !== expected.manifest.identity.runId ||
        result.revision !== expected.manifest.identity.runRevision ||
        result.mode !== expected.manifest.identity.mode
      )
        throw mismatch();
      for (const file of [...result.files, result.zip]) {
        if (
          !Buffer.isBuffer(file.bytes) ||
          file.bytes.length !== file.byteSize ||
          hash(file.bytes) !== file.sha256
        )
          throw mismatch();
      }
      if (result.zip.bytes.length > limits.zip) throw mismatch();
      verifyUsRequestPackageArchive(result.zip.bytes, {
        files: result.files,
        manifest: expected.manifest,
      });
    } catch {
      throw mismatch();
    }
  }
}
